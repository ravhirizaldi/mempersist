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
      run: () =>
        config.semanticFailure
          ? Promise.reject(new Error("Workers AI unavailable"))
          : Promise.resolve({ data: [embedding] }),
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
      return Promise.resolve({ data: [embedding] });
    };

    const result = await searchMemory(candidateEnv, { query, limit: 8, namespace: "work" });

    expect(result.results[0]?.revisionId).toBe(pangolin.stored.revisionId);
    expect(result.results[0]?.sources).toContain("recent_canonical");
    expect(semanticInputs).toEqual([[query]]);
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
