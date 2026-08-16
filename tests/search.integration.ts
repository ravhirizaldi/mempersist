import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMcpConversation } from "../src/chatgpt";
import { EMBEDDING_DIMENSIONS } from "../src/domain";
import { indexRevision, type IndexingEnv } from "../src/indexing";
import { enqueueIndex, retryJob } from "../src/jobs";
import { searchMemory, type SearchEnv } from "../src/search";
import {
  appendConversation,
  listConversations,
  loadCanonicalRevision,
  updateConversationTags,
  writeCanonicalConversation,
} from "../src/storage";

const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);

function searchEnv(
  config: {
    maxRevisions?: number;
    maxAgeSeconds?: number;
    maxMessages?: number;
    semanticFailure?: boolean;
    semanticMatches?: Array<{ chunkId: string; score: number }>;
  } = {},
): SearchEnv {
  return {
    MEMORY_DB: env.MEMORY_DB,
    MEMORY_BUCKET: env.MEMORY_BUCKET,
    ACTIVE_INDEX_GENERATION: env.ACTIVE_INDEX_GENERATION,
    RECENT_UNINDEXED_MAX_REVISIONS: config.maxRevisions ?? env.RECENT_UNINDEXED_MAX_REVISIONS,
    RECENT_UNINDEXED_MAX_AGE_SECONDS: config.maxAgeSeconds ?? env.RECENT_UNINDEXED_MAX_AGE_SECONDS,
    RECENT_UNINDEXED_MAX_MESSAGES: config.maxMessages ?? env.RECENT_UNINDEXED_MAX_MESSAGES,
    AI: {
      run: (_model, input) =>
        config.semanticFailure
          ? Promise.reject(new Error("Workers AI unavailable"))
          : Promise.resolve({ data: input.text.map(() => embedding) }),
    },
    MEMORY_VECTOR: {
      query: () => {
        const matches = (config.semanticMatches ?? []).map((match) => ({
          id: match.chunkId,
          score: match.score,
          metadata: { chunk_id: match.chunkId },
        }));
        return Promise.resolve({ matches, count: matches.length });
      },
    },
  };
}

function indexingEnv(failEmbedding = false): IndexingEnv {
  return {
    MEMORY_DB: env.MEMORY_DB,
    MEMORY_BUCKET: env.MEMORY_BUCKET,
    AI: {
      run: () =>
        failEmbedding
          ? Promise.reject(new Error("Workers AI unavailable"))
          : Promise.resolve({ data: [embedding] }),
    },
    MEMORY_VECTOR: {
      deleteByIds: (ids) =>
        Promise.resolve({ mutationId: "test-delete-mutation", ids, count: ids.length }),
      upsert: () => Promise.resolve({ mutationId: "test-mutation", ids: [], count: 0 }),
    },
  };
}

async function storeMemory(input: {
  id?: string;
  title: string;
  namespace: string;
  tags?: string[];
  messages: Array<{ role: string; content: string; timestamp?: string }>;
}) {
  const conversation = await createMcpConversation(input);
  const stored = await writeCanonicalConversation(env, conversation, null);
  const jobId = await enqueueIndex(env, stored.revisionId);
  return { conversation, stored, jobId };
}

