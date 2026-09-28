import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpConversation, normalizeChatGptConversation } from "../src/chatgpt";
import { domainId } from "../src/crypto";
import { createMemoryMcpServer } from "../src/mcp";
import {
  getOrCreateUser,
  grantNamespace,
  OWNER_DB_USER_ID,
  resolveTenant,
  type Tenant,
} from "../src/tenant";
import {
  appendConversation,
  copyConversations,
  loadCanonicalRevision,
  writeCanonicalConversation,
} from "../src/storage";
import { completeMemoryCopy, completeMemoryWrite } from "../src/writes";
import { branchedChatGptConversation } from "./fixtures/chatgpt";

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
});

const verificationResult = z.object({
  status: z.enum(["passed", "failed"]),
  revision_id: z.string(),
  readback_available: z.boolean(),
  checked_messages: z.number().optional(),
  readback: pageResult.optional(),
  error: z.unknown().optional(),
});

const copyResultItemSuccess = z.object({
  request_index: z.number().int().min(0),
  status: z.literal("copied"),
  source_conversation_id: z.string(),
  source_revision_id: z.string(),
  conversation_id: z.string(),
  revision_id: z.string(),
  durable: z.literal(true),
  indexing: z.object({
    status: z.enum(["queued", "failed"]),
    job_id: z.string().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
      })
      .optional(),
  }),
  verification: verificationResult.optional(),
});

const copyResultItemFailure = z.object({
  request_index: z.number().int().min(0),
  status: z.literal("failed"),
  source_conversation_id: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const copyResultItem = z.union([copyResultItemSuccess, copyResultItemFailure]);

const copyOutputSchema = z.object({
  results: z.array(copyResultItem),
  readback_requests: z
    .array(
      z.object({
        conversation_id: z.string(),
        revision_id: z.string(),
        offset: z.number(),
        limit: z.number(),
        branch: z.string(),
      }),
    )
    .optional(),
  omitted: z.array(z.string()).optional(),
  used_serialized_bytes: z.number(),
  max_serialized_bytes: z.number(),
});

const batchReadOutputSchema = z.object({
  results: z.array(
    z.object({
      requestIndex: z.number(),
      status: z.enum(["ok", "error", "deferred"]),
      page: z
        .object({
          conversation: z.object({ id: z.string(), revisionId: z.string() }),
          messages: z.array(messageResult),
          offset: z.number(),
          nextOffset: z.number().nullable(),
          total: z.number(),
          oversizedMessage: z.unknown().optional(),
        })
        .optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
  ),
  completed: z.number(),
  remaining: z.number(),
  nextCursor: z.string().nullable(),
  usedSerializedBytes: z.number(),
  maxSerializedBytes: z.number(),
});

const searchOutputSchema = z.object({
  results: z.array(
    z.object({
      conversationId: z.string(),
      revisionId: z.string(),
      chunkId: z.string(),
      title: z.string(),
      snippet: z.string(),
      timestamp: z.string().nullable(),
      namespace: z.string(),
      tags: z.array(z.string()),
      score: z.number(),
      sources: z.array(z.string()),
    }),
  ),
  degraded: z.boolean(),
  unavailable: z.array(z.string()),
});

type CallResult =
  | { isError: true; text: string; bytes: number }
  | { isError: false; text: string; bytes: number; value: unknown };

const connections: Array<{ client: Client; server: McpServer }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
});

async function connectedClient(tenant: Tenant): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "copy-integration-test", version: "1.0.0" });
  const server = createMemoryMcpServer(env, tenant);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

async function ownerClient(namespace = "copy-test-ns"): Promise<Client> {
  await grantNamespace(env, OWNER_DB_USER_ID, namespace);
  return await connectedClient(await resolveTenant(env, { userId: "owner" }));
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
  const bytes = new TextEncoder().encode(text).byteLength;
  if (result.isError === true) return { isError: true, text, bytes };
  return { isError: false, text, bytes, value: JSON.parse(text) as unknown };
}

async function callValue(client: Client, name: string, args: Record<string, unknown>) {
  const result = await call(client, name, args);
  if (result.isError) throw new Error(result.text);
  return result.value;
}

// ~44 KiB of multi-byte text per conversation. Larger than the whole receipt budget, so no
// single inline verification readback can fit the max-size bulk envelope.
const MULTIBYTE_FILLER = "雨🌙";
const OVERSIZED_UNITS = 6300;

function oversizedText(index: number): string {
  return `${index}:${MULTIBYTE_FILLER.repeat(OVERSIZED_UNITS)}`;
}

async function storeSources(
  namespace: string,
  prefix: string,
  conversations: string[][],
  userId = OWNER_DB_USER_ID,
): Promise<Array<{ id: string; revisionId: string; texts: string[] }>> {
  const sources: Array<{ id: string; revisionId: string; texts: string[] }> = [];
  for (const [index, texts] of conversations.entries()) {
    const conversation = await createMcpConversation({
      title: `${prefix} ${index}`,
      namespace,
      messages: texts.map((content) => ({ role: "user", content })),
    });
    const stored = await writeCanonicalConversation(env, conversation, null, null, userId);
    sources.push({ id: conversation.id, revisionId: stored.revisionId, texts });
  }
  return sources;
}

function accumulatePageTexts(
  target: Map<string, string[]>,
  value: z.infer<typeof batchReadOutputSchema>,
): void {
  for (const entry of value.results) {
    if (entry.status !== "ok" || !entry.page) continue;
    const conversationId = entry.page.conversation.id;
    target.set(conversationId, [
      ...(target.get(conversationId) ?? []),
      ...entry.page.messages.map((message) => message.text),
    ]);
  }
}

