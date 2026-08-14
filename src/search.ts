import { z } from "zod";
import { chunkConversation } from "./chunking";
import { embedTexts, type EmbeddingEnv } from "./indexing";
import type { AppEnv, SearchResponse, SearchResult } from "./domain";
import { loadCanonicalRevision } from "./storage";

export const RECENT_UNINDEXED_DEFAULTS = {
  maxRevisions: 8,
  maxAgeSeconds: 86_400,
  maxMessages: 200,
} as const;

export type SearchEnv = Pick<AppEnv, "MEMORY_DB" | "MEMORY_BUCKET" | "ACTIVE_INDEX_GENERATION"> &
  EmbeddingEnv & {
    MEMORY_VECTOR: Pick<VectorizeIndex, "query">;
    RECENT_UNINDEXED_MAX_REVISIONS?: number | string;
    RECENT_UNINDEXED_MAX_AGE_SECONDS?: number | string;
    RECENT_UNINDEXED_MAX_MESSAGES?: number | string;
  };

type SearchSource = SearchResult["sources"][number];
type UnavailableSource = SearchResponse["unavailable"][number];
type IndexingStatus = "queued" | "processing" | "failed";

interface RankedCandidate {
  chunkId: string;
  lexicalRank?: number;
  semanticRank?: number;
  semanticScore?: number;
  recentRank?: number;
}

interface ChunkRow {
  id: string;
  revision_id: string;
  conversation_id: string;
  title: string;
  body: string;
  conversation_timestamp: string | null;
  namespace: string;
}

interface LexicalRow extends ChunkRow {
  lexical_score: number;
}

interface RecentRevisionRow {
  revision_id: string;
  conversation_id: string;
  status: IndexingStatus;
  queued_at: string;
}

interface RecentMatch {
  row: ChunkRow;
  score: number;
  queuedAt: string;
  ordinal: number;
}

interface RecentSearchResult {
  matches: RecentMatch[];
  candidateCount: number;
  failedCount: number;
  statusCounts: Record<IndexingStatus, number>;
}

const recentConfigSchema = z.object({
  maxRevisions: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(RECENT_UNINDEXED_DEFAULTS.maxRevisions),
  maxAgeSeconds: z.coerce
    .number()
    .int()
    .min(60)
    .max(31 * 86_400)
    .default(RECENT_UNINDEXED_DEFAULTS.maxAgeSeconds),
  maxMessages: z.coerce
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(RECENT_UNINDEXED_DEFAULTS.maxMessages),
});

function recentConfig(env: SearchEnv) {
  return recentConfigSchema.parse({
    maxRevisions: env.RECENT_UNINDEXED_MAX_REVISIONS,
    maxAgeSeconds: env.RECENT_UNINDEXED_MAX_AGE_SECONDS,
    maxMessages: env.RECENT_UNINDEXED_MAX_MESSAGES,
  });
}

function normalizeText(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ").toLocaleLowerCase();
}

function extractLexicalTokens(value: string, limit?: number): string[] {
  const terms = value.match(/[\p{L}\p{N}][\p{L}\p{N}._:@/-]*/gu) ?? [];
  const tokens = [
    ...new Set(
      terms.map((term) => term.replace(/[._:@/-]+$/u, "").toLocaleLowerCase()).filter(Boolean),
    ),
  ];
  return limit === undefined ? tokens : tokens.slice(0, limit);
}

export function lexicalTokens(value: string): string[] {
  return extractLexicalTokens(value, 12);
}

