import type { AppEnv, CanonicalNode } from "./domain";
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
): Promise<{
  chunkId: string;
  revisionId: string;
  messages: CanonicalNode[];
  matchedRanges: Array<{ sourceNodeId: string; charStart: number; charEnd: number }>;
}> {
  const result = await env.MEMORY_DB.prepare(
    `SELECT c.revision_id, s.source_node_id, s.source_sequence, s.char_start, s.char_end, s.ordinal
     FROM chunks c JOIN chunk_sources s ON s.chunk_id = c.id
     WHERE c.id = ? ORDER BY s.ordinal`,
  )
    .bind(chunkId)
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
    messages,
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
) {
  const row = await env.MEMORY_DB.prepare(
    "SELECT current_revision_id FROM conversations WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(conversationId)
    .first<{ current_revision_id: string | null }>();
  if (!row?.current_revision_id) throw new AppError("NOT_FOUND", "Conversation not found", 404);
  const loaded = await loadCanonicalRevision(env, row.current_revision_id);
  const tags = (await loadConversationTags(env, [conversationId])).get(conversationId) ?? [];
  const byId = new Map(loaded.conversation.nodes.map((node) => [node.sourceNodeId, node]));
  const nodes =
    branch === "active"
      ? loaded.conversation.activeSourceNodeIds.flatMap((id) =>
          byId.get(id) ? [byId.get(id)!] : [],
        )
      : loaded.conversation.nodes;
  const boundedOffset = Math.max(0, offset);
  const boundedLimit = Math.min(100, Math.max(1, limit));
  return {
    conversation: {
      id: loaded.conversation.id,
      title: loaded.conversation.title,
      sourceType: loaded.conversation.sourceType,
      sourceId: loaded.conversation.sourceId,
      namespace: loaded.conversation.namespace,
      tags,
      revisionId: row.current_revision_id,
      currentSourceNodeId: loaded.conversation.currentSourceNodeId,
      anomalies: loaded.conversation.anomalies,
    },
    messages: nodes.slice(boundedOffset, boundedOffset + boundedLimit),
    nextOffset: boundedOffset + boundedLimit < nodes.length ? boundedOffset + boundedLimit : null,
    total: nodes.length,
  };
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
