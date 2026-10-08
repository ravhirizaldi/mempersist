import type { AppEnv, CanonicalConversation, CanonicalNode } from "./domain";
import { isValidMessageKey } from "./domain";
import { AppError } from "./errors";
import {
  BATCH_DEFAULT_SERIALIZED_BYTES,
  BATCH_MAX_SERIALIZED_BYTES,
  BATCH_MIN_SERIALIZED_BYTES,
  COMPACT_RESPONSE_BYTES,
  MAX_EXACT_MESSAGE_CURSOR_CHARS,
  MAX_EXACT_MESSAGE_REQUESTS,
  MAX_MESSAGE_KEY_CHARS,
  MAX_EXACT_SOURCE_NODE_ID_CHARS,
} from "./limits";
import { loadCanonicalRevision, loadConversationTags } from "./storage";

interface ChunkSourceRow {
  revision_id: string;
  branch_key: string;
  source_node_id: string;
  source_sequence: number | null;
  char_start: number;
  char_end: number;
  ordinal: number;
}

// Deterministic pointer-neighborhood expansion for chunk sources. Reconstructs
// the exact linear branch path (either the active branch timeline or the
// alternate branch path from root down to its leaf), then slices by message count
// around the matched chunk sources. Sibling branches are never included in after expansion.
export function expandPointerNeighborhood(
  conversation: CanonicalConversation,
  sourceNodeIds: string[],
  before: number,
  after: number,
  branchKey?: string,
): CanonicalNode[] {
  const byId = new Map(conversation.nodes.map((node) => [node.sourceNodeId, node]));
  let branchNodes: CanonicalNode[] | null = null;

  if (branchKey === "active") {
    branchNodes = (conversation.activeSourceNodeIds ?? [])
      .map((id) => byId.get(id))
      .filter((node): node is CanonicalNode => node !== undefined && node.text.length > 0);
  } else if (branchKey && branchKey.startsWith("alternate:")) {
    const leafId = branchKey.slice("alternate:".length);
    const leaf = byId.get(leafId);
    if (leaf) {
      const reversed: CanonicalNode[] = [];
      const seen = new Set<string>();
      let cursor: CanonicalNode | undefined = leaf;
      while (cursor && !seen.has(cursor.sourceNodeId)) {
        seen.add(cursor.sourceNodeId);
        reversed.push(cursor);
        cursor = cursor.parentSourceNodeId ? byId.get(cursor.parentSourceNodeId) : undefined;
      }
      branchNodes = reversed.reverse().filter((node) => node.text.length > 0);
    }
  }

  if (!branchNodes) {
    const seed = sourceNodeIds
      .map((id) => byId.get(id))
      .find((node): node is CanonicalNode => node !== undefined);
    if (seed) {
      const reversed: CanonicalNode[] = [];
      const seen = new Set<string>();
      let cursor: CanonicalNode | undefined = seed;
      while (cursor && !seen.has(cursor.sourceNodeId)) {
        seen.add(cursor.sourceNodeId);
        reversed.push(cursor);
        cursor = cursor.parentSourceNodeId ? byId.get(cursor.parentSourceNodeId) : undefined;
      }
      const ancestors = reversed.reverse();
      const descendants: CanonicalNode[] = [];
      let downCursor = seed.childSourceNodeIds[0]
        ? byId.get(seed.childSourceNodeIds[0])
        : undefined;
      while (downCursor && !seen.has(downCursor.sourceNodeId)) {
        seen.add(downCursor.sourceNodeId);
        descendants.push(downCursor);
        downCursor = downCursor.childSourceNodeIds[0]
          ? byId.get(downCursor.childSourceNodeIds[0])
          : undefined;
      }
      branchNodes = [...ancestors, ...descendants].filter((node) => node.text.length > 0);
    } else {
      branchNodes = conversation.nodes.filter((node) => node.text.length > 0);
    }
  }

  const indices = sourceNodeIds
    .map((id) => branchNodes.findIndex((node) => node.sourceNodeId === id))
    .filter((idx) => idx >= 0);

  if (indices.length === 0) {
    return [];
  }

  const beforeSteps = Math.min(10, Math.max(0, Math.floor(before)));
  const afterSteps = Math.min(10, Math.max(0, Math.floor(after)));
  const start = Math.max(0, Math.min(...indices) - beforeSteps);
  const end = Math.min(branchNodes.length, Math.max(...indices) + afterSteps + 1);
  return branchNodes.slice(start, end);
}
export async function getChunkContext(
  env: AppEnv,
  chunkId: string,
  before = 2,
  after = 2,
  expectedNamespaces?: string[],
  expectedUserId?: string,
  format: "canonical" | "compact" = "canonical",
) {
  const namespaceSql = expectedNamespaces?.length
    ? ` AND c.namespace IN (${expectedNamespaces.map(() => "?").join(",")})`
    : "";
  const userIdSql = expectedUserId ? " AND cv.user_id = ?" : "";
  const result = await env.MEMORY_DB.prepare(
    `SELECT c.revision_id, c.branch_key, s.source_node_id, s.source_sequence, s.char_start, s.char_end, s.ordinal
     FROM chunks c JOIN chunk_sources s ON s.chunk_id = c.id
     JOIN conversations cv ON cv.id = c.conversation_id
     WHERE c.id = ?${namespaceSql}${userIdSql} ORDER BY s.ordinal`,
  )
    .bind(chunkId, ...(expectedNamespaces ?? []), ...(expectedUserId ? [expectedUserId] : []))
    .all<ChunkSourceRow>();
  const first = result.results[0];
  if (!first) throw new AppError("NOT_FOUND", "Chunk not found", 404);
  const loaded = await loadCanonicalRevision(env, first.revision_id);
  const byId = new Map(loaded.conversation.nodes.map((node) => [node.sourceNodeId, node]));
  const active = loaded.conversation.activeSourceNodeIds;
  const activeSequences = result.results.flatMap((source) =>
    source.source_sequence === null ? [] : [source.source_sequence],
  );
  let messages: CanonicalNode[];
  if (
    first.branch_key === "active" &&
    activeSequences.length === result.results.length &&
    activeSequences.length > 0
  ) {
    const start = Math.max(0, Math.min(...activeSequences) - Math.min(10, Math.max(0, before)));
    const end = Math.min(
      active.length,
      Math.max(...activeSequences) + Math.min(10, Math.max(0, after)) + 1,
    );
    messages = active.slice(start, end).flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  } else {
    messages = expandPointerNeighborhood(
      loaded.conversation,
      result.results.map((source) => source.source_node_id),
      before,
      after,
      first.branch_key,
    );
  }
  return {
    chunkId,
    revisionId: first.revision_id,
    ...(format === "compact"
      ? {
          conversation: compactMetadata(
            loaded.conversation,
            first.revision_id,
            (await loadConversationTags(env, [loaded.conversation.id])).get(
              loaded.conversation.id,
            ) ?? [],
          ),
        }
      : {}),
    messages: format === "compact" ? messages.map(compactMessage) : messages,
    matchedRanges: result.results.map((source) => ({
      sourceNodeId: source.source_node_id,
      charStart: source.char_start,
      charEnd: source.char_end,
    })),
  };
}

export async function getConversationPage(
  env: AppEnv,
  conversationId: string,
  offset: number,
  limit: number,
  branch: "active" | "all" = "active",
  expectedNamespaces?: string[],
  expectedUserId?: string,
  revisionId?: string,
) {
  const row = await env.MEMORY_DB.prepare(
    `SELECT current_revision_id, namespace, user_id FROM conversations
     WHERE id = ? AND deleted_at IS NULL${expectedUserId ? " AND user_id = ?" : ""}`,
  )
    .bind(conversationId, ...(expectedUserId ? [expectedUserId] : []))
    .first<{ current_revision_id: string | null; namespace: string; user_id: string }>();
  if (!row?.current_revision_id) throw new AppError("NOT_FOUND", "Conversation not found", 404);
  if (expectedNamespaces?.length && !expectedNamespaces.includes(row.namespace)) {
    throw new AppError("NOT_FOUND", "Conversation not found", 404);
  }
  if (revisionId) {
    const revision = await env.MEMORY_DB.prepare(
      "SELECT id FROM conversation_revisions WHERE id = ? AND conversation_id = ?",
    )
      .bind(revisionId, conversationId)
      .first();
    if (!revision) throw new AppError("NOT_FOUND", "Revision not found", 404);
  }
  const loaded = await loadCanonicalRevision(env, revisionId ?? row.current_revision_id);
  const tags = (await loadConversationTags(env, [conversationId])).get(conversationId) ?? [];
  return conversationPage(
    loaded.conversation,
    revisionId ?? row.current_revision_id,
    tags,
    offset,
    limit,
    branch,
  );
}