export function queryTerms(query: string): string {
  return lexicalTokens(query)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

export function recentLexicalScore(query: string, text: string): number | null {
  const queryTokens = lexicalTokens(query);
  if (!queryTokens.length) return null;
  const normalizedQuery = normalizeText(query);
  const normalizedText = normalizeText(text);
  const exact = normalizedText.includes(normalizedQuery);
  const textTokens = new Set(extractLexicalTokens(normalizedText));
  const overlap = queryTokens.filter((term) => textTokens.has(term)).length;
  if (!exact && overlap < Math.min(2, queryTokens.length)) return null;
  return (exact ? 2 : 0) + overlap / queryTokens.length;
}

export function reciprocalRankFusion(
  candidates: RankedCandidate[],
  query: string,
  rows: Map<string, ChunkRow>,
  now = Date.now(),
): Array<{ chunkId: string; score: number; sources: SearchSource[] }> {
  const normalizedQuery = normalizeText(query);
  const identifier = /[._:@/\\-]|\d/u.test(query);
  return candidates
    .map((candidate) => {
      const row = rows.get(candidate.chunkId);
      if (!row) return null;
      let score = 0;
      const sources: SearchSource[] = [];
      if (candidate.lexicalRank !== undefined) {
        score += 1 / (60 + candidate.lexicalRank);
        sources.push("lexical");
      }
      if (candidate.semanticRank !== undefined && (candidate.semanticScore ?? 0) >= 0.35) {
        score += 1 / (60 + candidate.semanticRank);
        sources.push("semantic");
      }
      if (candidate.recentRank !== undefined) {
        score += 1 / (60 + candidate.recentRank);
        sources.push("recent_canonical");
      }
      score /= 2 / 61;
      const lowerBody = row.body.toLocaleLowerCase();
      const lowerTitle = row.title.toLocaleLowerCase();
      if (identifier && lowerBody.includes(normalizedQuery)) score += 0.08;
      if (lowerTitle === normalizedQuery || lowerTitle.includes(normalizedQuery)) score += 0.05;
      if (row.conversation_timestamp) {
        const ageDays = Math.max(0, (now - Date.parse(row.conversation_timestamp)) / 86_400_000);
        score *= 1 + 0.03 * Math.exp(-ageDays / 365);
      }
      return { chunkId: candidate.chunkId, score, sources };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
}

async function lexicalSearch(
  env: SearchEnv,
  query: string,
  generationId: string,
  candidateCount: number,
  namespace?: string,
): Promise<LexicalRow[]> {
  const fts = queryTerms(query);
  if (!fts) return [];
  const namespaceSql = namespace ? "AND c.namespace = ?" : "";
  const params: Array<string | number> = [fts, generationId];
  if (namespace) params.push(namespace);
  params.push(candidateCount);
  const result = await env.MEMORY_DB.prepare(
    `SELECT c.id, c.revision_id, c.conversation_id, c.title, c.body, c.conversation_timestamp,
            c.namespace, bm25(chunk_fts, 3.0, 1.0) AS lexical_score
     FROM chunk_fts
     JOIN chunks c ON c.id = chunk_fts.chunk_id
     JOIN conversations current ON current.id = c.conversation_id
       AND current.current_revision_id = c.revision_id AND current.deleted_at IS NULL
     WHERE chunk_fts MATCH ? AND c.generation_id = ? ${namespaceSql}
     ORDER BY lexical_score LIMIT ?`,
  )
    .bind(...params)
    .all<LexicalRow>();
  return result.results;
}

async function semanticSearch(
  env: SearchEnv,
  query: string,
  generationId: string,
  candidateCount: number,
  namespace?: string,
): Promise<Array<{ chunkId: string; score: number }>> {
  const [embedding] = await embedTexts(env, [query]);
  if (!embedding) return [];
  const filter: VectorizeVectorMetadataFilter = namespace
    ? { generation: { $eq: generationId }, namespace: { $eq: namespace } }
    : { generation: { $eq: generationId } };
  const matches = await env.MEMORY_VECTOR.query(embedding, {
    topK: candidateCount,
    returnMetadata: "all",
    filter,
  });
  return matches.matches.flatMap((match) => {
    const chunkId = match.metadata?.chunk_id;
    return typeof chunkId === "string" ? [{ chunkId, score: match.score }] : [];
  });
}

async function fetchChunkRows(env: SearchEnv, ids: string[]): Promise<Map<string, ChunkRow>> {
  const rows = new Map<string, ChunkRow>();
  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50);
    if (!batch.length) continue;
    const result = await env.MEMORY_DB.prepare(
      `SELECT c.id, c.revision_id, c.conversation_id, c.title, c.body,
              c.conversation_timestamp, c.namespace
       FROM chunks c
       JOIN conversations current ON current.id = c.conversation_id
         AND current.current_revision_id = c.revision_id AND current.deleted_at IS NULL
       WHERE c.id IN (${batch.map(() => "?").join(",")})`,
    )
      .bind(...batch)
      .all<ChunkRow>();
    for (const row of result.results) rows.set(row.id, row);
  }
  return rows;
}

async function recentCanonicalSearch(
  env: SearchEnv,
  query: string,
  generationId: string,
  candidateCount: number,
  namespace?: string,
): Promise<RecentSearchResult> {
  const config = recentConfig(env);
  const cutoff = new Date(Date.now() - config.maxAgeSeconds * 1000).toISOString();
  const namespaceSql = namespace ? "AND current.namespace = ?" : "";
  const params: Array<string | number> = [generationId, cutoff];
  if (namespace) params.push(namespace);
  params.push(config.maxRevisions);
  const candidateRows = await env.MEMORY_DB.prepare(
    `SELECT state.revision_id, revision.conversation_id, state.status, state.queued_at
     FROM chunk_index_state state
     JOIN conversation_revisions revision ON revision.id = state.revision_id
     JOIN conversations current ON current.id = revision.conversation_id
       AND current.current_revision_id = revision.id AND current.deleted_at IS NULL
     WHERE state.generation_id = ?
       AND state.status IN ('queued', 'processing', 'failed')
       AND state.queued_at >= ? ${namespaceSql}
     ORDER BY CASE state.status WHEN 'failed' THEN 1 ELSE 0 END, state.queued_at DESC
     LIMIT ?`,
  )
    .bind(...params)
    .all<RecentRevisionRow>();
  const candidates = candidateRows.results;
  const statusCounts: Record<IndexingStatus, number> = { queued: 0, processing: 0, failed: 0 };
  for (const candidate of candidates) statusCounts[candidate.status] += 1;

  const loads = await Promise.allSettled(
    candidates.map((candidate) => loadCanonicalRevision(env, candidate.revision_id)),
  );
  const matches: RecentMatch[] = [];
  let failedCount = 0;
  let remainingMessages = config.maxMessages;
  for (const [index, loaded] of loads.entries()) {
    if (remainingMessages <= 0) break;
    const candidate = candidates[index];
    if (!candidate || loaded?.status !== "fulfilled") {
      failedCount += 1;
      continue;
    }
    try {
      const eligibleIds = new Set(
        loaded.value.conversation.activeSourceNodeIds.slice(-remainingMessages),
      );
      remainingMessages -= eligibleIds.size;
      const eligibleText = new Map(
        loaded.value.conversation.nodes
          .filter((node) => eligibleIds.has(node.sourceNodeId))
          .map((node) => [node.sourceNodeId, node.text]),
      );
      const chunks = await chunkConversation(
        loaded.value.conversation,
        candidate.revision_id,
        generationId,
      );
      for (const chunk of chunks) {
        if (
          chunk.branchKey !== "active" ||
          !chunk.sources.some((source) => eligibleIds.has(source.sourceNodeId))
        ) {
          continue;
        }
        const scoreText = [
          chunk.title,
          ...new Set(
            chunk.sources.flatMap((source) => {
              const text = eligibleText.get(source.sourceNodeId);
              return text === undefined ? [] : [text];
            }),
          ),
        ].join("\n");
        const score = recentLexicalScore(query, scoreText);
        if (score === null) continue;
        matches.push({
          row: {
            id: chunk.id,
            revision_id: chunk.revisionId,
            conversation_id: chunk.conversationId,
            title: chunk.title,
            body: chunk.body,
            conversation_timestamp: chunk.conversationTimestamp,
            namespace: chunk.namespace,
          },
          score,
          queuedAt: candidate.queued_at,
          ordinal: chunk.ordinal,
        });
      }
    } catch {
      failedCount += 1;
    }
  }

  if (matches.length) {
    const conversationIds = [...new Set(matches.map((match) => match.row.conversation_id))];
    const currentRows = await env.MEMORY_DB.prepare(
      `SELECT id, current_revision_id FROM conversations
       WHERE deleted_at IS NULL AND id IN (${conversationIds.map(() => "?").join(",")})`,
    )
      .bind(...conversationIds)
      .all<{ id: string; current_revision_id: string | null }>();
    const current = new Map(currentRows.results.map((row) => [row.id, row.current_revision_id]));
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index];
      if (!match || current.get(match.row.conversation_id) !== match.row.revision_id) {
        matches.splice(index, 1);
      }
    }
  }

  matches.sort(
    (a, b) =>
      b.score - a.score ||
      b.queuedAt.localeCompare(a.queuedAt) ||
      b.ordinal - a.ordinal ||
      a.row.id.localeCompare(b.row.id),
  );
  return {
    matches: matches.slice(0, candidateCount),
    candidateCount: candidates.length,
    failedCount,
    statusCounts,
  };
}