describe("memory_copy_conversations integration", () => {
  it("losslessly copies full canonical graph (inactive branches, raw, timestamps, node ID re-derivation, derivedFrom) and verifies source immutability", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const raw = branchedChatGptConversation();
    const sourceConv = await normalizeChatGptConversation(raw);
    sourceConv.namespace = srcNs;
    sourceConv.tags = ["branched-gpt", "source-tag"];
    const storedSource = await writeCanonicalConversation(
      env,
      sourceConv,
      null,
      null,
      OWNER_DB_USER_ID,
    );
    const sourceRevId = storedSource.revisionId;

    const rawCopy = await callValue(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: `idemp-${crypto.randomUUID()}`,
      verify: true,
      requests: [
        {
          conversation_id: sourceConv.id,
        },
      ],
    });

    const parsedCopy = copyOutputSchema.parse(rawCopy);
    expect(parsedCopy.results).toHaveLength(1);
    const copyItem = parsedCopy.results[0]!;
    expect(copyItem.status).toBe("copied");
    if (copyItem.status !== "copied") throw new Error("Expected copied status");

    expect(copyItem.request_index).toBe(0);
    expect(copyItem.source_conversation_id).toBe(sourceConv.id);
    expect(copyItem.source_revision_id).toBe(sourceRevId);
    expect(copyItem.conversation_id).not.toBe(sourceConv.id);
    expect(copyItem.revision_id).toBeDefined();
    expect(copyItem.indexing.status).toBe("queued");
    expect(copyItem.indexing.job_id).toBeDefined();
    expect(copyItem.verification?.status).toBe("passed");
    expect(copyItem.verification?.revision_id).toBe(copyItem.revision_id);

    // Verify destination canonical storage
    const loadedDest = await loadCanonicalRevision(env, copyItem.revision_id);
    const destConv = loadedDest.conversation;
    const destManifest = loadedDest.manifest;

    expect(destConv.id).toBe(copyItem.conversation_id);
    expect(destConv.namespace).toBe(destNs);
    expect(destConv.sourceType).toBe(sourceConv.sourceType);
    expect(destConv.sourceId).toBe(sourceConv.sourceId);
    expect(destConv.title).toBe(sourceConv.title);
    expect(destConv.createdAt).toBe(sourceConv.createdAt);
    expect(destConv.updatedAt).toBe(sourceConv.updatedAt);
    expect(destConv.currentSourceNodeId).toBe(sourceConv.currentSourceNodeId);
    expect(destConv.activeSourceNodeIds).toEqual(sourceConv.activeSourceNodeIds);
    expect(destConv.metadata).toEqual(sourceConv.metadata);
    expect(destConv.anomalies).toEqual(sourceConv.anomalies);
    expect(destConv.tags).toEqual(["branched-gpt", "source-tag"]);

    // First-class CopyProvenance
    expect(destConv.derivedFrom).toMatchObject({
      operation: "copy",
      conversationId: sourceConv.id,
      revisionId: sourceRevId,
      namespace: srcNs,
    });
    expect(typeof destConv.derivedFrom?.copiedAt).toBe("string");
    expect(destManifest.derivedFrom).toEqual(destConv.derivedFrom);

    // Node ID re-derivation and structural fidelity across inactive branches, raw, timestamps, model_slug
    expect(destConv.nodes).toHaveLength(sourceConv.nodes.length);
    for (const destNode of destConv.nodes) {
      const sourceNode = sourceConv.nodes.find((n) => n.sourceNodeId === destNode.sourceNodeId);
      expect(sourceNode).toBeDefined();
      const expectedNodeId = await domainId(
        "message-node",
        copyItem.conversation_id,
        destNode.sourceNodeId,
      );
      expect(destNode.id).toBe(expectedNodeId);
      expect(destNode.parentSourceNodeId).toBe(sourceNode!.parentSourceNodeId);
      expect(destNode.childSourceNodeIds).toEqual(sourceNode!.childSourceNodeIds);
      expect(destNode.role).toBe(sourceNode!.role);
      expect(destNode.text).toBe(sourceNode!.text);
      expect(destNode.createdAt).toBe(sourceNode!.createdAt);
      expect(destNode.updatedAt).toBe(sourceNode!.updatedAt);
      expect(destNode.modelSlug).toBe(sourceNode!.modelSlug);
      expect(destNode.metadata).toEqual(sourceNode!.metadata);
      expect(destNode.raw).toEqual(sourceNode!.raw);
    }

    // Specific fixture assertions
    const altNode = destConv.nodes.find((n) => n.sourceNodeId === "assistant-alt");
    expect(altNode?.text).toBe("Alternate branch: rebuild atlas-db from scratch.");
    const deletedNode = destConv.nodes.find((n) => n.sourceNodeId === "deleted");
    expect((deletedNode?.raw as Record<string, unknown>)?.unexpected_field).toBe("kept in raw");
    const activeNode = destConv.nodes.find((n) => n.sourceNodeId === "assistant-active");
    expect(activeNode?.modelSlug).toBe("gpt-example");

    // Readback via MCP with branch: all vs active
    const allBranchesRead = await callValue(client, "memory_get_conversation", {
      conversation_id: copyItem.conversation_id,
      branch: "all",
      format: "canonical",
    });
    const allBranchesPage = pageResult.parse(allBranchesRead);
    const altBranchMsg = allBranchesPage.messages.find(
      (m) => m.text === "Alternate branch: rebuild atlas-db from scratch.",
    );
    expect(altBranchMsg).toBeDefined();
    expect(altBranchMsg?.sourceNodeId).toBe("assistant-alt");

    const activeBranchRead = await callValue(client, "memory_get_conversation", {
      conversation_id: copyItem.conversation_id,
      branch: "active",
      format: "canonical",
    });
    const activeBranchPage = pageResult.parse(activeBranchRead);
    const activeAlt = activeBranchPage.messages.find(
      (m) => m.text === "Alternate branch: rebuild atlas-db from scratch.",
    );
    expect(activeAlt).toBeUndefined();

    // Source immutability
    const sourceRow = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id, title, namespace FROM conversations WHERE id = ?",
    )
      .bind(sourceConv.id)
      .first<{ current_revision_id: string; title: string; namespace: string }>();
    expect(sourceRow?.current_revision_id).toBe(sourceRevId);
    expect(sourceRow?.title).toBe(sourceConv.title);
    expect(sourceRow?.namespace).toBe(srcNs);

    const sourceSegmentHead = await env.MEMORY_BUCKET.head(storedSource.segmentKey);
    expect(sourceSegmentHead).not.toBeNull();
    const sourceManifestHead = await env.MEMORY_BUCKET.head(storedSource.manifestKey);
    expect(sourceManifestHead).not.toBeNull();
  });

  it("applies title override and tag inherit / replace transforms without affecting source", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const sourceConv = await createMcpConversation({
      title: "Base Project",
      namespace: srcNs,
      tags: ["alpha", "beta"],
      messages: [{ role: "user", content: "Original project content" }],
    });
    const storedSource = await writeCanonicalConversation(
      env,
      sourceConv,
      null,
      null,
      OWNER_DB_USER_ID,
    );

    const rawCopy = await callValue(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: `idemp-tags-${crypto.randomUUID()}`,
      requests: [
        {
          conversation_id: sourceConv.id,
          title: "Forked Alpha",
          tags: {
            mode: "inherit",
            add: ["forked"],
            remove: ["beta"],
          },
        },
        {
          conversation_id: sourceConv.id,
          title: "Fresh Project",
          tags: {
            mode: "replace",
            add: ["fresh"],
            remove: [],
          },
        },
      ],
    });

    const parsedCopy = copyOutputSchema.parse(rawCopy);
    expect(parsedCopy.results).toHaveLength(2);

    const item0 = parsedCopy.results[0]!;
    const item1 = parsedCopy.results[1]!;
    expect(item0.status).toBe("copied");
    expect(item1.status).toBe("copied");
    if (item0.status !== "copied" || item1.status !== "copied") {
      throw new Error("Expected copies to succeed");
    }

    const loaded0 = await loadCanonicalRevision(env, item0.revision_id);
    expect(loaded0.conversation.title).toBe("Forked Alpha");
    expect(loaded0.conversation.tags).toEqual(["alpha", "forked"]);

    const loaded1 = await loadCanonicalRevision(env, item1.revision_id);
    expect(loaded1.conversation.title).toBe("Fresh Project");
    expect(loaded1.conversation.tags).toEqual(["fresh"]);

    // Source conversation is untouched
    const sourceRow = await env.MEMORY_DB.prepare(
      "SELECT title, current_revision_id FROM conversations WHERE id = ?",
    )
      .bind(sourceConv.id)
      .first<{ title: string; current_revision_id: string }>();
    expect(sourceRow?.title).toBe("Base Project");
    expect(sourceRow?.current_revision_id).toBe(storedSource.revisionId);

    const loadedSource = await loadCanonicalRevision(env, storedSource.revisionId);
    expect(loadedSource.conversation.tags).toEqual(["alpha", "beta"]);
  });

  it("validates tag count limit (>20 tags) per-item and prevents destination creation", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const initialTags = Array.from({ length: 19 }, (_, i) => `tag-${i}`);
    const sourceConv = await createMcpConversation({
      title: "Tag Overflow Source",
      namespace: srcNs,
      tags: initialTags,
      messages: [{ role: "user", content: "Tag overflow check" }],
    });
    await writeCanonicalConversation(env, sourceConv, null, null, OWNER_DB_USER_ID);

    const rawCopy = await callValue(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: `idemp-overflow-${crypto.randomUUID()}`,
      requests: [
        {
          conversation_id: sourceConv.id,
          tags: {
            mode: "inherit",
            add: ["overflow-1", "overflow-2", "overflow-3"],
            remove: [],
          },
        },
      ],
    });

    const parsedCopy = copyOutputSchema.parse(rawCopy);
    expect(parsedCopy.results).toHaveLength(1);
    const item = parsedCopy.results[0]!;
    expect(item.status).toBe("failed");
    if (item.status !== "failed") throw new Error("Expected failure");
    expect(item.error.code).toBe("VALIDATION");

    // Verify no conversation row created in destination namespace
    const destRows = await env.MEMORY_DB.prepare(
      "SELECT COUNT(*) AS total FROM conversations WHERE namespace = ?",
    )
      .bind(destNs)
      .first<{ total: number }>();
    expect(destRows?.total).toBe(0);
  });

  it("processes mixed valid and missing conversations in batch preserving request order", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const validConv = await createMcpConversation({
      title: "Valid Conv",
      namespace: srcNs,
      messages: [{ role: "user", content: "Valid content" }],
    });
    await writeCanonicalConversation(env, validConv, null, null, OWNER_DB_USER_ID);

    const missingId = crypto.randomUUID();

    const rawCopy = await callValue(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: `idemp-mixed-${crypto.randomUUID()}`,
      requests: [{ conversation_id: validConv.id }, { conversation_id: missingId }],
    });

    const parsedCopy = copyOutputSchema.parse(rawCopy);
    expect(parsedCopy.results).toHaveLength(2);

    const [res0, res1] = parsedCopy.results;
    expect(res0?.request_index).toBe(0);
    expect(res0?.status).toBe("copied");
    expect(res0?.source_conversation_id).toBe(validConv.id);

    expect(res1?.request_index).toBe(1);
    expect(res1?.status).toBe("failed");
    expect(res1?.source_conversation_id).toBe(missingId);
    if (res1?.status !== "failed") throw new Error("Expected index 1 failure");
    expect(res1.error.code).toBe("NOT_FOUND");
    expect(res1.error.message).toBe("Conversation not found");

    // Verify valid destination exists and missing has no row
    if (res0?.status === "copied") {
      const destRow = await env.MEMORY_DB.prepare("SELECT id FROM conversations WHERE id = ?")
        .bind(res0.conversation_id)
        .first<{ id: string }>();
      expect(destRow?.id).toBe(res0.conversation_id);
    }
  });

  it("omitted revision pin uses current head and persists across later source appends and idempotent retries", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const sourceConv = await createMcpConversation({
      title: "Pinning Test",
      namespace: srcNs,
      messages: [{ role: "user", content: "Message 1" }],
    });
    const stored1 = await writeCanonicalConversation(env, sourceConv, null, null, OWNER_DB_USER_ID);

    const stored2 = await appendConversation(env, sourceConv.id, stored1.revisionId, [
      { role: "user", content: "Message 2" },
    ]);
    const rev2 = stored2.revisionId;

    const idempKey = `idemp-pin-${crypto.randomUUID()}`;

    // First copy with omitted revision_id pins rev2
    const rawCopy1 = await callValue(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: idempKey,
      requests: [{ conversation_id: sourceConv.id }],
    });
    const parsed1 = copyOutputSchema.parse(rawCopy1);
    const item1 = parsed1.results[0]!;
    expect(item1.status).toBe("copied");
    if (item1.status !== "copied") throw new Error("Expected copied");
    expect(item1.source_revision_id).toBe(rev2);

    const destConvId = item1.conversation_id;
    const destRevId = item1.revision_id;

    // Append a third message to source conversation -> head advances to rev3
    const stored3 = await appendConversation(env, sourceConv.id, rev2, [
      { role: "user", content: "Message 3" },
    ]);
    const rev3 = stored3.revisionId;
    expect(rev3).not.toBe(rev2);

    // Retry copy with the EXACT same idempotency key and omitted revision_id
    const rawCopy2 = await callValue(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: idempKey,
      requests: [{ conversation_id: sourceConv.id }],
    });
    const parsed2 = copyOutputSchema.parse(rawCopy2);
    const item2 = parsed2.results[0]!;
    expect(item2.status).toBe("copied");
    if (item2.status !== "copied") throw new Error("Expected copied");

    // Pinned revision remains rev2, destination IDs unchanged
    expect(item2.source_revision_id).toBe(rev2);
    expect(item2.conversation_id).toBe(destConvId);
    expect(item2.revision_id).toBe(destRevId);

    // Verify destination nodes only have Message 1 and Message 2 (not Message 3)
    const loadedDest = await loadCanonicalRevision(env, destRevId);
    expect(loadedDest.conversation.nodes.map((n) => n.text)).toEqual(["Message 1", "Message 2"]);
  });

  it("replays exact request idempotently and raises IMPORT_CONFLICT for material divergence", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    const otherDestNs = `ns-copy-other-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    await grantNamespace(env, OWNER_DB_USER_ID, otherDestNs);
    const client = await ownerClient(srcNs);

    const sourceConv = await createMcpConversation({
      title: "Replay Original",
      namespace: srcNs,
      messages: [{ role: "user", content: "Replay material" }],
    });
    await writeCanonicalConversation(env, sourceConv, null, null, OWNER_DB_USER_ID);

    const idempKey = `idemp-replay-${crypto.randomUUID()}`;

    // Initial copy
    const raw1 = await callValue(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: idempKey,
      requests: [{ conversation_id: sourceConv.id, title: "Custom Title" }],
    });
    const parsed1 = copyOutputSchema.parse(raw1);
    const item1 = parsed1.results[0]!;
    expect(item1.status).toBe("copied");
    if (item1.status !== "copied") throw new Error("Expected copied");

    // Replay with exact same material
    const raw2 = await callValue(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: idempKey,
      requests: [{ conversation_id: sourceConv.id, title: "Custom Title" }],
    });
    const parsed2 = copyOutputSchema.parse(raw2);
    const item2 = parsed2.results[0]!;
    expect(item2.status).toBe("copied");
    if (item2.status !== "copied") throw new Error("Expected copied");
    expect(item2.conversation_id).toBe(item1.conversation_id);
    expect(item2.revision_id).toBe(item1.revision_id);

    // Exactly one conversation row in D1
    const countRow = await env.MEMORY_DB.prepare(
      "SELECT COUNT(*) AS total FROM conversations WHERE id = ?",
    )
      .bind(item1.conversation_id)
      .first<{ total: number }>();
    expect(countRow?.total).toBe(1);

    // Replay with divergent title -> IMPORT_CONFLICT
    const conflictTitle = await call(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: idempKey,
      requests: [{ conversation_id: sourceConv.id, title: "Divergent Title" }],
    });
    expect(conflictTitle.isError).toBe(true);
    expect(conflictTitle.text).toContain("different copy material");

    // Replay with divergent target_namespace -> IMPORT_CONFLICT
    const conflictNamespace = await call(client, "memory_copy_conversations", {
      target_namespace: otherDestNs,
      idempotency_key: idempKey,
      requests: [{ conversation_id: sourceConv.id, title: "Custom Title" }],
    });
    expect(conflictNamespace.isError).toBe(true);
    expect(conflictNamespace.text).toContain("different copy material");
  });

  it("enforces create_target_namespace flag (403 on unowned target when false, creates grant when true)", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const unownedNs = `ns-unowned-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    const client = await ownerClient(srcNs);

    const sourceConv = await createMcpConversation({
      title: "Namespace Grant Test",
      namespace: srcNs,
      messages: [{ role: "user", content: "Namespace testing" }],
    });
    await writeCanonicalConversation(env, sourceConv, null, null, OWNER_DB_USER_ID);

    // create_target_namespace: false -> 403 error
    const forbiddenCall = await call(client, "memory_copy_conversations", {
      target_namespace: unownedNs,
      create_target_namespace: false,
      idempotency_key: `idemp-unowned-fail-${crypto.randomUUID()}`,
      requests: [{ conversation_id: sourceConv.id }],
    });
    expect(forbiddenCall.isError).toBe(true);
    expect(forbiddenCall.text).toContain("Namespace is not accessible to this account");

    const grantCheckBefore = await env.MEMORY_DB.prepare(
      "SELECT * FROM user_namespaces WHERE namespace = ? AND user_id = ?",
    )
      .bind(unownedNs, OWNER_DB_USER_ID)
      .first();
    expect(grantCheckBefore).toBeNull();

    // create_target_namespace: true -> grants namespace and succeeds
    const allowedCall = await callValue(client, "memory_copy_conversations", {
      target_namespace: unownedNs,
      create_target_namespace: true,
      idempotency_key: `idemp-unowned-success-${crypto.randomUUID()}`,
      requests: [{ conversation_id: sourceConv.id }],
    });
    const parsed = copyOutputSchema.parse(allowedCall);
    expect(parsed.results[0]?.status).toBe("copied");

    const grantCheckAfter = await env.MEMORY_DB.prepare(
      "SELECT * FROM user_namespaces WHERE namespace = ? AND user_id = ?",
    )
      .bind(unownedNs, OWNER_DB_USER_ID)
      .first();
    expect(grantCheckAfter).not.toBeNull();
  });

  it("strictly isolates tenants and returns indistinguishable NOT_FOUND for foreign conversations and revisions", async () => {
    const sharedNs = `ns-shared-${crypto.randomUUID().slice(0, 8)}`;
    const destNsB = `ns-dest-b-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, sharedNs);

    // User A creates conversation
    const convA = await createMcpConversation({
      title: "User A Secret",
      namespace: sharedNs,
      messages: [{ role: "user", content: "Confidential data" }],
    });
    const storedA = await writeCanonicalConversation(env, convA, null, null, OWNER_DB_USER_ID);

    // Create User B with access to sharedNs and destNsB
    const userB = await getOrCreateUser(
      env,
      `user-b-${crypto.randomUUID().slice(0, 6)}@example.com`,
    );
    await grantNamespace(env, userB.id, sharedNs);
    await grantNamespace(env, userB.id, destNsB);
    const tenantB = await resolveTenant(env, { userId: userB.id });
    const clientB = await connectedClient(tenantB);

    // User B tries to copy User A's conversation ID
    const foreignCopy1 = await callValue(clientB, "memory_copy_conversations", {
      target_namespace: destNsB,
      idempotency_key: `idemp-foreign-1-${crypto.randomUUID()}`,
      requests: [{ conversation_id: convA.id }],
    });
    const parsed1 = copyOutputSchema.parse(foreignCopy1);
    expect(parsed1.results[0]?.status).toBe("failed");
    if (parsed1.results[0]?.status !== "failed") throw new Error("Expected failure");
    expect(parsed1.results[0].error.code).toBe("NOT_FOUND");
    expect(parsed1.results[0].error.message).toBe("Conversation not found");

    // User B tries to copy a non-existent conversation with User A's revision_id
    const fakeConvId = crypto.randomUUID();
    const foreignCopy2 = await callValue(clientB, "memory_copy_conversations", {
      target_namespace: destNsB,
      idempotency_key: `idemp-foreign-2-${crypto.randomUUID()}`,
      requests: [{ conversation_id: fakeConvId, revision_id: storedA.revisionId }],
    });
    const parsed2 = copyOutputSchema.parse(foreignCopy2);
    expect(parsed2.results[0]?.status).toBe("failed");
    if (parsed2.results[0]?.status !== "failed") throw new Error("Expected failure");
    expect(parsed2.results[0].error.code).toBe("NOT_FOUND");
    expect(parsed2.results[0].error.message).toBe("Conversation not found");

    // User A's conversation remains intact
    const headA = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id FROM conversations WHERE id = ?",
    )
      .bind(convA.id)
      .first<{ current_revision_id: string }>();
    expect(headA?.current_revision_id).toBe(storedA.revisionId);
  });

  it("durably copies conversation and returns failed retryable indexing on queue send failure", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const sourceConv = await createMcpConversation({
      title: "Queue Failure Test",
      namespace: srcNs,
      messages: [{ role: "user", content: "Testing indexing queue failure" }],
    });
    await writeCanonicalConversation(env, sourceConv, null, null, OWNER_DB_USER_ID);

    vi.spyOn(env.INDEX_QUEUE, "send").mockRejectedValue(new Error("Queue offline / unreachable"));

    const copyCall = await call(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: `idemp-queue-fail-${crypto.randomUUID()}`,
      requests: [{ conversation_id: sourceConv.id }],
    });
    expect(copyCall.isError).toBe(false);
    if (copyCall.isError) throw new Error(copyCall.text);

    const parsed = copyOutputSchema.parse(copyCall.value);
    const item = parsed.results[0]!;
    expect(item.status).toBe("copied");
    if (item.status !== "copied") throw new Error("Expected copied");

    expect(item.indexing.status).toBe("failed");
    expect(item.indexing.error?.code).toBe("DERIVED_INDEXING");
    expect(item.indexing.error?.retryable).toBe(true);

    // A failed enqueue is still a durable, bounded post-commit receipt: never the 64 KiB guard.
    expect(item.durable).toBe(true);
    expect(item.indexing.error?.message.length).toBeLessThanOrEqual(200);
    expect(parsed.results).toHaveLength(1);
    expect(copyCall.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(parsed.max_serialized_bytes).toBe(49152);
    expect(parsed.used_serialized_bytes).toBeLessThanOrEqual(parsed.max_serialized_bytes);

    // Destination conversation is still durably persisted in D1
    const destRow = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id, namespace FROM conversations WHERE id = ?",
    )
      .bind(item.conversation_id)
      .first<{ current_revision_id: string; namespace: string }>();
    expect(destRow?.current_revision_id).toBe(item.revision_id);
    expect(destRow?.namespace).toBe(destNs);
  });

  it("returns failed verification when destination manifest is deleted while D1 rows remain intact", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);

    const sourceConv = await createMcpConversation({
      title: "Verification Failure Test",
      namespace: srcNs,
      messages: [{ role: "user", content: "Verification base content" }],
    });
    await writeCanonicalConversation(env, sourceConv, null, null, OWNER_DB_USER_ID);

    const [copyResult] = await copyConversations(env, {
      userId: OWNER_DB_USER_ID,
      namespaces: [srcNs, destNs],
      targetNamespace: destNs,
      idempotencyKey: `idemp-vf-${crypto.randomUUID()}`,
      requests: [{ conversationId: sourceConv.id }],
    });
    if (!copyResult || copyResult.status !== "copied") {
      throw new Error("Expected successful storage copy");
    }

    const origManifest = await env.MEMORY_BUCKET.get(copyResult.stored.manifestKey);
    const manifestText = await origManifest!.text();
    await env.MEMORY_BUCKET.delete(copyResult.stored.manifestKey);

    try {
      const receipt = await completeMemoryCopy(env, copyResult.stored, true);
      expect(receipt.verification?.status).toBe("failed");
      expect(receipt.verification?.readback_available).toBe(false);
      expect(receipt.verification?.readback).toBeUndefined();
      expect(receipt.durable).toBe(true);
    } finally {
      await env.MEMORY_BUCKET.put(copyResult.stored.manifestKey, manifestText);
    }

    // Verify D1 destination row remains intact
    const destRow = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id, namespace FROM conversations WHERE id = ?",
    )
      .bind(copyResult.stored.conversationId)
      .first<{ current_revision_id: string; namespace: string }>();
    expect(destRow?.current_revision_id).toBe(copyResult.stored.revisionId);
    expect(destRow?.namespace).toBe(destNs);
  });

  it("returns a durable bounded tool receipt when verification fails post-commit through the copy tool", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const sourceConv = await createMcpConversation({
      title: "Tool Post Commit Failure",
      namespace: srcNs,
      messages: [{ role: "user", content: "Post commit verification failure content" }],
    });
    const storedSource = await writeCanonicalConversation(
      env,
      sourceConv,
      null,
      null,
      OWNER_DB_USER_ID,
    );

    const idempotencyKey = `idemp-tool-vf-${crypto.randomUUID()}`;
    // Same deterministic destination identity the copy path derives, so the manifest read can
    // be made to fail after the canonical commit has already succeeded.
    const destConversationId = await domainId(
      "copy-conversation",
      OWNER_DB_USER_ID,
      idempotencyKey,
      "0",
      sourceConv.id,
      storedSource.revisionId,
      destNs,
    );
    const destManifestPrefix = `canonical/conversations/${destConversationId}/revisions/`;

    const originalGet = env.MEMORY_BUCKET.get.bind(env.MEMORY_BUCKET);
    vi.spyOn(env.MEMORY_BUCKET, "get").mockImplementation((...args) => {
      const key = args[0];
      if (typeof key === "string" && key.startsWith(destManifestPrefix)) {
        return Promise.resolve(null);
      }
      return originalGet(...args);
    });

    const result = await call(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: idempotencyKey,
      verify: true,
      requests: [{ conversation_id: sourceConv.id }],
    });
    vi.restoreAllMocks();

    expect(result.isError).toBe(false);
    if (result.isError) throw new Error(result.text);
    expect(result.text).not.toContain("Response exceeds 64 KiB");
    expect(result.bytes).toBeLessThanOrEqual(64 * 1024);

    const parsed = copyOutputSchema.parse(result.value);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.max_serialized_bytes).toBe(49152);
    expect(parsed.used_serialized_bytes).toBeLessThanOrEqual(parsed.max_serialized_bytes);

    const item = parsed.results[0]!;
    expect(item.status).toBe("copied");
    if (item.status !== "copied") throw new Error("Expected copied");

    expect(item.durable).toBe(true);
    expect(item.conversation_id).toBe(destConversationId);
    expect(item.revision_id).toEqual(expect.any(String));
    expect(item.verification?.status).toBe("failed");
    expect(item.verification?.readback_available).toBe(false);
    expect(item.verification?.readback).toBeUndefined();
    // No usable readback means no continuation is advertised for this item.
    expect(parsed.readback_requests ?? []).toHaveLength(0);

    // The commit itself survived: D1 head and the R2 manifest are both intact.
    const destRow = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id, namespace FROM conversations WHERE id = ?",
    )
      .bind(destConversationId)
      .first<{ current_revision_id: string; namespace: string }>();
    expect(destRow?.current_revision_id).toBe(item.revision_id);
    expect(destRow?.namespace).toBe(destNs);
    const manifestKey = `canonical/conversations/${destConversationId}/revisions/${item.revision_id}.json`;
    expect(await env.MEMORY_BUCKET.head(manifestKey)).not.toBeNull();
  });

  it("supports destination-scoped search and cross-namespace search exposing both source and copy without dedup", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const uniquePhrase = `Quantum Matrix Cryptography Kernel ${crypto.randomUUID().slice(0, 8)}`;
    const sourceConv = await createMcpConversation({
      title: "Quantum Kernel Discussion",
      namespace: srcNs,
      messages: [{ role: "user", content: `Details on ${uniquePhrase} execution.` }],
    });
    const sourceStored = await writeCanonicalConversation(
      env,
      sourceConv,
      null,
      null,
      OWNER_DB_USER_ID,
    );
    await completeMemoryWrite(
      env,
      sourceStored,
      [{ role: "user", content: `Details on ${uniquePhrase} execution.` }],
      false,
    );

    const rawCopy = await callValue(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: `idemp-search-${crypto.randomUUID()}`,
      requests: [{ conversation_id: sourceConv.id }],
    });
    const parsedCopy = copyOutputSchema.parse(rawCopy);
    const copyItem = parsedCopy.results[0]!;
    expect(copyItem.status).toBe("copied");
    if (copyItem.status !== "copied") throw new Error("Expected copied");
    const destConvId = copyItem.conversation_id;

    // Scoped search to destNs only returns the destination copy
    const destSearch = await callValue(client, "memory_search", {
      query: uniquePhrase,
      namespace: destNs,
    });
    const parsedDestSearch = searchOutputSchema.parse(destSearch);
    const destFoundIds = parsedDestSearch.results.map((r) => r.conversationId);
    expect(destFoundIds).toContain(destConvId);
    expect(destFoundIds).not.toContain(sourceConv.id);

    // A source-scoped search proves the original remains searchable.
    const sourceSearch = await callValue(client, "memory_search", {
      query: uniquePhrase,
      namespace: srcNs,
    });
    const parsedSourceSearch = searchOutputSchema.parse(sourceSearch);
    expect(parsedSourceSearch.results.map((r) => r.conversationId)).toContain(sourceConv.id);

    // Cross-namespace search must not collapse source and destination identities.
    const allSearch = await callValue(client, "memory_search", {
      query: uniquePhrase,
    });
    const parsedAllSearch = searchOutputSchema.parse(allSearch);
    const allFoundIds = parsedAllSearch.results.map((r) => r.conversationId);
    expect(allFoundIds).toContain(destConvId);
    if (allFoundIds.includes(sourceConv.id)) {
      expect(allFoundIds).toContain(destConvId);
    }
  });

  it("keeps a maximum verified bulk receipt bounded and served by readback_requests", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const sources = await storeSources(
      srcNs,
      "Bulk receipt source",
      Array.from({ length: 20 }, (_, index) => [oversizedText(index)]),
    );

    const result = await call(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: `idemp-max-${crypto.randomUUID()}`,
      verify: true,
      requests: sources.map((source) => ({ conversation_id: source.id })),
    });
    expect(result.isError).toBe(false);
    if (result.isError) throw new Error(result.text);
    expect(result.bytes).toBeLessThanOrEqual(64 * 1024);

    const parsed = copyOutputSchema.parse(result.value);
    expect(parsed.results).toHaveLength(20);
    expect(parsed.max_serialized_bytes).toBe(49152);
    expect(parsed.used_serialized_bytes).toBeLessThanOrEqual(parsed.max_serialized_bytes);
    expect(parsed.used_serialized_bytes).toBeLessThanOrEqual(result.bytes);

    const copiedItems = parsed.results.flatMap((item) => (item.status === "copied" ? [item] : []));
    expect(copiedItems).toHaveLength(20);
    for (const item of copiedItems) {
      const source = sources[item.request_index]!;
      expect(source).toBeDefined();
      expect(item.source_conversation_id).toBe(source.id);
      expect(item.source_revision_id).toBe(source.revisionId);
      expect(item.durable).toBe(true);
      expect(item.conversation_id).not.toBe(source.id);
      expect(item.revision_id).toEqual(expect.any(String));
      expect(item.indexing.status).toBe("queued");
      expect(item.verification?.status).toBe("passed");
      expect(item.verification?.revision_id).toBe(item.revision_id);
      expect(item.verification?.readback_available).toBe(true);
      expect(item.verification?.checked_messages).toBe(1);
    }

    // Every verified copy advertises exactly one canonical readback request.
    const readbackRequests = parsed.readback_requests ?? [];
    expect(readbackRequests).toHaveLength(copiedItems.length);
    for (const item of copiedItems) {
      const advertised = readbackRequests.filter(
        (request) => request.conversation_id === item.conversation_id,
      );
      expect(advertised).toHaveLength(1);
      expect(advertised[0]).toMatchObject({
        revision_id: item.revision_id,
        offset: 0,
        limit: 20,
        branch: "active",
      });
    }

    // ~44 KiB readbacks cannot fit the max envelope, so the ledger names the omission and no
    // item may still carry the inline readback the receipt says it dropped.
    const omitted = parsed.omitted ?? [];
    expect(omitted).toContain("verification.readback");
    expect(copiedItems.filter((item) => item.verification?.readback !== undefined)).toHaveLength(0);

    // The opposite direction: a receipt that ledgers no omission keeps every inline readback.
    const smallText = `${MULTIBYTE_FILLER.repeat(40)} small verified`;
    const [smallSource] = await storeSources(srcNs, "Small receipt source", [[smallText]]);
    const smallResult = await call(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: `idemp-max-small-${crypto.randomUUID()}`,
      verify: true,
      requests: [{ conversation_id: smallSource!.id }],
    });
    expect(smallResult.isError).toBe(false);
    if (smallResult.isError) throw new Error(smallResult.text);
    const smallParsed = copyOutputSchema.parse(smallResult.value);
    expect(smallParsed.omitted ?? []).not.toContain("verification.readback");
    const smallItem = smallParsed.results[0]!;
    expect(smallItem.status).toBe("copied");
    if (smallItem.status !== "copied") throw new Error("Expected copied");
    expect(smallItem.durable).toBe(true);
    expect(smallItem.verification?.readback_available).toBe(true);
    expect(smallItem.verification?.readback?.messages.map((message) => message.text)).toEqual([
      smallText,
    ]);
  }, 60_000);

  it("serves every verified bulk conversation through canonical batch readback with cursor continuation", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const perMessage = MULTIBYTE_FILLER.repeat(150);
    const sources = await storeSources(
      srcNs,
      "Batch readback source",
      Array.from({ length: 20 }, (_, index) => [
        `${index}:${perMessage}`,
        `${index}-tail:${perMessage}`,
      ]),
    );

    const copyResult = await call(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: `idemp-batch-readback-${crypto.randomUUID()}`,
      verify: true,
      requests: sources.map((source) => ({ conversation_id: source.id })),
    });
    expect(copyResult.isError).toBe(false);
    if (copyResult.isError) throw new Error(copyResult.text);
    const parsed = copyOutputSchema.parse(copyResult.value);

    const readbackRequests = parsed.readback_requests ?? [];
    expect(readbackRequests).toHaveLength(20);

    // Results come back in request order, so request_index maps a readback request to its source.
    const destinationByIndex = new Map<number, string>();
    for (const item of parsed.results) {
      if (item.status !== "copied") throw new Error("Expected every copy to succeed");
      destinationByIndex.set(item.request_index, item.conversation_id);
    }
    for (const [index, request] of readbackRequests.entries()) {
      expect(request.conversation_id).toBe(destinationByIndex.get(index));
      expect(request.offset).toBe(0);
      expect(request.limit).toBe(20);
      expect(request.branch).toBe("active");
    }

    const observed = new Map<string, string[]>();
    let page = batchReadOutputSchema.parse(
      await callValue(client, "memory_get_conversations", { requests: readbackRequests }),
    );
    let pages = 1;
    for (;;) {
      expect(page.results.filter((entry) => entry.status === "error")).toHaveLength(0);
      accumulatePageTexts(observed, page);
      const nextCursor = page.nextCursor;
      if (nextCursor === null) break;
      expect(pages).toBeLessThan(50);
      pages += 1;
      page = batchReadOutputSchema.parse(
        await callValue(client, "memory_get_conversations", { cursor: nextCursor }),
      );
    }
    // The batch budget is smaller than this content, so the content needed continuation pages.
    expect(pages).toBeGreaterThan(1);
    expect(observed.size).toBe(20);

    let observedMessages = 0;
    for (const [index, source] of sources.entries()) {
      const destinationId = destinationByIndex.get(index)!;
      expect(observed.get(destinationId)).toEqual(source.texts);
      observedMessages += observed.get(destinationId)!.length;
    }
    const sourceMessages = sources.reduce((count, source) => count + source.texts.length, 0);
    expect(sourceMessages).toBe(40);
    expect(observedMessages).toBe(sourceMessages);
  }, 60_000);

  it("keeps a mixed success and failure maximum batch bounded with per-item error codes", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    const foreignNs = `ns-copy-foreign-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const foreignUser = await getOrCreateUser(
      env,
      `copy-foreign-${crypto.randomUUID().slice(0, 6)}@example.com`,
    );
    await grantNamespace(env, foreignUser.id, foreignNs);
    const foreignSources = await storeSources(
      foreignNs,
      "Foreign receipt source",
      Array.from({ length: 5 }, (_, index) => [`foreign ${index}`]),
      foreignUser.id,
    );
    const validSources = await storeSources(
      srcNs,
      "Mixed receipt source",
      Array.from({ length: 10 }, (_, index) => [oversizedText(index)]),
    );
    const missingIds = Array.from({ length: 5 }, () => crypto.randomUUID());

    const requests: Array<{ conversation_id: string }> = [];
    let validCursor = 0;
    let missingCursor = 0;
    let foreignCursor = 0;
    for (let index = 0; index < 20; index += 1) {
      if (index % 2 === 0) {
        requests.push({ conversation_id: validSources[validCursor++]!.id });
      } else if (index % 4 === 1) {
        requests.push({ conversation_id: missingIds[missingCursor++]! });
      } else {
        requests.push({ conversation_id: foreignSources[foreignCursor++]!.id });
      }
    }
    expect(validCursor).toBe(10);
    expect(missingCursor).toBe(5);
    expect(foreignCursor).toBe(5);

    const result = await call(client, "memory_copy_conversations", {
      target_namespace: destNs,
      idempotency_key: `idemp-mixed-max-${crypto.randomUUID()}`,
      verify: true,
      requests,
    });
    expect(result.isError).toBe(false);
    if (result.isError) throw new Error(result.text);
    expect(result.bytes).toBeLessThanOrEqual(64 * 1024);

    const parsed = copyOutputSchema.parse(result.value);
    expect(parsed.results).toHaveLength(20);
    expect(parsed.results.map((item) => item.request_index)).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );
    expect(parsed.max_serialized_bytes).toBe(49152);
    expect(parsed.used_serialized_bytes).toBeLessThanOrEqual(parsed.max_serialized_bytes);

    const copiedItems = parsed.results.flatMap((item) => (item.status === "copied" ? [item] : []));
    const failedItems = parsed.results.flatMap((item) => (item.status === "failed" ? [item] : []));
    expect(copiedItems).toHaveLength(10);
    expect(failedItems).toHaveLength(10);

    for (const item of failedItems) {
      expect(item.source_conversation_id).toBe(requests[item.request_index]!.conversation_id);
      expect(item.error.code).toBe("NOT_FOUND");
      expect(item.error.message.length).toBeGreaterThan(0);
      expect(item.error.message.length).toBeLessThanOrEqual(200);
    }
    for (const item of copiedItems) {
      expect(item.durable).toBe(true);
      expect(item.conversation_id).toEqual(expect.any(String));
      expect(item.revision_id).toEqual(expect.any(String));
      expect(item.indexing.status).toBe("queued");
      expect(item.verification?.status).toBe("passed");
      expect(item.verification?.readback_available).toBe(true);
    }
    // Only successful verified copies advertise readback continuations.
    expect(parsed.readback_requests ?? []).toHaveLength(copiedItems.length);
  }, 60_000);

  it("replays an identical maximum batch receipt byte-for-byte with the same idempotency key", async () => {
    const srcNs = `ns-copy-src-${crypto.randomUUID().slice(0, 8)}`;
    const destNs = `ns-copy-dest-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, srcNs);
    await grantNamespace(env, OWNER_DB_USER_ID, destNs);
    const client = await ownerClient(srcNs);

    const sources = await storeSources(
      srcNs,
      "Replay receipt source",
      Array.from({ length: 20 }, (_, index) => [oversizedText(index)]),
    );
    const args = {
      target_namespace: destNs,
      idempotency_key: `idemp-replay-max-${crypto.randomUUID()}`,
      verify: true,
      requests: sources.map((source) => ({ conversation_id: source.id })),
    };

    const first = await call(client, "memory_copy_conversations", args);
    const second = await call(client, "memory_copy_conversations", args);
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    if (first.isError || second.isError) throw new Error("Expected both copies to succeed");

    expect(first.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(second.bytes).toBe(first.bytes);
    expect(second.text).toBe(first.text);

    const firstParsed = copyOutputSchema.parse(first.value);
    const secondParsed = copyOutputSchema.parse(second.value);
    expect(secondParsed).toEqual(firstParsed);
    expect(secondParsed.used_serialized_bytes).toBe(firstParsed.used_serialized_bytes);
    expect(firstParsed.max_serialized_bytes).toBe(49152);
    expect(firstParsed.used_serialized_bytes).toBeLessThanOrEqual(firstParsed.max_serialized_bytes);

    // Replay reused the same committed destinations instead of creating new ones.
    const destinationRows = await env.MEMORY_DB.prepare(
      "SELECT COUNT(*) AS total FROM conversations WHERE namespace = ?",
    )
      .bind(destNs)
      .first<{ total: number }>();
    expect(destinationRows?.total).toBe(20);
  }, 60_000);
});
