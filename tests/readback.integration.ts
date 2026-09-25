import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpConversation, normalizeChatGptConversation } from "../src/chatgpt";
import app from "../src/app";
import { createMemoryMcpServer } from "../src/mcp";
import {
  getChunkContext,
  getConversationPage,
  getConversations,
  jsonBytes,
  type ConversationRequest,
} from "../src/retrieval";
import {
  appendConversation,
  replaceConversation,
  writeCanonicalConversation,
} from "../src/storage";
import { getOrCreateUser, OWNER_DB_USER_ID } from "../src/tenant";
import { completeMemoryWrite, verifyCommittedWrite } from "../src/writes";
import { branchedChatGptConversation } from "./fixtures/chatgpt";

const messages = [
  {
    role: "user",
    content: 'Original rule: keep the gate open.\n"Quoted" \\ 雨 🌙',
    timestamp: "2026-01-01T00:00:00.000Z",
  },
  {
    role: "assistant",
    content: "Correction: the gate is CLOSED.\r\nKeep both messages.",
    timestamp: "2026-01-02T00:00:00.000Z",
  },
];
const messageResult = z.object({
  sourceNodeId: z.string(),
  role: z.string().nullable(),
  text: z.string(),
  createdAt: z.string().nullable(),
});
const pageResult = z.object({
  conversation: z.object({
    id: z.string(),
    revisionId: z.string(),
    title: z.string(),
    namespace: z.string(),
    tags: z.array(z.string()),
  }),
  messages: z.array(messageResult),
  nextOffset: z.number().nullable(),
  total: z.number(),
  offset: z.number().optional(),
  oversizedMessage: z.unknown().optional(),
});
const receiptResult = z.object({
  conversation_id: z.string(),
  revision_id: z.string(),
  durable: z.literal(true),
  indexing: z.object({ status: z.string() }),
  verification: z
    .object({
      status: z.string(),
      revision_id: z.string(),
      checked_messages: z.number().optional(),
      readback: pageResult.optional(),
    })
    .optional(),
});

const connections: Array<{ client: Client; server: ReturnType<typeof createMemoryMcpServer> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
});

