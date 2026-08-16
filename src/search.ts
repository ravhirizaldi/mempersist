import { z } from "zod";
import { chunkConversation } from "./chunking";
import { embedTexts, type EmbeddingEnv } from "./indexing";
import { normalizeTags, type AppEnv, type SearchResponse, type SearchResult } from "./domain";
import { loadCanonicalRevision, loadConversationTags } from "./storage";

export const RECENT_UNINDEXED_DEFAULTS = {
  maxRevisions: 8,
  maxAgeSeconds: 86_400,
  maxMessages: 200,
} as const;

const RANKING_STRATEGY = "normalized-weighted-v5";

// Structured labels that are usable as precision signals when the query names
// them explicitly (EVENT 16, PHASE 3, CHAPTER 8). Generic markers such as
// CURRENT or NOTES are excluded so bare generic headings cannot dominate.
const STRUCTURED_LABEL_KINDS = new Set([
  "event",
  "phase",
  "chapter",
  "scene",
  "act",
  "level",
  "mission",
]);

// Specificity-aware component scales, relative to existing components:
// exactMatchBoost max 1.0, entityMatchBoost 0.35, tokenOverlapBoost max 0.45,
// tagMatchBoost max 0.25. Heading signals sit below the full-query exact
// signal but above entity and tag credit; partial heading credit scales with
// rare-token coverage so generic headings earn almost nothing.
const HEADING_EXACT_BOOST = 0.6;
const HEADING_PHRASE_BOOST: Record<number, number> = { 2: 0.35, 3: 0.5, 4: 0.6 };
const HEADING_COVERAGE_RATE = 0.4;
const HEADING_MAX_PARTIAL = 0.9;
const STRUCTURED_LABEL_HEADING_BOOST = 0.3;
const STRUCTURED_LABEL_BODY_BOOST = 0.1;
const STRUCTURED_LABEL_MAX = 0.6;
const SPECIFICITY_RATE = 0.5;
const COOCCURRENCE_PER_CONCEPT = 0.05;
const COOCCURRENCE_MAX = 0.25;

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

const OPERATIONAL_CONCEPTS = [
  {
    name: "responsibility",
    phrases: ["pic", "person in charge", "responsible", "responsibility", "owner", "operator"],
  },
  {
    name: "packet-loss",
    phrases: ["packet loss", "lost packet", "dropped packet", "packet drop"],
  },
  {
    name: "network-outage",
    phrases: [
      "wan outage",
      "internet failure",
      "internet outage",
      "connection outage",
      "network failure",
      "network outage",
    ],
  },
  { name: "redundancy", phrases: ["backup", "secondary", "fallback", "standby"] },
  {
    name: "maintenance-window",
    phrases: ["maintenance window", "maintenance schedule", "service window", "service schedule"],
  },
  { name: "network-edge", phrases: ["gateway", "edge gateway", "router", "device", "appliance"] },
  { name: "connection", phrases: ["link", "connection", "connectivity"] },
] as const;

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
  entityMatchBoost: number;
  tokenOverlapBoost: number;
  aliasOverlapBoost: number;
  fieldMatchBoost: number;
  recencyBoost: number;
  tagMatchBoost: number;
  headingMatchBoost: number;
  structuredLabelBoost: number;
  specificityBoost: number;
  coOccurrenceBoost: number;
  finalScore: number;
}

interface TextSignals {
  normalized: string;
  tokens: string[];
  tokenSet: Set<string>;
  concepts: Set<string>;
  aliases: Map<string, Set<string>>;
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
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[‐‑‒–—−-]+/gu, " ")
    .replaceAll(/[^\p{L}\p{N}._:@/\\]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
}

function tokenize(value: string): string[] {
  return (normalizeText(value).match(/[\p{L}\p{N}][\p{L}\p{N}._:@/\\]*/gu) ?? [])
    .map((term) => term.replace(/[._:@/\\]+$/u, ""))
    .filter(Boolean);
}

function stemToken(token: string): string {
  if (token === "people") return "person";
  if (token === "lost") return "loss";
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) {
    const base = token.slice(0, -3);
    return /(.)\1$/u.test(base) ? base.slice(0, -1) : base;
  }
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s") && !/(?:ss|us|is)$/u.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

function containsPhrase(normalized: string, phrase: string): boolean {
  return ` ${normalized} `.includes(` ${phrase} `);
}

