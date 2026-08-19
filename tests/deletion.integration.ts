import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMcpConversation } from "../src/chatgpt";
import {
  deleteAllMemories,
  deleteConversations,
  deleteNamespace,
  type DeletionEnv,
} from "../src/deletion";
import { EMBEDDING_DIMENSIONS } from "../src/domain";
import { indexRevision, type IndexingEnv } from "../src/indexing";
import { enqueueIndex, processJobMessage } from "../src/jobs";
import { searchMemory, type SearchEnv } from "../src/search";
import { writeCanonicalConversation } from "../src/storage";
import { OWNER_DB_USER_ID } from "../src/tenant";

const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);

function vectorBindings(failDelete = false) {
  const ids = new Set<string>();
  return {
    ids,
    binding: {
      deleteByIds(values: string[]) {
        if (failDelete) return Promise.reject(new Error("vector deletion unavailable"));
        for (const value of values) ids.delete(value);
        return Promise.resolve({
          mutationId: "delete-mutation",
          ids: values,
          count: values.length,
        });
      },
      upsert(values: VectorizeVector[]) {
        for (const value of values) ids.add(value.id);
        return Promise.resolve({ mutationId: "upsert-mutation", ids: [], count: values.length });
      },
    },
  };
}

function indexingEnv(binding: IndexingEnv["MEMORY_VECTOR"]): IndexingEnv {
  return {
    MEMORY_DB: env.MEMORY_DB,
    MEMORY_BUCKET: env.MEMORY_BUCKET,
    MEMORY_VECTOR: binding,
    AI: { run: () => Promise.resolve({ data: [embedding] }) },
  };
}

function deletionEnv(binding: DeletionEnv["MEMORY_VECTOR"]): DeletionEnv {
  return {
    MEMORY_DB: env.MEMORY_DB,
    MEMORY_BUCKET: env.MEMORY_BUCKET,
    MEMORY_VECTOR: binding,
  };
}

function searchEnv(semanticChunkId?: string): SearchEnv {
  return {
    MEMORY_DB: env.MEMORY_DB,
    MEMORY_BUCKET: env.MEMORY_BUCKET,
    ACTIVE_INDEX_GENERATION: env.ACTIVE_INDEX_GENERATION,
    RECENT_UNINDEXED_MAX_REVISIONS: env.RECENT_UNINDEXED_MAX_REVISIONS,
    RECENT_UNINDEXED_MAX_AGE_SECONDS: env.RECENT_UNINDEXED_MAX_AGE_SECONDS,
    RECENT_UNINDEXED_MAX_MESSAGES: env.RECENT_UNINDEXED_MAX_MESSAGES,
    AI: { run: () => Promise.resolve({ data: [embedding] }) },
    MEMORY_VECTOR: {
      query: () =>
        Promise.resolve({
          matches: semanticChunkId
            ? [{ id: semanticChunkId, score: 0.99, metadata: { chunk_id: semanticChunkId } }]
            : [],
          count: semanticChunkId ? 1 : 0,
        }),
    },
  };
}

async function storeMemory(namespace: string, token: string) {
  const conversation = await createMcpConversation({
    id: crypto.randomUUID(),
    title: token,
    namespace,
    messages: [{ role: "user", content: `${token} canonical memory` }],
  });
  const stored = await writeCanonicalConversation(env, conversation, null);
  const jobId = await enqueueIndex(env, stored.revisionId);
  return { conversation, stored, jobId };
}