describe("recent unindexed canonical search", () => {
  it("ranks a paraphrased recent memory first without embedding its canonical text", async () => {
    const unrelated = await storeMemory({
      title: "Project Glass Comet",
      namespace: "work",
      messages: [{ role: "user", content: "A separate archival retention discussion." }],
    });
    await indexRevision(indexingEnv(), unrelated.stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const unrelatedChunk = await env.MEMORY_DB.prepare(
      "SELECT id FROM chunks WHERE revision_id = ? LIMIT 1",
    )
      .bind(unrelated.stored.revisionId)
      .first<{ id: string }>();
    const pangolin = await storeMemory({
      title: "Pangolin Echo",
      namespace: "work",
      messages: [
        {
          role: "user",
          content:
            "Pangolin Echo is used specifically for packet-loss simulation on the backup satellite link. Testing happens every Thursday at 03:40 WIB. PIC is Satria Mahendra.",
        },
      ],
    });
    const query =
      "which gateway is used to test packet loss on the backup satellite connection, who is responsible for it, and when is the test?";
    const semanticInputs: string[][] = [];
    const candidateEnv = searchEnv({
      semanticMatches: [{ chunkId: unrelatedChunk?.id ?? "", score: 0.99 }],
    });
    candidateEnv.AI.run = (_model, input) => {
      semanticInputs.push(input.text);
      return Promise.resolve({ data: input.text.map(() => embedding) });
    };

    const result = await searchMemory(candidateEnv, { query, limit: 8, namespace: "work" });

    expect(result.results[0]?.revisionId).toBe(pangolin.stored.revisionId);
    expect(result.results[0]?.sources).toContain("recent_canonical");
    expect(semanticInputs).toHaveLength(1);
    expect(semanticInputs[0]?.[0]).toBe(query);
    expect(semanticInputs[0]?.length).toBe(2);
    expect(semanticInputs.flat()).not.toContain(pangolin.conversation.nodes[0]?.text);
  });

  it("finds a durable store immediately while its revision is queued", async () => {
    const { stored } = await storeMemory({
      title: "WAN outage test",
      namespace: "work",
      messages: [{ role: "user", content: "The WAN outage test gateway is called Marmot." }],
    });

    const state = await env.MEMORY_DB.prepare(
      "SELECT status, queued_at FROM chunk_index_state WHERE revision_id = ?",
    )
      .bind(stored.revisionId)
      .first<{ status: string; queued_at: string }>();
    const result = await searchMemory(searchEnv(), {
      query: "which gateway is used to test internet failure?",
      limit: 8,
      namespace: "work",
    });

    expect(state?.status).toBe("queued");
    expect(state?.queued_at).toBeTruthy();
    expect(result.results[0]?.revisionId).toBe(stored.revisionId);
    expect(result.results[0]?.sources).toContain("recent_canonical");

    await env.MEMORY_DB.prepare(
      "UPDATE chunk_index_state SET status = 'processing', started_at = ?, updated_at = ? WHERE revision_id = ?",
    )
      .bind(new Date().toISOString(), new Date().toISOString(), stored.revisionId)
      .run();
    const processing = await searchMemory(searchEnv(), { query: "Marmot gateway", limit: 8 });
    expect(processing.results[0]?.revisionId).toBe(stored.revisionId);
  });

  it("ranks an exact recent canonical entity above an unrelated indexed result", async () => {
    const glass = await storeMemory({
      title: "Project Glass Comet",
      namespace: "work",
      messages: [
        {
          role: "user",
          content: "Project Glass Comet has a maintenance window and a responsible technician.",
        },
      ],
    });
    await indexRevision(indexingEnv(), glass.stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const glassChunk = await env.MEMORY_DB.prepare(
      "SELECT id FROM chunks WHERE revision_id = ? LIMIT 1",
    )
      .bind(glass.stored.revisionId)
      .first<{ id: string }>();
    const tarsier = await storeMemory({
      title: "Maintenance record",
      namespace: "work",
      messages: [
        {
          role: "user",
          content:
            "Tarsier Delta has maintenance every Tuesday at 02:15 WIB. The responsible technician is Livia Maheswari.",
        },
      ],
    });

    expect(glassChunk).not.toBeNull();
    const result = await searchMemory(
      searchEnv({ semanticMatches: [{ chunkId: glassChunk?.id ?? "", score: 0.99 }] }),
      {
        query: "who is responsible for Tarsier Delta and when is the maintenance window?",
        limit: 8,
        namespace: "work",
      },
    );

    expect(result.results[0]?.revisionId).toBe(tarsier.stored.revisionId);
    expect(result.results[0]?.sources).toContain("recent_canonical");
  });

  it("returns the same logical chunk once after indexing completes", async () => {
    const { stored } = await storeMemory({
      title: "Gateway",
      namespace: "work",
      messages: [{ role: "user", content: "The gateway codename is Aardvark77." }],
    });
    const before = await searchMemory(searchEnv(), { query: "Aardvark77 gateway", limit: 8 });

    await indexRevision(indexingEnv(), stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const after = await searchMemory(searchEnv(), { query: "Aardvark77 gateway", limit: 8 });
    const state = await env.MEMORY_DB.prepare(
      `SELECT status, attempts, started_at, fts_indexed_at, indexed_at
       FROM chunk_index_state WHERE revision_id = ?`,
    )
      .bind(stored.revisionId)
      .first<{
        status: string;
        attempts: number;
        started_at: string | null;
        fts_indexed_at: string | null;
        indexed_at: string | null;
      }>();

    expect(before.results).toHaveLength(1);
    expect(after.results).toHaveLength(1);
    expect(after.results[0]?.chunkId).toBe(before.results[0]?.chunkId);
    expect(after.results[0]?.sources).toEqual(["lexical"]);
    expect(state).toMatchObject({ status: "indexed", attempts: 1 });
    expect(state?.started_at).toBeTruthy();
    expect(state?.fts_indexed_at).toBeTruthy();
    expect(state?.indexed_at).toBeTruthy();
  });

  it("keeps namespace filtering and fallback limits bounded", async () => {
    const namespace = `bounded-${crypto.randomUUID()}`;
    const older = await storeMemory({
      title: "Older bounded result",
      namespace,
      messages: [{ role: "user", content: "bounded needle alpha" }],
    });
    const newer = await storeMemory({
      title: "Newer bounded result",
      namespace,
      messages: [{ role: "user", content: "bounded needle beta" }],
    });
    await storeMemory({
      title: "Private bounded result",
      namespace: "private",
      messages: [{ role: "user", content: "bounded needle private" }],
    });
    await env.MEMORY_DB.prepare("UPDATE chunk_index_state SET queued_at = ? WHERE revision_id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), older.stored.revisionId)
      .run();
    await env.MEMORY_DB.prepare("UPDATE chunk_index_state SET queued_at = ? WHERE revision_id = ?")
      .bind(new Date().toISOString(), newer.stored.revisionId)
      .run();

    const result = await searchMemory(searchEnv({ maxRevisions: 1 }), {
      query: "bounded needle",
      limit: 8,
      namespace,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.revisionId).toBe(newer.stored.revisionId);
    expect(result.results[0]?.namespace).toBe(namespace);

    const plan = await env.MEMORY_DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT state.revision_id
       FROM chunk_index_state state
       WHERE state.generation_id = ?
         AND state.status IN ('queued', 'processing', 'failed')
         AND state.queued_at >= ?
       ORDER BY CASE state.status WHEN 'failed' THEN 1 ELSE 0 END, state.queued_at DESC
       LIMIT ?`,
    )
      .bind(env.ACTIVE_INDEX_GENERATION, new Date(Date.now() - 86_400_000).toISOString(), 1)
      .all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join(" ")).toContain(
      "chunk_index_state_recent_idx",
    );
  });

  it("enforces the maximum age and message window", async () => {
    const oldMessage = await storeMemory({
      title: "Message bound",
      namespace: "work",
      messages: [
        { role: "user", content: "old-only-token" },
        { role: "assistant", content: "fresh unrelated content" },
      ],
    });
    const messageBound = await searchMemory(searchEnv({ maxMessages: 1 }), {
      query: "old-only-token",
      limit: 8,
    });
    expect(messageBound.results).toEqual([]);

    await env.MEMORY_DB.prepare("UPDATE chunk_index_state SET queued_at = ? WHERE revision_id = ?")
      .bind("2000-01-01T00:00:00.000Z", oldMessage.stored.revisionId)
      .run();
    const ageBound = await searchMemory(searchEnv({ maxAgeSeconds: 60 }), {
      query: "fresh unrelated",
      limit: 8,
    });
    expect(ageBound.results).toEqual([]);
  });

  it("keeps failed indexing searchable, deduplicates FTS overlap, and requeues cleanly", async () => {
    const { stored, jobId } = await storeMemory({
      title: "Failed index",
      namespace: "work",
      messages: [{ role: "user", content: "failure bridge token Juniper" }],
    });
    await expect(
      indexRevision(indexingEnv(true), stored.revisionId, env.ACTIVE_INDEX_GENERATION),
    ).rejects.toThrow("indexing failed");

    const chunk = await env.MEMORY_DB.prepare("SELECT id FROM chunks WHERE revision_id = ? LIMIT 1")
      .bind(stored.revisionId)
      .first<{ id: string }>();
    expect(chunk).not.toBeNull();
    const failed = await searchMemory(
      searchEnv({ semanticMatches: [{ chunkId: chunk?.id ?? "", score: 0.9 }] }),
      { query: "Juniper bridge", limit: 8 },
    );
    const state = await env.MEMORY_DB.prepare(
      "SELECT status, failed_at, error_message FROM chunk_index_state WHERE revision_id = ?",
    )
      .bind(stored.revisionId)
      .first<{ status: string; failed_at: string | null; error_message: string | null }>();
    expect(failed.results).toHaveLength(1);
    expect(failed.results[0]?.sources).toEqual(["lexical", "semantic", "recent_canonical"]);
    expect(state?.status).toBe("failed");
    expect(state?.failed_at).toBeTruthy();
    expect(state?.error_message).not.toContain("Juniper");

    await retryJob(env, jobId);
    const retried = await env.MEMORY_DB.prepare(
      "SELECT status, failed_at, error_message FROM chunk_index_state WHERE revision_id = ?",
    )
      .bind(stored.revisionId)
      .first<{ status: string; failed_at: string | null; error_message: string | null }>();
    expect(retried).toEqual({ status: "queued", failed_at: null, error_message: null });
  });

  it("filters superseded revisions before fallback or indexed ranking", async () => {
    const id = crypto.randomUUID();
    const oldRevision = await storeMemory({
      id,
      title: "Pilot",
      namespace: "work",
      messages: [{ role: "user", content: "Pilot location: Gresik" }],
    });
    const latestRevision = await storeMemory({
      id,
      title: "Pilot",
      namespace: "work",
      messages: [{ role: "user", content: "FINAL pilot location: Sidoarjo" }],
    });

    const stale = await searchMemory(searchEnv(), { query: "Gresik pilot", limit: 8 });
    const latest = await searchMemory(searchEnv(), { query: "Sidoarjo pilot", limit: 8 });
    expect(stale.results).toEqual([]);
    expect(latest.results[0]?.revisionId).toBe(latestRevision.stored.revisionId);
    expect(latest.results[0]?.revisionId).not.toBe(oldRevision.stored.revisionId);
  });

  it("degrades to canonical search when semantic retrieval is unavailable", async () => {
    await storeMemory({
      title: "Semantic outage",
      namespace: "work",
      messages: [{ role: "user", content: "outage fallback token Redwood" }],
    });
    const result = await searchMemory(searchEnv({ semanticFailure: true }), {
      query: "Redwood outage",
      limit: 8,
    });
    expect(result.results[0]?.sources).toContain("recent_canonical");
    expect(result.degraded).toBe(true);
    expect(result.unavailable).toContain("semantic");
  });

  it("keeps semantic-only indexed retrieval working", async () => {
    const { stored } = await storeMemory({
      title: "Orchid protocol",
      namespace: "work",
      messages: [{ role: "user", content: "Orchid rotates access credentials after an incident." }],
    });
    await indexRevision(indexingEnv(), stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const chunk = await env.MEMORY_DB.prepare("SELECT id FROM chunks WHERE revision_id = ? LIMIT 1")
      .bind(stored.revisionId)
      .first<{ id: string }>();

    expect(chunk).not.toBeNull();
    const result = await searchMemory(
      searchEnv({ semanticMatches: [{ chunkId: chunk?.id ?? "", score: 0.9 }] }),
      { query: "abstract paraphrase", limit: 8, namespace: "work" },
    );
    expect(result.results[0]?.revisionId).toBe(stored.revisionId);
    expect(result.results[0]?.sources).toEqual(["semantic"]);
  });

  it("clamps the semantic topK to the Vectorize cap at large limits", async () => {
    const namespace = `clamp-${crypto.randomUUID()}`;
    const { stored } = await storeMemory({
      title: "Clamp survivor",
      namespace,
      messages: [{ role: "user", content: "clamp paraphrase token Wallaby" }],
    });
    await indexRevision(indexingEnv(), stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const chunk = await env.MEMORY_DB.prepare("SELECT id FROM chunks WHERE revision_id = ? LIMIT 1")
      .bind(stored.revisionId)
      .first<{ id: string }>();
    const topKs: number[] = [];
    const candidateEnv = searchEnv({
      semanticMatches: [{ chunkId: chunk?.id ?? "", score: 0.8 }],
    });
    candidateEnv.MEMORY_VECTOR = {
      query: (_embedding, options) => {
        topKs.push(options?.topK ?? 0);
        return Promise.resolve({
          matches: [{ id: chunk?.id ?? "", score: 0.8, metadata: { chunk_id: chunk?.id ?? "" } }],
          count: 1,
        });
      },
    };

    const result = await searchMemory(candidateEnv, {
      query: "paraphrase of wallaby token",
      limit: 20,
      namespace,
    });
    expect(topKs).toEqual([50]);
    expect(result.results[0]?.revisionId).toBe(stored.revisionId);
    expect(result.results[0]?.sources).toContain("semantic");
  });

  it("keeps indexed results when the canonical fallback object is unavailable", async () => {
    const { stored } = await storeMemory({
      title: "Canonical outage",
      namespace: "work",
      messages: [{ role: "user", content: "indexed survivor token Cypress" }],
    });
    await indexRevision(indexingEnv(), stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    await env.MEMORY_DB.prepare(
      `UPDATE chunk_index_state SET status = 'failed', failed_at = ?, queued_at = ?
       WHERE revision_id = ?`,
    )
      .bind(new Date().toISOString(), new Date().toISOString(), stored.revisionId)
      .run();
    await env.MEMORY_BUCKET.delete(stored.manifestKey);

    const result = await searchMemory(searchEnv({ maxRevisions: 50 }), {
      query: "Cypress survivor",
      limit: 8,
    });
    expect(result.results[0]?.sources).toContain("lexical");
    expect(result.degraded).toBe(true);
    expect(result.unavailable).toContain("recent_canonical");
  });

  it("returns an empty healthy response for a tokenless query", async () => {
    await expect(searchMemory(searchEnv(), { query: "  ---  ", limit: 8 })).resolves.toEqual({
      results: [],
      degraded: false,
      unavailable: [],
    });
  });

  it("filters indexed results by conversation tags with AND semantics", async () => {
    const tagged = await storeMemory({
      title: "Dragon arc",
      namespace: "work",
      tags: ["Dragon-Arc", "battle"],
      messages: [{ role: "user", content: "The guild defends the eastern gate of Aurelia." }],
    });
    await indexRevision(indexingEnv(), tagged.stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const untagged = await storeMemory({
      title: "Phoenix arc",
      namespace: "work",
      tags: ["phoenix-arc"],
      messages: [{ role: "user", content: "The guild defends the western gate of Aurelia." }],
    });
    await indexRevision(indexingEnv(), untagged.stored.revisionId, env.ACTIVE_INDEX_GENERATION);

    const matching = await searchMemory(searchEnv(), {
      query: "guild eastern gate",
      limit: 8,
      namespace: "work",
      tags: ["dragon-arc", "battle"],
    });
    expect(matching.results.map((result) => result.revisionId)).toEqual([tagged.stored.revisionId]);
    expect(matching.results[0]?.tags).toEqual(expect.arrayContaining(["dragon-arc", "battle"]));

    const missing = await searchMemory(searchEnv(), {
      query: "guild eastern gate",
      limit: 8,
      namespace: "work",
      tags: ["dragon-arc", "phoenix-arc"],
    });
    expect(missing.results).toEqual([]);
  });

  it("adds tags on append without removing existing ones", async () => {
    const { stored, conversation } = await storeMemory({
      title: "Prologue",
      namespace: "work",
      tags: ["prologue"],
      messages: [{ role: "user", content: "The story begins at dawn." }],
    });
    const appended = await appendConversation(
      env,
      conversation.id,
      stored.revisionId,
      [{ role: "assistant", content: "The climax arrives at dusk." }],
      ["Climax"],
    );
    const loaded = await loadCanonicalRevision(env, appended.revisionId);
    expect(loaded.conversation.tags).toEqual(["prologue", "climax"]);

    const listed = await listConversations(env, { limit: 100, namespace: "work" });
    const row = listed.conversations.find((candidate) => candidate.id === conversation.id);
    expect(row?.tags).toEqual(expect.arrayContaining(["prologue", "climax"]));
  });

  it("does not extract hashtags from body text", async () => {
    const namespace = `hashtag-${crypto.randomUUID()}`;
    const { stored, conversation } = await storeMemory({
      title: "Hashtag body",
      namespace,
      messages: [{ role: "user", content: "This mentions #alpha and #photobox." }],
    });
    await indexRevision(indexingEnv(), stored.revisionId, env.ACTIVE_INDEX_GENERATION);

    const listed = await listConversations(env, { limit: 100, namespace });
    const row = listed.conversations.find((candidate) => candidate.id === conversation.id);
    expect(row?.tags).toEqual([]);
    const result = await searchMemory(searchEnv(), { query: "alpha", limit: 8, namespace });
    const hit = result.results.find((item) => item.conversationId === conversation.id);
    expect(hit?.tags).toEqual([]);
  });

  it("filters by tags with all and any semantics on search and list", async () => {
    const namespace = `tagmode-${crypto.randomUUID()}`;
    const rulesDialogue = await storeMemory({
      title: "Rules dialogue",
      namespace,
      tags: ["rules", "dialogue"],
      messages: [{ role: "user", content: "rules dialogue marker qlzx" }],
    });
    const rulesWriting = await storeMemory({
      title: "Rules writing",
      namespace,
      tags: ["rules", "writing"],
      messages: [{ role: "user", content: "rules writing marker qlzx" }],
    });
    await indexRevision(
      indexingEnv(),
      rulesDialogue.stored.revisionId,
      env.ACTIVE_INDEX_GENERATION,
    );
    await indexRevision(indexingEnv(), rulesWriting.stored.revisionId, env.ACTIVE_INDEX_GENERATION);

    const all = await searchMemory(searchEnv(), {
      query: "qlzx",
      limit: 8,
      namespace,
      tags: ["rules", "dialogue"],
    });
    expect(all.results.map((result) => result.conversationId).sort()).toEqual([
      rulesDialogue.conversation.id,
    ]);
    const any = await searchMemory(searchEnv(), {
      query: "qlzx",
      limit: 8,
      namespace,
      tags: ["dialogue", "writing"],
      tagMode: "any",
    });
    expect(any.results.map((result) => result.conversationId).sort()).toEqual(
      [rulesDialogue.conversation.id, rulesWriting.conversation.id].sort(),
    );
    const listed = await listConversations(env, {
      limit: 100,
      namespace,
      tags: ["dialogue"],
      tagMode: "any",
    });
    expect(listed.conversations.map((candidate) => candidate.id).sort()).toEqual([
      rulesDialogue.conversation.id,
    ]);
  });

  it("keeps tag filters inside the namespace boundary", async () => {
    const foo = await storeMemory({
      title: "Foo rules",
      namespace: `tagfoo-${crypto.randomUUID()}`,
      tags: ["rules"],
      messages: [{ role: "user", content: "foo rules token qz1" }],
    });
    const bar = await storeMemory({
      title: "Bar rules",
      namespace: `tagbar-${crypto.randomUUID()}`,
      tags: ["rules"],
      messages: [{ role: "user", content: "bar rules token qz1" }],
    });
    await indexRevision(indexingEnv(), foo.stored.revisionId, env.ACTIVE_INDEX_GENERATION);

    const searchResult = await searchMemory(searchEnv(), {
      query: "qz1",
      limit: 8,
      namespace: foo.conversation.namespace,
      tags: ["rules"],
    });
    expect(searchResult.results.map((result) => result.conversationId)).toEqual([
      foo.conversation.id,
    ]);
    const listed = await listConversations(env, {
      limit: 100,
      namespace: foo.conversation.namespace,
      tags: ["rules"],
    });
    expect(listed.conversations.map((candidate) => candidate.id)).toEqual([foo.conversation.id]);
    expect(bar.conversation.id).not.toBe(foo.conversation.id);
  });

  it("leaves tags unchanged when appending without a tags argument", async () => {
    const { stored, conversation } = await storeMemory({
      title: "Tagged story",
      namespace: "work",
      tags: ["prologue", "arc-1"],
      messages: [{ role: "user", content: "First line." }],
    });
    const appended = await appendConversation(env, conversation.id, stored.revisionId, [
      { role: "assistant", content: "Second line." },
    ]);
    const loaded = await loadCanonicalRevision(env, appended.revisionId);
    expect(loaded.conversation.tags).toEqual(["prologue", "arc-1"]);
    const listed = await listConversations(env, { limit: 100, namespace: "work" });
    const row = listed.conversations.find((candidate) => candidate.id === conversation.id);
    expect(row?.tags).toEqual(["prologue", "arc-1"]);
  });

  it("updates tags with optimistic revision checking", async () => {
    const { stored, conversation } = await storeMemory({
      title: "Mutable tags",
      namespace: "work",
      tags: ["old-tag"],
      messages: [{ role: "user", content: "tag mutation body" }],
    });
    await expect(
      updateConversationTags(env, conversation.id, "stale-revision", ["x"], []),
    ).rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
    const updated = await updateConversationTags(
      env,
      conversation.id,
      stored.revisionId,
      ["alpha", "old-tag"],
      ["old-tag"],
    );
    expect(updated.tags).toEqual(["alpha", "old-tag"]);
    const removed = await updateConversationTags(
      env,
      conversation.id,
      stored.revisionId,
      [],
      ["alpha"],
    );
    expect(removed.tags).toEqual(["old-tag"]);
  });

  it("semantically retrieves a newly stored memory after indexing completes", async () => {
    const namespace = `sem-${crypto.randomUUID()}`;
    const { stored, conversation } = await storeMemory({
      title: "Event 16 photobox",
      namespace,
      messages: [
        {
          role: "user",
          content:
            "Ravhi and Adriana became a newly official couple at the photobox. The photobox image became Adriana's chosen wallpaper and lock screen.",
        },
      ],
    });
    const queued = await env.MEMORY_DB.prepare(
      "SELECT status FROM chunk_index_state WHERE revision_id = ?",
    )
      .bind(stored.revisionId)
      .first<{ status: string }>();
    expect(queued?.status).toBe("queued");
    await indexRevision(indexingEnv(), stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const indexed = await env.MEMORY_DB.prepare(
      "SELECT status, indexed_at FROM chunk_index_state WHERE revision_id = ?",
    )
      .bind(stored.revisionId)
      .first<{ status: string; indexed_at: string | null }>();
    expect(indexed?.status).toBe("indexed");
    expect(indexed?.indexed_at).toBeTruthy();
    const chunk = await env.MEMORY_DB.prepare("SELECT id FROM chunks WHERE revision_id = ? LIMIT 1")
      .bind(stored.revisionId)
      .first<{ id: string }>();

    const result = await searchMemory(
      searchEnv({ semanticMatches: [{ chunkId: chunk?.id ?? "", score: 0.85 }] }),
      {
        query: "gambar yang dipakai Adriana sebagai latar layar HP",
        limit: 8,
        namespace,
        debug: true,
      },
    );
    expect(result.results[0]?.revisionId).toBe(stored.revisionId);
    expect(result.results[0]?.sources).toContain("semantic");
    expect(result.results[0]?.debug?.semanticScore).toBeGreaterThan(0);
    expect(conversation.id).toBeTruthy();
  });

  it("unions semantic-only candidates with lexical candidates before reranking", async () => {
    const namespace = `union-${crypto.randomUUID()}`;
    const lexical = await storeMemory({
      title: "Lexical survivor",
      namespace,
      messages: [{ role: "user", content: "union bridge token Quokka" }],
    });
    await indexRevision(indexingEnv(), lexical.stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const semanticOnly = await storeMemory({
      title: "Semantic survivor",
      namespace,
      messages: [{ role: "user", content: "entirely unrelated calendar note" }],
    });
    await indexRevision(indexingEnv(), semanticOnly.stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const lexicalChunk = await env.MEMORY_DB.prepare(
      "SELECT id FROM chunks WHERE revision_id = ? LIMIT 1",
    )
      .bind(lexical.stored.revisionId)
      .first<{ id: string }>();
    const semanticChunk = await env.MEMORY_DB.prepare(
      "SELECT id FROM chunks WHERE revision_id = ? LIMIT 1",
    )
      .bind(semanticOnly.stored.revisionId)
      .first<{ id: string }>();

    const result = await searchMemory(
      searchEnv({
        semanticMatches: [{ chunkId: semanticChunk?.id ?? "", score: 0.9 }],
      }),
      { query: "Quokka bridge", limit: 8, namespace, debug: true },
    );
    const ids = new Set(result.results.map((item) => item.chunkId));
    expect(ids.has(semanticChunk?.id ?? "")).toBe(true);
    expect(ids.has(lexicalChunk?.id ?? "")).toBe(true);
    const semanticHit = result.results.find((item) => item.chunkId === semanticChunk?.id);
    expect(semanticHit?.sources).toContain("semantic");
    expect(semanticHit?.debug?.semanticScore).toBeGreaterThan(0);
  });

  it("recalls morphological variants through FTS prefix terms", async () => {
    const { stored } = await storeMemory({
      title: "Coastal bird",
      namespace: "work",
      messages: [
        { role: "user", content: "The coastal puffin returns each spring to the cliffs." },
      ],
    });
    await indexRevision(indexingEnv(), stored.revisionId, env.ACTIVE_INDEX_GENERATION);

    const result = await searchMemory(searchEnv(), {
      query: "puffins",
      limit: 8,
      namespace: "work",
    });
    expect(result.results[0]?.revisionId).toBe(stored.revisionId);
    expect(result.results[0]?.sources).toContain("lexical");
  });

  it("ranks adjacent phrase matches above scattered tokens", async () => {
    const namespace = `phrase-${crypto.randomUUID()}`;
    const adjacent = await storeMemory({
      title: "Red dragon lore",
      namespace,
      messages: [{ role: "user", content: "The red dragon breathes fire at dusk." }],
    });
    await indexRevision(indexingEnv(), adjacent.stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const scattered = await storeMemory({
      title: "Dragon sightings",
      namespace,
      messages: [{ role: "user", content: "Red lights appeared, and later a dragon was seen." }],
    });
    await indexRevision(indexingEnv(), scattered.stored.revisionId, env.ACTIVE_INDEX_GENERATION);

    const result = await searchMemory(searchEnv(), {
      query: "red dragon",
      limit: 8,
      namespace,
    });
    expect(result.results[0]?.revisionId).toBe(adjacent.stored.revisionId);
  });
});

function eventMessage(index: number): { role: string; content: string } {
  const body =
    index === 15
      ? "Ravhi and Adriana became a newly official couple at the photobox. The photobox image became Adriana's chosen wallpaper and lock screen."
      : index === 11
        ? "Vien and Prasetyo became an established couple with an official relationship."
        : index === 20
          ? "The MacBook migration moved developer configuration to the new work laptop."
          : `Canonical event record with operator context and outcome details. `.repeat(5);
  const label =
    index === 15
      ? "EVENT 16 NEW-COUPLE PHOTOBOX CANONICAL WALLPAPER"
      : index === 11
        ? "EVENT 12 VIEN + PRASETYO BECOME ESTABLISHED COUPLE"
        : index === 20
          ? "EVENT 21 MACBOOK DEVICE MIGRATION"
          : `EVENT ${index + 1} SAMPLE RECORD ${index + 1}`;
  return { role: index % 2 === 0 ? "user" : "assistant", content: `[${label}]\n\n${body}` };
}

describe("message-boundary semantic chunking", () => {
  it("keeps one semantic chunk per event message and isolates unrelated events", async () => {
    const namespace = `evchunk-${crypto.randomUUID()}`;
    const { stored } = await storeMemory({
      title: "ASTARA event log",
      namespace,
      messages: Array.from({ length: 35 }, (_, index) => eventMessage(index)),
    });
    await indexRevision(indexingEnv(), stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const rows = (
      await env.MEMORY_DB.prepare(
        "SELECT id, body, token_estimate FROM chunks WHERE revision_id = ? ORDER BY ordinal",
      )
        .bind(stored.revisionId)
        .all<{ id: string; body: string; token_estimate: number }>()
    ).results;

    expect(rows.length).toBe(35);
    const photobox = rows.find((row) => row.body.includes("PHOTOBOX"));
    const macbook = rows.find((row) => row.body.includes("MACBOOK"));
    const vien = rows.find((row) => row.body.includes("PRASETYO"));
    expect(photobox?.id).toBeTruthy();
    expect(macbook?.id).toBeTruthy();
    expect(vien?.id).toBeTruthy();
    expect(photobox?.body).toContain("Adriana's chosen wallpaper");
    expect(photobox?.token_estimate).toBeLessThan(1800);
    expect(macbook?.body).not.toContain("PHOTOBOX");
    expect(photobox?.body).not.toContain("MACBOOK");
    expect(photobox?.body).not.toContain("PRASETYO");

    const exact = await searchMemory(searchEnv(), {
      query: "EVENT 16 NEW-COUPLE PHOTOBOX CANONICAL WALLPAPER",
      limit: 8,
      namespace,
      debug: true,
    });
    expect(exact.results[0]?.chunkId).toBe(photobox?.id);
    expect(exact.results[0]?.sources).toContain("lexical");
    const vienRank = exact.results.findIndex((result) => result.chunkId === vien?.id);
    expect(vienRank).toBeGreaterThan(0);

    const generic = await searchMemory(searchEnv(), {
      query: "photobox wallpaper couple",
      limit: 8,
      namespace,
    });
    expect(generic.results[0]?.chunkId).toBe(photobox?.id);
  });

  it("retrieves the photobox event for English and Indonesian paraphrases", async () => {
    const namespace = `evpar-${crypto.randomUUID()}`;
    const { stored } = await storeMemory({
      title: "ASTARA event log",
      namespace,
      messages: Array.from({ length: 35 }, (_, index) => eventMessage(index)),
    });
    await indexRevision(indexingEnv(), stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const rows = (
      await env.MEMORY_DB.prepare(
        "SELECT id, body FROM chunks WHERE revision_id = ? ORDER BY ordinal",
      )
        .bind(stored.revisionId)
        .all<{ id: string; body: string }>()
    ).results;
    const chunk = (bodyFragment: string) =>
      rows.find((row) => row.body.includes(bodyFragment))?.id ?? "";

    const semanticMatches = [
      { chunkId: chunk("PHOTOBOX"), score: 0.85 },
      { chunkId: chunk("MACBOOK"), score: 0.85 },
      { chunkId: chunk("PRASETYO"), score: 0.75 },
      { chunkId: chunk("SAMPLE RECORD 3"), score: 0.6 },
    ];

    const english = await searchMemory(searchEnv({ semanticMatches }), {
      query: "picture Adriana uses as her phone background after she and Ravhi started dating",
      limit: 8,
      namespace,
      debug: true,
    });
    expect(english.results[0]?.chunkId).toBe(chunk("PHOTOBOX"));
    expect(english.results[0]?.sources).toContain("semantic");
    expect(english.results[0]?.debug?.semanticScore).toBeGreaterThan(0);

    const indonesian = await searchMemory(searchEnv({ semanticMatches }), {
      query: "gambar yang Adriana pakai sebagai latar layar HP setelah dia dan Ravhi mulai pacaran",
      limit: 8,
      namespace,
      debug: true,
    });
    expect(indonesian.results[0]?.chunkId).toBe(chunk("PHOTOBOX"));
    expect(indonesian.results[0]?.sources).toContain("semantic");
  });

  it("supersedes old-generation vectors and queries only the active generation", async () => {
    const namespace = `evgen-${crypto.randomUUID()}`;
    const { stored } = await storeMemory({
      title: "Generation migration",
      namespace,
      messages: [
        { role: "user", content: "A canonical memory used to verify generation rebuild." },
      ],
    });
    const g1 = "bge-m3-chat-turn-v1" as const;
    const g2 = "bge-m3-chat-turn-v2" as const;
    const deleted: string[][] = [];
    const upserted: string[][] = [];
    const captureIndexing = (): IndexingEnv => ({
      ...indexingEnv(),
      MEMORY_VECTOR: {
        deleteByIds: (ids) => {
          deleted.push([...ids]);
          return Promise.resolve({ mutationId: "test-delete", ids: [...ids], count: ids.length });
        },
        upsert: (vectors) => {
          upserted.push(vectors.map((vector) => vector.id));
          return Promise.resolve({ mutationId: "test-upsert", ids: [], count: 0 });
        },
      },
    });

    await indexRevision(captureIndexing(), stored.revisionId, g1);
    const g1Vectors = (
      await env.MEMORY_DB.prepare(
        "SELECT vector_id FROM chunks WHERE revision_id = ? AND generation_id = ?",
      )
        .bind(stored.revisionId, g1)
        .all<{ vector_id: string }>()
    ).results;
    expect(g1Vectors.length).toBe(1);

    await indexRevision(captureIndexing(), stored.revisionId, g2);
    expect(deleted.flat()).toEqual(expect.arrayContaining(g1Vectors.map((row) => row.vector_id)));
    const g2Rows = (
      await env.MEMORY_DB.prepare(
        "SELECT id, vector_id FROM chunks WHERE revision_id = ? AND generation_id = ?",
      )
        .bind(stored.revisionId, g2)
        .all<{ id: string; vector_id: string }>()
    ).results;
    expect(g2Rows.length).toBe(1);
    expect(g2Rows[0]?.vector_id).not.toBe(g1Vectors[0]?.vector_id);
    expect(upserted.at(-1)).toEqual([g2Rows[0]?.vector_id]);
    const g1Count = await env.MEMORY_DB.prepare(
      "SELECT COUNT(*) AS count FROM chunks WHERE revision_id = ? AND generation_id = ?",
    )
      .bind(stored.revisionId, g1)
      .first<{ count: number }>();
    expect(g1Count?.count).toBe(1);

    const seenFilters: Array<VectorizeVectorMetadataFilter | undefined> = [];
    const searchGenEnv = {
      ...searchEnv({ semanticMatches: [{ chunkId: g2Rows[0]?.id ?? "", score: 0.99 }] }),
      ACTIVE_INDEX_GENERATION: g2,
    };
    const baseQuery = searchGenEnv.MEMORY_VECTOR.query;
    searchGenEnv.MEMORY_VECTOR.query = (embedding, options) => {
      seenFilters.push(options?.filter);
      return baseQuery(embedding, options);
    };

    const result = await searchMemory(searchGenEnv, {
      query: "canonical memory",
      limit: 8,
      namespace,
    });
    expect(seenFilters).toEqual([{ generation: { $eq: g2 }, namespace: { $eq: namespace } }]);
    expect(result.results[0]?.chunkId).toBe(g2Rows[0]?.id);
    expect(result.results.map((item) => item.chunkId)).toEqual([
      ...new Set(result.results.map((item) => item.chunkId)),
    ]);
  });

  it("caps one container conversation at five chunks without starving its top semantic event", async () => {
    const namespace = `evcap-${crypto.randomUUID()}`;
    const { stored, conversation } = await storeMemory({
      title: "Container event log",
      namespace,
      messages: Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `[EVENT ${index + 1} / QUOKKA RIVER ${index + 1}]\n\n${"quokka river token common filler words repeated for length. ".repeat(3)}`,
      })),
    });
    await indexRevision(indexingEnv(), stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const rows = (
      await env.MEMORY_DB.prepare("SELECT id FROM chunks WHERE revision_id = ? ORDER BY ordinal")
        .bind(stored.revisionId)
        .all<{ id: string }>()
    ).results;

    const lexicalOnly = await searchMemory(searchEnv(), {
      query: "quokka river token",
      limit: 8,
      namespace,
    });
    expect(lexicalOnly.results.length).toBe(5);
    expect(lexicalOnly.results.every((item) => item.conversationId === conversation.id)).toBe(true);

    const target = rows[7]?.id ?? "";
    const withSemantic = await searchMemory(
      searchEnv({
        semanticMatches: [
          ...rows.slice(0, 7).map((row) => ({ chunkId: row.id, score: 0.55 })),
          { chunkId: target, score: 0.7 },
        ],
      }),
      {
        query: "quokka river token",
        limit: 8,
        namespace,
        debug: true,
      },
    );
    expect(withSemantic.results.some((item) => item.chunkId === target)).toBe(true);
    expect(withSemantic.results.length).toBeLessThanOrEqual(8);
    const scores = withSemantic.results.map((item) => item.debug?.semanticScore ?? 0);
    expect(Math.max(...scores)).toBe(
      withSemantic.results.find((item) => item.chunkId === target)?.debug?.semanticScore,
    );
  });

  it("unions and deduplicates candidates across semantic query representations", async () => {
    const namespace = `variants-${crypto.randomUUID()}`;
    const wallpaper = await storeMemory({
      title: "Wallpaper story",
      namespace,
      messages: [
        {
          role: "user",
          content: "The photobox image became her wallpaper and lock screen.",
        },
      ],
    });
    const device = await storeMemory({
      title: "Device story",
      namespace,
      messages: [{ role: "user", content: "The MacBook migration moved configuration." }],
    });
    await indexRevision(indexingEnv(), wallpaper.stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    await indexRevision(indexingEnv(), device.stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    const chunkId = async (revisionId: string) =>
      (
        await env.MEMORY_DB.prepare("SELECT id FROM chunks WHERE revision_id = ? LIMIT 1")
          .bind(revisionId)
          .first<{ id: string }>()
      )?.id ?? "";
    const wallpaperChunk = await chunkId(wallpaper.stored.revisionId);
    const deviceChunk = await chunkId(device.stored.revisionId);

    let vectorCalls = 0;
    const seenFilters: Array<VectorizeVectorMetadataFilter | undefined> = [];
    const variantEnv = {
      ...searchEnv(),
      AI: {
        run: (_model: unknown, input: { text: string[] }) =>
          Promise.resolve({ data: input.text.map(() => embedding) }),
      },
    };
    variantEnv.MEMORY_VECTOR.query = (_vector, options) => {
      vectorCalls += 1;
      seenFilters.push(options?.filter);
      const matches =
        vectorCalls === 1
          ? [
              { id: wallpaperChunk, score: 0.7, metadata: { chunk_id: wallpaperChunk } },
              { id: deviceChunk, score: 0.55, metadata: { chunk_id: deviceChunk } },
            ]
          : [
              { id: wallpaperChunk, score: 0.75, metadata: { chunk_id: wallpaperChunk } },
              { id: deviceChunk, score: 0.5, metadata: { chunk_id: deviceChunk } },
            ];
      return Promise.resolve({ matches, count: matches.length });
    };

    const result = await searchMemory(variantEnv, {
      query: "photobox wallpaper phone",
      limit: 8,
      namespace,
      debug: true,
    });
    expect(vectorCalls).toBe(2);
    expect(seenFilters).toEqual([
      { generation: { $eq: env.ACTIVE_INDEX_GENERATION }, namespace: { $eq: namespace } },
      { generation: { $eq: env.ACTIVE_INDEX_GENERATION }, namespace: { $eq: namespace } },
    ]);
    expect(result.results.filter((item) => item.chunkId === wallpaperChunk).length).toBe(1);
    const wallpaperHit = result.results.find((item) => item.chunkId === wallpaperChunk);
    const normalized = 0.5 + 0.5 * ((0.75 - 0.3) / 0.65);
    expect(wallpaperHit?.debug?.semanticScore).toBeCloseTo(normalized, 10);
    expect(wallpaperHit?.debug?.semanticVariants[0]).toBe("photobox wallpaper phone");
    expect(wallpaperHit?.debug?.semanticVariants).toHaveLength(2);
    expect(result.results[0]?.chunkId).toBe(wallpaperChunk);
  });
});