export async function searchMemory(
  env: SearchEnv,
  input: { query: string; limit: number; namespace?: string },
): Promise<SearchResponse> {
  if (!lexicalTokens(input.query).length) return { results: [], degraded: false, unavailable: [] };
  const limit = Math.min(20, Math.max(1, input.limit));
  const candidateCount = Math.min(50, Math.max(20, limit * 4));
  const generation = env.ACTIVE_INDEX_GENERATION;
  const [lexicalResult, semanticResult, recentResult] = await Promise.allSettled([
    lexicalSearch(env, input.query, generation, candidateCount, input.namespace),
    semanticSearch(env, input.query, generation, candidateCount, input.namespace),
    recentCanonicalSearch(env, input.query, generation, candidateCount, input.namespace),
  ]);
  const unavailable: UnavailableSource[] = [];
  const lexical = lexicalResult.status === "fulfilled" ? lexicalResult.value : [];
  const semantic = semanticResult.status === "fulfilled" ? semanticResult.value : [];
  const recent =
    recentResult.status === "fulfilled"
      ? recentResult.value
      : {
          matches: [],
          candidateCount: 0,
          failedCount: 0,
          statusCounts: { queued: 0, processing: 0, failed: 0 },
        };
  if (lexicalResult.status === "rejected") unavailable.push("fts");
  if (semanticResult.status === "rejected") unavailable.push("semantic");
  if (recentResult.status === "rejected" || recent.failedCount > 0) {
    unavailable.push("recent_canonical");
  }

  const merged = new Map<string, RankedCandidate>();
  lexical.forEach((row, index) => merged.set(row.id, { chunkId: row.id, lexicalRank: index + 1 }));
  semantic.forEach((match, index) => {
    const candidate = merged.get(match.chunkId) ?? { chunkId: match.chunkId };
    candidate.semanticRank = index + 1;
    candidate.semanticScore = match.score;
    merged.set(match.chunkId, candidate);
  });
  recent.matches.forEach((match, index) => {
    const candidate = merged.get(match.row.id) ?? { chunkId: match.row.id };
    candidate.recentRank = index + 1;
    merged.set(match.row.id, candidate);
  });

  const rows = await fetchChunkRows(env, [...merged.keys()]);
  for (const row of lexical) rows.set(row.id, row);
  for (const match of recent.matches)
    if (!rows.has(match.row.id)) rows.set(match.row.id, match.row);
  const ranked = reciprocalRankFusion([...merged.values()], input.query, rows);
  const perConversation = new Map<string, number>();
  const results: SearchResult[] = [];
  for (const item of ranked) {
    const row = rows.get(item.chunkId);
    if (!row) continue;
    const exact = row.body.toLocaleLowerCase().includes(normalizeText(input.query));
    if (item.score < 0.25 && !exact) continue;
    const count = perConversation.get(row.conversation_id) ?? 0;
    if (count >= 2) continue;
    perConversation.set(row.conversation_id, count + 1);
    results.push({
      conversationId: row.conversation_id,
      revisionId: row.revision_id,
      chunkId: row.id,
      title: row.title,
      snippet: row.body.length > 500 ? `${row.body.slice(0, 497)}...` : row.body,
      timestamp: row.conversation_timestamp,
      namespace: row.namespace,
      score: Number(item.score.toFixed(6)),
      sources: item.sources,
    });
    if (results.length >= limit) break;
  }

  if (recent.candidateCount > 0 || unavailable.length > 0) {
    const indexedIds = new Set([
      ...lexical.map((row) => row.id),
      ...semantic.map((match) => match.chunkId),
    ]);
    console.info(
      JSON.stringify({
        message: "memory_search_summary",
        indexed_result_count: [...indexedIds].filter((id) => rows.has(id)).length,
        recent_fallback_candidate_count: recent.candidateCount,
        recent_fallback_match_count: recent.matches.length,
        merged_result_count: results.length,
        indexing_status: recent.statusCounts,
        fallback_used: recent.matches.length > 0,
        unavailable,
      }),
    );
  }
  return { results, degraded: unavailable.length > 0, unavailable };
}