function textSignals(value: string): TextSignals {
  const normalized = normalizeText(value);
  const tokens = [...new Set(tokenize(normalized).map(stemToken))];
  const meaningful = tokens.filter((token) => !QUERY_STOP_WORDS.has(token));
  const selected = meaningful.length ? meaningful : tokens;
  const stemmedText = tokenize(normalized).map(stemToken).join(" ");
  const concepts = new Set<string>();
  const aliases = new Map<string, Set<string>>();
  for (const concept of OPERATIONAL_CONCEPTS) {
    const matches = concept.phrases
      .map((phrase) => tokenize(phrase).map(stemToken).join(" "))
      .filter((phrase) => containsPhrase(stemmedText, phrase));
    if (matches.length) {
      concepts.add(concept.name);
      aliases.set(concept.name, new Set(matches));
    }
  }
  return { normalized, tokens: selected, tokenSet: new Set(selected), concepts, aliases };
}

function overlapRatio(values: Iterable<string>, candidates: Set<string>): number {
  const terms = [...values];
  return terms.length ? terms.filter((term) => candidates.has(term)).length / terms.length : 0;
}

function normalizedPhraseCoverage(query: TextSignals, text: TextSignals): number {
  for (let length = Math.min(4, query.tokens.length); length >= 2; length -= 1) {
    for (let start = 0; start <= query.tokens.length - length; start += 1) {
      if (
        containsPhrase(text.tokens.join(" "), query.tokens.slice(start, start + length).join(" "))
      ) {
        return Math.min(1, length / 3);
      }
    }
  }
  return 0;
}

function aliasOverlap(query: TextSignals, text: TextSignals): { count: number; ratio: number } {
  let count = 0;
  for (const concept of query.concepts) {
    const queryAliases = query.aliases.get(concept);
    const textAliases = text.aliases.get(concept);
    if (
      queryAliases &&
      textAliases &&
      [...queryAliases].every((alias) => !textAliases.has(alias))
    ) {
      count += 1;
    }
  }
  return { count, ratio: query.concepts.size ? count / query.concepts.size : 0 };
}

function hasFieldConceptMatch(queryConcepts: Set<string>, text: string): boolean {
  for (const match of text.matchAll(/([\p{L}][\p{L} -]{0,30})\s*:/gu)) {
    const label = match[1];
    if (label && [...queryConcepts].some((concept) => textSignals(label).concepts.has(concept))) {
      return true;
    }
  }
  return false;
}

function rankingSignals(query: string, text: string) {
  const querySignals = textSignals(query);
  const textValue = textSignals(text);
  const tokenOverlap = overlapRatio(querySignals.tokens, textValue.tokenSet);
  const aliases = aliasOverlap(querySignals, textValue);
  const phraseCoverage = normalizedPhraseCoverage(querySignals, textValue);
  return {
    query: querySignals,
    text: textValue,
    tokenOverlap,
    aliasOverlap: aliases.ratio,
    aliasMatches: aliases.count,
    phraseCoverage,
  };
}

function extractLexicalTokens(value: string, limit?: number): string[] {
  const tokens = [...new Set(tokenize(value))];
  return limit === undefined ? tokens : tokens.slice(0, limit);
}

function meaningfulTokens(value: string): string[] {
  return textSignals(value).tokens.slice(0, 12);
}

export function lexicalTokens(value: string): string[] {
  return extractLexicalTokens(value, 12);
}

export function queryTerms(query: string): string {
  const tokens = [...new Set(tokenize(query))].filter((token) => !QUERY_STOP_WORDS.has(token));
  if (!tokens.length) return "";
  const quote = (term: string) => `"${term.replaceAll('"', '""')}"`;
  const terms: string[] = [];
  if (tokens.length >= 2) {
    terms.push(quote(tokens.join(" ")));
  }
  tokens.forEach((token, index) => {
    const quoted = quote(token);
    terms.push(quoted);
    const stemmed = stemToken(token);
    if (stemmed !== token && stemmed.length >= 4) terms.push(`"${stemmed}"*`);
    if (index === tokens.length - 1 && token.length >= 4) terms.push(`${quoted}*`);
  });
  return terms.join(" OR ");
}

