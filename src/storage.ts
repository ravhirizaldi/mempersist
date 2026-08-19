import { domainId, sha256, stableJson } from "./crypto";
import {
  normalizeTags,
  type AppEnv,
  type CanonicalConversation,
  type CanonicalNode,
  type CanonicalRevisionManifest,
} from "./domain";
import { AppError } from "./errors";
import { OWNER_DB_USER_ID } from "./tenant";

const encoder = new TextEncoder();

interface ConversationRow {
  id: string;
  source_type: string;
  source_id: string | null;
  title: string;
  tags: string[];
  current_revision_id: string | null;
  current_node_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  namespace: string;
  user_id: string;
}

interface RevisionRow {
  id: string;
  conversation_id: string;
  manifest_object_key: string;
}

type CanonicalReadEnv = Pick<AppEnv, "MEMORY_DB" | "MEMORY_BUCKET">;

export interface StoredRevision {
  conversationId: string;
  revisionId: string;
  manifestKey: string;
  segmentKey: string;
  contentHash: string;
  created: boolean;
}

function chunked<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    groups.push(values.slice(index, index + size));
  return groups;
}

async function putImmutable(
  bucket: R2Bucket,
  key: string,
  body: string,
  metadata: Record<string, string>,
) {
  const existing = await bucket.head(key);
  if (existing) return;
  await bucket.put(key, body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: metadata,
  });
}

