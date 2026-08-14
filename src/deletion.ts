import type { AppEnv } from "./domain";
import { errorDetails } from "./errors";

export const MAX_CONVERSATION_DELETE_BATCH = 100;
const SCOPE_PAGE_SIZE = 50;
const SCOPE_DELETE_LIMIT = 500;
const REVISION_PAGE_SIZE = 25;
const VECTOR_DELETE_BATCH = 100;

export type DeletionEnv = Pick<AppEnv, "MEMORY_DB" | "MEMORY_BUCKET"> & {
  MEMORY_VECTOR: Pick<VectorizeIndex, "deleteByIds">;
};

type DeleteFailureStage = "tombstone" | "canonical" | "vectorize" | "catalog";

export interface DeleteFailure {
  conversation_id: string;
  stage: DeleteFailureStage;
  message: string;
}

export interface DeleteConversationsResult {
  requested: number;
  deleted: string[];
  missing: string[];
  failed: DeleteFailure[];
}

export interface DeleteScopeResult {
  requested: number;
  processed: number;
  deleted: number;
  failed: DeleteFailure[];
  remaining: number;
  complete: boolean;
}

interface RevisionRow {
  id: string;
  manifest_object_key: string;
}

interface SegmentRow {
  id: string;
  object_key: string;
}