export interface ConversationPage {
  conversation: {
    id: string;
    title: string;
    sourceType: string;
    sourceId: string | null;
    namespace: string;
    tags: string[];
    revisionId: string;
    currentSourceNodeId: string | null;
    anomalies: string[];
  };
  messages: CanonicalNode[];
  nextOffset: number | null;
  total: number;
}

export function conversationPage(
  conversation: CanonicalConversation,
  revisionId: string,
  tags: string[],
  offset: number,
  limit: number,
  branch: "active" | "all" = "active",
): ConversationPage {
  const byId = new Map(conversation.nodes.map((node) => [node.sourceNodeId, node]));
  const nodes =
    branch === "active"
      ? conversation.activeSourceNodeIds.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []))
      : conversation.nodes;
  const boundedOffset = Math.max(0, offset);
  const boundedLimit = Math.min(100, Math.max(1, limit));
  return {
    conversation: {
      id: conversation.id,
      title: conversation.title,
      sourceType: conversation.sourceType,
      sourceId: conversation.sourceId,
      namespace: conversation.namespace,
      tags,
      revisionId,
      currentSourceNodeId: conversation.currentSourceNodeId,
      anomalies: conversation.anomalies,
    },
    messages: nodes.slice(boundedOffset, boundedOffset + boundedLimit),
    nextOffset: boundedOffset + boundedLimit < nodes.length ? boundedOffset + boundedLimit : null,
    total: nodes.length,
  };
}

export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export interface CompactMessage {
  sourceNodeId: string;
  messageKey?: string;
  role: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  text: string;
}

export interface OversizedMessageDiagnostic {
  conversationId: string;
  revisionId: string;
  offset: number;
  sourceNodeId: string;
  bytes: number;
}

export interface CompactPage {
  conversation: {
    id: string;
    revisionId: string;
    title: string;
    namespace: string;
    tags: string[];
  };
  messages: CompactMessage[];
  offset: number;
  nextOffset: number | null;
  total: number;
  oversizedMessage: OversizedMessageDiagnostic | null;
}

function compactMessage({
  sourceNodeId,
  messageKey,
  role,
  createdAt,
  updatedAt,
  text,
}: CanonicalNode): CompactMessage {
  return {
    sourceNodeId,
    ...(messageKey === undefined ? {} : { messageKey }),
    role,
    createdAt,
    updatedAt,
    text,
  };
}

function compactMetadata(
  conversation: { id: string; title: string; namespace: string },
  revisionId: string,
  tags: string[],
): CompactPage["conversation"] {
  return {
    id: conversation.id,
    revisionId,
    title: conversation.title,
    namespace: conversation.namespace,
    tags,
  };
}

export function compactConversationPage(page: ConversationPage, offset: number): CompactPage {
  return {
    conversation: compactMetadata(
      page.conversation,
      page.conversation.revisionId,
      page.conversation.tags,
    ),
    messages: page.messages.map(compactMessage),
    offset,
    nextOffset: page.nextOffset,
    total: page.total,
    oversizedMessage: null,
  };
}

// Drop whole messages only. The omitted message remains at nextOffset.
export function boundCompactPage(
  page: CompactPage,
  maxBytes = COMPACT_RESPONSE_BYTES,
): CompactPage {
  const result: CompactPage = { ...page, messages: [] };
  for (const message of page.messages) {
    result.messages.push(message);
    result.nextOffset =
      page.offset + result.messages.length < page.total
        ? page.offset + result.messages.length
        : null;
    if (jsonBytes(result) > maxBytes) {
      result.messages.pop();
      result.nextOffset = page.offset + result.messages.length;
      break;
    }
  }
  const first = page.messages[0];
  if (first && !result.messages.length) {
    result.oversizedMessage = {
      conversationId: page.conversation.id,
      revisionId: page.conversation.revisionId,
      offset: page.offset,
      sourceNodeId: first.sourceNodeId,
      bytes: jsonBytes(first),
    };
  }
  return result;
}

export interface ConversationRequest {
  conversation_id: string;
  offset: number;
  limit: number;
  branch: "active" | "all";
  revision_id?: string | undefined;
}

export interface ConversationBatchInput {
  requests?: ConversationRequest[];
  cursor?: string;
  maxSerializedBytes?: number;
  max_serialized_bytes?: number;
}

type BatchItemError = { code: string; message: string };

export interface ConversationBatchEntry {
  requestIndex: number;
  status: "ok" | "error" | "deferred";
  continuation: ConversationRequest | null;
  page?: CompactPage;
  error?: BatchItemError;
}

export interface ConversationBatchResult {
  batchId: string;
  results: ConversationBatchEntry[];
  completed: number;
  remaining: number;
  nextCursor: string | null;
  usedSerializedBytes: number;
  maxSerializedBytes: number;
}

type BatchEntry = ConversationBatchEntry;

type BatchStateKind = "pending" | "done" | "error";
type BatchState = {
  requestIndex: number;
  conversationId: string;
  revisionId?: string;
  branch: "active" | "all";
  limit: number;
  offset: number;
  kind: BatchStateKind;
  error?: BatchItemError;
  touched: boolean;
  loaded?: {
    page: CompactPage;
    candidates: CompactPage["messages"];
    total: number;
  };
  oversized?: OversizedMessageDiagnostic;
  compatibilityOffset?: number;
};

type BatchCursorState = {
  i: number;
  c: string;
  r?: string;
  b: "active" | "all";
  l: number;
  o?: number;
  k: BatchStateKind;
  e?: string;
};

type BatchCursorTuple = [
  i: number,
  c: string,
  r: string,
  b: 0 | 1,
  l: number,
  o: number,
  k: 0 | 1 | 2,
  e: string,
];

type BatchCursorPayload = {
  v: 1;
  s: 1;
  e: number;
  b: string;
  f: number;
  q: BatchCursorState[];
};

const BATCH_CURSOR_TTL_MS = 15 * 60 * 1000;
const BATCH_CURSOR_MAX_LENGTH = 16 * 1024;
const BATCH_CURSOR_ERROR_CODES: Record<string, true> = {
  NOT_FOUND: true,
  CANONICAL_STORAGE: true,
  RESPONSE_TOO_LARGE: true,
};
const textEncoder = new TextEncoder();

function itemError(error: unknown): BatchItemError {
  if (error instanceof AppError && error.code === "NOT_FOUND") {
    return { code: "NOT_FOUND", message: "Conversation or revision not found" };
  }
  return { code: "CANONICAL_STORAGE", message: "Canonical read failed" };
}

function invalidBatchCursor(): never {
  throw new AppError("VALIDATION", "Invalid batch cursor", 400);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) invalidBatchCursor();
  const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    invalidBatchCursor();
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeCursorId(value: string): string {
  const uuid = value.match(
    /^([a-f0-9]{8})-([a-f0-9]{4})-([a-f0-9]{4})-([a-f0-9]{4})-([a-f0-9]{12})$/u,
  );
  if (uuid) {
    const hex = uuid.slice(1).join("");
    return `u${base64UrlEncode(Uint8Array.from(hex.match(/../gu)!, (pair) => parseInt(pair, 16)))}`;
  }
  if (/^[a-f0-9]{64}$/u.test(value)) {
    return `h${base64UrlEncode(Uint8Array.from(value.match(/../gu)!, (pair) => parseInt(pair, 16)))}`;
  }
  return `s${base64UrlEncode(textEncoder.encode(value))}`;
}