export async function writeCanonicalConversation(
  env: AppEnv,
  conversation: CanonicalConversation,
  importId: string | null,
  expectedRevisionId: string | null = null,
  userId: string = OWNER_DB_USER_ID,
): Promise<StoredRevision> {
  const header = { ...conversation, nodes: undefined };
  const lines = [
    stableJson({ format: "mempersist.conversation-segment.v1", conversation: header }),
  ];
  for (const node of conversation.nodes) lines.push(stableJson({ type: "node", node }));
  const segmentBody = `${lines.join("\n")}\n`;
  const sizeBytes = encoder.encode(segmentBody).byteLength;
  const segmentHash = await sha256(segmentBody);
  const segmentId = await domainId("segment", segmentHash);
  const contentHash = await domainId(
    "revision-content",
    segmentHash,
    conversation.currentSourceNodeId,
    stableJson(conversation.metadata),
  );
  const revisionId = await domainId("revision", conversation.id, contentHash);
  const segmentKey = `canonical/conversations/${conversation.id}/segments/${segmentHash}.jsonl`;
  const manifestKey = `canonical/conversations/${conversation.id}/revisions/${revisionId}.json`;
  const manifest: CanonicalRevisionManifest = {
    format: "mempersist.conversation-revision.v1",
    conversationId: conversation.id,
    revisionId,
    sourceType: conversation.sourceType,
    sourceId: conversation.sourceId,
    title: conversation.title,
    namespace: conversation.namespace,
    tags: conversation.tags ?? [],
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    currentSourceNodeId: conversation.currentSourceNodeId,
    activeSourceNodeIds: conversation.activeSourceNodeIds,
    nodeCount: conversation.nodes.length,
    contentHash,
    segments: [{ id: segmentId, key: segmentKey, sha256: segmentHash, sizeBytes }],
    metadata: conversation.metadata,
    anomalies: conversation.anomalies,
  };

  try {
    await putImmutable(env.MEMORY_BUCKET, segmentKey, segmentBody, {
      sha256: segmentHash,
      format: "mempersist.conversation-segment.v1",
    });
    await putImmutable(env.MEMORY_BUCKET, manifestKey, stableJson(manifest), {
      sha256: await sha256(stableJson(manifest)),
      format: manifest.format,
    });
  } catch (error) {
    throw new AppError(
      "CANONICAL_STORAGE",
      `R2 canonical write failed: ${error instanceof Error ? error.message : String(error)}`,
      503,
      true,
    );
  }

  const existing = await env.MEMORY_DB.prepare("SELECT id FROM conversation_revisions WHERE id = ?")
    .bind(revisionId)
    .first<{ id: string }>();
  const now = new Date().toISOString();
  const activeSequence = new Map(conversation.activeSourceNodeIds.map((id, index) => [id, index]));
  const conversationStatement = expectedRevisionId
    ? env.MEMORY_DB.prepare(
        `INSERT INTO conversations
         (id, source_type, source_id, title, current_revision_id, current_node_id, created_at, updated_at, imported_at, namespace, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           namespace = excluded.namespace,
           imported_at = excluded.imported_at`,
      )
    : env.MEMORY_DB.prepare(
        `INSERT INTO conversations
       (id, source_type, source_id, title, current_revision_id, current_node_id, created_at, updated_at, imported_at, namespace, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         current_revision_id = excluded.current_revision_id,
         current_node_id = excluded.current_node_id,
         updated_at = excluded.updated_at,
         imported_at = excluded.imported_at,
         namespace = excluded.namespace
       WHERE COALESCE(excluded.updated_at, '') >= COALESCE(conversations.updated_at, '')`,
      );
  const statements: D1PreparedStatement[] = [
    conversationStatement.bind(
      conversation.id,
      conversation.sourceType,
      conversation.sourceId,
      conversation.title,
      revisionId,
      conversation.currentSourceNodeId,
      conversation.createdAt,
      conversation.updatedAt,
      now,
      conversation.namespace,
      userId,
    ),
    env.MEMORY_DB.prepare(
      `INSERT INTO canonical_segments (id, object_key, sha256, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    ).bind(segmentId, segmentKey, segmentHash, sizeBytes, now),
    env.MEMORY_DB.prepare(
      `INSERT INTO conversation_revisions
       (id, conversation_id, import_id, content_hash, manifest_object_key, current_node_id, node_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    ).bind(
      revisionId,
      conversation.id,
      importId,
      contentHash,
      manifestKey,
      conversation.currentSourceNodeId,
      conversation.nodes.length,
      now,
    ),
    env.MEMORY_DB.prepare(
      `INSERT INTO revision_segments (revision_id, segment_id, ordinal)
       VALUES (?, ?, 0) ON CONFLICT(revision_id, ordinal) DO NOTHING`,
    ).bind(revisionId, segmentId),
  ];

  for (const [index, node] of conversation.nodes.entries()) {
    statements.push(
      env.MEMORY_DB.prepare(
        `INSERT INTO message_nodes
         (id, revision_id, source_node_id, parent_node_id, role, sequence, is_active, created_at, updated_at, model_slug, segment_id, line_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(revision_id, source_node_id) DO NOTHING`,
      ).bind(
        node.id,
        revisionId,
        node.sourceNodeId,
        node.parentSourceNodeId,
        node.role,
        activeSequence.get(node.sourceNodeId) ?? null,
        activeSequence.has(node.sourceNodeId) ? 1 : 0,
        node.createdAt,
        node.updatedAt,
        node.modelSlug,
        segmentId,
        index + 2,
      ),
    );
  }
  for (const tag of conversation.tags ?? []) {
    statements.push(
      env.MEMORY_DB.prepare(
        `INSERT INTO conversation_tags (conversation_id, tag) VALUES (?, ?)
         ON CONFLICT(conversation_id, tag) DO NOTHING`,
      ).bind(conversation.id, tag),
    );
  }
  for (const group of chunked(statements, 50)) await env.MEMORY_DB.batch(group);

  if (expectedRevisionId) {
    const result = await env.MEMORY_DB.prepare(
      `UPDATE conversations SET current_revision_id = ?, current_node_id = ?, updated_at = ?, imported_at = ?
       WHERE id = ? AND current_revision_id = ?`,
    )
      .bind(
        revisionId,
        conversation.currentSourceNodeId,
        conversation.updatedAt,
        now,
        conversation.id,
        expectedRevisionId,
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new AppError(
        "IMPORT_CONFLICT",
        "Conversation changed before append completed",
        409,
        false,
      );
    }
  }

  return {
    conversationId: conversation.id,
    revisionId,
    manifestKey,
    segmentKey,
    contentHash,
    created: !existing,
  };
}

function parseSegment(text: string): CanonicalConversation {
  const lines = text.split("\n").filter(Boolean);
  const header = JSON.parse(lines.shift() ?? "null") as unknown;
  if (!header || typeof header !== "object" || !("conversation" in header)) {
    throw new AppError("CANONICAL_STORAGE", "Invalid canonical segment header", 500);
  }
  const headerConversation = (
    header as { conversation: Partial<Omit<CanonicalConversation, "nodes">> }
  ).conversation;
  const nodes: CanonicalNode[] = lines.map((line) => {
    const entry = JSON.parse(line) as { node?: CanonicalNode };
    if (!entry.node) throw new AppError("CANONICAL_STORAGE", "Invalid canonical node line", 500);
    return entry.node;
  });
  return {
    ...(headerConversation as Omit<CanonicalConversation, "nodes">),
    tags: normalizeTags(headerConversation.tags ?? []),
    nodes,
  };
}

export async function loadConversationTags(
  env: CanonicalReadEnv,
  conversationIds: string[],
): Promise<Map<string, string[]>> {
  const tags = new Map<string, string[]>();
  for (let index = 0; index < conversationIds.length; index += 50) {
    const batch = conversationIds.slice(index, index + 50);
    if (!batch.length) continue;
    const result = await env.MEMORY_DB.prepare(
      `SELECT conversation_id, tag FROM conversation_tags
       WHERE conversation_id IN (${batch.map(() => "?").join(",")})
       ORDER BY rowid`,
    )
      .bind(...batch)
      .all<{ conversation_id: string; tag: string }>();
    for (const row of result.results) {
      const list = tags.get(row.conversation_id) ?? [];
      list.push(row.tag);
      tags.set(row.conversation_id, list);
    }
  }
  return tags;
}

async function withTags(
  env: CanonicalReadEnv,
  rows: ConversationRow[],
): Promise<ConversationRow[]> {
  const tags = await loadConversationTags(
    env,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, tags: tags.get(row.id) ?? [] }));
}

