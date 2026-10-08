import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpConversation } from "../src/chatgpt";
import { createMemoryMcpServer } from "../src/mcp";
import {
  appendConversation,
  cleanupPreparedCommitBatches,
  commitConversationBatch,
  materializeCommittedBatchDerivedRows,
  writeCanonicalConversation,
} from "../src/storage";
import { completeMemoryBatch } from "../src/writes";
import { domainId } from "../src/crypto";
import {
  getOrCreateUser,
  grantNamespace,
  OWNER_DB_USER_ID,
  resolveTenant,
  type Tenant,
} from "../src/tenant";

const receiptSchema = z.object({
  batch_id: z.string(),
  status: z.literal("committed"),
  durable: z.literal(true),
  results: z.array(
    z.object({
      request_index: z.number().int(),
      conversation_id: z.string(),
      previous_revision_id: z.string(),
      revision_id: z.string(),
      durable: z.literal(true),
      indexing: z.unknown(),
      derived: z
        .union([
          z.object({ status: z.literal("materialized") }),
          z.object({
            status: z.literal("failed"),
            error: z.object({
              code: z.literal("DERIVED_MATERIALIZATION"),
              message: z.string(),
              retryable: z.literal(true),
            }),
          }),
        ])
        .optional(),
      verification: z.unknown().optional(),
    }),
  ),
  readback_requests: z.unknown().optional(),
  omitted: z.unknown().optional(),
  used_serialized_bytes: z.number(),
  max_serialized_bytes: z.number(),
});

type CallResult =
  { isError: true; text: string } | { isError: false; text: string; value: unknown };

type Seed = {
  id: string;
  revisionId: string;
};

const connections: Array<{ client: Client; server: McpServer }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) {
    await connection.client.close();
    await connection.server.close();
  }
});

async function connectedClient(tenant: Tenant): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "commit-batch-integration", version: "1.0.0" });
  const server = createMemoryMcpServer(env, tenant);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

async function ownerClient(namespaces: string[]): Promise<Client> {
  for (const namespace of namespaces) await grantNamespace(env, OWNER_DB_USER_ID, namespace);
  return connectedClient(await resolveTenant(env, { userId: "owner" }));
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  const content = z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .parse(result.content);
  const text = content[0]!.text;
  if (result.isError === true) return { isError: true, text };
  return { isError: false, text, value: JSON.parse(text) as unknown };
}

async function callValue(client: Client, args: Record<string, unknown>) {
  const result = await call(client, "memory_commit_batch", args);
  if (result.isError) throw new Error(result.text);
  return receiptSchema.parse(result.value);
}

async function seed(namespace: string, content = "before"): Promise<Seed> {
  const conversation = await createMcpConversation({
    id: crypto.randomUUID(),
    title: `Batch ${content}`,
    namespace,
    messages: [{ role: "user", content }],
  });
  const stored = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);
  return { id: conversation.id, revisionId: stored.revisionId };
}

async function snapshot(ids: string[]) {
  const rows = await Promise.all(
    ids.map(async (id) => {
      const head = await env.MEMORY_DB.prepare(
        "SELECT current_revision_id FROM conversations WHERE id = ?",
      )
        .bind(id)
        .first<{ current_revision_id: string | null }>();
      const revisions = await env.MEMORY_DB.prepare(
        "SELECT COUNT(*) AS total FROM conversation_revisions WHERE conversation_id = ?",
      )
        .bind(id)
        .first<{ total: number }>();
      const jobs = await env.MEMORY_DB.prepare(
        `SELECT COUNT(*) AS total FROM jobs WHERE kind = 'index' AND subject_id IN
         (SELECT id FROM conversation_revisions WHERE conversation_id = ?)`,
      )
        .bind(id)
        .first<{ total: number }>();
      return [
        id,
        {
          head: head?.current_revision_id ?? null,
          revisions: revisions?.total ?? 0,
          jobs: jobs?.total ?? 0,
        },
      ] as const;
    }),
  );
  return Object.fromEntries(rows);
}

