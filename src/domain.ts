export const SOURCE_CHATGPT = "chatgpt";
export const SOURCE_MCP = "mcp";
export const CHUNK_STRATEGY = "chat-turn-v2";
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;

export type AppEnv = Env & { MEMORY_API_TOKEN: string };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function normalizeTags(input: string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input) {
    const tag = raw.normalize("NFKC").toLowerCase().trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export interface CanonicalNode {
  id: string;
  sourceNodeId: string;
  parentSourceNodeId: string | null;
  childSourceNodeIds: string[];
  role: string | null;
  text: string;
  content: JsonValue;
  createdAt: string | null;
  updatedAt: string | null;
  modelSlug: string | null;
  metadata: JsonValue;
  raw: JsonValue;
}

export interface CanonicalConversation {
  id: string;
  sourceType: string;
  sourceId: string | null;
  title: string;
  namespace: string;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
  currentSourceNodeId: string | null;
  activeSourceNodeIds: string[];
  nodes: CanonicalNode[];
  metadata: JsonValue;
  anomalies: string[];
}

export interface CanonicalRevisionManifest {
  format: "mempersist.conversation-revision.v1";
  conversationId: string;
  revisionId: string;
  sourceType: string;
  sourceId: string | null;
  title: string;
  namespace: string;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
  currentSourceNodeId: string | null;
  activeSourceNodeIds: string[];
  nodeCount: number;
  contentHash: string;
  segments: Array<{ id: string; key: string; sha256: string; sizeBytes: number }>;
  metadata: JsonValue;
  anomalies: string[];
}

export interface ChunkSource {
  sourceNodeId: string;
  sourceSequence: number | null;
  charStart: number;
  charEnd: number;
}

export interface SearchChunk {
  id: string;
  vectorId: string;
  revisionId: string;
  conversationId: string;
  generationId: string;
  branchKey: string;
  ordinal: number;
  title: string;
  body: string;
  tokenEstimate: number;
  conversationTimestamp: string | null;
  namespace: string;
  sources: ChunkSource[];
}

export interface SearchResult {
  conversationId: string;
  revisionId: string;
  chunkId: string;
  title: string;
  snippet: string;
  timestamp: string | null;
  namespace: string;
  tags: string[];
  score: number;
  sources: Array<"lexical" | "semantic" | "recent_canonical">;
  debug?: SearchResultDebug;
}

export interface SearchResultDebug {
  finalScore: number;
  lexicalScore: number;
  semanticScore: number;
  recentCanonicalScore: number;
  sourceConfidence: number;
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
  lexicalEvidence: number;
  semanticLift: number;
  semanticVariants: string[];
  sources: SearchResult["sources"];
}

export interface SearchResponse {
  results: SearchResult[];
  degraded: boolean;
  unavailable: Array<"fts" | "semantic" | "recent_canonical">;
}

export interface JobMessage {
  version: 1;
  job_id: string;
}