export async function loadCanonicalRevision(
  env: CanonicalReadEnv,
  revisionId: string,
): Promise<{ manifest: CanonicalRevisionManifest; conversation: CanonicalConversation }> {
  const row = await env.MEMORY_DB.prepare(
    "SELECT id, conversation_id, manifest_object_key FROM conversation_revisions WHERE id = ?",
  )
    .bind(revisionId)
    .first<RevisionRow>();
  if (!row) throw new AppError("NOT_FOUND", "Revision not found", 404);
  const manifestObject = await env.MEMORY_BUCKET.get(row.manifest_object_key);
  if (!manifestObject)
    throw new AppError("CANONICAL_STORAGE", "Revision manifest missing from R2", 500);
  const manifest = JSON.parse(await manifestObject.text()) as CanonicalRevisionManifest;
  const segment = manifest.segments[0];
  if (!segment) throw new AppError("CANONICAL_STORAGE", "Revision has no canonical segment", 500);
  const segmentObject = await env.MEMORY_BUCKET.get(segment.key);
  if (!segmentObject)
    throw new AppError("CANONICAL_STORAGE", "Canonical segment missing from R2", 500);
  return { manifest, conversation: parseSegment(await segmentObject.text()) };
}

export async function loadCurrentConversation(
  env: AppEnv,
  conversationId: string,
  expectedNamespaces?: string[],
  expectedUserId?: string,
): Promise<{
  row: ConversationRow;
  manifest: CanonicalRevisionManifest;
  conversation: CanonicalConversation;
}> {
  const row = await env.MEMORY_DB.prepare(
    `SELECT id, source_type, source_id, title, current_revision_id, current_node_id, created_at, updated_at, namespace, user_id
     FROM conversations WHERE id = ? AND deleted_at IS NULL${expectedUserId ? " AND user_id = ?" : ""}`,
  )
    .bind(conversationId, ...(expectedUserId ? [expectedUserId] : []))
    .first<ConversationRow>();
  if (!row?.current_revision_id) throw new AppError("NOT_FOUND", "Conversation not found", 404);
  if (expectedNamespaces?.length && !expectedNamespaces.includes(row.namespace)) {
    throw new AppError("NOT_FOUND", "Conversation not found", 404);
  }
  const tags = (await loadConversationTags(env, [row.id])).get(row.id) ?? [];
  return {
    row: { ...row, tags },
    ...(await loadCanonicalRevision(env, row.current_revision_id)),
  };
}

export async function listConversations(
  env: AppEnv,
  input: {
    limit: number;
    cursor?: string;
    userId?: string;
    namespace?: string;
    namespaces?: string[];
    tags?: string[];
    tagMode?: "any" | "all";
  },
): Promise<{ conversations: ConversationRow[]; nextCursor: string | null }> {
  const limit = Math.min(100, Math.max(1, input.limit));
  const where = ["deleted_at IS NULL"];
  const params: Array<string | number> = [];
  const tags = normalizeTags(input.tags ?? []);
  if (tags.length) {
    where.push(
      input.tagMode === "any"
        ? `id IN (SELECT DISTINCT conversation_id FROM conversation_tags WHERE tag IN (${tags
            .map(() => "?")
            .join(",")}))`
        : `id IN (SELECT conversation_id FROM conversation_tags WHERE tag IN (${tags
            .map(() => "?")
            .join(",")}) GROUP BY conversation_id HAVING COUNT(*) = ?)`,
    );
    params.push(...tags);
    if (input.tagMode !== "any") params.push(tags.length);
  }
  const namespaces = input.namespaces?.length
    ? input.namespaces
    : input.namespace
      ? [input.namespace]
      : [];
  if (namespaces.length) {
    where.push(`namespace IN (${namespaces.map(() => "?").join(",")})`);
    params.push(...namespaces);
  }
  if (input.userId) {
    where.push("user_id = ?");
    params.push(input.userId);
  }
  if (input.cursor) {
    where.push("id > ?");
    params.push(input.cursor);
  }
  params.push(limit + 1);
  const result = await env.MEMORY_DB.prepare(
    `SELECT id, source_type, source_id, title, current_revision_id, current_node_id, created_at, updated_at, namespace, user_id
     FROM conversations WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`,
  )
    .bind(...params)
    .all<ConversationRow>();
  const rows = result.results;
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  return {
    conversations: await withTags(env, rows),
    nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
  };
}