async function bucketKeys(): Promise<string[]> {
  return (await env.MEMORY_BUCKET.list()).objects.map((object) => object.key).sort();
}

async function derivedSnapshot(conversationId: string, revisionId: string) {
  const nodes = await env.MEMORY_DB.prepare(
    "SELECT source_node_id FROM message_nodes WHERE revision_id = ? ORDER BY sequence, source_node_id",
  )
    .bind(revisionId)
    .all<{ source_node_id: string }>();
  const tags = await env.MEMORY_DB.prepare(
    "SELECT tag FROM conversation_tags WHERE conversation_id = ? ORDER BY tag",
  )
    .bind(conversationId)
    .all<{ tag: string }>();
  return {
    sourceNodeIds: nodes.results.map((row) => row.source_node_id),
    tags: tags.results.map((row) => row.tag),
  };
}

async function batchLedger(batchId: string) {
  const batch = await env.MEMORY_DB.prepare(
    "SELECT status, receipt_json FROM commit_batches WHERE batch_id = ?",
  )
    .bind(batchId)
    .first<{ status: string; receipt_json: string | null }>();
  const operations = await env.MEMORY_DB.prepare(
    "SELECT request_index, conversation_id, revision_id, segment_object_key, status FROM commit_batch_operations WHERE batch_id = ? ORDER BY request_index",
  )
    .bind(batchId)
    .all<{
      request_index: number;
      conversation_id: string;
      revision_id: string;
      segment_object_key: string;
      status: string;
    }>();
  return { batch, operations: operations.results };
}

function appendOperation(seedValue: Seed, text = "after") {
  return {
    operation: "append",
    conversation_id: seedValue.id,
    base_revision_id: seedValue.revisionId,
    messages: [{ role: "assistant", content: text }],
  };
}

