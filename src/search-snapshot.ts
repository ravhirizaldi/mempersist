import { AppError } from "./errors";
import type {
  SearchResponse,
  SearchResult,
  SearchSnapshotMetadata,
  SearchSnapshotOmitted,
} from "./domain";
import {
  SEARCH_CURSOR_MAX_CHARS,
  SEARCH_RANKING_VERSION,
  SEARCH_SNAPSHOT_CANDIDATE_CAP,
  SEARCH_SNAPSHOT_TTL_MS,
} from "./limits";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY_OMITTED: SearchSnapshotOmitted = { stale: 0, deleted: 0, ownership: 0, unknown: 0 };

export interface SearchSnapshotCandidate {
  chunk_id: string;
  conversation_id: string;
  revision_id: string;
  result: SearchResult;
}

export interface SearchSnapshotRecord {
  id: string;
  userId: string;
  namespaces: string[];
  tags: string[];
  tagMode: "any" | "all";
  queryHash: string;
  rankingVersion: string;
  candidateCap: number;
  candidates: SearchSnapshotCandidate[];
  unavailable: SearchResponse["unavailable"];
  degraded: boolean;
  position: number;
  createdAt: string;
  expiresAt: string;
}

export type SearchSnapshotEnv = Pick<Env, "MEMORY_DB"> & { MEMORY_API_TOKEN: string };

interface CursorPayload {
  v: 1;
  s: string;
  e: number;
}

function invalidCursor(): never {
  throw new AppError("VALIDATION", "Invalid search cursor", 400);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) invalidCursor();
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    invalidCursor();
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret)
    throw new AppError("VALIDATION", "Search cursor signing requires MEMORY_API_TOKEN", 400);
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function cursorBody(payload: CursorPayload): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(payload)));
}

function isSearchSource(value: unknown): value is SearchResult["sources"][number] {
  return value === "lexical" || value === "semantic" || value === "recent_canonical";
}

function isSearchResultDebug(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const debug = value as Record<string, unknown>;
  const numericKeys = [
    "finalScore",
    "lexicalScore",
    "semanticScore",
    "recentCanonicalScore",
    "sourceConfidence",
    "exactMatchBoost",
    "entityMatchBoost",
    "tokenOverlapBoost",
    "aliasOverlapBoost",
    "fieldMatchBoost",
    "recencyBoost",
    "tagMatchBoost",
    "headingMatchBoost",
    "structuredLabelBoost",
    "specificityBoost",
    "coOccurrenceBoost",
    "lexicalEvidence",
    "semanticLift",
  ];
  return (
    numericKeys.every((key) => {
      const number = debug[key];
      return typeof number === "number" && Number.isFinite(number);
    }) &&
    isStringArray(debug.semanticVariants) &&
    Array.isArray(debug.sources) &&
    debug.sources.every(isSearchSource)
  );
}
function isSearchSnapshotResult(value: unknown): value is SearchResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.conversationId === "string" &&
    typeof result.revisionId === "string" &&
    typeof result.chunkId === "string" &&
    typeof result.title === "string" &&
    typeof result.snippet === "string" &&
    (typeof result.timestamp === "string" || result.timestamp === null) &&
    typeof result.namespace === "string" &&
    isStringArray(result.tags) &&
    typeof result.score === "number" &&
    Number.isFinite(result.score) &&
    Array.isArray(result.sources) &&
    result.sources.every(isSearchSource) &&
    (result.debug === undefined || isSearchResultDebug(result.debug))
  );
}

function isSearchSnapshotCandidate(value: unknown): value is SearchSnapshotCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.chunk_id === "string" &&
    typeof candidate.conversation_id === "string" &&
    typeof candidate.revision_id === "string" &&
    isSearchSnapshotResult(candidate.result)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isUnavailableArray(value: unknown): value is SearchResponse["unavailable"] {
  return (
    Array.isArray(value) &&
    value.every((item) => item === "fts" || item === "semantic" || item === "recent_canonical")
  );
}
function isCandidateArray(value: unknown): value is SearchSnapshotCandidate[] {
  return (
    Array.isArray(value) &&
    value.length <= SEARCH_SNAPSHOT_CANDIDATE_CAP &&
    value.every(isSearchSnapshotCandidate)
  );
}