export async function updateConversationTags(
  env: AppEnv,
  conversationId: string,
  baseRevisionId: string,
  add: string[],
  remove: string[],
  expectedNamespaces?: string[],
  expectedUserId?: string,
): Promise<{ conversationId: string; tags: string[] }> {
  const loaded = await loadCurrentConversation(
    env,
    conversationId,
    expectedNamespaces,
    expectedUserId,
  );
  if (loaded.row.current_revision_id !== baseRevisionId) {
    throw new AppError("IMPORT_CONFLICT", "base_revision_id is stale", 409);
  }
  const toAdd = normalizeTags(add);
  const toRemove = normalizeTags(remove);
  // Removals are applied first so a tag present in both lists ends up added.
  const statements: D1PreparedStatement[] = [
    ...toRemove.map((tag) =>
      env.MEMORY_DB.prepare(
        `DELETE FROM conversation_tags WHERE conversation_id = ? AND tag = ?`,
      ).bind(conversationId, tag),
    ),
    ...toAdd.map((tag) =>
      env.MEMORY_DB.prepare(
        `INSERT INTO conversation_tags (conversation_id, tag) VALUES (?, ?)
         ON CONFLICT(conversation_id, tag) DO NOTHING`,
      ).bind(conversationId, tag),
    ),
  ];
  if (statements.length) await env.MEMORY_DB.batch(statements);
  const tags = (await loadConversationTags(env, [conversationId])).get(conversationId) ?? [];
  return { conversationId, tags };
}

export async function appendConversation(
  env: AppEnv,
  conversationId: string,
  baseRevisionId: string,
  messages: Array<{ role: string; content: string; timestamp?: string | undefined }>,
  tags?: string[],
  expectedNamespaces?: string[],
  expectedUserId?: string,
): Promise<StoredRevision> {
  const loaded = await loadCurrentConversation(
    env,
    conversationId,
    expectedNamespaces,
    expectedUserId,
  );
  if (loaded.row.current_revision_id !== baseRevisionId) {
    throw new AppError("IMPORT_CONFLICT", "base_revision_id is stale", 409);
  }
  const nodes = [...loaded.conversation.nodes];
  let parent = loaded.conversation.currentSourceNodeId;
  for (const [index, message] of messages.entries()) {
    const sourceNodeId = `append-${crypto.randomUUID()}`;
    const node: CanonicalNode = {
      id: await domainId("message-node", conversationId, sourceNodeId),
      sourceNodeId,
      parentSourceNodeId: parent,
      childSourceNodeIds: [],
      role: message.role,
      text: message.content,
      content: { content_type: "text", parts: [message.content] },
      createdAt: message.timestamp ?? new Date().toISOString(),
      updatedAt: null,
      modelSlug: null,
      metadata: { append_ordinal: index },
      raw: {},
    };
    if (parent)
      nodes
        .find((candidate) => candidate.sourceNodeId === parent)
        ?.childSourceNodeIds.push(sourceNodeId);
    nodes.push(node);
    parent = sourceNodeId;
  }
  const updated: CanonicalConversation = {
    ...loaded.conversation,
    nodes,
    tags: normalizeTags([...(loaded.conversation.tags ?? []), ...(tags ?? [])]),
    updatedAt: new Date().toISOString(),
    currentSourceNodeId: parent,
    activeSourceNodeIds: [
      ...loaded.conversation.activeSourceNodeIds,
      ...nodes.slice(-messages.length).map((node) => node.sourceNodeId),
    ],
  };
  return writeCanonicalConversation(env, updated, null, baseRevisionId, loaded.row.user_id);
}