export function recentLexicalScore(query: string, text: string): number | null {
  const signals = rankingSignals(query, text);
  if (!signals.query.tokens.length) return null;
  const exact = signals.text.normalized.includes(signals.query.normalized);
  const tokenMatches = signals.query.tokens.filter((term) =>
    signals.text.tokenSet.has(term),
  ).length;
  if (
    !exact &&
    tokenMatches < Math.min(2, signals.query.tokens.length) &&
    signals.aliasMatches === 0
  ) {
    return null;
  }
  if (exact) return 1;
  return Math.min(
    1,
    signals.tokenOverlap * 0.55 + signals.aliasOverlap * 0.3 + signals.phraseCoverage * 0.15,
  );
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

function structuredLabels(value: string): Set<string> {
  const tokens = tokenize(value.replaceAll(/[._:@/\\]+/gu, " "));
  const labels = new Set<string>();
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const kind = tokens[index];
    const number = tokens[index + 1];
    if (kind && number && /^\d+$/u.test(number) && STRUCTURED_LABEL_KINDS.has(kind)) {
      labels.add(`${kind} ${number}`);
    }
  }
  return labels;
}

function headingTexts(row: ChunkRow): string[] {
  const texts = [row.title];
  for (const line of row.body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 2 && trimmed.startsWith("[") && trimmed.endsWith("]")) {
      texts.push(trimmed.slice(1, -1));
      if (texts.length >= 3) break;
    }
  }
  return texts;
}