async function connectedClientFor(userId = OWNER_DB_USER_ID, namespaces = ["personal"]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthetic-readback", version: "1" });
  const server = createMemoryMcpServer(env, {
    userId,
    defaultNamespace: namespaces[0] ?? "personal",
    namespaces,
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

async function connectedClient() {
  return connectedClientFor();
}

async function callRaw(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .parse(result.content);
  const text = content[0]!.text;
  return { result, text, bytes: new TextEncoder().encode(text).byteLength };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await callRaw(client, name, args);
  expect(result.result.isError).not.toBe(true);
  return { value: JSON.parse(result.text) as unknown, bytes: result.bytes };
}

type BatchPage = {
  conversation?: { id?: string; revisionId?: string };
  messages?: Array<{ text: string; sourceNodeId?: string }>;
  oversizedMessage?: {
    conversationId?: string;
    revisionId?: string;
    sourceNodeId?: string;
    offset?: number;
    bytes?: number;
  } | null;
  nextOffset?: number | null;
};

type BatchEntry = {
  requestIndex: number;
  status: string;
  continuation?: unknown;
  page?: BatchPage;
  error?: { code?: string; message?: string };
};

type BatchValue = {
  batchId?: string;
  completed?: number;
  remaining?: number;
  nextCursor?: string | null;
  usedSerializedBytes?: number;
  maxSerializedBytes?: number;
  results: BatchEntry[];
};

function batch(value: unknown): BatchValue {
  return value as BatchValue;
}

function pageTexts(value: BatchValue): Map<number, string[]> {
  const texts = new Map<number, string[]>();
  for (const entry of value.results) {
    if (entry.page?.messages?.length)
      texts.set(
        entry.requestIndex,
        entry.page.messages.map((message) => message.text),
      );
  }
  return texts;
}

function addPageTexts(target: Map<number, string[]>, value: BatchValue): void {
  for (const [requestIndex, messages] of pageTexts(value)) {
    target.set(requestIndex, [...(target.get(requestIndex) ?? []), ...messages]);
  }
}

async function store(content = messages, userId = OWNER_DB_USER_ID) {
  const conversation = await createMcpConversation({
    title: "Synthetic runtime",
    namespace: "personal",
    tags: ["runtime"],
    messages: content,
  });
  return {
    conversation,
    stored: await writeCanonicalConversation(env, conversation, null, null, userId),
  };
}

function request(id: string, offset = 0, limit = 100): ConversationRequest {
  return { conversation_id: id, offset, limit, branch: "active" };
}

describe("compact readback and committed write verification", () => {
  it("keeps HTTP canonical defaults and exposes compact and verified reads through authenticated routes", async () => {
    const headers = {
      authorization: "Bearer integration-test-token",
      "content-type": "application/json",
    };
    const response = await app.request(
      "/api/memories",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "HTTP synthetic", messages, verify: true }),
      },
      env,
    );
    expect(response.status).toBe(201);
    const receipt = receiptResult.parse(await response.json());
    expect(receipt.verification?.status).toBe("passed");
    const path = `/api/conversations/${receipt.conversation_id}`;
    const canonical = await app.request(path, { headers }, env);
    expect(await canonical.json()).toHaveProperty("messages.0.content");
    const compact = await app.request(
      `${path}?format=compact&revision_id=${receipt.revision_id}`,
      { headers },
      env,
    );
    expect(pageResult.parse(await compact.json()).messages.map((m) => m.text)).toEqual(
      messages.map((m) => m.content),
    );
    expect((await app.request(`${path}?format=summary`, { headers }, env)).status).toBe(400);
    expect((await app.request(`${path}?format=compact`, {}, env)).status).toBe(401);
    const append = await app.request(
      `${path}/append`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          base_revision_id: receipt.revision_id,
          messages: [messages[0]],
          verify: true,
        }),
      },
      env,
    );
    expect(await append.json()).toMatchObject({
      durable: true,
      verification: { status: "passed", readback: { offset: 2 } },
    });
  });

  it("returns durable MCP receipts on queue failure but errors on canonical write failure", async () => {
    const client = await connectedClient();
    vi.spyOn(env.INDEX_QUEUE, "send").mockRejectedValue(new Error("Synthetic queue failure"));
    for (const verify of [false, true]) {
      const receipt = receiptResult.parse(
        (await call(client, "memory_store", { title: "Queue failure", messages, verify })).value,
      );
      expect(receipt.indexing.status).toBe("failed");
      if (verify) expect(receipt.verification?.status).toBe("passed");
      else expect(receipt.verification).toBeUndefined();
    }
    vi.spyOn(env.MEMORY_BUCKET, "put").mockRejectedValue(new Error("Synthetic R2 failure"));
    const failed = await client.callTool({
      name: "memory_store",
      arguments: { title: "R2 failure", messages, verify: true },
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('"durable":true');
  });

  it("benchmarks synthetic continuation and 3–6-owner saves over the real MCP handlers", async () => {
    const client = await connectedClient();
    const owners: Array<z.infer<typeof receiptResult>> = [];
    for (let i = 0; i < 6; i++) {
      owners.push(
        receiptResult.parse(
          (
            await call(client, "memory_store", {
              title: `Synthetic owner ${i}`,
              messages: messages.map((m) => ({
                ...m,
                content: m.content + "fiction ".repeat(470),
              })),
            })
          ).value,
        ),
      );
    }
    const measure = async (name: string, operations: Array<() => ReturnType<typeof call>>) => {
      const start = performance.now();
      let bytes = 0;
      for (const operation of operations) bytes += (await operation()).bytes;
      return {
        name,
        calls: operations.length,
        bytes,
        elapsed_ms: Math.round((performance.now() - start) * 100) / 100,
      };
    };
    const snapshots = owners.map((owner) => ({
      conversation_id: owner.conversation_id,
      revision_id: owner.revision_id,
    }));
    const samples = [];
    const totals = new Map(owners.map((owner) => [owner.conversation_id, 2]));
    for (let sample = 0; sample < 3; sample++) {
      const single = await measure(
        "continuation_single",
        snapshots
          .slice(0, 5)
          .map((snapshot) => () => call(client, "memory_get_conversation", snapshot)),
      );
      const batch = await measure("continuation_batch", [
        async () => {
          const response = await call(client, "memory_get_conversations", {
            requests: snapshots.slice(0, 5),
            max_serialized_bytes: 49152,
          });
          const parsed = z
            .object({
              results: z.array(
                z.object({ status: z.literal("ok"), continuation: z.null(), page: pageResult }),
              ),
            })
            .parse(response.value);
          expect(parsed.results).toHaveLength(5);
          expect(parsed.results.flatMap((entry) => entry.page.messages)).toHaveLength(10);
          return response;
        },
      ]);
      expect(batch.bytes).toBeLessThan(single.bytes);
      samples.push(single, batch);
      for (const count of [3, 6]) {
        for (const verify of [false, true]) {
          const operations = owners.slice(0, count).flatMap((owner) => {
            const write = async () => {
              const response = await call(client, "memory_append", {
                conversation_id: owner.conversation_id,
                base_revision_id: owner.revision_id,
                messages: [messages[1]],
                verify,
              });
              owner.revision_id = receiptResult.parse(response.value).revision_id;
              totals.set(owner.conversation_id, totals.get(owner.conversation_id)! + 1);
              return response;
            };
            return verify
              ? [write]
              : [
                  write,
                  () =>
                    call(client, "memory_get_conversation", {
                      conversation_id: owner.conversation_id,
                      revision_id: owner.revision_id,
                      offset: totals.get(owner.conversation_id)! - 1,
                    }),
                ];
          });
          samples.push(
            await measure(`save_${count}_${verify ? "verified" : "separate"}`, operations),
          );
        }
      }
    }
    // Local MCP transport + real Miniflare R2/D1. No production/network latency claim.
    console.info("RP_BENCHMARK", JSON.stringify(samples));
  }, 30_000);

  it("preserves canonical defaults and exact compact text, timestamps, corrections, and branch nodes", async () => {
    const client = await connectedClient();
    const receipt = receiptResult.parse(
      (await call(client, "memory_store", { title: "Rules", messages, verify: true })).value,
    );
    expect(receipt.verification?.status).toBe("passed");
    expect(receipt.verification?.readback?.messages.map((m) => m.text)).toEqual(
      messages.map((m) => m.content),
    );
    const canonical = await call(client, "memory_get_conversation", {
      conversation_id: receipt.conversation_id,
    });
    expect(canonical.value).toMatchObject({
      messages: [{ content: { parts: [messages[0]!.content] }, raw: {} }, {}],
    });
    const compact = await call(client, "memory_get_conversation", {
      conversation_id: receipt.conversation_id,
      format: "compact",
    });
    const page = pageResult.parse(compact.value);
    expect(page.messages.map((m) => m.text)).toEqual(messages.map((m) => m.content));
    expect(page.messages.map((m) => m.createdAt)).toEqual(messages.map((m) => m.timestamp));
    expect(compact.bytes).toBeLessThan(canonical.bytes);
    expect(compact.value).not.toHaveProperty("messages.0.content");
    expect(compact.value).not.toHaveProperty("messages.0.raw");
    const branched = await normalizeChatGptConversation(branchedChatGptConversation());
    branched.namespace = "personal";
    await writeCanonicalConversation(env, branched, null);
    const result = await getConversations(
      env,
      [{ ...request(branched.id), branch: "all" }],
      ["personal"],
      OWNER_DB_USER_ID,
    );
    expect(result.results[0]?.page?.messages.map((m) => m.text)).toEqual(
      branched.nodes.map((n) => n.text),
    );
  });

  it("returns ordered mixed failures, preserves duplicates, and isolates same-namespace accounts and revision IDs", async () => {
    const own = await store();
    const user = await getOrCreateUser(env, "readback-other@example.com");
    const foreign = await store(messages, user.id);
    const missing = crypto.randomUUID();
    const broken = await store();
    await env.MEMORY_BUCKET.delete(broken.stored.segmentKey);
    const result = await getConversations(
      env,
      [
        request(own.conversation.id, 1, 1),
        request(foreign.conversation.id),
        request(missing),
        request(own.conversation.id),
        { ...request(own.conversation.id), revision_id: foreign.stored.revisionId },
        request(broken.conversation.id),
      ],
      ["personal"],
      OWNER_DB_USER_ID,
    );
    expect(result.results.map((r) => r.requestIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.results.map((r) => r.status)).toEqual([
      "ok",
      "error",
      "error",
      "ok",
      "error",
      "error",
    ]);
    expect(result.results[1]?.error).toEqual(result.results[2]?.error);
    expect(result.results[4]?.error?.code).toBe("NOT_FOUND");
    expect(result.results[5]?.error?.code).toBe("CANONICAL_STORAGE");
    expect(result.results[0]?.page?.messages[0]?.text).toBe(messages[1]!.content);
    expect(JSON.stringify(result)).not.toContain(foreign.stored.revisionId);
    const denied = await getConversations(
      env,
      [request(own.conversation.id)],
      ["elsewhere"],
      OWNER_DB_USER_ID,
    );
    expect(denied.results[0]?.error?.code).toBe("NOT_FOUND");
  });

  it("keeps batches below 48 KiB and follows partial and deferred pages without losing Unicode prose", async () => {
    const largeMessages = Array.from({ length: 6 }, (_, i) => ({
      ...messages[0]!,
      content: `${i}:` + '雨🌙\\"\n'.repeat(900),
    }));
    const owners = [
      await store(largeMessages),
      await store(largeMessages),
      await store(largeMessages),
    ];
    let pending = owners.map((o) => request(o.conversation.id));
    const seen = new Map<string, string[]>();
    let calls = 0;
    let hadDeferred = false;
    while (pending.length) {
      expect(++calls).toBeLessThan(20);
      const batch = await getConversations(env, pending, ["personal"], OWNER_DB_USER_ID);
      expect(jsonBytes(batch)).toBeLessThanOrEqual(48 * 1024);
      pending = [];
      for (const entry of batch.results) {
        hadDeferred ||= entry.status === "deferred";
        if (entry.page) {
          expect(entry.page.oversizedMessage).toBeNull();
          const id = entry.page.conversation.id;
          seen.set(id, [...(seen.get(id) ?? []), ...entry.page.messages.map((m) => m.text)]);
        }
        if (entry.continuation) pending.push(entry.continuation);
      }
    }
    expect(hadDeferred).toBe(true);
    for (const owner of owners)
      expect(seen.get(owner.conversation.id)).toEqual(largeMessages.map((m) => m.content));
    const oversized = await store([{ ...messages[0]!, content: "雨".repeat(20_000) }]);
    const batch = await getConversations(
      env,
      [request(oversized.conversation.id)],
      ["personal"],
      OWNER_DB_USER_ID,
    );
    expect(batch.results[0]?.page?.oversizedMessage?.offset).toBe(0);
    expect(batch.results[0]?.continuation?.offset).toBe(0);
    expect(jsonBytes(batch)).toBeLessThanOrEqual(48 * 1024);
  });

  it("uses one top-level cursor for deterministic fair paging and accepts 1–20 requests", async () => {
    const client = await connectedClient();
    const content = Array.from({ length: 8 }, (_, index) => ({
      ...messages[0]!,
      content: `${index}:${"x".repeat(700)}`,
    }));
    const owner = await store(content);
    const firstResponse = await call(client, "memory_get_conversations", {
      requests: [request(owner.conversation.id)],
      max_serialized_bytes: 4096,
    });
    const first = batch(firstResponse.value);
    expect(first.batchId).toEqual(expect.any(String));
    expect(first.completed).toEqual(expect.any(Number));
    expect(first.remaining).toEqual(expect.any(Number));
    expect(first.maxSerializedBytes).toBe(4096);
    expect(firstResponse.bytes).toBeLessThanOrEqual(4096);
    expect(first.nextCursor).toEqual(expect.any(String));
    const defaultBudget = batch(
      (
        await call(client, "memory_get_conversations", {
          requests: [request(owner.conversation.id, 0, 1)],
        })
      ).value,
    );
    expect(defaultBudget.maxSerializedBytes).toBe(32768);
    expect(defaultBudget.nextCursor).toEqual(expect.any(String));

    const seen = new Map<number, string[]>();
    addPageTexts(seen, first);
    let cursor = first.nextCursor;
    for (let pageNumber = 0; cursor; pageNumber++) {
      expect(pageNumber).toBeLessThan(20);
      const response = await call(client, "memory_get_conversations", {
        cursor,
        max_serialized_bytes: 4096,
      });
      expect(response.bytes).toBeLessThanOrEqual(4096);
      const page = batch(response.value);
      expect(page.batchId).toBe(first.batchId);
      expect(page.results.every((entry) => entry.requestIndex === 0)).toBe(true);
      addPageTexts(seen, page);
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(seen.get(0)).toEqual(content.map((message) => message.content));

    const twentyTexts = Array.from(
      { length: 20 },
      (_, index) => `twenty-${index}:${"x".repeat(700)}`,
    );
    const twentyOwners = await Promise.all(
      twentyTexts.map((content) => store([{ ...messages[0]!, content }])),
    );
    const twentyRequests = twentyOwners.map((owner) => request(owner.conversation.id));
    const twentyResponse = await call(client, "memory_get_conversations", {
      requests: twentyRequests,
      max_serialized_bytes: 4096,
    });
    let twenty = batch(twentyResponse.value);
    const twentyBatchId = twenty.batchId;
    expect(twentyBatchId).toEqual(expect.any(String));
    expect(twentyResponse.bytes).toBeLessThanOrEqual(4096);
    expect(twenty.results).toHaveLength(20);
    expect(twenty.results.map((entry) => entry.requestIndex)).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );
    expect(twenty.maxSerializedBytes).toBe(4096);
    expect(twenty.results.some((entry) => entry.status === "deferred")).toBe(true);
    expect(twenty.nextCursor).toEqual(expect.any(String));

    const twentySeen = new Map<number, string[]>();
    const twentySeenTexts = new Set<string>();
    const twentySeenIndexes = new Set<number>();
    const twentySeenCursors = new Set<string>();
    let twentyBytes = twentyResponse.bytes;
    let previousCompleted = twenty.completed!;
    let previousRemaining = twenty.remaining!;
    let pageCount = 0;
    while (true) {
      expect(pageCount++).toBeLessThan(200);
      expect(twenty.batchId).toBe(twentyBatchId);
      expect(twenty.completed).toEqual(expect.any(Number));
      expect(twenty.remaining).toEqual(expect.any(Number));
      expect(twentyBytes).toBeLessThanOrEqual(4096);
      const indexes = twenty.results.map((entry) => entry.requestIndex);
      expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
      expect(new Set(indexes).size).toBe(indexes.length);
      expect(indexes.every((index) => index >= 0 && index < twentyRequests.length)).toBe(true);
      const hasPayload = twenty.results.some(
        (entry) => (entry.page?.messages?.length ?? 0) > 0 || Boolean(entry.page?.oversizedMessage),
      );
      const aggregateAdvanced =
        twenty.completed !== previousCompleted || twenty.remaining !== previousRemaining;
      if (pageCount > 1) expect(hasPayload || aggregateAdvanced).toBe(true);
      for (const entry of twenty.results) {
        if (entry.page?.messages?.length) {
          twentySeenIndexes.add(entry.requestIndex);
          for (const message of entry.page.messages) {
            expect(twentySeenTexts.has(message.text)).toBe(false);
            twentySeenTexts.add(message.text);
          }
        }
      }
      addPageTexts(twentySeen, twenty);
      previousCompleted = twenty.completed!;
      previousRemaining = twenty.remaining!;
      if (!twenty.nextCursor) break;
      const nextCursor = twenty.nextCursor;
      expect(nextCursor).toEqual(expect.any(String));
      expect(twentySeenCursors.has(nextCursor)).toBe(false);
      twentySeenCursors.add(nextCursor);
      const response = await call(client, "memory_get_conversations", {
        cursor: nextCursor,
        max_serialized_bytes: 4096,
      });
      twenty = batch(response.value);
      twentyBytes = response.bytes;
    }
    expect(twenty.nextCursor).toBeNull();
    expect(twentySeenIndexes).toEqual(new Set(Array.from({ length: 20 }, (_, index) => index)));
    expect([...twentySeenTexts].sort()).toEqual([...twentyTexts].sort());
    for (const [index, text] of twentyTexts.entries())
      expect(twentySeen.get(index)).toEqual([text]);
  }, 30_000);

  it("keeps mixed-size admissions round-robin, whole-message, ordered, and repeatable", async () => {
    const client = await connectedClient();
    const contents = [
      Array.from({ length: 4 }, (_, index) => ({ ...messages[0]!, content: `small-a-${index}` })),
      Array.from({ length: 4 }, (_, index) => ({
        ...messages[0]!,
        content: `large-${index}:${"L".repeat(2_000)}`,
      })),
      Array.from({ length: 4 }, (_, index) => ({ ...messages[0]!, content: `small-b-${index}` })),
    ];
    const owners = await Promise.all(contents.map((value) => store(value)));
    const requests = owners.map((owner) => request(owner.conversation.id));
    const firstArgs = { requests, max_serialized_bytes: 6000 };
    const first = batch((await call(client, "memory_get_conversations", firstArgs)).value);
    const repeated = batch((await call(client, "memory_get_conversations", firstArgs)).value);
    const shape = (value: BatchValue) =>
      value.results.map((entry) => ({
        requestIndex: entry.requestIndex,
        status: entry.status,
        texts: entry.page?.messages?.map((message) => message.text) ?? [],
      }));
    expect(shape(repeated)).toEqual(shape(first));
    const admitted = first.results
      .filter((entry) => (entry.page?.messages?.length ?? 0) > 0)
      .map((entry) => entry.requestIndex);
    expect(new Set(admitted).size).toBeGreaterThan(1);
    expect(admitted).toEqual([...admitted].sort((left, right) => left - right));
    expect(jsonBytes(first)).toBeLessThanOrEqual(6000);

    const seen = new Map<number, string[]>();
    addPageTexts(seen, first);
    let cursor = first.nextCursor;
    for (let pageNumber = 0; cursor; pageNumber++) {
      expect(pageNumber).toBeLessThan(20);
      const page = batch(
        (
          await call(client, "memory_get_conversations", {
            cursor,
            max_serialized_bytes: 6000,
          })
        ).value,
      );
      expect(jsonBytes(page)).toBeLessThanOrEqual(6000);
      addPageTexts(seen, page);
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    for (const [index, value] of contents.entries())
      expect(seen.get(index)).toEqual(value.map((message) => message.content));
  });

  it("pins every current revision before body reads, including cursor pages", async () => {
    const client = await connectedClient();
    const content = Array.from({ length: 6 }, (_, index) => ({
      ...messages[0]!,
      content: `${index}:${"p".repeat(900)}`,
    }));
    const owners = await Promise.all([store(content), store(content)]);
    const originalGet = env.MEMORY_BUCKET.get.bind(env.MEMORY_BUCKET);
    let injected = false;
    vi.spyOn(env.MEMORY_BUCKET, "get").mockImplementation(async (...args) => {
      if (!injected) {
        injected = true;
        await Promise.all(
          owners.map((owner) =>
            appendConversation(env, owner.conversation.id, owner.stored.revisionId, [messages[1]!]),
          ),
        );
      }
      return originalGet(...args);
    });
    const requests = owners.map((owner) => request(owner.conversation.id));
    const first = batch(
      (
        await call(client, "memory_get_conversations", {
          requests,
          max_serialized_bytes: 6000,
        })
      ).value,
    );
    const revisions = new Set<string>();
    for (const entry of first.results)
      if (entry.page?.conversation?.revisionId) revisions.add(entry.page.conversation.revisionId);
    expect(
      [...revisions].every((revisionId) =>
        owners.some((owner) => owner.stored.revisionId === revisionId),
      ),
    ).toBe(true);
    const seen = new Map<number, string[]>();
    addPageTexts(seen, first);
    let cursor = first.nextCursor;
    for (let pageNumber = 0; cursor; pageNumber++) {
      expect(pageNumber).toBeLessThan(20);
      const page = batch(
        (
          await call(client, "memory_get_conversations", {
            cursor,
            max_serialized_bytes: 6000,
          })
        ).value,
      );
      for (const entry of page.results)
        if (entry.page?.conversation?.revisionId) revisions.add(entry.page.conversation.revisionId);
      addPageTexts(seen, page);
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(revisions).toEqual(new Set(owners.map((owner) => owner.stored.revisionId)));
    for (const [index] of owners.entries())
      expect(seen.get(index)).toEqual(content.map((message) => message.content));
  });

  it("keeps missing and foreign items as indistinguishable per-item errors", async () => {
    const client = await connectedClient();
    const foreignUser = await getOrCreateUser(env, "readback-foreign@example.com");
    const foreign = await store(messages, foreignUser.id);
    const missing = crypto.randomUUID();
    const value = batch(
      (
        await call(client, "memory_get_conversations", {
          requests: [request(foreign.conversation.id), request(missing)],
        })
      ).value,
    );
    expect(value.results.map((entry) => entry.requestIndex)).toEqual([0, 1]);
    expect(value.results.map((entry) => entry.status)).toEqual(["error", "error"]);
    expect(value.results[0]?.error).toEqual(value.results[1]?.error);
    expect(JSON.stringify(value)).not.toContain(foreign.stored.revisionId);
  });

  it("rejects forged, expired, version-incompatible, and cross-tenant cursors generically", async () => {
    const ownerClient = await connectedClient();
    const content = Array.from({ length: 8 }, (_, index) => ({
      ...messages[0]!,
      content: `${index}:${"c".repeat(800)}`,
    }));
    const owner = await store(content);
    const first = batch(
      (
        await call(ownerClient, "memory_get_conversations", {
          requests: [request(owner.conversation.id)],
          max_serialized_bytes: 4096,
        })
      ).value,
    );
    expect(first.nextCursor).toEqual(expect.any(String));
    const cursor = first.nextCursor as string;
    expect(cursor).not.toContain(OWNER_DB_USER_ID);
    expect(cursor).not.toContain(owner.conversation.id);
    expect(cursor).not.toContain(owner.stored.revisionId);
    const forgedCursor = cursor.replace(/[A-Za-z0-9]/u, (character) =>
      character === "a" ? "b" : "a",
    );
    const invalid = await callRaw(ownerClient, "memory_get_conversations", {
      cursor: forgedCursor,
    });
    const wrongVersion = await callRaw(ownerClient, "memory_get_conversations", {
      cursor: `v0.${cursor}`,
    });
    expect(invalid.result.isError).toBe(true);
    expect(wrongVersion.result.isError).toBe(true);
    expect(invalid.text).toBe(wrongVersion.text);

    const foreignUser = await getOrCreateUser(env, "readback-cursor-foreign@example.com");
    const foreignClient = await connectedClientFor(foreignUser.id, [foreignUser.namespace]);
    const crossTenant = await callRaw(foreignClient, "memory_get_conversations", { cursor });
    expect(crossTenant.result.isError).toBe(true);
    expect(crossTenant.text).toBe(invalid.text);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 16 * 60_000));
    const expired = await callRaw(ownerClient, "memory_get_conversations", { cursor });
    vi.useRealTimers();
    expect(expired.result.isError).toBe(true);
    expect(expired.text).toBe(invalid.text);
  });

  it("reports oversized messages without prose and advances the top-level cursor", async () => {
    const client = await connectedClient();
    const oversizedText = "雨".repeat(20_000);
    const afterText = `message after the oversized node:${"n".repeat(3200)}`;
    const owner = await store([
      { ...messages[0]!, content: oversizedText },
      { ...messages[1]!, content: afterText },
    ]);
    const firstResponse = await call(client, "memory_get_conversations", {
      requests: [request(owner.conversation.id)],
      max_serialized_bytes: 4096,
    });
    const first = batch(firstResponse.value);
    const diagnostic = first.results[0]?.page?.oversizedMessage;
    expect(diagnostic).toMatchObject({
      conversationId: owner.conversation.id,
      revisionId: owner.stored.revisionId,
      sourceNodeId: owner.conversation.nodes[0]!.sourceNodeId,
      offset: 0,
    });
    expect(diagnostic?.bytes).toBeGreaterThan(4096);
    expect(JSON.stringify(first)).not.toContain(oversizedText);
    expect(first.nextCursor).toEqual(expect.any(String));

    const next = batch(
      (
        await call(client, "memory_get_conversations", {
          cursor: first.nextCursor,
          max_serialized_bytes: 4096,
        })
      ).value,
    );
    expect(JSON.stringify(next)).not.toContain(oversizedText);
    expect(
      next.results.flatMap((entry) => entry.page?.messages?.map((message) => message.text) ?? []),
    ).toContain(afterText);
    expect(next.results.some((entry) => entry.page?.oversizedMessage)).toBe(false);
    expect(next.nextCursor).toBeNull();
  });

  it("pages oversized diagnostics in a multi-request 4096-byte batch", async () => {
    const client = await connectedClient();
    const oversizedText = "雨".repeat(20_000);
    const normalText = `normal conversation after the oversized node:${"n".repeat(3200)}`;
    const oversized = await store([{ ...messages[0]!, content: oversizedText }]);
    const normal = await store([{ ...messages[1]!, content: normalText }]);
    const firstResponse = await call(client, "memory_get_conversations", {
      requests: [request(oversized.conversation.id), request(normal.conversation.id)],
      max_serialized_bytes: 4096,
    });
    let page = batch(firstResponse.value);
    const batchId = page.batchId;
    expect(batchId).toEqual(expect.any(String));
    expect(page.completed).toEqual(expect.any(Number));
    expect(page.remaining).toEqual(expect.any(Number));
    expect(page.maxSerializedBytes).toBe(4096);
    expect(firstResponse.bytes).toBeLessThanOrEqual(4096);
    expect(page.nextCursor).toEqual(expect.any(String));

    const normalTexts = new Set<string>();
    const seenIndexes = new Set<number>();
    const seenCursors = new Set<string>();
    let currentBytes = firstResponse.bytes;
    let previousCompleted = page.completed!;
    let previousRemaining = page.remaining!;
    let diagnosticCount = 0;
    let pageCount = 0;
    while (true) {
      expect(pageCount++).toBeLessThan(100);
      expect(page.batchId).toBe(batchId);
      expect(page.completed).toEqual(expect.any(Number));
      expect(page.remaining).toEqual(expect.any(Number));
      expect(currentBytes).toBeLessThanOrEqual(4096);
      const indexes = page.results.map((entry) => entry.requestIndex);
      expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
      expect(new Set(indexes).size).toBe(indexes.length);
      expect(indexes.every((index) => index === 0 || index === 1)).toBe(true);
      const hasPayload = page.results.some(
        (entry) => (entry.page?.messages?.length ?? 0) > 0 || Boolean(entry.page?.oversizedMessage),
      );
      const aggregateAdvanced =
        page.completed !== previousCompleted || page.remaining !== previousRemaining;
      if (pageCount > 1) expect(hasPayload || aggregateAdvanced).toBe(true);
      expect(JSON.stringify(page)).not.toContain(oversizedText);
      for (const entry of page.results) {
        const diagnostic = entry.page?.oversizedMessage;
        if (diagnostic) {
          diagnosticCount++;
          seenIndexes.add(entry.requestIndex);
          expect(diagnostic).toMatchObject({
            conversationId: oversized.conversation.id,
            revisionId: oversized.stored.revisionId,
            sourceNodeId: oversized.conversation.nodes[0]!.sourceNodeId,
            offset: 0,
          });
          expect(diagnostic.bytes).toBeGreaterThan(4096);
        }
        for (const message of entry.page?.messages ?? []) {
          expect(message.text).toBe(normalText);
          expect(normalTexts.has(message.text)).toBe(false);
          normalTexts.add(message.text);
          seenIndexes.add(entry.requestIndex);
        }
      }
      previousCompleted = page.completed!;
      previousRemaining = page.remaining!;
      if (!page.nextCursor) break;
      const nextCursor = page.nextCursor;
      expect(nextCursor).toEqual(expect.any(String));
      expect(seenCursors.has(nextCursor)).toBe(false);
      seenCursors.add(nextCursor);
      const response = await call(client, "memory_get_conversations", {
        cursor: nextCursor,
        max_serialized_bytes: 4096,
      });
      page = batch(response.value);
      currentBytes = response.bytes;
    }
    expect(page.nextCursor).toBeNull();
    expect(diagnosticCount).toBe(1);
    expect(normalTexts).toEqual(new Set([normalText]));
    expect(seenIndexes).toEqual(new Set([0, 1]));
  }, 30_000);

  it("enforces UTF-8 byte budgets rather than character counts", async () => {
    const client = await connectedClient();
    const unicode = await store([{ ...messages[0]!, content: "雨🌙".repeat(850) }]);
    const response = await call(client, "memory_get_conversations", {
      requests: [request(unicode.conversation.id)],
      max_serialized_bytes: 5000,
    });
    const value = batch(response.value);
    expect(response.bytes).toBeLessThanOrEqual(5000);
    expect(value.usedSerializedBytes).toBeLessThanOrEqual(5000);
    expect(jsonBytes(value)).toBe(response.bytes);
  });

  it("bounds concurrent canonical read chains to four", async () => {
    const owner = await store();
    const originalGet = env.MEMORY_BUCKET.get.bind(env.MEMORY_BUCKET);
    let active = 0;
    let peak = 0;
    vi.spyOn(env.MEMORY_BUCKET, "get").mockImplementation(async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await originalGet(...args);
      } finally {
        active--;
      }
    });
    const batch = await getConversations(
      env,
      Array.from({ length: 20 }, () => request(owner.conversation.id)),
      ["personal"],
      OWNER_DB_USER_ID,
    );
    expect(batch.results.every((r) => r.status === "ok")).toBe(true);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("verifies store, append offsets, replacement, and the exact committed revision despite later writes", async () => {
    const client = await connectedClient();
    const first = receiptResult.parse(
      (await call(client, "memory_store", { title: "State", messages })).value,
    );
    expect(first.verification).toBeUndefined();
    const appended = receiptResult.parse(
      (
        await call(client, "memory_append", {
          conversation_id: first.conversation_id,
          base_revision_id: first.revision_id,
          messages: [messages[0]],
          verify: true,
        })
      ).value,
    );
    expect(appended.verification?.readback?.offset).toBe(2);
    expect(appended.verification?.readback?.messages).toHaveLength(1);
    expect(appended.verification?.status).toBe("passed");
    const replacement = receiptResult.parse(
      (
        await call(client, "memory_replace", {
          conversation_id: first.conversation_id,
          base_revision_id: appended.revision_id,
          messages: [messages[1]],
          verify: true,
        })
      ).value,
    );
    expect(replacement.verification?.readback?.total).toBe(1);
    expect(replacement.verification?.status).toBe("passed");
    const owner = await store();
    const oldAppend = await appendConversation(
      env,
      owner.conversation.id,
      owner.stored.revisionId,
      [messages[0]!],
    );
    await replaceConversation(env, owner.conversation.id, oldAppend.revisionId, [messages[1]!]);
    const verified = await verifyCommittedWrite(env, oldAppend, [messages[0]!]);
    expect(verified.status).toBe("passed");
    expect(verified.revision_id).toBe(oldAppend.revisionId);
    expect(verified).toMatchObject({ readback: { offset: 2 } });
    const pinned = await getConversations(
      env,
      [{ ...request(owner.conversation.id, 2), revision_id: oldAppend.revisionId }],
      ["personal"],
      OWNER_DB_USER_ID,
    );
    expect(pinned.results[0]?.page?.messages[0]?.text).toBe(messages[0]!.content);
    await expect(
      appendConversation(env, owner.conversation.id, owner.stored.revisionId, messages),
    ).rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
  });

  it("reports concurrent update conflicts without a false verification receipt", async () => {
    const owner = await store();
    const results = await Promise.allSettled([
      appendConversation(env, owner.conversation.id, owner.stored.revisionId, [messages[0]!]),
      replaceConversation(env, owner.conversation.id, owner.stored.revisionId, [messages[1]!]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toMatchObject({
      code: "IMPORT_CONFLICT",
    });
  });

  it("separates indexing failures, missing R2 data, and message/hash mismatches from canonical commit", async () => {
    const owner = await store();
    vi.spyOn(env.INDEX_QUEUE, "send").mockRejectedValue(new Error("synthetic queue unavailable"));
    const result = await completeMemoryWrite(env, owner.stored, messages, true);
    expect(result).toMatchObject({
      durable: true,
      indexing: { status: "failed" },
      verification: { status: "passed" },
    });
    expect((await verifyCommittedWrite(env, owner.stored, [messages[1]!])).status).toBe("failed");
    const segment = await env.MEMORY_BUCKET.get(owner.stored.segmentKey);
    const body = await segment!.text();
    await env.MEMORY_BUCKET.put(owner.stored.segmentKey, body.replace("CLOSED", "OPENED"));
    expect((await verifyCommittedWrite(env, owner.stored, messages)).status).toBe("failed");
    await env.MEMORY_BUCKET.delete(owner.stored.segmentKey);
    expect(await completeMemoryWrite(env, owner.stored, messages, true)).toMatchObject({
      durable: true,
      verification: { status: "failed", revision_id: owner.stored.revisionId },
    });
    await env.MEMORY_BUCKET.delete(owner.stored.manifestKey);
    expect((await verifyCommittedWrite(env, owner.stored, messages)).status).toBe("failed");
  });

  it("verifies all saved messages even when compact readback needs another page or cannot fit one message", async () => {
    const many = Array.from({ length: 105 }, (_, i) => ({
      ...messages[0]!,
      content: `Saved ${i}`,
    }));
    const owner = await store(many);
    const result = await verifyCommittedWrite(env, owner.stored, many);
    expect(result).toMatchObject({
      status: "passed",
      checked_messages: 105,
      readback: { nextOffset: 100, total: 105 },
    });
    const page = await getConversationPage(
      env,
      owner.conversation.id,
      100,
      100,
      "active",
      ["personal"],
      OWNER_DB_USER_ID,
      owner.stored.revisionId,
    );
    expect(page.messages.map((m) => m.text)).toEqual(many.slice(100).map((m) => m.content));
    const huge = [{ ...messages[0]!, content: "x".repeat(70_000) }];
    const oversized = await store(huge);
    const receipt = await completeMemoryWrite(env, oversized.stored, huge, true);
    expect(receipt.verification).toMatchObject({
      status: "passed",
      readback: { messages: [], nextOffset: 0, oversizedMessage: { offset: 0 } },
    });
    expect(jsonBytes(receipt)).toBeLessThan(64 * 1024);
  });

  it("preserves source ranges and ownership on compact chunk contexts", async () => {
    const owner = await store();
    const now = new Date().toISOString();
    await env.MEMORY_DB.prepare(
      `INSERT OR IGNORE INTO index_generations (id, status, chunk_strategy, embedding_model, embedding_dimensions, vector_index_name, created_at) VALUES (?, 'active', 'v1', 'model', 3, 'index', ?)`,
    )
      .bind(env.ACTIVE_INDEX_GENERATION, now)
      .run();
    await env.MEMORY_DB.prepare(
      `INSERT INTO chunks (id, vector_id, revision_id, conversation_id, generation_id, branch_key, ordinal, title, body, token_estimate, namespace, created_at) VALUES ('readback-chunk', 'vector', ?, ?, ?, 'active', 0, 'Synthetic', 'Synthetic', 1, 'personal', ?)`,
    )
      .bind(owner.stored.revisionId, owner.conversation.id, env.ACTIVE_INDEX_GENERATION, now)
      .run();
    await env.MEMORY_DB.prepare(
      `INSERT INTO chunk_sources (chunk_id, source_node_id, source_sequence, char_start, char_end, ordinal) VALUES ('readback-chunk', ?, 1, 0, 10, 0)`,
    )
      .bind(owner.conversation.nodes[1]!.sourceNodeId)
      .run();
    const canonical = await getChunkContext(
      env,
      "readback-chunk",
      1,
      0,
      ["personal"],
      OWNER_DB_USER_ID,
    );
    const compact = await getChunkContext(
      env,
      "readback-chunk",
      1,
      0,
      ["personal"],
      OWNER_DB_USER_ID,
      "compact",
    );
    expect(compact.matchedRanges).toEqual(canonical.matchedRanges);
    expect(compact.messages.map((m) => m.text)).toEqual(messages.map((m) => m.content));
    expect(compact.conversation?.tags).toEqual(["runtime"]);
    await expect(
      getChunkContext(env, "readback-chunk", 1, 0, ["personal"], "foreign", "compact"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
