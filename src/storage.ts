import { domainId, sha256, stableJson } from "./crypto";
import {
  normalizeTags,
  type AppEnv,
  type CanonicalConversation,
  type CanonicalNode,
  type CanonicalRevisionManifest,
} from "./domain";
import { AppError, errorDetails } from "./errors";
import { assertAccountWritable, OWNER_DB_USER_ID } from "./tenant";

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
  writeOffset?: number;
}

export interface RestoredRevision extends StoredRevision {
  previousRevisionId: string;
  transitionId: string;
  transitionKey?: string;
}

export interface CanonicalTransitionRecord {
  format: "mempersist.conversation-transition.v1";
  transitionId: string;
  conversationId: string;
  operation: "restore";
  previousRevisionId: string;
  restoredRevisionId: string;
  userId: string;
  createdAt: string;
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
  await assertAccountWritable(env, userId, conversation.namespace);
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
    derivedFrom: conversation.derivedFrom ?? null,
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
    derivedFrom: headerConversation.derivedFrom ?? null,
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
  expected?: StoredRevision,
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
  manifest.derivedFrom ??= null;
  const segment = manifest.segments[0];
  if (!segment) throw new AppError("CANONICAL_STORAGE", "Revision has no canonical segment", 500);
  const segmentObject = await env.MEMORY_BUCKET.get(segment.key);
  if (!segmentObject)
    throw new AppError("CANONICAL_STORAGE", "Canonical segment missing from R2", 500);
  const body = await segmentObject.text();
  const conversation = parseSegment(body);
  if (expected) {
    const segmentHash = await sha256(body);
    const contentHash = await domainId(
      "revision-content",
      segmentHash,
      conversation.currentSourceNodeId,
      stableJson(conversation.metadata),
    );
    if (
      manifest.revisionId !== expected.revisionId ||
      manifest.conversationId !== expected.conversationId ||
      conversation.id !== expected.conversationId ||
      row.manifest_object_key !== expected.manifestKey ||
      segment.key !== expected.segmentKey ||
      segment.sha256 !== segmentHash ||
      manifest.contentHash !== expected.contentHash ||
      contentHash !== expected.contentHash
    ) {
      throw new AppError("CANONICAL_STORAGE", "Committed revision integrity mismatch", 500);
    }
  }
  return { manifest, conversation };
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
  const loaded = await loadCanonicalRevision(env, row.current_revision_id);
  return {
    row: { ...row, tags },
    ...loaded,
    conversation: { ...loaded.conversation, tags },
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

export const RESOLVE_MATCH_CAP = 50;

export interface ConversationResolveRequest {
  title: string;
  namespaces: string[];
  tags?: string[];
  tagMode?: "any" | "all";
}

export interface ConversationResolveMatch {
  conversationId: string;
  revisionId: string;
  title: string;
  namespace: string;
  tags: string[];
  updatedAt: string | null;
}

export interface ConversationResolveResultItem {
  requestIndex: number;
  status: "ok" | "not_found" | "ambiguous";
  matches: ConversationResolveMatch[];
  hasMore: boolean;
}

interface ResolveRow {
  id: string;
  title: string;
  namespace: string;
  current_revision_id: string;
  updated_at: string | null;
}

export async function resolveConversations(
  env: CanonicalReadEnv,
  userId: string,
  requests: ConversationResolveRequest[],
): Promise<ConversationResolveResultItem[]> {
  if (requests.length === 0) return [];

  const statements: D1PreparedStatement[] = [];
  for (const req of requests) {
    const where = [
      "user_id = ?",
      "deleted_at IS NULL",
      "current_revision_id IS NOT NULL",
      "title = ?",
    ];
    const params: Array<string | number> = [userId, req.title];

    if (req.namespaces.length === 0) {
      where.push("1 = 0");
    } else {
      where.push(`namespace IN (${req.namespaces.map(() => "?").join(",")})`);
      params.push(...req.namespaces);
    }

    const tags = normalizeTags(req.tags ?? []);
    if (tags.length) {
      where.push(
        req.tagMode === "any"
          ? `id IN (SELECT DISTINCT conversation_id FROM conversation_tags WHERE tag IN (${tags
              .map(() => "?")
              .join(",")}))`
          : `id IN (SELECT conversation_id FROM conversation_tags WHERE tag IN (${tags
              .map(() => "?")
              .join(",")}) GROUP BY conversation_id HAVING COUNT(*) = ?)`,
      );
      params.push(...tags);
      if (req.tagMode !== "any") params.push(tags.length);
    }

    statements.push(
      env.MEMORY_DB.prepare(
        `SELECT id, title, namespace, current_revision_id, updated_at
         FROM conversations
         WHERE ${where.join(" AND ")}
         ORDER BY id
         LIMIT ?`,
      ).bind(...params, RESOLVE_MATCH_CAP + 1),
    );
  }

  const batchResults = await env.MEMORY_DB.batch<ResolveRow>(statements);
  const allConversationIds = Array.from(
    new Set(batchResults.flatMap((r) => r.results.map((row) => row.id))),
  );
  const tagsMap = await loadConversationTags(env, allConversationIds);

  return batchResults.map((result, index) => {
    const rows = [...result.results];
    const hasMore = rows.length > RESOLVE_MATCH_CAP;
    if (hasMore) rows.pop();

    const matches: ConversationResolveMatch[] = rows.map((row) => ({
      conversationId: row.id,
      revisionId: row.current_revision_id,
      title: row.title,
      namespace: row.namespace,
      tags: tagsMap.get(row.id) ?? [],
      updatedAt: row.updated_at,
    }));

    let status: "ok" | "not_found" | "ambiguous";
    if (matches.length === 0) {
      status = "not_found";
    } else if (matches.length === 1 && !hasMore) {
      status = "ok";
    } else {
      status = "ambiguous";
    }

    return {
      requestIndex: index,
      status,
      matches,
      hasMore,
    };
  });
}

interface RevisionCatalogRow {
  id: string;
  content_hash: string;
  node_count: number;
  created_at: string;
}

export interface ConversationRevisionSummary {
  revisionId: string;
  createdAt: string;
  nodeCount: number;
  contentHash: string;
}

interface RevisionCursorState {
  anchorRevisionId: string;
  currentRevisionId: string;
  createdAt: string;
  revisionId: string;
}

interface RevisionAnchor {
  revisionId: string;
  rowId: number;
}

const REVISION_CURSOR_SEPARATOR = "\u001f";

function invalidRevisionCursor(): never {
  throw new AppError("VALIDATION", "Invalid cursor", 400);
}

function encodeRevisionCursor(state: RevisionCursorState): string {
  return btoa(
    [state.anchorRevisionId, state.currentRevisionId, state.createdAt, state.revisionId].join(
      REVISION_CURSOR_SEPARATOR,
    ),
  );
}

// The cursor carries the exact (created_at, id) ordering key of the last returned row,
// the snapshot anchor, and the head that was current when the walk started. Every value
// is already returned to the caller; internal catalog rowids never leave the server.
function decodeRevisionCursor(cursor: string): RevisionCursorState {
  let decoded: string;
  try {
    decoded = atob(cursor);
  } catch {
    return invalidRevisionCursor();
  }
  const parts = decoded.split(REVISION_CURSOR_SEPARATOR);
  if (parts.length !== 4 || parts.some((part) => !part)) return invalidRevisionCursor();
  const [anchorRevisionId, currentRevisionId, createdAt, revisionId] = parts as [
    string,
    string,
    string,
    string,
  ];
  return { anchorRevisionId, currentRevisionId, createdAt, revisionId };
}

// Resolves a cursor anchor inside this conversation only. Its rowid is the private
// snapshot bound: later inserts have greater rowids and cannot enter continuation pages.
async function resolveRevisionAnchor(
  env: Pick<AppEnv, "MEMORY_DB">,
  conversationId: string,
  revisionId: string,
): Promise<RevisionAnchor | null> {
  const row = await env.MEMORY_DB.prepare(
    `SELECT id, rowid AS row_id FROM conversation_revisions
     WHERE conversation_id = ? AND id = ?`,
  )
    .bind(conversationId, revisionId)
    .first<{ id: string; row_id: number }>();
  return row ? { revisionId: row.id, rowId: row.row_id } : null;
}

// Metadata only: transcript bodies stay in R2 behind the revision-pinned read path.
export async function listConversationRevisions(
  env: Pick<AppEnv, "MEMORY_DB">,
  input: {
    conversationId: string;
    limit: number;
    cursor?: string;
    namespaces?: string[];
    userId?: string;
  },
): Promise<{
  conversationId: string;
  currentRevisionId: string;
  revisions: ConversationRevisionSummary[];
  nextCursor: string | null;
}> {
  const limit = Math.min(100, Math.max(1, input.limit));
  // One statement pins the live head and latest inserted revision to the same D1
  // snapshot. A live row without a valid current revision is not readable history.
  const scope = await env.MEMORY_DB.prepare(
    `WITH target AS (
       SELECT id, current_revision_id, namespace FROM conversations
       WHERE id = ? AND deleted_at IS NULL${input.userId ? " AND user_id = ?" : ""}
     )
     SELECT current.id AS current_revision_id,
            target.namespace,
            anchor.id AS anchor_revision_id,
            anchor.rowid AS anchor_row_id
     FROM target
     JOIN conversation_revisions current
       ON current.conversation_id = target.id AND current.id = target.current_revision_id
     LEFT JOIN conversation_revisions anchor
       ON anchor.conversation_id = target.id
      AND anchor.rowid = (
        SELECT MAX(revision.rowid) FROM conversation_revisions revision
        WHERE revision.conversation_id = target.id
      )`,
  )
    .bind(input.conversationId, ...(input.userId ? [input.userId] : []))
    .first<{
      current_revision_id: string;
      namespace: string;
      anchor_revision_id: string | null;
      anchor_row_id: number | null;
    }>();
  // Missing, deleted, foreign, empty-history, and unreadable conversations share one not-found.
  if (!scope?.anchor_revision_id || scope.anchor_row_id === null) {
    throw new AppError("NOT_FOUND", "Conversation not found", 404);
  }
  if (input.namespaces?.length && !input.namespaces.includes(scope.namespace)) {
    throw new AppError("NOT_FOUND", "Conversation not found", 404);
  }

  const cursor = input.cursor ? decodeRevisionCursor(input.cursor) : null;
  let anchor: RevisionAnchor = {
    revisionId: scope.anchor_revision_id,
    rowId: scope.anchor_row_id,
  };
  let currentRevisionId = scope.current_revision_id;
  if (cursor) {
    const resolved = await resolveRevisionAnchor(
      env,
      input.conversationId,
      cursor.anchorRevisionId,
    );
    if (!resolved) return invalidRevisionCursor();
    anchor = resolved;

    // Validate both cursor revision IDs against the owned snapshot. The boundary's
    // timestamp must match so a forged cursor cannot silently skip history.
    const pinned = await env.MEMORY_DB.prepare(
      `SELECT id, created_at FROM conversation_revisions
       WHERE conversation_id = ? AND rowid <= ? AND id IN (?, ?)`,
    )
      .bind(input.conversationId, anchor.rowId, cursor.currentRevisionId, cursor.revisionId)
      .all<{ id: string; created_at: string }>();
    const byId = new Map(pinned.results.map((revision) => [revision.id, revision.created_at]));
    if (!byId.has(cursor.currentRevisionId) || byId.get(cursor.revisionId) !== cursor.createdAt) {
      return invalidRevisionCursor();
    }
    currentRevisionId = cursor.currentRevisionId;
  }

  const where = ["conversation_id = ?", "rowid <= ?"];
  const params: Array<string | number> = [input.conversationId, anchor.rowId];
  if (cursor) {
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(cursor.createdAt, cursor.createdAt, cursor.revisionId);
  }
  params.push(limit + 1);
  const result = await env.MEMORY_DB.prepare(
    `SELECT id, content_hash, node_count, created_at FROM conversation_revisions
     WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...params)
    .all<RevisionCatalogRow>();
  const rows = result.results;
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  return {
    conversationId: input.conversationId,
    currentRevisionId,
    revisions: rows.map((revision) => ({
      revisionId: revision.id,
      createdAt: revision.created_at,
      nodeCount: revision.node_count,
      contentHash: revision.content_hash,
    })),
    nextCursor:
      hasMore && last
        ? encodeRevisionCursor({
            anchorRevisionId: anchor.revisionId,
            currentRevisionId,
            createdAt: last.created_at,
            revisionId: last.id,
          })
        : null,
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
  await assertAccountWritable(env, loaded.row.user_id, loaded.row.namespace);
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
  const stored = await writeCanonicalConversation(
    env,
    updated,
    null,
    baseRevisionId,
    loaded.row.user_id,
  );
  return { ...stored, writeOffset: loaded.conversation.activeSourceNodeIds.length };
}

export async function replaceConversation(
  env: AppEnv,
  conversationId: string,
  baseRevisionId: string,
  messages: Array<{ role: string; content: string; timestamp?: string | undefined }>,
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
  const now = new Date().toISOString();
  const nodes: CanonicalNode[] = [];
  let parent: string | null = null;
  for (const [index, message] of messages.entries()) {
    const sourceNodeId = `replace-${crypto.randomUUID()}`;
    const node: CanonicalNode = {
      id: await domainId("message-node", conversationId, sourceNodeId),
      sourceNodeId,
      parentSourceNodeId: parent,
      childSourceNodeIds: [],
      role: message.role,
      text: message.content,
      content: { content_type: "text", parts: [message.content] },
      createdAt: message.timestamp ?? now,
      updatedAt: null,
      modelSlug: null,
      metadata: { replace_ordinal: index },
      raw: {},
    };
    nodes.at(-1)?.childSourceNodeIds.push(sourceNodeId);
    nodes.push(node);
    parent = sourceNodeId;
  }
  const updated: CanonicalConversation = {
    ...loaded.conversation,
    tags: loaded.row.tags,
    nodes,
    updatedAt: now,
    currentSourceNodeId: parent,
    activeSourceNodeIds: nodes.map((node) => node.sourceNodeId),
  };
  return writeCanonicalConversation(env, updated, null, baseRevisionId, loaded.row.user_id);
}

export async function restoreConversationRevision(
  env: AppEnv,
  conversationId: string,
  revisionId: string,
  baseRevisionId: string,
  expectedNamespaces?: string[],
  expectedUserId?: string,
): Promise<RestoredRevision> {
  const loaded = await loadCurrentConversation(
    env,
    conversationId,
    expectedNamespaces,
    expectedUserId,
  );
  await assertAccountWritable(env, loaded.row.user_id, loaded.row.namespace);

  const targetRow = await env.MEMORY_DB.prepare(
    `SELECT id, conversation_id, manifest_object_key FROM conversation_revisions WHERE id = ? AND conversation_id = ?`,
  )
    .bind(revisionId, conversationId)
    .first<RevisionRow>();
  if (!targetRow) {
    throw new AppError("NOT_FOUND", "Revision not found", 404);
  }

  const target = await loadCanonicalRevision(env, revisionId);
  if (
    target.manifest.conversationId !== conversationId ||
    target.conversation.id !== conversationId ||
    target.manifest.revisionId !== revisionId
  ) {
    throw new AppError("NOT_FOUND", "Revision not found", 404);
  }

  const segment = target.manifest.segments[0];
  if (!segment) {
    throw new AppError("CANONICAL_STORAGE", "Revision has no canonical segment", 500);
  }

  const transitionId = await domainId("transition", conversationId, baseRevisionId, revisionId);
  const transitionKey = `canonical/conversations/${conversationId}/transitions/${transitionId}.json`;

  const existingTransition = await env.MEMORY_DB.prepare(
    `SELECT id, status, previous_revision_id, restored_revision_id
     FROM conversation_head_transitions
     WHERE id = ?`,
  )
    .bind(transitionId)
    .first<{
      id: string;
      status: string;
      previous_revision_id: string;
      restored_revision_id: string;
    }>();

  if (
    loaded.row.current_revision_id === revisionId &&
    existingTransition &&
    existingTransition.previous_revision_id === baseRevisionId &&
    existingTransition.restored_revision_id === revisionId
  ) {
    if (existingTransition.status !== "applied") {
      await env.MEMORY_DB.prepare(
        `UPDATE conversation_head_transitions SET status = 'applied', applied_at = ? WHERE id = ?`,
      )
        .bind(new Date().toISOString(), transitionId)
        .run();
    }
    return {
      conversationId,
      revisionId,
      manifestKey: targetRow.manifest_object_key,
      segmentKey: segment.key,
      contentHash: target.manifest.contentHash,
      created: false,
      previousRevisionId: baseRevisionId,
      transitionId,
      transitionKey,
    };
  }

  if (loaded.row.current_revision_id !== baseRevisionId) {
    throw new AppError("IMPORT_CONFLICT", "base_revision_id is stale", 409);
  }

  const now = new Date().toISOString();
  const transitionRecord: CanonicalTransitionRecord = {
    format: "mempersist.conversation-transition.v1",
    transitionId,
    conversationId,
    operation: "restore",
    previousRevisionId: baseRevisionId,
    restoredRevisionId: revisionId,
    userId: loaded.row.user_id,
    createdAt: now,
  };

  try {
    await putImmutable(env.MEMORY_BUCKET, transitionKey, stableJson(transitionRecord), {
      sha256: await sha256(stableJson(transitionRecord)),
      format: transitionRecord.format,
    });
  } catch (error) {
    throw new AppError(
      "CANONICAL_STORAGE",
      `R2 transition write failed: ${error instanceof Error ? error.message : String(error)}`,
      503,
      true,
    );
  }

  await env.MEMORY_DB.prepare(
    `INSERT INTO conversation_head_transitions
     (id, conversation_id, previous_revision_id, restored_revision_id, operation, user_id, transition_object_key, status, created_at, applied_at)
     VALUES (?, ?, ?, ?, 'restore', ?, ?, 'prepared', ?, NULL)
     ON CONFLICT(id) DO UPDATE SET status = 'prepared' WHERE status != 'applied'`,
  )
    .bind(
      transitionId,
      conversationId,
      baseRevisionId,
      revisionId,
      loaded.row.user_id,
      transitionKey,
      now,
    )
    .run();

  const targetNodeId =
    target.manifest.currentSourceNodeId ?? target.conversation.currentSourceNodeId ?? null;

  const updateResult = await env.MEMORY_DB.prepare(
    `UPDATE conversations
     SET current_revision_id = ?, current_node_id = ?, updated_at = ?
     WHERE id = ? AND current_revision_id = ?`,
  )
    .bind(revisionId, targetNodeId, now, conversationId, baseRevisionId)
    .run();

  if (updateResult.meta.changes !== 1) {
    await env.MEMORY_DB.prepare(
      `UPDATE conversation_head_transitions
       SET status = 'failed'
       WHERE id = ? AND status = 'prepared'`,
    )
      .bind(transitionId)
      .run();

    throw new AppError(
      "IMPORT_CONFLICT",
      "Conversation changed before restore completed",
      409,
      false,
    );
  }

  await env.MEMORY_DB.prepare(
    `UPDATE conversation_head_transitions
     SET status = 'applied', applied_at = ?
     WHERE id = ?`,
  )
    .bind(now, transitionId)
    .run();

  return {
    conversationId,
    revisionId,
    manifestKey: targetRow.manifest_object_key,
    segmentKey: segment.key,
    contentHash: target.manifest.contentHash,
    created: false,
    previousRevisionId: baseRevisionId,
    transitionId,
    transitionKey,
  };
}

export interface CopyConversationRequest {
  conversationId: string;
  revisionId?: string;
  title?: string;
  tags?: { mode: "inherit" | "replace"; add: string[]; remove: string[] };
}

export interface CopyConversationsInput {
  userId: string;
  namespaces: string[];
  targetNamespace: string;
  idempotencyKey: string;
  requests: CopyConversationRequest[];
}

export type CopiedConversationResult =
  | {
      requestIndex: number;
      status: "copied";
      sourceConversationId: string;
      sourceRevisionId: string;
      stored: StoredRevision;
    }
  | {
      requestIndex: number;
      status: "failed";
      sourceConversationId: string;
      error: { code: string; message: string };
    };

interface ConversationCopyOperationRow {
  user_id: string;
  idempotency_key: string;
  material_hash: string;
  target_namespace: string;
  copied_at: string;
  requests_json: string;
  created_at: string;
  updated_at: string;
}

interface StoredCopyRequestState {
  request_index: number;
  source_conversation_id: string;
  pinned_revision_id: string | null;
  destination_conversation_id: string | null;
  destination_revision_id: string | null;
  status: "copied" | "failed";
  error?: { code: string; message: string };
}

function copyTags(
  sourceTags: string[],
  spec: { mode: "inherit" | "replace"; add: string[]; remove: string[] },
): string[] {
  const base = spec.mode === "replace" ? [] : sourceTags;
  const toRemove = new Set(normalizeTags(spec.remove));
  const toAdd = normalizeTags(spec.add);
  const next = normalizeTags([...base.filter((tag) => !toRemove.has(tag)), ...toAdd]);
  if (next.length > 20) {
    throw new AppError("VALIDATION", "Tag set exceeds 20 after normalization", 400);
  }
  return next;
}

export async function copyConversations(
  env: AppEnv,
  input: CopyConversationsInput,
): Promise<CopiedConversationResult[]> {
  await assertAccountWritable(env, input.userId, input.targetNamespace);

  const wireRequests = input.requests.map((req) => ({
    conversation_id: req.conversationId,
    revision_id: req.revisionId ?? null,
    title: req.title ?? null,
    tags: {
      mode: req.tags?.mode ?? "inherit",
      add: req.tags?.add ?? [],
      remove: req.tags?.remove ?? [],
    },
  }));
  const materialHash = await sha256(
    stableJson({
      target_namespace: input.targetNamespace,
      requests: wireRequests,
    }),
  );

  let operationRow = await env.MEMORY_DB.prepare(
    `SELECT user_id, idempotency_key, material_hash, target_namespace, copied_at, requests_json, created_at, updated_at
     FROM conversation_copy_operations
     WHERE user_id = ? AND idempotency_key = ?`,
  )
    .bind(input.userId, input.idempotencyKey)
    .first<ConversationCopyOperationRow>();

  if (operationRow && operationRow.material_hash !== materialHash) {
    throw new AppError(
      "IMPORT_CONFLICT",
      "idempotency_key was reused with different copy material",
      409,
    );
  }

  const now = new Date().toISOString();
  if (!operationRow) {
    await env.MEMORY_DB.prepare(
      `INSERT INTO conversation_copy_operations (
         user_id, idempotency_key, material_hash, target_namespace, copied_at, requests_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
    )
      .bind(
        input.userId,
        input.idempotencyKey,
        materialHash,
        input.targetNamespace,
        now,
        JSON.stringify([]),
        now,
        now,
      )
      .run();

    operationRow = await env.MEMORY_DB.prepare(
      `SELECT user_id, idempotency_key, material_hash, target_namespace, copied_at, requests_json, created_at, updated_at
       FROM conversation_copy_operations
       WHERE user_id = ? AND idempotency_key = ?`,
    )
      .bind(input.userId, input.idempotencyKey)
      .first<ConversationCopyOperationRow>();

    if (!operationRow) {
      throw new AppError(
        "RETRYABLE_INFRASTRUCTURE",
        "Failed to initialize copy operation",
        500,
        true,
      );
    }
    if (operationRow.material_hash !== materialHash) {
      throw new AppError(
        "IMPORT_CONFLICT",
        "idempotency_key was reused with different copy material",
        409,
      );
    }
  }

  const copiedAt = operationRow.copied_at;
  let states: StoredCopyRequestState[];
  try {
    states = JSON.parse(operationRow.requests_json) as StoredCopyRequestState[];
  } catch {
    states = [];
  }

  let pinsChanged = false;
  for (let i = 0; i < input.requests.length; i++) {
    const req = input.requests[i]!;
    let state = states.find((s) => s.request_index === i);

    if (!state || (state.pinned_revision_id === null && state.status !== "failed")) {
      pinsChanged = true;
      const sourceRow = await env.MEMORY_DB.prepare(
        `SELECT id, current_revision_id, namespace FROM conversations WHERE id = ? AND deleted_at IS NULL AND user_id = ?`,
      )
        .bind(req.conversationId, input.userId)
        .first<{ id: string; current_revision_id: string | null; namespace: string }>();

      if (!sourceRow || !input.namespaces.includes(sourceRow.namespace)) {
        state = {
          request_index: i,
          source_conversation_id: req.conversationId,
          pinned_revision_id: null,
          destination_conversation_id: null,
          destination_revision_id: null,
          status: "failed",
          error: { code: "NOT_FOUND", message: "Conversation not found" },
        };
      } else if (!req.revisionId) {
        if (!sourceRow.current_revision_id) {
          state = {
            request_index: i,
            source_conversation_id: req.conversationId,
            pinned_revision_id: null,
            destination_conversation_id: null,
            destination_revision_id: null,
            status: "failed",
            error: { code: "NOT_FOUND", message: "Revision not found" },
          };
        } else {
          state = {
            request_index: i,
            source_conversation_id: req.conversationId,
            pinned_revision_id: sourceRow.current_revision_id,
            destination_conversation_id: null,
            destination_revision_id: null,
            status: "failed",
          };
        }
      } else {
        const revRow = await env.MEMORY_DB.prepare(
          `SELECT id FROM conversation_revisions WHERE id = ? AND conversation_id = ?`,
        )
          .bind(req.revisionId, req.conversationId)
          .first<{ id: string }>();

        if (!revRow) {
          state = {
            request_index: i,
            source_conversation_id: req.conversationId,
            pinned_revision_id: null,
            destination_conversation_id: null,
            destination_revision_id: null,
            status: "failed",
            error: { code: "NOT_FOUND", message: "Revision not found" },
          };
        } else {
          state = {
            request_index: i,
            source_conversation_id: req.conversationId,
            pinned_revision_id: req.revisionId,
            destination_conversation_id: null,
            destination_revision_id: null,
            status: "failed",
          };
        }
      }

      const existingIndex = states.findIndex((s) => s.request_index === i);
      if (existingIndex >= 0) {
        states[existingIndex] = state;
      } else {
        states.push(state);
      }
    }
  }

  states.sort((a, b) => a.request_index - b.request_index);

  if (pinsChanged) {
    await env.MEMORY_DB.prepare(
      `UPDATE conversation_copy_operations SET requests_json = ?, updated_at = ? WHERE user_id = ? AND idempotency_key = ?`,
    )
      .bind(JSON.stringify(states), new Date().toISOString(), input.userId, input.idempotencyKey)
      .run();
  }

  const results: CopiedConversationResult[] = [];

  for (let i = 0; i < input.requests.length; i++) {
    const req = input.requests[i]!;
    const state = states.find((s) => s.request_index === i) ?? {
      request_index: i,
      source_conversation_id: req.conversationId,
      pinned_revision_id: null,
      destination_conversation_id: null,
      destination_revision_id: null,
      status: "failed",
      error: { code: "NOT_FOUND", message: "Conversation not found" },
    };

    if (
      state.status === "copied" &&
      state.destination_conversation_id &&
      state.destination_revision_id &&
      state.pinned_revision_id
    ) {
      try {
        const destConvId = state.destination_conversation_id;
        const destRevId = state.destination_revision_id;
        const { manifest: destManifest } = await loadCanonicalRevision(env, destRevId);
        const destSegment = destManifest.segments[0];
        const manifestKey = `canonical/conversations/${destConvId}/revisions/${destRevId}.json`;
        const segmentKey = destSegment
          ? destSegment.key
          : `canonical/conversations/${destConvId}/segments/${destManifest.segments[0]?.sha256}.jsonl`;
        const stored: StoredRevision = {
          conversationId: destConvId,
          revisionId: destRevId,
          manifestKey,
          segmentKey,
          contentHash: destManifest.contentHash,
          created: false,
        };
        results.push({
          requestIndex: i,
          status: "copied",
          sourceConversationId: req.conversationId,
          sourceRevisionId: state.pinned_revision_id,
          stored,
        });
        continue;
      } catch {
        // Fall back to attempting write below
      }
    }

    if (!state.pinned_revision_id) {
      results.push({
        requestIndex: i,
        status: "failed",
        sourceConversationId: req.conversationId,
        error: state.error ?? { code: "NOT_FOUND", message: "Conversation not found" },
      });
      continue;
    }

    try {
      const pinnedRevId = state.pinned_revision_id;
      let loadedSource: {
        manifest: CanonicalRevisionManifest;
        conversation: CanonicalConversation;
      };
      try {
        loadedSource = await loadCanonicalRevision(env, pinnedRevId);
      } catch (err) {
        if (err instanceof AppError && err.code === "NOT_FOUND") {
          throw err;
        }
        const details = errorDetails(err);
        throw new AppError("CANONICAL_STORAGE", details.message, 500, details.retryable);
      }

      const { manifest: sourceManifest, conversation: sourceConv } = loadedSource;
      if (
        sourceManifest.conversationId !== req.conversationId ||
        sourceConv.id !== req.conversationId
      ) {
        throw new AppError("NOT_FOUND", "Revision not found", 404);
      }

      const destId = await domainId(
        "copy-conversation",
        input.userId,
        input.idempotencyKey,
        String(i),
        sourceConv.id,
        pinnedRevId,
        input.targetNamespace,
      );

      const destTags = copyTags(
        sourceConv.tags ?? [],
        req.tags ?? { mode: "inherit", add: [], remove: [] },
      );

      const destNodes: CanonicalNode[] = [];
      for (const node of sourceConv.nodes) {
        destNodes.push({
          ...node,
          id: await domainId("message-node", destId, node.sourceNodeId),
        });
      }

      const destConversation: CanonicalConversation = {
        id: destId,
        sourceType: sourceConv.sourceType,
        sourceId: sourceConv.sourceId,
        title: req.title ?? sourceConv.title,
        namespace: input.targetNamespace,
        tags: destTags,
        createdAt: sourceConv.createdAt,
        updatedAt: sourceConv.updatedAt,
        currentSourceNodeId: sourceConv.currentSourceNodeId,
        activeSourceNodeIds: sourceConv.activeSourceNodeIds,
        nodes: destNodes,
        metadata: sourceConv.metadata,
        anomalies: sourceConv.anomalies,
        derivedFrom: {
          operation: "copy",
          conversationId: sourceConv.id,
          revisionId: pinnedRevId,
          namespace: sourceConv.namespace,
          copiedAt,
        },
      };

      const stored = await writeCanonicalConversation(
        env,
        destConversation,
        null,
        null,
        input.userId,
      );

      state.destination_conversation_id = destId;
      state.destination_revision_id = stored.revisionId;
      state.status = "copied";
      delete state.error;

      const stateIndex = states.findIndex((s) => s.request_index === i);
      if (stateIndex >= 0) states[stateIndex] = state;

      await env.MEMORY_DB.prepare(
        `UPDATE conversation_copy_operations SET requests_json = ?, updated_at = ? WHERE user_id = ? AND idempotency_key = ?`,
      )
        .bind(JSON.stringify(states), new Date().toISOString(), input.userId, input.idempotencyKey)
        .run();

      results.push({
        requestIndex: i,
        status: "copied",
        sourceConversationId: req.conversationId,
        sourceRevisionId: pinnedRevId,
        stored,
      });
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === "IMPORT_CONFLICT" ||
          error.code === "DELETION_PENDING" ||
          error.code === "AUTHENTICATION")
      ) {
        throw error;
      }

      const details = errorDetails(error);
      state.status = "failed";
      state.error = { code: details.code, message: details.message };

      const stateIndex = states.findIndex((s) => s.request_index === i);
      if (stateIndex >= 0) states[stateIndex] = state;

      await env.MEMORY_DB.prepare(
        `UPDATE conversation_copy_operations SET requests_json = ?, updated_at = ? WHERE user_id = ? AND idempotency_key = ?`,
      )
        .bind(JSON.stringify(states), new Date().toISOString(), input.userId, input.idempotencyKey)
        .run();

      results.push({
        requestIndex: i,
        status: "failed",
        sourceConversationId: req.conversationId,
        error: { code: details.code, message: details.message },
      });
    }
  }

  return results;
}