// Heading comparisons collapse the exact-identifier separators (`. _ : @ / \`)
// that normalizeText deliberately preserves, so "[EVENT 16 / NEW-COUPLE ...]"
// and "EVENT 16 NEW COUPLE ..." compare as the same heading text.
function headingNormalized(value: string): string {
  return normalizeText(value)
    .replaceAll(/[._:@/\\]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function textTokenSet(...values: string[]): Set<string> {
  return new Set(values.flatMap((value) => textSignals(value).tokens));
}

// Candidate-local IDF: a query token present in every candidate earns ~0
// weight, a token unique to one candidate earns ~1. Weights are ratios against
// the per-query total, so the absolute scale cancels out of the boosts.
function queryTokenWeights(tokens: string[], rows: Map<string, ChunkRow>): Map<string, number> {
  const documentCount = rows.size;
  const df = new Map<string, number>();
  for (const row of rows.values()) {
    const rowTokens = textTokenSet(row.title, row.body);
    for (const token of tokens) {
      if (rowTokens.has(token)) df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const weights = new Map<string, number>();
  for (const token of tokens) {
    const docs = df.get(token) ?? 0;
    weights.set(token, Math.log2((documentCount + 0.5) / (docs + 0.5)));
  }
  return weights;
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
  context: { conversationTags?: Map<string, string[]>; requestedTags?: string[] } = {},
): RankedResult[] {
  const normalizedQuery = normalizeText(query);
  const queryTokens = meaningfulTokens(query);
  // Pure-number tokens are excluded from rarity weighting: bare digits are
  // low-information in this domain, and numeric precision is carried by the
  // structured-label and heading-phrase signals instead.
  const rarityTokens = queryTokens.filter((token) => !/^\d+$/u.test(token));
  const tokenWeights = queryTokenWeights(rarityTokens, rows);
  const totalWeight = [...tokenWeights.values()].reduce((sum, weight) => sum + weight, 0);
  const queryLabels = structuredLabels(query);
  const requestedTags = context.requestedTags ?? [];
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
      const signals = rankingSignals(query, text);
      const normalizedText = normalizeText(text);
      const textTokens = new Set(tokenize(text));
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
      const entityMatchBoost = hasExactNamedPhrase(query, text) ? 0.35 : 0;
      const tokenOverlapBoost = signals.tokenOverlap * 0.45;
      const aliasOverlapBoost = signals.aliasOverlap * 0.15;
      const queryConcepts = signals.query.concepts;
      const fieldMatchBoost =
        hasExactNamedPhrase(query, row.title) || hasFieldConceptMatch(queryConcepts, text)
          ? 0.15
          : 0;
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
      const conversationTags = context.conversationTags?.get(row.conversation_id) ?? [];
      const queryTagTokens = new Set(queryTokens);
      const matchedTags = conversationTags.filter(
        (tag) =>
          requestedTags.includes(tag) ||
          meaningfulTokens(tag).some((token) => queryTagTokens.has(token)),
      ).length;
      const tagMatchBoost = Math.min(0.25, matchedTags * 0.1);
      const headings = headingTexts(row);
      const headingTokens = textTokenSet(...headings);
      const headingExact = headings.some((heading) =>
        headingNormalized(heading).includes(headingNormalized(query)),
      );
      const headingPhraseLength = Math.max(
        0,
        ...headings.map((heading) => longestExactPhrase(query, heading)),
      );
      let headingMatchedWeight = 0;
      for (const [token, weight] of tokenWeights) {
        if (headingTokens.has(token)) headingMatchedWeight += weight;
      }
      const headingCoverage = totalWeight > 0 ? headingMatchedWeight / totalWeight : 0;
      const headingPhraseBoost = HEADING_PHRASE_BOOST[Math.min(4, headingPhraseLength)] ?? 0;
      const headingMatchBoost = headingExact
        ? HEADING_EXACT_BOOST
        : Math.min(
            HEADING_MAX_PARTIAL,
            headingPhraseBoost + headingCoverage * HEADING_COVERAGE_RATE,
          );
      const headingLabels = new Set(headings.flatMap((heading) => [...structuredLabels(heading)]));
      const bodyLabels = structuredLabels(row.body);
      let structuredLabelBoost = 0;
      for (const label of queryLabels) {
        if (headingLabels.has(label)) structuredLabelBoost += STRUCTURED_LABEL_HEADING_BOOST;
        else if (bodyLabels.has(label)) structuredLabelBoost += STRUCTURED_LABEL_BODY_BOOST;
      }
      structuredLabelBoost = Math.min(STRUCTURED_LABEL_MAX, structuredLabelBoost);
      const fullTextTokens = textTokenSet(row.title, row.body);
      let specificityWeight = 0;
      let matchedRareConcepts = 0;
      for (const token of rarityTokens) {
        const weight = tokenWeights.get(token) ?? 0;
        if (weight > 0 && fullTextTokens.has(token)) {
          specificityWeight += weight;
          matchedRareConcepts += 1;
        }
      }
      const specificityBoost =
        totalWeight > 0 ? (specificityWeight / totalWeight) * SPECIFICITY_RATE : 0;
      const coOccurrenceBoost = Math.min(
        COOCCURRENCE_MAX,
        Math.max(0, matchedRareConcepts - 1) * COOCCURRENCE_PER_CONCEPT,
      );
      const finalScore =
        sourceConfidence +
        sourceAgreementBoost +
        exactMatchBoost +
        entityMatchBoost +
        tokenOverlapBoost +
        aliasOverlapBoost +
        fieldMatchBoost +
        recencyBoost +
        tagMatchBoost +
        headingMatchBoost +
        structuredLabelBoost +
        specificityBoost +
        coOccurrenceBoost;
      const debug: RankingDebug = {
        strategy: RANKING_STRATEGY,
        lexicalScore,
        semanticScore,
        recentCanonicalScore,
        sourceConfidence,
        sourceAgreementBoost,
        exactMatchBoost,
        entityMatchBoost,
        tokenOverlapBoost,
        aliasOverlapBoost,
        fieldMatchBoost,
        recencyBoost,
        tagMatchBoost,
        headingMatchBoost,
        structuredLabelBoost,
        specificityBoost,
        coOccurrenceBoost,
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
  input: { query: string; limit: number; namespace?: string; tags?: string[] },
): Promise<SearchResponse> {
  if (!lexicalTokens(input.query).length) return { results: [], degraded: false, unavailable: [] };
  const limit = Math.min(20, Math.max(1, input.limit));
  const requestedTags = normalizeTags(input.tags ?? []);
  // Tag-filtered searches expand the pool so the AND predicate does not starve
  // results on narrow tags; the cap keeps Vectorize topK and FTS reads bounded.
  const candidateCount = Math.min(200, Math.max(20, limit * (requestedTags.length ? 8 : 4)));
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
  const conversationTags = await loadConversationTags(env, [
    ...new Set([...rows.values()].map((row) => row.conversation_id)),
  ]);
  let ranked = rankCandidates([...merged.values()], input.query, rows, undefined, {
    conversationTags,
    requestedTags,
  });
  if (requestedTags.length) {
    ranked = ranked.filter((item) => {
      const row = rows.get(item.chunkId);
      if (!row) return false;
      const tags = conversationTags.get(row.conversation_id) ?? [];
      return requestedTags.every((tag) => tags.includes(tag));
    });
  }
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
      tags: conversationTags.get(row.conversation_id) ?? [],
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