function decodeCursorId(value: unknown): string {
  if (typeof value !== "string" || value.length < 2) invalidBatchCursor();
  const bytes = base64UrlDecode(value.slice(1));
  if (value[0] === "u" && bytes.byteLength === 16) {
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  if (value[0] === "h" && bytes.byteLength === 32) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  if (value[0] === "s") {
    return new TextDecoder().decode(bytes);
  }
  invalidBatchCursor();
}

async function cursorKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function cursorBinding(expectedUserId: string, expectedNamespaces: string[]): string {
  return `${expectedUserId}\u0000${[...new Set(expectedNamespaces)].sort().join("\u0001")}`;
}

function cursorTupleForState(state: BatchCursorState): BatchCursorTuple {
  return [
    state.i,
    encodeCursorId(state.c),
    state.r ? encodeCursorId(state.r) : "",
    state.b === "active" ? 0 : 1,
    state.l,
    state.k === "pending" ? (state.o ?? 0) : -1,
    state.k === "pending" ? 0 : state.k === "done" ? 1 : 2,
    state.k === "error" ? (state.e ?? "CANONICAL_STORAGE") : "",
  ];
}

function cursorBody(payload: BatchCursorPayload): string {
  const wire = { ...payload, q: payload.q.map(cursorTupleForState) };
  return base64UrlEncode(textEncoder.encode(JSON.stringify(wire)));
}

async function signBatchCursor(
  payload: BatchCursorPayload,
  secret: string,
  expectedUserId: string,
  expectedNamespaces: string[],
): Promise<string> {
  if (!secret) invalidBatchCursor();
  const body = cursorBody(payload);
  const key = await cursorKey(secret);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      textEncoder.encode(`${cursorBinding(expectedUserId, expectedNamespaces)}.${body}`),
    ),
  );
  return `${body}.${base64UrlEncode(signature)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function validateCursorState(value: unknown, expectedIndex: number): BatchCursorState {
  if (!Array.isArray(value) || value.length !== 8) invalidBatchCursor();
  const [index, encodedConversationId, encodedRevisionId, branch, limit, offset, kind, errorCode] =
    value as [unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown];
  if (
    index !== expectedIndex ||
    !isSafeInteger(index) ||
    typeof encodedConversationId !== "string" ||
    typeof encodedRevisionId !== "string" ||
    (branch !== 0 && branch !== 1) ||
    !isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !isSafeInteger(offset) ||
    (kind !== 0 && kind !== 1 && kind !== 2) ||
    typeof errorCode !== "string"
  ) {
    invalidBatchCursor();
  }
  const conversationId = decodeCursorId(encodedConversationId);
  const revisionId = encodedRevisionId ? decodeCursorId(encodedRevisionId) : undefined;
  const stateKind: BatchStateKind = kind === 0 ? "pending" : kind === 1 ? "done" : "error";
  if (stateKind === "pending" && (!revisionId || offset < 0)) invalidBatchCursor();
  if (stateKind !== "pending" && offset !== -1) invalidBatchCursor();
  if (stateKind === "error" && !BATCH_CURSOR_ERROR_CODES[errorCode]) invalidBatchCursor();
  if (stateKind !== "error" && errorCode !== "") invalidBatchCursor();
  return {
    i: index,
    c: conversationId,
    ...(revisionId ? { r: revisionId } : {}),
    b: branch === 0 ? "active" : "all",
    l: limit,
    ...(stateKind === "pending" ? { o: offset } : {}),
    k: stateKind,
    ...(stateKind === "error" ? { e: errorCode } : {}),
  };
}

async function decodeBatchCursor(
  cursor: string,
  secret: string,
  expectedUserId: string,
  expectedNamespaces: string[],
): Promise<BatchCursorPayload> {
  if (
    !secret ||
    typeof cursor !== "string" ||
    cursor.length < 16 ||
    cursor.length > BATCH_CURSOR_MAX_LENGTH
  ) {
    invalidBatchCursor();
  }
  const separator = cursor.lastIndexOf(".");
  if (separator <= 0 || separator === cursor.length - 1) invalidBatchCursor();
  const body = cursor.slice(0, separator);
  const encodedSignature = cursor.slice(separator + 1);
  const signature = base64UrlDecode(encodedSignature);
  if (signature.byteLength !== 32) invalidBatchCursor();
  const key = await cursorKey(secret);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature.slice().buffer,
      textEncoder.encode(`${cursorBinding(expectedUserId, expectedNamespaces)}.${body}`),
    );
  } catch {
    invalidBatchCursor();
  }
  if (!valid) invalidBatchCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as unknown;
  } catch {
    invalidBatchCursor();
  }
  if (!isRecord(decoded)) invalidBatchCursor();
  if (
    decoded.v !== 1 ||
    decoded.s !== 1 ||
    typeof decoded.e !== "number" ||
    !Number.isSafeInteger(decoded.e) ||
    decoded.e <= Date.now() ||
    decoded.e > Date.now() + BATCH_CURSOR_TTL_MS + 60_000 ||
    typeof decoded.b !== "string" ||
    decoded.b.length < 1 ||
    decoded.b.length > 64 ||
    typeof decoded.f !== "number" ||
    !Number.isSafeInteger(decoded.f) ||
    !Array.isArray(decoded.q) ||
    decoded.q.length < 1 ||
    decoded.q.length > 20
  ) {
    invalidBatchCursor();
  }
  const states = decoded.q.map((state, index) => validateCursorState(state, index));
  if (decoded.f < 0 || decoded.f >= states.length) invalidBatchCursor();
  return { v: 1, s: 1, e: decoded.e, b: decoded.b, f: decoded.f, q: states };
}

function normalizeBatchBudget(value: unknown, legacy: boolean): number {
  const budget =
    value === undefined
      ? legacy
        ? COMPACT_RESPONSE_BYTES
        : BATCH_DEFAULT_SERIALIZED_BYTES
      : value;
  if (
    !isSafeInteger(budget) ||
    budget < (legacy ? 1 : BATCH_MIN_SERIALIZED_BYTES) ||
    budget > BATCH_MAX_SERIALIZED_BYTES
  ) {
    throw new AppError(
      "VALIDATION",
      `max_serialized_bytes must be between ${legacy ? 1 : BATCH_MIN_SERIALIZED_BYTES} and ${BATCH_MAX_SERIALIZED_BYTES}`,
      400,
    );
  }
  return budget;
}

function normalizeRequest(request: ConversationRequest): ConversationRequest {
  return {
    conversation_id: request.conversation_id,
    offset: request.offset ?? 0,
    limit: request.limit ?? 20,
    branch: request.branch ?? "active",
    ...(request.revision_id ? { revision_id: request.revision_id } : {}),
  };
}

function validateRequest(request: ConversationRequest): void {
  if (
    typeof request.conversation_id !== "string" ||
    request.conversation_id.length < 1 ||
    request.conversation_id.length > 128 ||
    !isSafeInteger(request.offset) ||
    request.offset < 0 ||
    !isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 100 ||
    (request.branch !== "active" && request.branch !== "all") ||
    (request.revision_id !== undefined &&
      (typeof request.revision_id !== "string" ||
        request.revision_id.length < 1 ||
        request.revision_id.length > 128))
  ) {
    throw new AppError("VALIDATION", "Invalid conversation request", 400);
  }
}

function continuationFor(state: BatchState, offset = state.offset): ConversationRequest {
  return {
    conversation_id: state.conversationId,
    offset,
    limit: state.limit,
    branch: state.branch,
    ...(state.revisionId ? { revision_id: state.revisionId } : {}),
  };
}

function cursorStateFor(state: BatchState): BatchCursorState {
  return {
    i: state.requestIndex,
    c: state.conversationId,
    ...(state.revisionId ? { r: state.revisionId } : {}),
    b: state.branch,
    l: state.limit,
    ...(state.kind === "pending" ? { o: state.offset } : {}),
    k: state.kind,
    ...(state.kind === "error" && state.error ? { e: state.error.code } : {}),
  };
}

function cursorPayloadFor(
  states: BatchState[],
  batchId: string,
  expiresAt: number,
  fairness: number,
): BatchCursorPayload {
  return {
    v: 1,
    s: 1,
    e: expiresAt,
    b: batchId,
    f: states.length ? fairness % states.length : 0,
    q: states.map(cursorStateFor),
  };
}

function estimateCursorLength(payload: BatchCursorPayload): number {
  return cursorBody(payload).length + 1 + 43;
}

function stateError(state: BatchState, error: BatchItemError): void {
  state.kind = "error";
  state.error = error;
  state.touched = true;
  delete state.loaded;
}

async function pinBatchRequest(
  env: AppEnv,
  conversationId: string,
  requestedRevisionId: string | undefined,
  expectedNamespaces: string[],
  expectedUserId: string,
): Promise<{ revisionId: string } | { error: BatchItemError }> {
  try {
    const row = await env.MEMORY_DB.prepare(
      `SELECT c.current_revision_id, c.namespace, c.user_id, r.id AS pinned_revision_id
       FROM conversations c
       LEFT JOIN conversation_revisions r
         ON r.id = ? AND r.conversation_id = c.id
       WHERE c.id = ? AND c.deleted_at IS NULL`,
    )
      .bind(requestedRevisionId ?? null, conversationId)
      .first<{
        current_revision_id: string | null;
        namespace: string;
        user_id: string;
        pinned_revision_id: string | null;
      }>();
    if (
      !row ||
      row.user_id !== expectedUserId ||
      (expectedNamespaces.length > 0 && !expectedNamespaces.includes(row.namespace))
    ) {
      return { error: { code: "NOT_FOUND", message: "Conversation or revision not found" } };
    }
    const revisionId = requestedRevisionId ?? row.current_revision_id;
    if (
      !revisionId ||
      (requestedRevisionId !== undefined && row.pinned_revision_id !== revisionId)
    ) {
      return { error: { code: "NOT_FOUND", message: "Conversation or revision not found" } };
    }
    return { revisionId };
  } catch {
    return { error: { code: "CANONICAL_STORAGE", message: "Canonical read failed" } };
  }
}

function batchResultPage(
  state: BatchState,
  page: CompactPage | undefined,
  legacyOversizedOffset?: number,
  includeCompatibilityContinuation = true,
): BatchEntry {
  if (state.kind === "error") {
    return {
      requestIndex: state.requestIndex,
      status: "error",
      continuation: null,
      error: state.error ?? { code: "CANONICAL_STORAGE", message: "Canonical read failed" },
    };
  }
  const continuation =
    state.kind === "pending" && includeCompatibilityContinuation
      ? continuationFor(state, legacyOversizedOffset ?? state.offset)
      : null;
  if (page) {
    return {
      requestIndex: state.requestIndex,
      status: "ok",
      page,
      continuation,
    };
  }
  return {
    requestIndex: state.requestIndex,
    status: "deferred",
    continuation,
  };
}

function draftBatchValue(
  states: BatchState[],
  pages: Array<CompactPage | undefined>,
  batchId: string,
  nextCursor: string | null,
  maxSerializedBytes: number,
  usedSerializedBytes: number,
  includeCompatibilityContinuation: boolean,
  includeUntouchedResults: boolean,
): ConversationBatchResult {
  const results = states.flatMap((state, index) => {
    if (!includeUntouchedResults && !state.touched) return [];
    return [
      batchResultPage(
        state,
        state.touched ? pages[index] : undefined,
        state.oversized ? state.compatibilityOffset : undefined,
        includeCompatibilityContinuation,
      ),
    ];
  });
  const remaining = states.filter((state) => state.kind === "pending").length;
  return {
    batchId,
    results,
    completed: states.length - remaining,
    remaining,
    nextCursor,
    usedSerializedBytes,
    maxSerializedBytes,
  };
}

async function renderBatchValue(
  states: BatchState[],
  pages: Array<CompactPage | undefined>,
  batchId: string,
  expiresAt: number,
  fairness: number,
  maxSerializedBytes: number,
  secret: string,
  expectedUserId: string,
  expectedNamespaces: string[],
  includeUntouchedResults: boolean,
): Promise<{
  value: ConversationBatchResult;
  cursor: string | null;
}> {
  const includeCompatibilityContinuation = states.length <= 3;
  const pending = states.some((state) => state.kind === "pending");
  const payload = pending ? cursorPayloadFor(states, batchId, expiresAt, fairness) : null;
  const cursor = payload
    ? await signBatchCursor(payload, secret, expectedUserId, expectedNamespaces)
    : null;
  let used = 0;
  let value = draftBatchValue(
    states,
    pages,
    batchId,
    cursor,
    maxSerializedBytes,
    used,
    includeCompatibilityContinuation,
    includeUntouchedResults,
  );
  for (let attempt = 0; attempt < 4; attempt++) {
    const nextUsed = jsonBytes(value);
    if (nextUsed === used) break;
    used = nextUsed;
    value = draftBatchValue(
      states,
      pages,
      batchId,
      cursor,
      maxSerializedBytes,
      used,
      includeCompatibilityContinuation,
      includeUntouchedResults,
    );
  }
  return { value, cursor };
}

async function getCursorConversations(
  env: AppEnv,
  input: ConversationBatchInput,
  expectedNamespaces: string[],
  expectedUserId: string,
  secret: string,
) {
  const hasRequests = input.requests !== undefined;
  const hasCursor = input.cursor !== undefined;
  const includeUntouchedResults = !hasCursor;
  if (hasRequests === hasCursor) {
    throw new AppError("VALIDATION", "Provide exactly one of requests or cursor", 400);
  }
  const maxSerializedBytes = normalizeBatchBudget(
    input.maxSerializedBytes ?? input.max_serialized_bytes,
    false,
  );
  let states: BatchState[];
  let batchId: string;
  let expiresAt: number;
  let fairness: number;
  if (hasCursor) {
    const payload = await decodeBatchCursor(
      input.cursor!,
      secret,
      expectedUserId,
      expectedNamespaces,
    );
    batchId = payload.b;
    expiresAt = payload.e;
    fairness = payload.f;
    states = payload.q.map((state) => ({
      requestIndex: state.i,
      conversationId: state.c,
      ...(state.r ? { revisionId: state.r } : {}),
      branch: state.b,
      limit: state.l,
      offset: state.o ?? 0,
      kind: state.k,
      ...(state.e
        ? {
            error: {
              code: state.e,
              message:
                state.e === "NOT_FOUND"
                  ? "Conversation or revision not found"
                  : state.e === "RESPONSE_TOO_LARGE"
                    ? "Conversation metadata exceeds the batch response budget"
                    : "Canonical read failed",
            },
          }
        : {}),
      touched: false,
    }));
  } else {
    const requests = input.requests!;
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 20) {
      throw new AppError("VALIDATION", "Expected 1–20 requests", 400);
    }
    states = requests.map((raw, requestIndex) => {
      const request = normalizeRequest(raw);
      validateRequest(request);
      return {
        requestIndex,
        conversationId: request.conversation_id,
        branch: request.branch,
        limit: request.limit,
        offset: request.offset,
        ...(request.revision_id ? { revisionId: request.revision_id } : {}),
        kind: "pending" as const,
        touched: false,
      };
    });
    batchId = crypto.randomUUID();
    expiresAt = Date.now() + BATCH_CURSOR_TTL_MS;
    fairness = 0;
  }

  // Resolve ownership and revision membership for the entire request set before
  // starting any R2 read. Cursor calls use their immutable pinned revision IDs.
  const pinResults = await Promise.all(
    states.map(async (state) => {
      if (state.kind === "error") return { state, result: { error: state.error! } };
      const result = await pinBatchRequest(
        env,
        state.conversationId,
        state.revisionId,
        expectedNamespaces,
        expectedUserId,
      );
      return { state, result };
    }),
  );
  for (const { state, result } of pinResults) {
    if ("error" in result) {
      stateError(state, result.error);
      continue;
    }
    if (state.revisionId && state.revisionId !== result.revisionId) {
      stateError(state, { code: "NOT_FOUND", message: "Conversation or revision not found" });
      continue;
    }
    state.revisionId = result.revisionId;
  }

  const tags = new Map<string, string[]>();
  const validStates = states.filter(
    (state): state is BatchState & { revisionId: string } =>
      state.kind === "pending" && typeof state.revisionId === "string",
  );
  if (validStates.length) {
    try {
      const loadedTags = await loadConversationTags(env, [
        ...new Set(validStates.map((state) => state.conversationId)),
      ]);
      for (const [conversationId, conversationTags] of loadedTags) {
        tags.set(conversationId, conversationTags);
      }
    } catch {
      for (const state of validStates) {
        stateError(state, { code: "CANONICAL_STORAGE", message: "Canonical read failed" });
      }
    }
  }

  const loadableStates = states.filter(
    (state): state is BatchState & { revisionId: string } =>
      state.kind === "pending" && typeof state.revisionId === "string",
  );
  const revisionIds = [...new Set(loadableStates.map((state) => state.revisionId))];
  const loadedRevisions = new Map<
    string,
    { conversation: CanonicalConversation } | { error: BatchItemError }
  >();
  // Four immutable canonical loads per wave preserve the existing read headroom.
  for (let start = 0; start < revisionIds.length; start += 4) {
    const wave = await Promise.all(
      revisionIds.slice(start, start + 4).map(async (revisionId) => {
        try {
          const loaded = await loadCanonicalRevision(env, revisionId);
          return { revisionId, value: { conversation: loaded.conversation } as const };
        } catch (error) {
          return { revisionId, value: { error: itemError(error) } as const };
        }
      }),
    );
    for (const loaded of wave) loadedRevisions.set(loaded.revisionId, loaded.value);
  }

  const pages: Array<CompactPage | undefined> = Array.from({ length: states.length });
  for (const state of states) {
    if (state.kind !== "pending" || !state.revisionId) continue;
    const loaded = loadedRevisions.get(state.revisionId);
    if (!loaded || "error" in loaded) {
      stateError(
        state,
        loaded && "error" in loaded
          ? loaded.error
          : { code: "CANONICAL_STORAGE", message: "Canonical read failed" },
      );
      continue;
    }
    if (loaded.conversation.id !== state.conversationId) {
      stateError(state, { code: "CANONICAL_STORAGE", message: "Canonical read failed" });
      continue;
    }
    const fullPage = compactConversationPage(
      conversationPage(
        loaded.conversation,
        state.revisionId,
        tags.get(state.conversationId) ?? [],
        state.offset,
        state.limit,
        state.branch,
      ),
      state.offset,
    );
    state.loaded = {
      page: { ...fullPage, messages: [], nextOffset: fullPage.nextOffset },
      candidates: fullPage.messages,
      total: fullPage.total,
    };
    pages[state.requestIndex] = state.loaded.page;
    if (state.offset >= fullPage.total || fullPage.messages.length === 0) {
      state.kind = "done";
      state.touched = true;
      state.loaded.page.nextOffset = null;
    }
  }

  const renderingIncludesUntouched = includeUntouchedResults;
  let roundStart = fairness;
  let lastProcessed = fairness;
  const draftUsedSerializedBytes = 10 ** (String(maxSerializedBytes).length - 1);
  const admitPages = (includeResults: boolean): number => {
    let admitted = 0;
    let pageProgress = true;
    while (pageProgress) {
      pageProgress = false;
      for (let step = 0; step < states.length; step++) {
        const index = (roundStart + step) % states.length;
        const state = states[index]!;
        if (state.kind !== "pending" || !state.loaded || state.oversized) continue;
        const page = state.loaded.page;
        const candidateIndex = state.offset - page.offset;
        if (candidateIndex >= state.loaded.candidates.length || candidateIndex >= state.limit) {
          page.nextOffset = state.offset < state.loaded.total ? state.offset : null;
          if (state.offset >= state.loaded.total) {
            state.kind = "done";
            state.touched = true;
          }
          continue;
        }
        const candidate = state.loaded.candidates[candidateIndex]!;
        const candidateBytes = jsonBytes(candidate);
        const draftFits = (): boolean => {
          const draftPayload = cursorPayloadFor(states, batchId, expiresAt, roundStart);
          const draftCursor = states.some((item) => item.kind === "pending")
            ? `x`.repeat(estimateCursorLength(draftPayload))
            : null;
          const draft = draftBatchValue(
            states,
            pages,
            batchId,
            draftCursor,
            maxSerializedBytes,
            draftUsedSerializedBytes,
            states.length <= 3,
            includeResults,
          );
          return jsonBytes(draft) <= maxSerializedBytes;
        };
        if (candidateBytes + 512 > maxSerializedBytes) {
          const previousKind = state.kind;
          const previousOffset = state.offset;
          const previousTouched = state.touched;
          const previousOversized = state.oversized;
          const previousCompatibilityOffset = state.compatibilityOffset;
          const previousDiagnostic = page.oversizedMessage;
          const previousNextOffset = page.nextOffset;
          state.oversized = {
            conversationId: state.conversationId,
            revisionId: state.revisionId!,
            sourceNodeId: candidate.sourceNodeId,
            offset: state.offset,
            bytes: candidateBytes,
          };
          state.compatibilityOffset = state.offset;
          state.offset++;
          state.touched = true;
          pages[index] = page;
          page.oversizedMessage = state.oversized;
          page.nextOffset = state.offset < state.loaded.total ? state.offset : null;
          if (state.offset >= state.loaded.total) state.kind = "done";
          if (!draftFits()) {
            state.kind = previousKind;
            state.offset = previousOffset;
            state.touched = previousTouched;
            if (previousOversized !== undefined) {
              state.oversized = previousOversized;
            } else {
              delete state.oversized;
            }
            if (previousCompatibilityOffset !== undefined) {
              state.compatibilityOffset = previousCompatibilityOffset;
            } else {
              delete state.compatibilityOffset;
            }
            page.oversizedMessage = previousDiagnostic;
            page.nextOffset = previousNextOffset;
            if (!state.touched) pages[index] = undefined;
            continue;
          }
          admitted++;
          pageProgress = true;
          lastProcessed = index;
          continue;
        }
        const previousKind = state.kind;
        const previousOffset = state.offset;
        const previousTouched = state.touched;
        const previousOversized = state.oversized;
        const previousCompatibilityOffset = state.compatibilityOffset;
        const previousMessageCount = page.messages.length;
        const previousDiagnostic = page.oversizedMessage;
        const previousNextOffset = page.nextOffset;
        page.messages.push(candidate);
        state.offset++;
        state.touched = true;
        pages[index] = page;
        page.nextOffset = state.offset < state.loaded.total ? state.offset : null;
        if (state.offset >= state.loaded.total) state.kind = "done";
        if (!draftFits()) {
          state.kind = previousKind;
          state.offset = previousOffset;
          state.touched = previousTouched;
          if (previousOversized !== undefined) {
            state.oversized = previousOversized;
          } else {
            delete state.oversized;
          }
          if (previousCompatibilityOffset !== undefined) {
            state.compatibilityOffset = previousCompatibilityOffset;
          } else {
            delete state.compatibilityOffset;
          }
          page.messages.length = previousMessageCount;
          page.oversizedMessage = previousDiagnostic;
          page.nextOffset = previousNextOffset;
          if (!state.touched) pages[index] = undefined;
          continue;
        }
        admitted++;
        pageProgress = true;
        lastProcessed = index;
      }
      if (pageProgress) roundStart = (lastProcessed + 1) % states.length;
    }
    return admitted;
  };
  const admittedContent = admitPages(renderingIncludesUntouched);
  if (
    !renderingIncludesUntouched &&
    admittedContent === 0 &&
    states.some((state) => state.kind === "pending")
  ) {
    const terminalIndex = states.findIndex((state) => state.kind === "pending");
    const terminal = states[terminalIndex];
    if (terminal) {
      stateError(terminal, {
        code: "RESPONSE_TOO_LARGE",
        message: "Conversation metadata exceeds the batch response budget",
      });
      pages[terminalIndex] = undefined;
      delete terminal.oversized;
      delete terminal.compatibilityOffset;
    }
  }
  fairness = states.some((state) => state.kind === "pending")
    ? (lastProcessed + 1) % states.length
    : 0;

  // Shrink only whole messages if the real HMAC cursor is a few bytes larger
  // than the conservative draft used during round-robin admission.
  let rendered = await renderBatchValue(
    states,
    pages,
    batchId,
    expiresAt,
    fairness,
    maxSerializedBytes,
    secret,
    expectedUserId,
    expectedNamespaces,
    renderingIncludesUntouched,
  );
  const markResponseTooLarge = (state: BatchState, index: number): void => {
    stateError(state, {
      code: "RESPONSE_TOO_LARGE",
      message: "Conversation metadata exceeds the batch response budget",
    });
    pages[index] = undefined;
    delete state.oversized;
    delete state.compatibilityOffset;
  };
  while (jsonBytes(rendered.value) > maxSerializedBytes) {
    let removed = false;
    for (let index = states.length - 1; index >= 0; index--) {
      const state = states[index]!;
      const page = pages[index];
      if (!page) continue;
      if (page.messages.length) {
        page.messages.pop();
        state.offset--;
        state.kind = "pending";
        state.touched = page.messages.length > 0 || Boolean(page.oversizedMessage);
        page.nextOffset = state.offset;
        if (!state.touched) pages[index] = undefined;
        removed = true;
        break;
      }
      if (page.oversizedMessage && state.oversized) {
        state.offset--;
        state.kind = "pending";
        state.touched = false;
        delete state.oversized;
        delete state.compatibilityOffset;
        page.oversizedMessage = null;
        page.nextOffset = state.offset;
        pages[index] = undefined;
        removed = true;
        break;
      }
    }
    if (!removed) {
      if (renderingIncludesUntouched) {
        throw new AppError(
          "VALIDATION",
          "max_serialized_bytes is too small for the batch envelope",
          400,
        );
      }
      const terminalIndex = states.findIndex(
        (state, index) =>
          state.kind === "pending" || Boolean(state.oversized) || Boolean(pages[index]),
      );
      const terminal = states[terminalIndex];
      if (!terminal) {
        throw new AppError(
          "VALIDATION",
          "max_serialized_bytes is too small for the batch envelope",
          400,
        );
      }
      markResponseTooLarge(terminal, terminalIndex);
    }
    fairness = states.some((state) => state.kind === "pending")
      ? (lastProcessed + 1) % states.length
      : 0;
    rendered = await renderBatchValue(
      states,
      pages,
      batchId,
      expiresAt,
      fairness,
      maxSerializedBytes,
      secret,
      expectedUserId,
      expectedNamespaces,
      renderingIncludesUntouched,
    );
  }
  if (
    !renderingIncludesUntouched &&
    !states.some((_, index) => {
      const page = pages[index];
      return Boolean(page && (page.messages.length || page.oversizedMessage));
    }) &&
    states.some((state) => state.kind === "pending")
  ) {
    const terminalIndex = states.findIndex((state) => state.kind === "pending");
    const terminal = states[terminalIndex];
    if (terminal) {
      markResponseTooLarge(terminal, terminalIndex);
      fairness = states.some((state) => state.kind === "pending")
        ? (lastProcessed + 1) % states.length
        : 0;
      rendered = await renderBatchValue(
        states,
        pages,
        batchId,
        expiresAt,
        fairness,
        maxSerializedBytes,
        secret,
        expectedUserId,
        expectedNamespaces,
        renderingIncludesUntouched,
      );
    }
  }
  return rendered.value;
}

async function getLegacyConversations(
  env: AppEnv,
  requests: ConversationRequest[],
  expectedNamespaces: string[],
  expectedUserId: string,
) {
  if (!requests.length || requests.length > 20)
    throw new AppError("VALIDATION", "Expected 1–20 requests", 400);
  const result = {
    results: requests.map((request, requestIndex): BatchEntry => ({
      requestIndex,
      status: "deferred",
      continuation: request,
    })),
  };
  // Four serial read chains per wave leave connection headroom for the request.
  for (let start = 0; start < requests.length; start += 4) {
    const pages = await Promise.allSettled(
      requests
        .slice(start, start + 4)
        .map(async (request) =>
          compactConversationPage(
            await getConversationPage(
              env,
              request.conversation_id,
              request.offset,
              request.limit,
              request.branch,
              expectedNamespaces,
              expectedUserId,
              request.revision_id,
            ),
            request.offset,
          ),
        ),
    );
    for (const [index, loaded] of pages.entries()) {
      const requestIndex = start + index;
      const request = requests[requestIndex]!;
      if (loaded.status === "rejected") {
        result.results[requestIndex] = {
          requestIndex,
          status: "error",
          continuation: null,
          error: itemError(loaded.reason),
        };
        continue;
      }
      const framingBytes = jsonBytes({
        results: [
          {
            requestIndex,
            status: "ok",
            page: null,
            continuation: { ...request, revision_id: loaded.value.conversation.revisionId },
          },
        ],
      });
      const page = boundCompactPage(loaded.value, COMPACT_RESPONSE_BYTES - framingBytes);
      if (jsonBytes(page) + framingBytes > COMPACT_RESPONSE_BYTES) {
        result.results[requestIndex] = {
          requestIndex,
          status: "error",
          continuation: null,
          error: {
            code: "RESPONSE_TOO_LARGE",
            message: "Conversation metadata exceeds the batch response budget",
          },
        };
        continue;
      }
      const entry: BatchEntry = { requestIndex, status: "ok", page, continuation: null };
      const deferred = result.results[requestIndex]!;
      result.results[requestIndex] = entry;
      const updateContinuation = () => {
        entry.continuation =
          page.nextOffset === null
            ? null
            : {
                ...request,
                offset: page.nextOffset,
                revision_id: page.conversation.revisionId,
              };
      };
      updateContinuation();
      while (
        page.messages.length &&
        jsonBytes(result) + (requests.length - requestIndex - 1) * 256 > COMPACT_RESPONSE_BYTES
      ) {
        page.messages.pop();
        page.nextOffset = page.offset + page.messages.length;
        updateContinuation();
      }
      if (
        (loaded.value.messages.length && !page.messages.length && !page.oversizedMessage) ||
        jsonBytes(result) + (requests.length - requestIndex - 1) * 256 > COMPACT_RESPONSE_BYTES
      ) {
        result.results[requestIndex] = deferred;
        deferred.continuation = { ...request, revision_id: page.conversation.revisionId };
      }
    }
  }
  return result;
}

export async function getConversations(
  env: AppEnv,
  input: ConversationRequest[] | ConversationBatchInput,
  expectedNamespaces: string[],
  expectedUserId: string,
  secret = env.MEMORY_API_TOKEN,
) {
  if (Array.isArray(input))
    return getLegacyConversations(env, input, expectedNamespaces, expectedUserId);
  return getCursorConversations(env, input, expectedNamespaces, expectedUserId, secret);
}
export interface ExactMessageRequest {
  conversation_id: string;
  revision_id?: string;
  source_node_id?: string;
  message_key?: string;
}

export interface ExactMessagesInput {
  requests?: ExactMessageRequest[];
  cursor?: string;
  max_serialized_bytes?: number;
}

export interface ExactMessage {
  sourceNodeId: string;
  messageKey: string | null;
  role: string | null;
  text: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ExactMessageResult {
  request_index: number;
  status: "ok" | "error" | "oversized";
  conversation_id: string;
  revision_id?: string;
  message?: ExactMessage;
  error?: { code: "NOT_FOUND" | "CANONICAL_STORAGE"; message: string };
  oversized_message?: {
    sourceNodeId: string;
    messageKey: string | null;
    bytes: number;
  };
}

export interface ExactMessagesResult {
  results: ExactMessageResult[];
  next_cursor: string | null;
  used_serialized_bytes: number;
  max_serialized_bytes: number;
}

export type GetMessagesInput = ExactMessagesInput;
export type GetMessageRequest = ExactMessageRequest;
export type GetMessagesResult = ExactMessagesResult;
type ExactState = {
  conversationId: string;
  revisionId?: string;
  selector: { kind: "source_node_id" | "message_key"; value: string };
  errorCode?: "NOT_FOUND" | "CANONICAL_STORAGE";
};

type ExactCursorPayload = {
  v: 1;
  s: 2;
  e: number;
  p: number;
  q: Array<[string, string, 0 | 1, string, "" | "NOT_FOUND" | "CANONICAL_STORAGE"]>;
};

const EXACT_CURSOR_TTL_MS = 15 * 60 * 1000;

function invalidExactCursor(): never {
  throw new AppError("VALIDATION", "Invalid message cursor", 400);
}

function normalizeExactBudget(value: unknown): number {
  if (value === undefined) return BATCH_DEFAULT_SERIALIZED_BYTES;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= BATCH_MIN_SERIALIZED_BYTES &&
    value <= BATCH_MAX_SERIALIZED_BYTES
  ) {
    return value;
  }
  throw new AppError(
    "VALIDATION",
    `max_serialized_bytes must be between ${BATCH_MIN_SERIALIZED_BYTES} and ${BATCH_MAX_SERIALIZED_BYTES}`,
    400,
  );
}

function validateExactRequest(value: unknown): ExactMessageRequest {
  if (!isRecord(value)) throw new AppError("VALIDATION", "Invalid message request", 400);
  const conversationId = value.conversation_id;
  const revisionId = value.revision_id;
  const sourceNodeId = value.source_node_id;
  const messageKey = value.message_key;
  const selectorCount = Number(sourceNodeId !== undefined) + Number(messageKey !== undefined);
  if (
    typeof conversationId !== "string" ||
    conversationId.length < 1 ||
    conversationId.length > 128 ||
    (revisionId !== undefined &&
      (typeof revisionId !== "string" || revisionId.length < 1 || revisionId.length > 128)) ||
    selectorCount !== 1
  ) {
    throw new AppError("VALIDATION", "Invalid message request", 400);
  }
  if (
    sourceNodeId !== undefined &&
    (typeof sourceNodeId !== "string" ||
      sourceNodeId.length < 1 ||
      sourceNodeId.length > MAX_EXACT_SOURCE_NODE_ID_CHARS)
  ) {
    throw new AppError("VALIDATION", "Invalid source_node_id", 400);
  }
  if (
    messageKey !== undefined &&
    (typeof messageKey !== "string" ||
      messageKey.length < 1 ||
      messageKey.length > MAX_MESSAGE_KEY_CHARS ||
      !/^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/u.test(messageKey))
  ) {
    throw new AppError("VALIDATION", "Invalid message_key", 400);
  }
  return {
    conversation_id: conversationId,
    ...(revisionId === undefined ? {} : { revision_id: revisionId }),
    ...(sourceNodeId === undefined ? {} : { source_node_id: sourceNodeId }),
    ...(messageKey === undefined ? {} : { message_key: messageKey }),
  };
}

function exactCursorBody(payload: ExactCursorPayload): string {
  const wire = {
    ...payload,
    q: payload.q.map(([conversationId, revisionId, selectorKind, selector, error]) => [
      encodeCursorId(conversationId),
      revisionId ? encodeCursorId(revisionId) : "",
      selectorKind,
      base64UrlEncode(textEncoder.encode(selector)),
      error,
    ]),
  };
  return base64UrlEncode(textEncoder.encode(JSON.stringify(wire)));
}

async function signExactCursor(
  payload: ExactCursorPayload,
  secret: string,
  expectedUserId: string,
  expectedNamespaces: string[],
): Promise<string> {
  if (!secret) invalidExactCursor();
  const body = exactCursorBody(payload);
  const key = await cursorKey(secret);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      textEncoder.encode(`${cursorBinding(expectedUserId, expectedNamespaces)}.${body}`),
    ),
  );
  return `${body}.${base64UrlEncode(signature)}`;
}

function decodeExactState(value: unknown, index: number): ExactState {
  if (!Array.isArray(value) || value.length !== 5) invalidExactCursor();
  const [encodedConversationId, encodedRevisionId, selectorKind, encodedSelector, errorCode] =
    value as [unknown, unknown, unknown, unknown, unknown];
  if (
    typeof encodedConversationId !== "string" ||
    typeof encodedRevisionId !== "string" ||
    (selectorKind !== 0 && selectorKind !== 1) ||
    typeof encodedSelector !== "string" ||
    (errorCode !== "" && errorCode !== "NOT_FOUND" && errorCode !== "CANONICAL_STORAGE")
  ) {
    invalidExactCursor();
  }
  const conversationId = decodeCursorId(encodedConversationId);
  const revisionId = encodedRevisionId ? decodeCursorId(encodedRevisionId) : undefined;
  const selector = new TextDecoder().decode(base64UrlDecode(encodedSelector));
  const selectorLimit = selectorKind === 0 ? MAX_EXACT_SOURCE_NODE_ID_CHARS : MAX_MESSAGE_KEY_CHARS;
  if (!selector || selector.length > selectorLimit || !conversationId || index < 0)
    invalidExactCursor();
  if (selectorKind === 1 && !/^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/u.test(selector)) {
    invalidExactCursor();
  }
  return {
    conversationId,
    ...(revisionId ? { revisionId } : {}),
    selector: {
      kind: selectorKind === 0 ? "source_node_id" : "message_key",
      value: selector,
    },
    ...(errorCode ? { errorCode } : {}),
  };
}

async function decodeExactCursor(
  cursor: unknown,
  secret: string,
  expectedUserId: string,
  expectedNamespaces: string[],
): Promise<{ position: number; expiresAt: number; states: ExactState[] }> {
  if (
    typeof cursor !== "string" ||
    cursor.length < 16 ||
    cursor.length > MAX_EXACT_MESSAGE_CURSOR_CHARS ||
    !secret
  ) {
    invalidExactCursor();
  }
  const separator = cursor.lastIndexOf(".");
  if (separator <= 0 || separator === cursor.length - 1) invalidExactCursor();
  const body = cursor.slice(0, separator);
  const signature = base64UrlDecode(cursor.slice(separator + 1));
  if (signature.byteLength !== 32) invalidExactCursor();
  const key = await cursorKey(secret);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature.slice().buffer,
      textEncoder.encode(`${cursorBinding(expectedUserId, expectedNamespaces)}.${body}`),
    );
  } catch {
    invalidExactCursor();
  }
  if (!valid) invalidExactCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as unknown;
  } catch {
    invalidExactCursor();
  }
  if (!isRecord(decoded)) invalidExactCursor();
  if (
    decoded.v !== 1 ||
    decoded.s !== 2 ||
    typeof decoded.e !== "number" ||
    !Number.isSafeInteger(decoded.e) ||
    decoded.e <= Date.now() ||
    decoded.e > Date.now() + EXACT_CURSOR_TTL_MS + 60_000 ||
    !isSafeInteger(decoded.p) ||
    !Array.isArray(decoded.q) ||
    decoded.q.length < 1 ||
    decoded.q.length > MAX_EXACT_MESSAGE_REQUESTS ||
    decoded.p < 0 ||
    decoded.p > decoded.q.length
  ) {
    invalidExactCursor();
  }
  const states = decoded.q.map((state, index) => decodeExactState(state, index));
  if (states.slice(decoded.p).some((state) => !state.revisionId && !state.errorCode)) {
    invalidExactCursor();
  }
  return { position: decoded.p, expiresAt: decoded.e, states };
}

async function pinExactRequest(
  env: AppEnv,
  request: ExactMessageRequest,
  expectedNamespaces: string[],
  expectedUserId: string,
): Promise<ExactState> {
  const selector =
    request.source_node_id !== undefined
      ? { kind: "source_node_id" as const, value: request.source_node_id }
      : { kind: "message_key" as const, value: request.message_key! };
  try {
    const row = await env.MEMORY_DB.prepare(
      `SELECT c.current_revision_id, c.namespace, c.user_id, r.id AS pinned_revision_id
       FROM conversations c
       LEFT JOIN conversation_revisions r
         ON r.id = ? AND r.conversation_id = c.id
       WHERE c.id = ? AND c.deleted_at IS NULL`,
    )
      .bind(request.revision_id ?? null, request.conversation_id)
      .first<{
        current_revision_id: string | null;
        namespace: string;
        user_id: string;
        pinned_revision_id: string | null;
      }>();
    const revisionId = request.revision_id ?? row?.current_revision_id;
    const denied =
      !row ||
      row.user_id !== expectedUserId ||
      (expectedNamespaces.length > 0 && !expectedNamespaces.includes(row.namespace)) ||
      !revisionId ||
      (request.revision_id !== undefined && row.pinned_revision_id !== revisionId);
    return {
      conversationId: request.conversation_id,
      ...(denied ? {} : { revisionId }),
      selector,
      ...(denied ? { errorCode: "NOT_FOUND" as const } : {}),
    };
  } catch {
    return {
      conversationId: request.conversation_id,
      selector,
      errorCode: "CANONICAL_STORAGE",
    };
  }
}

function exactError(
  index: number,
  state: ExactState,
  code: "NOT_FOUND" | "CANONICAL_STORAGE",
): ExactMessageResult {
  return {
    request_index: index,
    status: "error",
    conversation_id: state.conversationId,
    ...(state.revisionId ? { revision_id: state.revisionId } : {}),
    error:
      code === "NOT_FOUND"
        ? { code, message: "Conversation, revision, or message not found" }
        : { code, message: "Canonical read failed" },
  };
}

function exactMessageFromNode(node: CanonicalNode): ExactMessage {
  return {
    sourceNodeId: node.sourceNodeId,
    messageKey: node.messageKey ?? null,
    role: node.role,
    text: node.text,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

export async function getMessages(
  env: AppEnv,
  input: ExactMessagesInput,
  expectedNamespaces: string[],
  expectedUserId: string,
  secret = env.MEMORY_API_TOKEN,
): Promise<ExactMessagesResult> {
  const hasRequests = input.requests !== undefined;
  const hasCursor = input.cursor !== undefined;
  if (hasRequests === hasCursor) {
    throw new AppError("VALIDATION", "Provide exactly one of requests or cursor", 400);
  }
  const maxSerializedBytes = normalizeExactBudget(input.max_serialized_bytes);
  let states: ExactState[];
  let position: number;
  let expiresAt: number;
  if (hasRequests) {
    if (
      !Array.isArray(input.requests) ||
      input.requests.length < 1 ||
      input.requests.length > MAX_EXACT_MESSAGE_REQUESTS
    ) {
      throw new AppError("VALIDATION", `Expected 1–${MAX_EXACT_MESSAGE_REQUESTS} requests`, 400);
    }
    const requests = input.requests.map(validateExactRequest);
    // Pin every request before starting any canonical R2 load.
    states = await Promise.all(
      requests.map((request) => pinExactRequest(env, request, expectedNamespaces, expectedUserId)),
    );
    position = 0;
    expiresAt = Date.now() + EXACT_CURSOR_TTL_MS;
  } else {
    const decoded = await decodeExactCursor(
      input.cursor,
      secret,
      expectedUserId,
      expectedNamespaces,
    );
    states = decoded.states;
    position = decoded.position;
    expiresAt = decoded.expiresAt;
  }

  const revisionIds = [
    ...new Set(states.flatMap((state) => (state.revisionId ? [state.revisionId] : []))),
  ];
  const loaded = new Map<
    string,
    { conversation: CanonicalConversation } | { error: "CANONICAL_STORAGE" }
  >();
  for (const revisionId of revisionIds) {
    try {
      loaded.set(revisionId, {
        conversation: (await loadCanonicalRevision(env, revisionId)).conversation,
      });
    } catch {
      loaded.set(revisionId, { error: "CANONICAL_STORAGE" });
    }
  }

  const resolve = (index: number, state: ExactState): ExactMessageResult => {
    if (state.errorCode) return exactError(index, state, state.errorCode);
    if (!state.revisionId) return exactError(index, state, "NOT_FOUND");
    const revision = loaded.get(state.revisionId);
    if (!revision || "error" in revision) return exactError(index, state, "CANONICAL_STORAGE");
    if (revision.conversation.id !== state.conversationId) {
      return exactError(index, state, "CANONICAL_STORAGE");
    }
    const matches = revision.conversation.nodes.filter((node) =>
      state.selector.kind === "source_node_id"
        ? node.sourceNodeId === state.selector.value
        : node.messageKey === state.selector.value,
    );
    if (matches.length === 0) return exactError(index, state, "NOT_FOUND");
    if (matches.length > 1) return exactError(index, state, "CANONICAL_STORAGE");
    const message = exactMessageFromNode(matches[0]!);
    if (jsonBytes(message) > maxSerializedBytes) {
      return {
        request_index: index,
        status: "oversized",
        conversation_id: state.conversationId,
        revision_id: state.revisionId,
        oversized_message: {
          sourceNodeId: message.sourceNodeId,
          messageKey: message.messageKey,
          bytes: jsonBytes(message),
        },
      };
    }
    return {
      request_index: index,
      status: "ok",
      conversation_id: state.conversationId,
      revision_id: state.revisionId,
      message,
    };
  };

  const cursorFor = async (nextPosition: number): Promise<string | null> =>
    nextPosition >= states.length
      ? null
      : signExactCursor(
          {
            v: 1,
            s: 2,
            e: expiresAt,
            p: nextPosition,
            q: states.map((state) => [
              state.conversationId,
              state.revisionId ?? "",
              state.selector.kind === "source_node_id" ? 0 : 1,
              state.selector.value,
              state.errorCode ?? "",
            ]),
          },
          secret,
          expectedUserId,
          expectedNamespaces,
        );
  const results: ExactMessageResult[] = [];
  for (let index = position; index < states.length; index++) {
    const entry = resolve(index, states[index]!);
    const nextCursor = await cursorFor(index + 1);
    const candidate: ExactMessagesResult = {
      results: [...results, entry],
      next_cursor: nextCursor,
      used_serialized_bytes: 0,
      max_serialized_bytes: maxSerializedBytes,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const used = jsonBytes(candidate);
      if (candidate.used_serialized_bytes === used) break;
      candidate.used_serialized_bytes = used;
    }
    if (jsonBytes(candidate) > maxSerializedBytes) {
      if (results.length === 0) {
        throw new AppError(
          "VALIDATION",
          "max_serialized_bytes is too small for the message response",
          400,
        );
      }
      break;
    }
    results.push(entry);
  }
  const nextCursor = await cursorFor(position + results.length);
  const value: ExactMessagesResult = {
    results,
    next_cursor: nextCursor,
    used_serialized_bytes: 0,
    max_serialized_bytes: maxSerializedBytes,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const used = jsonBytes(value);
    if (value.used_serialized_bytes === used) break;
    value.used_serialized_bytes = used;
  }
  return value;
}

export async function verifyIntegrity(env: AppEnv): Promise<{
  checkedRevisions: number;
  missingManifests: string[];
  missingSegments: string[];
  corruptManifests: string[];
  corruptSegments: Array<{
    revisionId: string;
    segmentIndex: number;
    lineNumber: number;
  }>;
  invalidMessageKeys: Array<{
    conversationId: string;
    revisionId: string;
    sourceNodeId: string;
    reason: "invalid_format" | "invalid_type";
  }>;
  duplicateMessageKeys: Array<{
    conversationId: string;
    revisionId: string;
    messageKey: string;
    sourceNodeIds: string[];
  }>;
}> {
  const revisions = await env.MEMORY_DB.prepare(
    "SELECT id, manifest_object_key FROM conversation_revisions ORDER BY created_at",
  ).all<{ id: string; manifest_object_key: string }>();
  const missingManifests: string[] = [];
  const missingSegments: string[] = [];
  const corruptManifests: string[] = [];
  const corruptSegments: Array<{
    revisionId: string;
    segmentIndex: number;
    lineNumber: number;
  }> = [];
  const invalidMessageKeys: Array<{
    conversationId: string;
    revisionId: string;
    sourceNodeId: string;
    reason: "invalid_format" | "invalid_type";
  }> = [];
  const duplicateMessageKeys: Array<{
    conversationId: string;
    revisionId: string;
    messageKey: string;
    sourceNodeIds: string[];
  }> = [];
  for (const revision of revisions.results) {
    const manifest = await env.MEMORY_BUCKET.get(revision.manifest_object_key);
    if (!manifest) {
      missingManifests.push(revision.id);
      continue;
    }
    let parsed: {
      conversationId?: string;
      segments: Array<{ id?: string; key?: string }>;
    };
    try {
      const value: unknown = JSON.parse(await manifest.text());
      if (
        !isRecord(value) ||
        !Array.isArray(value.segments) ||
        value.segments.some(
          (segment) =>
            !isRecord(segment) || (segment.key !== undefined && typeof segment.key !== "string"),
        )
      ) {
        corruptManifests.push(revision.id);
        continue;
      }
      parsed = {
        ...(typeof value.conversationId === "string"
          ? { conversationId: value.conversationId }
          : {}),
        segments: value.segments as Array<{ id?: string; key?: string }>,
      };
    } catch {
      corruptManifests.push(revision.id);
      continue;
    }
    const nodesByKey = new Map<string, string[]>();
    for (const [segmentIndex, segment] of parsed.segments.entries()) {
      if (!segment.key || !(await env.MEMORY_BUCKET.head(segment.key))) {
        // Report only the revision and segment position; R2 object keys are internal.
        missingSegments.push(`${revision.id}:segment-${segmentIndex}`);
        continue;
      }
      const segmentObject = await env.MEMORY_BUCKET.get(segment.key);
      if (!segmentObject) continue;
      const lines = (await segmentObject.text()).split("\n");
      for (const [lineIndex, line] of lines.entries()) {
        if (!line) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line) as unknown;
        } catch {
          corruptSegments.push({
            revisionId: revision.id,
            segmentIndex,
            lineNumber: lineIndex + 1,
          });
          continue;
        }
        if (lineIndex === 0 && (!isRecord(entry) || !isRecord(entry.conversation))) {
          corruptSegments.push({
            revisionId: revision.id,
            segmentIndex,
            lineNumber: lineIndex + 1,
          });
          continue;
        }
        if (lineIndex === 0) continue;
        if (
          !isRecord(entry) ||
          entry.type !== "node" ||
          !isRecord(entry.node) ||
          typeof entry.node.sourceNodeId !== "string"
        ) {
          corruptSegments.push({
            revisionId: revision.id,
            segmentIndex,
            lineNumber: lineIndex + 1,
          });
          continue;
        }
        if (!("messageKey" in entry.node)) continue;
        const sourceNodeId = entry.node.sourceNodeId;
        const rawMessageKey = entry.node.messageKey;
        if (!isValidMessageKey(rawMessageKey)) {
          invalidMessageKeys.push({
            conversationId: parsed.conversationId ?? "",
            revisionId: revision.id,
            sourceNodeId,
            reason: typeof rawMessageKey === "string" ? "invalid_format" : "invalid_type",
          });
          continue;
        }
        const sourceNodeIds = nodesByKey.get(rawMessageKey) ?? [];
        sourceNodeIds.push(sourceNodeId);
        nodesByKey.set(rawMessageKey, sourceNodeIds);
      }
    }
    for (const [messageKey, sourceNodeIds] of nodesByKey) {
      if (sourceNodeIds.length > 1) {
        duplicateMessageKeys.push({
          conversationId: parsed.conversationId ?? "",
          revisionId: revision.id,
          messageKey,
          sourceNodeIds,
        });
      }
    }
  }
  return {
    checkedRevisions: revisions.results.length,
    missingManifests,
    missingSegments,
    corruptManifests,
    corruptSegments,
    invalidMessageKeys,
    duplicateMessageKeys,
  };
}