function parseRecord(row: Record<string, unknown>): SearchSnapshotRecord {
  const position = row.position;
  if (
    typeof row.id !== "string" ||
    typeof row.user_id !== "string" ||
    typeof row.namespaces_json !== "string" ||
    typeof row.tags_json !== "string" ||
    (row.tag_mode !== "any" && row.tag_mode !== "all") ||
    typeof row.query_hash !== "string" ||
    typeof row.ranking_version !== "string" ||
    row.ranking_version !== SEARCH_RANKING_VERSION ||
    typeof row.candidate_cap !== "number" ||
    row.candidate_cap !== SEARCH_SNAPSHOT_CANDIDATE_CAP ||
    typeof position !== "number" ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    typeof row.candidates_json !== "string" ||
    typeof row.unavailable_json !== "string" ||
    (row.degraded !== 0 && row.degraded !== 1) ||
    typeof row.created_at !== "string" ||
    typeof row.expires_at !== "string"
  )
    invalidCursor();
  let namespaces: unknown;
  let tags: unknown;
  let candidates: unknown;
  let unavailable: unknown;
  try {
    namespaces = JSON.parse(row.namespaces_json);
    tags = JSON.parse(row.tags_json);
    candidates = JSON.parse(row.candidates_json);
    unavailable = JSON.parse(row.unavailable_json);
  } catch {
    invalidCursor();
  }
  if (
    !isStringArray(namespaces) ||
    !isStringArray(tags) ||
    !isCandidateArray(candidates) ||
    !isUnavailableArray(unavailable)
  )
    invalidCursor();
  if (position > candidates.length) invalidCursor();
  return {
    id: row.id,
    userId: row.user_id,
    namespaces,
    tags,
    tagMode: row.tag_mode,
    queryHash: row.query_hash,
    rankingVersion: row.ranking_version,
    candidateCap: row.candidate_cap,
    candidates,
    unavailable,
    degraded: row.degraded === 1,
    position,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function hashSearchQuery(query: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(query));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeSearchNamespaces(namespaces?: string[]): string[] {
  return [...new Set((namespaces ?? []).filter((namespace) => namespace.length > 0))].sort();
}

export async function createSearchSnapshot(
  env: SearchSnapshotEnv,
  input: {
    userId: string;
    namespaces: string[];
    tags: string[];
    tagMode: "any" | "all";
    queryHash: string;
    candidates: SearchSnapshotCandidate[];
    unavailable: SearchResponse["unavailable"];
    degraded: boolean;
    now?: Date;
  },
): Promise<{ record: SearchSnapshotRecord; cursor: string }> {
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.valueOf() + SEARCH_SNAPSHOT_TTL_MS).toISOString();
  const id = crypto.randomUUID();
  const candidates = input.candidates.slice(0, SEARCH_SNAPSHOT_CANDIDATE_CAP);
  const record: SearchSnapshotRecord = {
    id,
    userId: input.userId,
    namespaces: normalizeSearchNamespaces(input.namespaces),
    tags: input.tags,
    tagMode: input.tagMode,
    queryHash: input.queryHash,
    rankingVersion: SEARCH_RANKING_VERSION,
    candidateCap: SEARCH_SNAPSHOT_CANDIDATE_CAP,
    candidates,
    unavailable: input.unavailable,
    degraded: input.degraded,
    position: 0,
    createdAt,
    expiresAt,
  };
  await env.MEMORY_DB.prepare("DELETE FROM search_snapshots WHERE expires_at <= ?")
    .bind(createdAt)
    .run();
  await env.MEMORY_DB.prepare(
    `INSERT INTO search_snapshots
     (id, user_id, namespaces_json, tags_json, tag_mode, query_hash, ranking_version,
      candidate_cap, candidates_json, unavailable_json, degraded, position, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      record.id,
      record.userId,
      JSON.stringify(record.namespaces),
      JSON.stringify(record.tags),
      record.tagMode,
      record.queryHash,
      record.rankingVersion,
      record.candidateCap,
      JSON.stringify(record.candidates),
      JSON.stringify(record.unavailable),
      record.degraded ? 1 : 0,
      record.position,
      record.createdAt,
      record.expiresAt,
    )
    .run();
  return {
    record,
    cursor: await signSearchSnapshotCursor(env, record, record.userId),
  };
}

export async function signSearchSnapshotCursor(
  env: SearchSnapshotEnv,
  record: SearchSnapshotRecord,
  userId: string,
): Promise<string> {
  const body = cursorBody({ v: 1, s: record.id, e: Date.parse(record.expiresAt) });
  const key = await hmacKey(env.MEMORY_API_TOKEN);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${userId}.${body}`)),
  );
  return `${body}.${base64UrlEncode(signature)}`;
}

