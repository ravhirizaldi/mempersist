import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { normalizeChatGptConversation } from "../src/chatgpt";
import type { AppEnv } from "../src/domain";
import { loadCanonicalRevision, writeCanonicalConversation } from "../src/storage";
import { getConversationPage } from "../src/retrieval";
import { searchMemory, type SearchEnv } from "../src/search";
import { branchedChatGptConversation } from "./fixtures/chatgpt";

describe("canonical R2 plus D1 storage", () => {
  it("writes canonical data before cataloging and reuses a deterministic revision", async () => {
    const appEnv = env as AppEnv;
    const conversation = await normalizeChatGptConversation(branchedChatGptConversation());
    const first = await writeCanonicalConversation(appEnv, conversation, null);
    const second = await writeCanonicalConversation(appEnv, conversation, null);
    expect(first.revisionId).toBe(second.revisionId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await env.MEMORY_BUCKET.head(first.segmentKey)).not.toBeNull();
    const loaded = await loadCanonicalRevision(appEnv, first.revisionId);
    expect(loaded.conversation.activeSourceNodeIds).toEqual(conversation.activeSourceNodeIds);
    expect(loaded.conversation.nodes).toHaveLength(conversation.nodes.length);
    const page = await getConversationPage(appEnv, conversation.id, 0, 20);
    expect(page.messages.map((message) => message.sourceNodeId)).toEqual(
      conversation.activeSourceNodeIds,
    );
  });

  it("supports exact FTS identifiers", async () => {
    const now = new Date().toISOString();
    await env.MEMORY_DB.batch([
      env.MEMORY_DB.prepare(
        `INSERT INTO index_generations
         (id, status, chunk_strategy, embedding_model, embedding_dimensions, vector_index_name, created_at)
         VALUES (?, 'active', 'v1', 'model', 3, 'index', ?)`,
      ).bind(env.ACTIVE_INDEX_GENERATION, now),
      env.MEMORY_DB.prepare(
        `INSERT INTO conversations
         (id, source_type, title, imported_at, namespace) VALUES ('c', 'test', 'Exact', ?, 'work')`,
      ).bind(now),
      env.MEMORY_DB.prepare(
        `INSERT INTO conversation_revisions
         (id, conversation_id, content_hash, manifest_object_key, node_count, created_at)
         VALUES ('r', 'c', 'hash', 'missing', 0, ?)`,
      ).bind(now),
      env.MEMORY_DB.prepare("UPDATE conversations SET current_revision_id = 'r' WHERE id = 'c'"),
      env.MEMORY_DB.prepare(
        `INSERT INTO chunks
         (id, vector_id, revision_id, conversation_id, generation_id, branch_key, ordinal, title, body,
          token_estimate, namespace, created_at)
         VALUES ('chunk', 'vector', 'r', 'c', ?, 'active', 0, 'Exact', 'api.internal.example ERR_DB_42', 5, 'work', ?)`,
      ).bind(env.ACTIVE_INDEX_GENERATION, now),
      env.MEMORY_DB.prepare(
        "INSERT INTO chunk_fts (chunk_id, title, body) VALUES ('chunk', 'Exact', 'api.internal.example ERR_DB_42')",
      ),
    ]);
    const result = await env.MEMORY_DB.prepare(
      `SELECT chunk_id FROM chunk_fts WHERE chunk_fts MATCH '"api.internal.example"'`,
    ).all<{ chunk_id: string }>();
    expect(result.results).toEqual([{ chunk_id: "chunk" }]);

    const degradedEnv: SearchEnv = {
      MEMORY_DB: env.MEMORY_DB,
      MEMORY_BUCKET: env.MEMORY_BUCKET,
      ACTIVE_INDEX_GENERATION: env.ACTIVE_INDEX_GENERATION,
      RECENT_UNINDEXED_MAX_REVISIONS: env.RECENT_UNINDEXED_MAX_REVISIONS,
      RECENT_UNINDEXED_MAX_AGE_SECONDS: env.RECENT_UNINDEXED_MAX_AGE_SECONDS,
      RECENT_UNINDEXED_MAX_MESSAGES: env.RECENT_UNINDEXED_MAX_MESSAGES,
      AI: { run: async () => Promise.reject(new Error("Workers AI unavailable")) },
      MEMORY_VECTOR: { query: () => Promise.resolve({ matches: [], count: 0 }) },
    };
    const search = await searchMemory(degradedEnv, { query: "ERR_DB_42", limit: 8 });
    expect(search.degraded).toBe(true);
    expect(search.unavailable).toContain("semantic");
    expect(search.results[0]?.chunkId).toBe("chunk");
  });
});
