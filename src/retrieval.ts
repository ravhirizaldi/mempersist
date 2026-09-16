import type { AppEnv, CanonicalConversation, CanonicalNode } from "./domain";
import { AppError } from "./errors";
import { loadCanonicalRevision, loadConversationTags } from "./storage";

interface ChunkSourceRow {
  revision_id: string;
  source_node_id: string;
  source_sequence: number | null;
  char_start: number;
  char_end: number;
  ordinal: number;
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
    `SELECT c.revision_id, s.source_node_id, s.source_sequence, s.char_start, s.char_end, s.ordinal
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
  if (activeSequences.length) {
    const start = Math.max(0, Math.min(...activeSequences) - Math.min(10, Math.max(0, before)));
    const end = Math.min(
      active.length,
      Math.max(...activeSequences) + Math.min(10, Math.max(0, after)) + 1,
    );
    messages = active.slice(start, end).flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  } else {
    const ids = new Set<string>();
    for (const source of result.results) {
      ids.add(source.source_node_id);
      const node = byId.get(source.source_node_id);
      if (node?.parentSourceNodeId) ids.add(node.parentSourceNodeId);
      node?.childSourceNodeIds.forEach((id) => ids.add(id));
    }
    messages = [...ids].flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
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

export function conversationPage(
  conversation: CanonicalConversation,
  revisionId: string,
  tags: string[],
  offset: number,
  limit: number,
  branch: "active" | "all" = "active",
) {
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

export const COMPACT_RESPONSE_BYTES = 48 * 1024;

export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function compactMessage({ sourceNodeId, role, createdAt, updatedAt, text }: CanonicalNode) {
  return { sourceNodeId, role, createdAt, updatedAt, text };
}

function compactMetadata(
  conversation: { id: string; title: string; namespace: string },
  revisionId: string,
  tags: string[],
) {
  return {
    id: conversation.id,
    revisionId,
    title: conversation.title,
    namespace: conversation.namespace,
    tags,
  };
}

export function compactConversationPage(page: ReturnType<typeof conversationPage>, offset: number) {
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
    oversizedMessage: null as { offset: number; sourceNodeId: string; bytes: number } | null,
  };
}

type CompactPage = ReturnType<typeof compactConversationPage>;

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

type BatchEntry = {
  requestIndex: number;
  status: "ok" | "error" | "deferred";
  continuation: ConversationRequest | null;
  page?: CompactPage;
  error?: { code: string; message: string };
};

export async function getConversations(
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
          error: {
            code: loaded.reason instanceof AppError ? loaded.reason.code : "CANONICAL_STORAGE",
            message:
              loaded.reason instanceof AppError && loaded.reason.code === "NOT_FOUND"
                ? "Conversation or revision not found"
                : "Canonical read failed",
          },
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
      // Reserve room for each remaining entry's error or 64-character revision pin.
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

export async function verifyIntegrity(env: AppEnv): Promise<{
  checkedRevisions: number;
  missingManifests: string[];
  missingSegments: string[];
}> {
  const revisions = await env.MEMORY_DB.prepare(
    "SELECT id, manifest_object_key FROM conversation_revisions ORDER BY created_at",
  ).all<{ id: string; manifest_object_key: string }>();
  const missingManifests: string[] = [];
  const missingSegments: string[] = [];
  for (const revision of revisions.results) {
    const manifest = await env.MEMORY_BUCKET.get(revision.manifest_object_key);
    if (!manifest) {
      missingManifests.push(revision.id);
      continue;
    }
    const parsed = JSON.parse(await manifest.text()) as { segments?: Array<{ key?: string }> };
    for (const segment of parsed.segments ?? []) {
      if (!segment.key || !(await env.MEMORY_BUCKET.head(segment.key))) {
        missingSegments.push(`${revision.id}:${segment.key ?? "missing-key"}`);
      }
    }
  }
  return { checkedRevisions: revisions.results.length, missingManifests, missingSegments };
}
