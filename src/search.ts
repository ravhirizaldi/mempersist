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

const RANKING_STRATEGY = "normalized-weighted-v1";

const SEMANTIC_MIN_SCORE = 0.35;
const RRF_K = 60;
const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "for",
  "from",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

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
  semanticScore?: number;
  recentScore?: number;
}

interface RankingDebug {
  strategy: typeof RANKING_STRATEGY;
  lexicalScore: number;
  semanticScore: number;
  recentCanonicalScore: number;
  sourceConfidence: number;
  sourceAgreementBoost: number;
  exactMatchBoost: number;
  tokenOverlapBoost: number;
  recencyBoost: number;
  finalScore: number;
}

interface RankedResult {
  chunkId: string;
  score: number;
  sources: SearchSource[];
  debug: RankingDebug;
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

function tokenize(value: string): string[] {
  return (value.match(/[\p{L}\p{N}][\p{L}\p{N}._:@/-]*/gu) ?? [])
    .map((term) => term.replace(/[._:@/-]+$/u, "").toLocaleLowerCase())
    .filter(Boolean);
}

function extractLexicalTokens(value: string, limit?: number): string[] {
  const tokens = [...new Set(tokenize(value))];
  return limit === undefined ? tokens : tokens.slice(0, limit);
}

function meaningfulTokens(value: string): string[] {
  const tokens = lexicalTokens(value);
  const meaningful = tokens.filter((token) => !QUERY_STOP_WORDS.has(token));
  return meaningful.length ? meaningful : tokens;
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
  const queryTokens = meaningfulTokens(query);
  if (!queryTokens.length) return null;
  const normalizedQuery = normalizeText(query);
  const normalizedText = normalizeText(text);
  const exact = normalizedText.includes(normalizedQuery);
  const textTokens = new Set(tokenize(normalizedText));
  const overlap = queryTokens.filter((term) => textTokens.has(term)).length;
  if (!exact && overlap < Math.min(2, queryTokens.length)) return null;
  return exact ? 1 : overlap / queryTokens.length;
}

function longestExactPhrase(query: string, text: string): number {
  const queryTokens = tokenize(query).slice(0, 12);
  const normalizedText = tokenize(text).join(" ");
  for (let length = Math.min(4, queryTokens.length); length >= 2; length -= 1) {
    for (let start = 0; start <= queryTokens.length - length; start += 1) {
      const phrase = queryTokens.slice(start, start + length);
      if (
        phrase.every((token) => !QUERY_STOP_WORDS.has(token)) &&
        normalizedText.includes(phrase.join(" "))
      ) {
        return length;
      }
    }
  }
  return 0;
}

function hasExactNamedPhrase(query: string, text: string): boolean {
  const phrases = query.match(/\p{Lu}[\p{L}\p{N}._:@/-]*(?:\s+\p{Lu}[\p{L}\p{N}._:@/-]*)+/gu) ?? [];
  const normalizedText = tokenize(text).join(" ");
  return phrases.some((phrase) => normalizedText.includes(tokenize(phrase).join(" ")));
}

function normalizedSemanticScore(score: number | undefined): number {
  if (score === undefined || score < SEMANTIC_MIN_SCORE) return 0;
  return 0.5 + 0.5 * Math.min(1, Math.max(0, (score - SEMANTIC_MIN_SCORE) / 0.65));
}

export function rankCandidates(
  candidates: RankedCandidate[],
  query: string,
  rows: Map<string, ChunkRow>,
  now = Date.now(),
): RankedResult[] {
  const normalizedQuery = normalizeText(query);
  const queryTokens = meaningfulTokens(query);
  return candidates
    .map((candidate) => {
      const row = rows.get(candidate.chunkId);
      if (!row) return null;
      const sources: SearchSource[] = [];
      const lexicalScore =
        candidate.lexicalRank === undefined ? 0 : (RRF_K + 1) / (RRF_K + candidate.lexicalRank);
      const semanticScore = normalizedSemanticScore(candidate.semanticScore);
      const recentCanonicalScore = Math.min(1, Math.max(0, candidate.recentScore ?? 0));
      if (candidate.lexicalRank !== undefined) {
        sources.push("lexical");
      }
      if (semanticScore > 0) {
        sources.push("semantic");
      }
      if (candidate.recentScore !== undefined) {
        sources.push("recent_canonical");
      }
      if (!sources.length) return null;
      const text = `${row.title}\n${row.body}`;
      const normalizedText = normalizeText(text);
      const textTokens = new Set(tokenize(text));
      const tokenOverlap = queryTokens.length
        ? queryTokens.filter((token) => textTokens.has(token)).length / queryTokens.length
        : 0;
      const phraseLength = longestExactPhrase(query, text);
      const exactIdentifier = queryTokens.some(
        (token) => /[._:@/\\-]|\d/u.test(token) && textTokens.has(token),
      );
      const exactMatchBoost = normalizedText.includes(normalizedQuery)
        ? 1
        : hasExactNamedPhrase(query, text)
          ? 1
          : phraseLength >= 3
            ? 0.8
            : phraseLength === 2
              ? 0.65
              : exactIdentifier
                ? 0.4
                : 0;
      const tokenOverlapBoost = tokenOverlap * 0.6;
      const sourceConfidence = Math.max(lexicalScore, semanticScore, recentCanonicalScore);
      const sourceAgreementBoost = Math.min(0.1, Math.max(0, sources.length - 1) * 0.05);
      let recencyBoost = 0;
      if (row.conversation_timestamp) {
        const timestamp = Date.parse(row.conversation_timestamp);
        if (Number.isFinite(timestamp)) {
          const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
          recencyBoost = 0.1 * Math.exp(-ageDays / 365);
        }
      }
      const finalScore =
        sourceConfidence +
        sourceAgreementBoost +
        exactMatchBoost +
        tokenOverlapBoost +
        recencyBoost;
      const debug: RankingDebug = {
        strategy: RANKING_STRATEGY,
        lexicalScore,
        semanticScore,
        recentCanonicalScore,
        sourceConfidence,
        sourceAgreementBoost,
        exactMatchBoost,
        tokenOverlapBoost,
        recencyBoost,
        finalScore,
      };
      return {
        chunkId: candidate.chunkId,
        score: finalScore,
        sources,
        debug,
      };
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
  semantic.forEach((match) => {
    const candidate = merged.get(match.chunkId) ?? { chunkId: match.chunkId };
    candidate.semanticScore = match.score;
    merged.set(match.chunkId, candidate);
  });
  recent.matches.forEach((match) => {
    const candidate = merged.get(match.row.id) ?? { chunkId: match.row.id };
    candidate.recentScore = match.score;
    merged.set(match.row.id, candidate);
  });

  const rows = await fetchChunkRows(env, [...merged.keys()]);
  for (const row of lexical) rows.set(row.id, row);
  for (const match of recent.matches)
    if (!rows.has(match.row.id)) rows.set(match.row.id, match.row);
  const ranked = rankCandidates([...merged.values()], input.query, rows);
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