export async function loadSearchSnapshot(
  env: SearchSnapshotEnv,
  cursor: string,
  userId: string,
): Promise<SearchSnapshotRecord> {
  if (typeof cursor !== "string" || cursor.length < 16 || cursor.length > SEARCH_CURSOR_MAX_CHARS)
    invalidCursor();
  const separator = cursor.lastIndexOf(".");
  if (separator <= 0 || separator === cursor.length - 1) invalidCursor();
  const body = cursor.slice(0, separator);
  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(cursor.slice(separator + 1));
  } catch {
    invalidCursor();
  }
  if (signature.byteLength !== 32) invalidCursor();
  const key = await hmacKey(env.MEMORY_API_TOKEN);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature.slice().buffer,
      encoder.encode(`${userId}.${body}`),
    );
  } catch {
    invalidCursor();
  }
  if (!valid) invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(decoder.decode(base64UrlDecode(body))) as unknown;
  } catch {
    invalidCursor();
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded) ||
    (decoded as { v?: unknown }).v !== 1 ||
    typeof (decoded as { s?: unknown }).s !== "string" ||
    !/^[0-9a-f-]{20,80}$/u.test((decoded as { s: string }).s) ||
    typeof (decoded as { e?: unknown }).e !== "number" ||
    !Number.isSafeInteger((decoded as { e: number }).e) ||
    (decoded as { e: number }).e <= Date.now() ||
    (decoded as { e: number }).e > Date.now() + SEARCH_SNAPSHOT_TTL_MS + 60_000
  )
    invalidCursor();
  const now = new Date().toISOString();
  await env.MEMORY_DB.prepare("DELETE FROM search_snapshots WHERE expires_at <= ?").bind(now).run();
  const row = await env.MEMORY_DB.prepare(
    "SELECT * FROM search_snapshots WHERE id = ? AND user_id = ? AND expires_at > ?",
  )
    .bind((decoded as { s: string }).s, userId, now)
    .first<Record<string, unknown>>();
  if (!row) invalidCursor();
  const record = parseRecord(row);
  if (
    record.rankingVersion !== SEARCH_RANKING_VERSION ||
    record.id !== (decoded as { s: string }).s ||
    record.userId !== userId ||
    record.expiresAt !== new Date((decoded as { e: number }).e).toISOString()
  )
    invalidCursor();
  return record;
}

export async function updateSearchSnapshotPosition(
  env: SearchSnapshotEnv,
  id: string,
  expectedPosition: number,
  position: number,
): Promise<void> {
  const result = await env.MEMORY_DB.prepare(
    "UPDATE search_snapshots SET position = ? WHERE id = ? AND position = ? AND expires_at > ?",
  )
    .bind(position, id, expectedPosition, new Date().toISOString())
    .run();
  if (result.meta.changes !== 1) {
    throw new AppError(
      "RETRYABLE_INFRASTRUCTURE",
      "Search snapshot changed; retry the cursor",
      409,
      true,
    );
  }
}

export function snapshotMetadata(
  record: SearchSnapshotRecord,
  omitted: SearchSnapshotOmitted = EMPTY_OMITTED,
): SearchSnapshotMetadata {
  return {
    ranking_version: record.rankingVersion,
    candidate_count: record.candidates.length,
    candidate_cap: record.candidateCap,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    omitted: { ...omitted },
  };
}