async function count(table: string, column: string, value: string): Promise<number> {
  const row = await env.MEMORY_DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
  )
    .bind(value)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe("safe memory deletion", () => {
  it("deletes canonical, D1, lexical, semantic, and queued state idempotently", async () => {
    const vectors = vectorBindings();
    const { conversation, stored } = await storeMemory("delete-one", "Quokka delete needle");
    await indexRevision(
      indexingEnv(vectors.binding),
      stored.revisionId,
      env.ACTIVE_INDEX_GENERATION,
    );
    const chunk = await env.MEMORY_DB.prepare("SELECT id FROM chunks WHERE revision_id = ? LIMIT 1")
      .bind(stored.revisionId)
      .first<{ id: string }>();

    const deleted = await deleteConversations(deletionEnv(vectors.binding), [conversation.id]);

    expect(deleted).toEqual({
      requested: 1,
      deleted: [conversation.id],
      missing: [],
      failed: [],
    });
    expect(await env.MEMORY_BUCKET.head(stored.manifestKey)).toBeNull();
    expect(await env.MEMORY_BUCKET.head(stored.segmentKey)).toBeNull();
    expect(await count("conversations", "id", conversation.id)).toBe(0);
    expect(await count("conversation_revisions", "id", stored.revisionId)).toBe(0);
    expect(await count("chunk_index_state", "revision_id", stored.revisionId)).toBe(0);
    expect(await count("chunks", "revision_id", stored.revisionId)).toBe(0);
    expect(await count("jobs", "subject_id", stored.revisionId)).toBe(0);
    expect(vectors.ids.size).toBe(0);
    const fts = await env.MEMORY_DB.prepare(
      "SELECT COUNT(*) AS count FROM chunk_fts WHERE chunk_id = ?",
    )
      .bind(chunk?.id ?? "")
      .first<{ count: number }>();
    expect(fts?.count).toBe(0);

    const search = await searchMemory(searchEnv(chunk?.id), {
      query: "Quokka delete needle",
      limit: 8,
      namespace: "delete-one",
    });
    expect(search.results).toEqual([]);
    await expect(
      deleteConversations(deletionEnv(vectors.binding), [conversation.id]),
    ).resolves.toEqual({ requested: 1, deleted: [], missing: [conversation.id], failed: [] });
  });

  it("deletes multiple conversations and reports missing IDs separately", async () => {
    const vectors = vectorBindings();
    const first = await storeMemory("delete-many", "first deletion");
    const second = await storeMemory("delete-many", "second deletion");
    const missing = crypto.randomUUID();

    const result = await deleteConversations(deletionEnv(vectors.binding), [
      first.conversation.id,
      missing,
      second.conversation.id,
    ]);

    expect(result.deleted).toEqual([first.conversation.id, second.conversation.id]);
    expect(result.missing).toEqual([missing]);
    expect(result.failed).toEqual([]);
  });

  it("keeps partial failures visible, tombstoned, and restart-safe", async () => {
    const vectors = vectorBindings();
    const failed = await storeMemory("partial", "partial failure");
    const succeeded = await storeMemory("partial", "successful peer");
    await indexRevision(
      indexingEnv(vectors.binding),
      failed.stored.revisionId,
      env.ACTIVE_INDEX_GENERATION,
    );

    const result = await deleteConversations(deletionEnv(vectorBindings(true).binding), [
      failed.conversation.id,
      succeeded.conversation.id,
    ]);

    expect(result.deleted).toEqual([succeeded.conversation.id]);
    expect(result.failed).toEqual([
      expect.objectContaining({ conversation_id: failed.conversation.id, stage: "vectorize" }),
    ]);
    const tombstone = await env.MEMORY_DB.prepare(
      "SELECT deleted_at FROM conversations WHERE id = ?",
    )
      .bind(failed.conversation.id)
      .first<{ deleted_at: string | null }>();
    expect(tombstone?.deleted_at).toBeTruthy();
    expect(
      (
        await searchMemory(searchEnv(), {
          query: "partial failure",
          limit: 8,
          namespace: "partial",
        })
      ).results,
    ).toEqual([]);

    const retry = await deleteConversations(deletionEnv(vectors.binding), [failed.conversation.id]);
    expect(retry.deleted).toEqual([failed.conversation.id]);
    expect(retry.failed).toEqual([]);
  });

  it("deletes one namespace without crossing namespace boundaries", async () => {
    const vectors = vectorBindings();
    const first = await storeMemory("astara-alt", "namespace first");
    const second = await storeMemory("astara-alt", "namespace second");
    const isolated = await storeMemory("personal", "namespace survivor");

    const result = await deleteNamespace(
      deletionEnv(vectors.binding),
      OWNER_DB_USER_ID,
      "astara-alt",
    );

    expect(result).toMatchObject({
      namespace: "astara-alt",
      requested: 2,
      processed: 2,
      deleted: 2,
      remaining: 0,
      complete: true,
      failed: [],
    });
    expect(await count("conversations", "id", first.conversation.id)).toBe(0);
    expect(await count("conversations", "id", second.conversation.id)).toBe(0);
    expect(await count("conversations", "id", isolated.conversation.id)).toBe(1);
  });

  it("deletes all of the caller's memories while retaining raw archives and other tenants", async () => {
    const vectors = vectorBindings();
    await storeMemory("personal", "delete all first");
    await storeMemory("personal", "delete all second");
    await storeMemory("other-tenant", "untouched tenant");
    const rawKey = `raw/imports/${crypto.randomUUID()}/source/conversations.json`;
    await env.MEMORY_BUCKET.put(rawKey, "[]");
    const before = await env.MEMORY_DB.prepare(
      "SELECT COUNT(*) AS count FROM conversations WHERE namespace = 'personal'",
    ).first<{
      count: number;
    }>();

    const result = await deleteAllMemories(deletionEnv(vectors.binding), OWNER_DB_USER_ID, [
      "personal",
    ]);

    expect(result).toMatchObject({
      requested: before?.count ?? 0,
      deleted: before?.count ?? 0,
      remaining: 0,
      complete: true,
    });
    expect(result.failed).toEqual([]);
    expect(await env.MEMORY_BUCKET.head(rawKey)).not.toBeNull();
    expect(await count("conversations", "namespace", "other-tenant")).toBe(1);
  });

  it("makes stale queued indexing messages harmless after deletion", async () => {
    const vectors = vectorBindings();
    const memory = await storeMemory("queued-delete", "queued resurrection");
    await deleteConversations(deletionEnv(vectors.binding), [memory.conversation.id]);

    await expect(
      processJobMessage(env, { version: 1, job_id: memory.jobId }),
    ).resolves.toBeUndefined();
    expect(await count("chunks", "revision_id", memory.stored.revisionId)).toBe(0);
  });

  it("lets deletion win when indexing is already upserting vectors", async () => {
    const vectors = vectorBindings();
    const memory = await storeMemory("race-delete", "indexing race");
    let releaseUpsert: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    const raceBinding: IndexingEnv["MEMORY_VECTOR"] = {
      deleteByIds: (ids) => vectors.binding.deleteByIds(ids),
      async upsert(values) {
        signalStarted?.();
        await release;
        return vectors.binding.upsert(values);
      },
    };
    const indexing = indexRevision(
      indexingEnv(raceBinding),
      memory.stored.revisionId,
      env.ACTIVE_INDEX_GENERATION,
    );
    await started;

    const deleted = await deleteConversations(deletionEnv(vectors.binding), [
      memory.conversation.id,
    ]);
    releaseUpsert?.();

    expect(deleted.failed).toEqual([]);
    await expect(indexing).resolves.toBe(0);
    expect(vectors.ids.size).toBe(0);
    expect(await count("chunks", "revision_id", memory.stored.revisionId)).toBe(0);
  });
});