function failure(conversationId: string, stage: DeleteFailureStage, error: unknown): DeleteFailure {
  return {
    conversation_id: conversationId,
    stage,
    message: errorDetails(error).message.slice(0, 500),
  };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

async function deleteRevisionVectors(env: DeletionEnv, revisionIds: string[]): Promise<void> {
  let cursor = "";
  while (true) {
    const rows = await env.MEMORY_DB.prepare(
      `SELECT vector_id FROM chunks
       WHERE revision_id IN (${placeholders(revisionIds)}) AND vector_id > ?
       ORDER BY vector_id LIMIT ?`,
    )
      .bind(...revisionIds, cursor, VECTOR_DELETE_BATCH)
      .all<{ vector_id: string }>();
    const ids = rows.results.map((row) => row.vector_id);
    if (!ids.length) return;
    await env.MEMORY_VECTOR.deleteByIds(ids);
    cursor = ids.at(-1) ?? cursor;
  }
}

async function deleteRevisionCatalog(
  env: DeletionEnv,
  conversationId: string,
  revisions: RevisionRow[],
  segments: SegmentRow[],
): Promise<void> {
  const revisionIds = revisions.map((revision) => revision.id);
  const statements: D1PreparedStatement[] = [
    env.MEMORY_DB.prepare(
      `DELETE FROM chunk_fts
       WHERE chunk_id IN (SELECT id FROM chunks WHERE revision_id IN (${placeholders(revisionIds)}))`,
    ).bind(...revisionIds),
    env.MEMORY_DB.prepare(
      `DELETE FROM jobs
       WHERE kind IN ('index', 'reindex') AND subject_id IN (${placeholders(revisionIds)})`,
    ).bind(...revisionIds),
    env.MEMORY_DB.prepare(
      `UPDATE import_items SET revision_id = NULL
       WHERE revision_id IN (${placeholders(revisionIds)})`,
    ).bind(...revisionIds),
    env.MEMORY_DB.prepare(
      `DELETE FROM conversation_revisions
       WHERE conversation_id = ? AND id IN (${placeholders(revisionIds)})`,
    ).bind(conversationId, ...revisionIds),
  ];
  for (let index = 0; index < segments.length; index += 50) {
    const ids = segments.slice(index, index + 50).map((segment) => segment.id);
    statements.push(
      env.MEMORY_DB.prepare(
        `DELETE FROM canonical_segments
         WHERE id IN (${placeholders(ids)})
           AND NOT EXISTS (
             SELECT 1 FROM revision_segments WHERE segment_id = canonical_segments.id
           )`,
      ).bind(...ids),
    );
  }
  await env.MEMORY_DB.batch(statements);
}

async function deleteOneConversation(
  env: DeletionEnv,
  conversationId: string,
): Promise<"deleted" | "missing" | DeleteFailure> {
  const existing = await env.MEMORY_DB.prepare("SELECT id FROM conversations WHERE id = ?")
    .bind(conversationId)
    .first<{ id: string }>();
  if (!existing) return "missing";

  try {
    await env.MEMORY_DB.prepare(
      "UPDATE conversations SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?",
    )
      .bind(new Date().toISOString(), conversationId)
      .run();
  } catch (error) {
    return failure(conversationId, "tombstone", error);
  }

  while (true) {
    const revisionRows = await env.MEMORY_DB.prepare(
      `SELECT id, manifest_object_key FROM conversation_revisions
       WHERE conversation_id = ? ORDER BY id LIMIT ?`,
    )
      .bind(conversationId, REVISION_PAGE_SIZE)
      .all<RevisionRow>();
    const revisions = revisionRows.results;
    if (!revisions.length) break;
    const revisionIds = revisions.map((revision) => revision.id);
    const segmentRows = await env.MEMORY_DB.prepare(
      `SELECT DISTINCT segment.id, segment.object_key
       FROM revision_segments link
       JOIN canonical_segments segment ON segment.id = link.segment_id
       WHERE link.revision_id IN (${placeholders(revisionIds)})`,
    )
      .bind(...revisionIds)
      .all<SegmentRow>();
    const segments = segmentRows.results;

    try {
      const keys = [
        ...revisions.map((revision) => revision.manifest_object_key),
        ...segments.map((segment) => segment.object_key),
      ];
      for (let index = 0; index < keys.length; index += 1000) {
        const batch = keys.slice(index, index + 1000);
        if (batch.length) await env.MEMORY_BUCKET.delete(batch);
      }
    } catch (error) {
      return failure(conversationId, "canonical", error);
    }

    try {
      await deleteRevisionVectors(env, revisionIds);
    } catch (error) {
      return failure(conversationId, "vectorize", error);
    }

    try {
      await deleteRevisionCatalog(env, conversationId, revisions, segments);
    } catch (error) {
      return failure(conversationId, "catalog", error);
    }
  }

  try {
    await env.MEMORY_DB.batch([
      env.MEMORY_DB.prepare(
        "UPDATE import_items SET conversation_id = NULL, revision_id = NULL WHERE conversation_id = ?",
      ).bind(conversationId),
      env.MEMORY_DB.prepare("DELETE FROM conversations WHERE id = ?").bind(conversationId),
    ]);
    return "deleted";
  } catch (error) {
    return failure(conversationId, "catalog", error);
  }
}

export async function deleteConversations(
  env: DeletionEnv,
  conversationIds: string[],
): Promise<DeleteConversationsResult> {
  const result: DeleteConversationsResult = {
    requested: conversationIds.length,
    deleted: [],
    missing: [],
    failed: [],
  };
  for (const conversationId of conversationIds) {
    const outcome = await deleteOneConversation(env, conversationId);
    if (outcome === "deleted") result.deleted.push(conversationId);
    else if (outcome === "missing") result.missing.push(conversationId);
    else result.failed.push(outcome);
  }
  return result;
}

async function countScope(env: DeletionEnv, namespace?: string): Promise<number> {
  const row = namespace
    ? await env.MEMORY_DB.prepare("SELECT COUNT(*) AS count FROM conversations WHERE namespace = ?")
        .bind(namespace)
        .first<{ count: number }>()
    : await env.MEMORY_DB.prepare("SELECT COUNT(*) AS count FROM conversations").first<{
        count: number;
      }>();
  return row?.count ?? 0;
}

async function deleteScope(env: DeletionEnv, namespace?: string): Promise<DeleteScopeResult> {
  const requested = await countScope(env, namespace);
  const result: DeleteScopeResult = {
    requested,
    processed: 0,
    deleted: 0,
    failed: [],
    remaining: requested,
    complete: false,
  };
  let cursor = "";
  while (result.processed < SCOPE_DELETE_LIMIT) {
    const limit = Math.min(SCOPE_PAGE_SIZE, SCOPE_DELETE_LIMIT - result.processed);
    const rows = namespace
      ? await env.MEMORY_DB.prepare(
          `SELECT id FROM conversations
           WHERE namespace = ? AND id > ? ORDER BY id LIMIT ?`,
        )
          .bind(namespace, cursor, limit)
          .all<{ id: string }>()
      : await env.MEMORY_DB.prepare("SELECT id FROM conversations WHERE id > ? ORDER BY id LIMIT ?")
          .bind(cursor, limit)
          .all<{ id: string }>();
    if (!rows.results.length) break;
    for (const row of rows.results) {
      cursor = row.id;
      result.processed += 1;
      const outcome = await deleteOneConversation(env, row.id);
      if (outcome === "deleted") result.deleted += 1;
      else if (outcome !== "missing") result.failed.push(outcome);
    }
  }
  result.remaining = await countScope(env, namespace);
  result.complete = result.remaining === 0 && result.failed.length === 0;
  return result;
}

export async function deleteNamespace(
  env: DeletionEnv,
  namespace: string,
): Promise<DeleteScopeResult & { namespace: string }> {
  return { namespace, ...(await deleteScope(env, namespace)) };
}

export async function deleteAllMemories(env: DeletionEnv): Promise<DeleteScopeResult> {
  return deleteScope(env);
}