describe("memory_commit_batch integration", () => {
  it("commits one append and one complete replace across account namespaces", async () => {
    const personal = `batch-personal-${crypto.randomUUID().slice(0, 8)}`;
    const work = `batch-work-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient([personal, work]);
    const first = await seed(personal, "append source");
    const second = await seed(work, "replace source");

    const receipt = await callValue(client, {
      idempotency_key: `batch-${crypto.randomUUID()}`,
      verify: true,
      operations: [
        { ...appendOperation(first, "appended"), tags: ["batched"] },
        {
          operation: "replace",
          conversation_id: second.id,
          base_revision_id: second.revisionId,
          messages: [
            { role: "user", content: "replacement one" },
            { role: "assistant", content: "replacement two" },
          ],
        },
      ],
    });

    expect(receipt.results).toHaveLength(2);
    expect(receipt.results.map((item) => item.request_index)).toEqual([0, 1]);
    expect(receipt.results.every((item) => item.durable)).toBe(true);
    expect(receipt.results.every((item) => item.verification !== undefined)).toBe(true);
    expect(receipt.results[0]!.previous_revision_id).toBe(first.revisionId);
    expect(receipt.results[1]!.previous_revision_id).toBe(second.revisionId);
    const state = await snapshot([first.id, second.id]);
    expect(state[first.id]!.head).toBe(receipt.results[0]!.revision_id);
    expect(state[second.id]!.head).toBe(receipt.results[1]!.revision_id);
    expect(state[first.id]!.revisions).toBe(2);
    expect(state[second.id]!.revisions).toBe(2);
    expect(state[first.id]!.jobs).toBe(1);
    expect(state[second.id]!.jobs).toBe(1);
  });

  it("commits the maximum twenty unique operations", { timeout: 30_000 }, async () => {
    const namespaces = [
      `batch-a-${crypto.randomUUID().slice(0, 8)}`,
      `batch-b-${crypto.randomUUID().slice(0, 8)}`,
    ];
    const client = await ownerClient(namespaces);
    const seeds = await Promise.all(
      Array.from({ length: 20 }, (_, index) => seed(namespaces[index % 2]!, `item-${index}`)),
    );
    const batchSizes: number[] = [];
    const originalBatch = env.MEMORY_DB.batch.bind(env.MEMORY_DB);
    vi.spyOn(env.MEMORY_DB, "batch").mockImplementation(async (statements) => {
      batchSizes.push(statements.length);
      return originalBatch(statements);
    });
    const receipt = await callValue(client, {
      idempotency_key: `batch-${crypto.randomUUID()}`,
      operations: seeds.map((item, index) => appendOperation(item, `appended-${index}`)),
    });
    const finalBatchIndex = batchSizes.findIndex((size) => size > 50);
    expect(finalBatchIndex).toBeGreaterThanOrEqual(0);
    expect(batchSizes[finalBatchIndex]!).toBeLessThanOrEqual(100);
    expect(batchSizes.every((size, index) => index === finalBatchIndex || size <= 50)).toBe(true);
    expect(receipt.results).toHaveLength(20);
    expect(new Set(receipt.results.map((item) => item.conversation_id)).size).toBe(20);
    const state = await snapshot(seeds.map((item) => item.id));
    for (const item of receipt.results) {
      expect(state[item.conversation_id]!.head).toBe(item.revision_id);
      expect(state[item.conversation_id]!.revisions).toBe(2);
      expect(state[item.conversation_id]!.jobs).toBe(1);
      expect(item.derived).toMatchObject({ status: "materialized" });
      expect(
        (await derivedSnapshot(item.conversation_id, item.revision_id)).sourceNodeIds,
      ).toHaveLength(2);
    }
  });
  it("materializes a 1000-message replace in bounded D1 batches", { timeout: 60_000 }, async () => {
    const namespace = `batch-large-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient([namespace]);
    const item = await seed(namespace, "large source");
    const batchSizes: number[] = [];
    const originalBatch = env.MEMORY_DB.batch.bind(env.MEMORY_DB);
    vi.spyOn(env.MEMORY_DB, "batch").mockImplementation(async (statements) => {
      batchSizes.push(statements.length);
      return originalBatch(statements);
    });
    const receipt = await callValue(client, {
      idempotency_key: `batch-${crypto.randomUUID()}`,
      operations: [
        {
          operation: "replace",
          conversation_id: item.id,
          base_revision_id: item.revisionId,
          messages: Array.from({ length: 1000 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `message-${index}`,
          })),
        },
      ],
    });
    const revisionId = receipt.results[0]!.revision_id;
    expect(batchSizes.length).toBeGreaterThan(0);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(50);
    expect((await derivedSnapshot(item.id, revisionId)).sourceNodeIds).toHaveLength(1000);
  });

  it("rejects duplicate operations before preparing R2 and leaves every head unchanged", async () => {
    const namespace = `batch-validation-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient([namespace]);
    const first = await seed(namespace);
    const before = await snapshot([first.id]);
    const keys = await bucketKeys();
    const put = vi.spyOn(env.MEMORY_BUCKET, "put");
    const result = await call(client, "memory_commit_batch", {
      idempotency_key: `batch-${crypto.randomUUID()}`,
      operations: [appendOperation(first), appendOperation(first, "duplicate")],
    });
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.text).not.toContain(first.id);
      expect(result.text).not.toContain(first.revisionId);
    }
    expect(put).not.toHaveBeenCalled();
    expect(await snapshot([first.id])).toEqual(before);
    expect(await bucketKeys()).toEqual(keys);
  });
  it("rejects a stale middle operation atomically without changing valid neighbors", async () => {
    const namespace = `batch-stale-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient([namespace]);
    const seeds = await Promise.all([
      seed(namespace, "one"),
      seed(namespace, "two"),
      seed(namespace, "three"),
    ]);
    const [firstSeed, middleSeed, lastSeed] = seeds;
    const advanced = await appendConversation(
      env,
      middleSeed.id,
      middleSeed.revisionId,
      [{ role: "assistant", content: "advanced" }],
      undefined,
      [namespace],
      OWNER_DB_USER_ID,
    );
    await env.MEMORY_DB.prepare("UPDATE conversations SET current_revision_id = ? WHERE id = ?")
      .bind(middleSeed.revisionId, middleSeed.id)
      .run();
    const before = await snapshot(seeds.map((item) => item.id));
    const idempotencyKey = `batch-${crypto.randomUUID()}`;
    const batchId = await domainId("commit-batch", OWNER_DB_USER_ID, idempotencyKey);
    const originalBatch = env.MEMORY_DB.batch.bind(env.MEMORY_DB);
    const batchSizes: number[] = [];
    let batches = 0;
    let rejectedBatches = 0;
    vi.spyOn(env.MEMORY_DB, "batch").mockImplementation(async (statements) => {
      batchSizes.push(statements.length);
      try {
        const result = await originalBatch(statements);
        batches += 1;
        if (batches === 1) {
          await env.MEMORY_DB.prepare(
            "UPDATE conversations SET current_revision_id = ? WHERE id = ?",
          )
            .bind(advanced.revisionId, middleSeed.id)
            .run();
        }
        return result;
      } catch (error) {
        rejectedBatches += 1;
        throw error;
      }
    });
    await call(client, "memory_commit_batch", {
      idempotency_key: idempotencyKey,
      operations: seeds.map((item) => appendOperation(item, `batch-${item.id}`)),
    });
    expect(rejectedBatches).toBeGreaterThanOrEqual(1);
    expect(batchSizes.length).toBeGreaterThanOrEqual(2);
    const after = await snapshot(seeds.map((item) => item.id));
    expect(after[firstSeed.id]).toEqual(before[firstSeed.id]);
    expect(after[lastSeed.id]).toEqual(before[lastSeed.id]);
    expect(after[middleSeed.id]!.head).toBe(advanced.revisionId);
    expect(after[middleSeed.id]!.revisions).toBe(before[middleSeed.id]!.revisions);
    expect(after[middleSeed.id]!.jobs).toBe(before[middleSeed.id]!.jobs);
    const ledger = await batchLedger(batchId);
    expect(ledger.batch?.status).not.toBe("committed");
    expect(ledger.batch?.receipt_json).toBeNull();
    expect(ledger.operations.every((operation) => operation.status !== "committed")).toBe(true);
    const committedIdempotency = await env.MEMORY_DB.prepare(
      "SELECT COUNT(*) AS total FROM commit_batches WHERE idempotency_key = ? AND status = 'committed'",
    )
      .bind(idempotencyKey)
      .first<{ total: number }>();
    expect(committedIdempotency?.total ?? 0).toBe(0);
    const committedRevisions = await env.MEMORY_DB.prepare(
      `SELECT COUNT(*) AS total FROM conversation_revisions
       WHERE conversation_id IN (?, ?, ?) AND id NOT IN (?, ?, ?, ?)`,
    )
      .bind(
        firstSeed.id,
        middleSeed.id,
        lastSeed.id,
        firstSeed.revisionId,
        middleSeed.revisionId,
        lastSeed.revisionId,
        advanced.revisionId,
      )
      .first<{ total: number }>();
    expect(committedRevisions?.total ?? 0).toBe(0);
  });
  it("keeps prepared objects trackable across R2 and D1 failures and resumes after restart", async () => {
    const namespace = `batch-retry-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient([namespace]);
    const item = await seed(namespace);
    const before = await snapshot([item.id]);
    const keysBefore = await bucketKeys();
    const idempotencyKey = `batch-${crypto.randomUUID()}`;
    const batchId = await domainId("commit-batch", OWNER_DB_USER_ID, idempotencyKey);
    const originalPut = env.MEMORY_BUCKET.put.bind(env.MEMORY_BUCKET);
    let puts = 0;
    vi.spyOn(env.MEMORY_BUCKET, "put").mockImplementation(async (...args) => {
      puts += 1;
      if (puts === 2) throw new Error("synthetic prepare failure");
      return originalPut(...args);
    });
    const failed = await call(client, "memory_commit_batch", {
      idempotency_key: idempotencyKey,
      operations: [appendOperation(item)],
    });
    expect(failed.isError).toBe(true);
    expect(await snapshot([item.id])).toEqual(before);
    expect((await bucketKeys()).length).toBeGreaterThan(keysBefore.length);

    const prepared = await batchLedger(batchId);
    const preparedOperation = prepared.operations[0];
    expect(preparedOperation?.status).toBe("prepared");
    if (!preparedOperation) throw new Error("Expected prepared batch operation");
    const preparedSegment = await env.MEMORY_BUCKET.get(preparedOperation.segment_object_key);
    if (!preparedSegment) throw new Error("Expected prepared segment");
    const preparedSourceNodeIds = (await preparedSegment.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; node?: { sourceNodeId?: string } })
      .filter((line) => line.type === "node" && line.node?.sourceNodeId)
      .map((line) => line.node!.sourceNodeId!);
    expect(preparedSourceNodeIds.length).toBeGreaterThan(0);

    vi.restoreAllMocks();
    const restarted = await ownerClient([namespace]);
    const resumed = await callValue(restarted, {
      idempotency_key: idempotencyKey,
      operations: [appendOperation(item)],
    });
    expect(resumed.results[0]!.previous_revision_id).toBe(item.revisionId);
    expect(resumed.results[0]!.revision_id).toBe(preparedOperation.revision_id);
    const derived = await derivedSnapshot(item.id, resumed.results[0]!.revision_id);
    expect(derived.sourceNodeIds).toEqual(preparedSourceNodeIds);
    expect((await snapshot([item.id]))[item.id]!.head).toBe(resumed.results[0]!.revision_id);
    expect((await snapshot([item.id]))[item.id]!.jobs).toBe(1);
    const replay = await callValue(restarted, {
      idempotency_key: idempotencyKey,
      operations: [appendOperation(item)],
    });
    expect(replay.results[0]!.revision_id).toBe(resumed.results[0]!.revision_id);
    expect((await snapshot([item.id]))[item.id]!.jobs).toBe(1);
  });
  it("leaves heads unchanged when the atomic D1 batch fails", async () => {
    const namespace = `batch-d1-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient([namespace]);
    const item = await seed(namespace);
    const before = await snapshot([item.id]);
    const keysBefore = await bucketKeys();
    const originalBatch = env.MEMORY_DB.batch.bind(env.MEMORY_DB);
    let batches = 0;
    vi.spyOn(env.MEMORY_DB, "batch").mockImplementation(async (statements) => {
      batches += 1;
      if (batches === 2) throw new Error("synthetic D1 failure");
      return originalBatch(statements);
    });
    const result = await call(client, "memory_commit_batch", {
      idempotency_key: `batch-${crypto.randomUUID()}`,
      operations: [appendOperation(item)],
    });
    expect(result.isError).toBe(true);
    expect(await snapshot([item.id])).toEqual(before);
    expect((await bucketKeys()).length).toBeGreaterThan(keysBefore.length);
  });
  it("reruns post-commit derived materialization from R2 without duplicates", async () => {
    const namespace = `batch-derived-${crypto.randomUUID().slice(0, 8)}`;
    await ownerClient([namespace]);
    const item = await seed(namespace, "derived source");
    const committed = await commitConversationBatch(env, {
      userId: OWNER_DB_USER_ID,
      namespaces: [namespace],
      idempotencyKey: `batch-${crypto.randomUUID()}`,
      operations: [
        {
          operation: "append",
          conversationId: item.id,
          baseRevisionId: item.revisionId,
          messages: [{ role: "assistant", content: "derived append" }],
          tags: ["rerun-tag"],
        },
      ],
    });
    const operation = committed.operations[0];
    if (!operation) throw new Error("Expected committed batch operation");
    const pending = await env.MEMORY_DB.prepare(
      "SELECT receipt_json FROM commit_batches WHERE batch_id = ?",
    )
      .bind(committed.batchId)
      .first<{ receipt_json: string | null }>();
    expect(JSON.parse(pending?.receipt_json ?? "{}")).toMatchObject({ status: "pending" });
    vi.spyOn(env.MEMORY_DB, "batch").mockRejectedValue(new Error("synthetic derived failure"));
    const failed = await completeMemoryBatch(env, committed, false);
    expect(failed.results[0]!.derived).toMatchObject({
      status: "failed",
      error: { code: "DERIVED_MATERIALIZATION", retryable: true },
    });
    expect(failed.results[0]!.indexing).toMatchObject({ status: "queued" });
    const pendingAfterFailure = await env.MEMORY_DB.prepare(
      "SELECT status, receipt_json FROM commit_batches WHERE batch_id = ?",
    )
      .bind(committed.batchId)
      .first<{ status: string; receipt_json: string | null }>();
    expect(pendingAfterFailure?.status).toBe("committed");
    expect(JSON.parse(pendingAfterFailure?.receipt_json ?? "{}")).toMatchObject({
      status: "pending",
    });
    expect((await snapshot([item.id]))[item.id]!.jobs).toBe(1);
    vi.restoreAllMocks();
    const retried = await completeMemoryBatch(env, committed, false);
    expect(retried.results[0]!.derived).toMatchObject({ status: "materialized" });
    expect(retried.results[0]!.indexing).toMatchObject({ status: "queued" });
    const first = await derivedSnapshot(item.id, operation.revision.revisionId);
    await materializeCommittedBatchDerivedRows(env, committed.operations);
    const second = await derivedSnapshot(item.id, operation.revision.revisionId);
    expect(second).toEqual(first);
    expect(second.sourceNodeIds).toHaveLength(2);
    expect(second.tags).toEqual(["rerun-tag"]);
    expect((await snapshot([item.id]))[item.id]!.jobs).toBe(1);
  });
  it("reports queue and verification failures after durable commit", async () => {
    const namespace = `batch-post-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient([namespace]);
    const queueItem = await seed(namespace, "queue");
    vi.spyOn(env.INDEX_QUEUE, "send").mockRejectedValue(new Error("synthetic queue failure"));
    const queued = await callValue(client, {
      idempotency_key: `batch-${crypto.randomUUID()}`,
      operations: [appendOperation(queueItem)],
    });
    expect(queued.durable).toBe(true);
    expect(queued.results[0]!.indexing).toMatchObject({ status: "failed" });
    expect((await snapshot([queueItem.id]))[queueItem.id]!.head).toBe(
      queued.results[0]!.revision_id,
    );

    vi.restoreAllMocks();
    const verifyItem = await seed(namespace, "verify");
    const committed = await commitConversationBatch(env, {
      userId: OWNER_DB_USER_ID,
      namespaces: [namespace],
      idempotencyKey: `batch-${crypto.randomUUID()}`,
      operations: [
        {
          operation: "append",
          conversationId: verifyItem.id,
          baseRevisionId: verifyItem.revisionId,
          messages: [{ role: "assistant", content: "after verification" }],
        },
      ],
    });
    const committedOperation = committed.operations[0];
    if (!committedOperation) throw new Error("Expected committed batch operation");
    const committedHead = (await snapshot([verifyItem.id]))[verifyItem.id]!.head;
    expect(committedHead).toBe(committedOperation.revision.revisionId);
    const originalManifest = await env.MEMORY_BUCKET.get(committedOperation.revision.manifestKey);
    if (!originalManifest) throw new Error("Expected the committed manifest");
    const manifestText = await originalManifest.text();
    await env.MEMORY_BUCKET.delete(committedOperation.revision.manifestKey);
    try {
      const verified = await completeMemoryBatch(env, committed, true);
      expect(verified.durable).toBe(true);
      expect(verified.results[0]!.verification).toMatchObject({ status: "failed" });
      expect((await snapshot([verifyItem.id]))[verifyItem.id]!.head).toBe(committedHead);
    } finally {
      await env.MEMORY_BUCKET.put(committedOperation.revision.manifestKey, manifestText);
    }
  });

  it("replays identically, conflicts on changed material, and cleans orphan preparations", async () => {
    const namespace = `batch-replay-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient([namespace]);
    const item = await seed(namespace);
    const idempotencyKey = `batch-${crypto.randomUUID()}`;
    const input = { idempotency_key: idempotencyKey, operations: [appendOperation(item, "same")] };
    const first = await callValue(client, input);
    const jobsAfterFirst = (await snapshot([item.id]))[item.id]!.jobs;
    const replay = await callValue(client, input);
    expect(replay.results.map((entry) => entry.revision_id)).toEqual(
      first.results.map((entry) => entry.revision_id),
    );
    expect((await snapshot([item.id]))[item.id]!.jobs).toBe(jobsAfterFirst);

    const conflict = await call(client, "memory_commit_batch", {
      ...input,
      operations: [appendOperation(item, "changed")],
    });
    expect(conflict.isError).toBe(true);
    if (conflict.isError) {
      expect(conflict.text).not.toContain(item.id);
      expect(conflict.text).not.toContain(item.revisionId);
    }
    expect((await snapshot([item.id]))[item.id]!.head).toBe(first.results[0]!.revision_id);

    const orphan = await seed(namespace, "orphan");
    const orphanBefore = await bucketKeys();
    const originalPut = env.MEMORY_BUCKET.put.bind(env.MEMORY_BUCKET);
    let puts = 0;
    vi.spyOn(env.MEMORY_BUCKET, "put").mockImplementation(async (...args) => {
      puts += 1;
      if (puts === 2) throw new Error("orphan preparation failure");
      return originalPut(...args);
    });
    const orphanResult = await call(client, "memory_commit_batch", {
      idempotency_key: `batch-${crypto.randomUUID()}`,
      operations: [appendOperation(orphan)],
    });
    expect(orphanResult.isError).toBe(true);
    const afterFailure = await bucketKeys();
    expect(afterFailure.length).toBeGreaterThan(orphanBefore.length);
    const orphanKeys = afterFailure.filter((key) => !orphanBefore.includes(key));
    const deleted = await cleanupPreparedCommitBatches(env, "9999-12-31T00:00:00.000Z");
    expect(deleted).toBeGreaterThan(0);
    const afterCleanup = await bucketKeys();
    expect(orphanKeys.every((key) => !afterCleanup.includes(key))).toBe(true);
    expect(afterCleanup.some((key) => key.includes(item.id))).toBe(true);
  });

  it("does not reveal or mutate another tenant's conversation", async () => {
    const namespace = `batch-isolation-${crypto.randomUUID().slice(0, 8)}`;
    await ownerClient([namespace]);
    const item = await seed(namespace, "owner secret");
    const other = await getOrCreateUser(env, `batch-other-${crypto.randomUUID()}@example.com`);
    await grantNamespace(env, other.id, namespace);
    const foreign = await connectedClient(await resolveTenant(env, { userId: other.id }));
    const result = await call(foreign, "memory_commit_batch", {
      idempotency_key: `batch-${crypto.randomUUID()}`,
      operations: [appendOperation(item, "intrusion")],
    });
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.text).not.toContain(item.id);
      expect(result.text).not.toContain(item.revisionId);
    }
    expect((await snapshot([item.id]))[item.id]!.head).toBe(item.revisionId);
  });
});
