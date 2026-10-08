import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpConversation } from "../src/chatgpt";
import { createMemoryMcpServer } from "../src/mcp";
import { MAX_MESSAGE_CONTENT_CHARS } from "../src/limits";
import { completeMemoryUpsert } from "../src/writes";
import { getMessages } from "../src/retrieval";
import type { CanonicalConversation } from "../src/domain";
import {
  appendConversation,
  copyConversations,
  loadCanonicalRevision,
  restoreConversationRevision,
  upsertConversationMessages,
  writeCanonicalConversation,
} from "../src/storage";
import { getOrCreateUser, grantNamespace, OWNER_DB_USER_ID } from "../src/tenant";
const connections: Array<{
  client: Client;
  server: McpServer;
}> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
});

async function seedConversation(namespace: string): Promise<{
  conversation: CanonicalConversation;
  revisionId: string;
}> {
  const conversation = await createMcpConversation({
    title: "Keyed upsert",
    namespace,
    messages: [{ role: "user", content: "seed", timestamp: "2026-01-01T00:00:00.000Z" }],
  });
  conversation.nodes[0]!.messageKey = "state.seed";
  const revision = await writeCanonicalConversation(
    env,
    conversation,
    null,
    null,
    OWNER_DB_USER_ID,
  );
  return { conversation, revisionId: revision.revisionId };
}
async function connectedClient(namespace: string): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "upsert-integration", version: "1.0.0" });
  const server = createMemoryMcpServer(env, {
    userId: OWNER_DB_USER_ID,
    defaultNamespace: namespace,
    namespaces: [namespace],
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

async function callValue(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`MCP call failed: ${name}`);
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error(`MCP call returned no text: ${name}`);
  const value: unknown = JSON.parse(content.text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`MCP call returned non-object: ${name}`);
  }
  return value as Record<string, unknown>;
}

describe("canonical keyed upserts", () => {
  it("executes the MCP upsert path with verified bounded readback", async () => {
    const namespace = `upsert-mcp-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);
    const client = await connectedClient(namespace);

    const receipt = await callValue(client, "memory_upsert_messages", {
      conversation_id: seeded.conversation.id,
      base_revision_id: seeded.revisionId,
      messages: [
        { message_key: "state.seed", role: "user", text: "seed" },
        { message_key: "state.mcp", role: "assistant", text: "from MCP" },
      ],
      verify: true,
    });
    expect(receipt.status).toBe("upserted");
    expect(receipt.durable).toBe(true);
    const verification = receipt.verification as {
      status: string;
      revision_id: string;
      readback_available: boolean;
      readback?: { messages: Array<{ messageKey?: string; text: string }> };
    };
    expect(verification.status).toBe("passed");
    expect(verification.revision_id).toBe(receipt.revision_id);
    expect(verification.readback_available).toBe(true);
    expect(verification.readback?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageKey: "state.seed", text: "seed" }),
        expect.objectContaining({ messageKey: "state.mcp", text: "from MCP" }),
      ]),
    );
  });
  it("keeps a maximum verified MCP receipt within the budget", async () => {
    const namespace = `upsert-receipt-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);
    const client = await connectedClient(namespace);
    const messages = Array.from({ length: 99 }, (_, index) => ({
      message_key: `state.receipt-${index}`,
      role: "assistant",
      text: "x".repeat(500),
    }));

    const receipt = await callValue(client, "memory_upsert_messages", {
      conversation_id: seeded.conversation.id,
      base_revision_id: seeded.revisionId,
      messages,
      verify: true,
    });
    expect(receipt.durable).toBe(true);
    expect(receipt.messages).toHaveLength(99);
    expect(receipt.used_serialized_bytes).toBeLessThanOrEqual(49_152);
    expect(receipt.max_serialized_bytes).toBe(49_152);
  });

  it("commits mixed updated, unchanged, and inserted results in one revision", async () => {
    const namespace = `upsert-mixed-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);
    const first = await upsertConversationMessages(
      env,
      seeded.conversation.id,
      seeded.revisionId,
      [{ messageKey: "state.same", role: "assistant", text: "same" }],
      [namespace],
      OWNER_DB_USER_ID,
    );
    const mixed = await upsertConversationMessages(
      env,
      seeded.conversation.id,
      first.revisionId,
      [
        { messageKey: "state.seed", role: "user", text: "changed" },
        { messageKey: "state.same", role: "assistant", text: "same" },
        { messageKey: "state.new", role: "assistant", text: "new" },
      ],
      [namespace],
      OWNER_DB_USER_ID,
    );
    expect(mixed.status).toBe("upserted");
    expect(mixed.revisionId).not.toBe(first.revisionId);
    expect(mixed.messages.map((message) => message.status)).toEqual([
      "updated",
      "unchanged",
      "inserted",
    ]);
  });

  it("inserts in request order, then updates identity without changing role or creation time", async () => {
    const namespace = `upsert-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);

    const inserted = await upsertConversationMessages(
      env,
      seeded.conversation.id,
      seeded.revisionId,
      [
        { messageKey: "state.second", role: "assistant", text: "two" },
        { messageKey: "state.third", role: "assistant", text: "three" },
      ],
      [namespace],
      OWNER_DB_USER_ID,
    );
    expect(inserted.status).toBe("upserted");
    expect(inserted.messages.map((item) => item.status)).toEqual(["inserted", "inserted"]);

    const afterInsert = await loadCanonicalRevision(env, inserted.revisionId);
    expect(afterInsert.conversation.activeSourceNodeIds.slice(-2)).toEqual(
      inserted.messages.map((item) => item.sourceNodeId),
    );
    expect(afterInsert.conversation.nodes.map((node) => node.messageKey)).toEqual([
      "state.seed",
      "state.second",
      "state.third",
    ]);

    const seed = afterInsert.conversation.nodes[0]!;
    const updated = await upsertConversationMessages(
      env,
      seeded.conversation.id,
      inserted.revisionId,
      [{ messageKey: "state.seed", role: "user", text: "changed" }],
      [namespace],
      OWNER_DB_USER_ID,
    );
    const afterUpdate = await loadCanonicalRevision(env, updated.revisionId);
    const changed = afterUpdate.conversation.nodes.find(
      (node) => node.messageKey === "state.seed",
    )!;
    expect(changed.sourceNodeId).toBe(seed.sourceNodeId);
    expect(changed.createdAt).toBe(seed.createdAt);
    expect(changed.role).toBe(seed.role);
    expect(changed.text).toBe("changed");
    expect(changed.updatedAt).not.toBe(seed.updatedAt);
    const lookup = await getMessages(
      env,
      {
        requests: [
          {
            conversation_id: seeded.conversation.id,
            revision_id: updated.revisionId,
            message_key: "state.seed",
          },
        ],
      },
      [namespace],
      OWNER_DB_USER_ID,
      "upsert-test-secret",
    );
    expect(lookup.results[0]?.status).toBe("ok");
    expect(lookup.results[0]?.message?.sourceNodeId).toBe(seed.sourceNodeId);
    expect(lookup.results[0]?.message?.text).toBe("changed");
  });

  it("returns no_change without creating a revision and rejects stale bases", async () => {
    const namespace = `upsert-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);
    const noChange = await upsertConversationMessages(
      env,
      seeded.conversation.id,
      seeded.revisionId,
      [{ messageKey: "state.seed", role: "user", text: "seed" }],
      [namespace],
      OWNER_DB_USER_ID,
    );
    expect(noChange.status).toBe("no_change");
    expect(noChange.revision).toBeNull();
    expect(noChange.revisionId).toBe(seeded.revisionId);

    await expect(
      upsertConversationMessages(
        env,
        seeded.conversation.id,
        "stale-revision",
        [{ messageKey: "state.other", role: "assistant", text: "value" }],
        [namespace],
        OWNER_DB_USER_ID,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
  });

  it("rejects duplicate keys already present in the complete canonical graph", async () => {
    const namespace = `upsert-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const conversation = await createMcpConversation({
      title: "Duplicate keys",
      namespace,
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
      ],
    });
    conversation.nodes[0]!.messageKey = "duplicate.key";
    conversation.nodes[1]!.messageKey = "duplicate.key";
    await expect(
      writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID),
    ).rejects.toMatchObject({ code: "CANONICAL_STORAGE" });

    conversation.nodes[1]!.messageKey = "unique.key";
    const revision = await writeCanonicalConversation(
      env,
      conversation,
      null,
      null,
      OWNER_DB_USER_ID,
    );
    const segment = await env.MEMORY_BUCKET.get(revision.segmentKey);
    const segmentText = await segment!.text();
    const corruptedSegment = segmentText.replace(
      '"messageKey":"unique.key"',
      '"messageKey":"duplicate.key"',
    );
    await env.MEMORY_BUCKET.put(revision.segmentKey, corruptedSegment);
    try {
      await expect(
        upsertConversationMessages(
          env,
          conversation.id,
          revision.revisionId,
          [{ messageKey: "duplicate.key", role: "user", text: "replacement" }],
          [namespace],
          OWNER_DB_USER_ID,
        ),
      ).rejects.toMatchObject({ code: "CANONICAL_STORAGE" });
    } finally {
      await env.MEMORY_BUCKET.put(revision.segmentKey, segmentText);
    }
  });
  it("rejects oversized text before canonical work", async () => {
    const namespace = `upsert-size-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);
    await expect(
      upsertConversationMessages(
        env,
        seeded.conversation.id,
        seeded.revisionId,
        [
          {
            messageKey: "state.large",
            role: "assistant",
            text: "x".repeat(MAX_MESSAGE_CONTENT_CHARS + 1),
          },
        ],
        [namespace],
        OWNER_DB_USER_ID,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await loadCanonicalRevision(env, seeded.revisionId)).conversation.nodes).toHaveLength(
      1,
    );
  });

  it("allows only one concurrent upsert to advance the same base revision", async () => {
    const namespace = `upsert-concurrent-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);
    const results = await Promise.allSettled([
      upsertConversationMessages(
        env,
        seeded.conversation.id,
        seeded.revisionId,
        [{ messageKey: "state.seed", role: "user", text: "first" }],
        [namespace],
        OWNER_DB_USER_ID,
      ),
      upsertConversationMessages(
        env,
        seeded.conversation.id,
        seeded.revisionId,
        [{ messageKey: "state.seed", role: "user", text: "second" }],
        [namespace],
        OWNER_DB_USER_ID,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ code: "IMPORT_CONFLICT" });
  });

  it("validates keys, duplicate request keys, role mismatches, and writes nothing on failure", async () => {
    const namespace = `upsert-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);
    for (const messageKey of ["", "Bad Key", "-bad", "bad-", "a".repeat(129)]) {
      await expect(
        upsertConversationMessages(
          env,
          seeded.conversation.id,
          seeded.revisionId,
          [{ messageKey, role: "assistant", text: "invalid" }],
          [namespace],
          OWNER_DB_USER_ID,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(
      upsertConversationMessages(
        env,
        seeded.conversation.id,
        seeded.revisionId,
        [
          { messageKey: "state.new", role: "assistant", text: "new" },
          { messageKey: "state.new", role: "assistant", text: "duplicate" },
        ],
        [namespace],
        OWNER_DB_USER_ID,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      upsertConversationMessages(
        env,
        seeded.conversation.id,
        seeded.revisionId,
        [
          { messageKey: "state.new", role: "assistant", text: "new" },
          { messageKey: "state.seed", role: "assistant", text: "wrong role" },
        ],
        [namespace],
        OWNER_DB_USER_ID,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const unchanged = await loadCanonicalRevision(env, seeded.revisionId);
    expect(unchanged.conversation.nodes.map((node) => node.messageKey)).toEqual(["state.seed"]);
  });

  it("accepts Unicode and empty text and the maximum keyed batch", async () => {
    const namespace = `upsert-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);
    const messages = Array.from({ length: 100 }, (_, index) => ({
      messageKey: `state.batch-${index}`,
      role: "assistant",
      text: index === 0 ? "こんにちは 🌍" : index === 1 ? "" : `value-${index}`,
    }));
    const result = await upsertConversationMessages(
      env,
      seeded.conversation.id,
      seeded.revisionId,
      messages,
      [namespace],
      OWNER_DB_USER_ID,
    );
    expect(result.status).toBe("upserted");
    expect(result.messages).toHaveLength(100);
    expect(result.messages.every((message) => message.status === "inserted")).toBe(true);
    const stored = await loadCanonicalRevision(env, result.revisionId);
    expect(
      stored.conversation.nodes.find((node) => node.messageKey === "state.batch-0")?.text,
    ).toBe("こんにちは 🌍");
    expect(
      stored.conversation.nodes.find((node) => node.messageKey === "state.batch-1")?.text,
    ).toBe("");
  });

  it("updates a keyed message on an inactive branch without changing graph identity", async () => {
    const namespace = `upsert-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const conversation = await createMcpConversation({
      title: "Inactive keyed branch",
      namespace,
      messages: [
        { role: "user", content: "root" },
        { role: "assistant", content: "active" },
        { role: "assistant", content: "inactive" },
      ],
    });
    const root = conversation.nodes[0]!;
    const active = conversation.nodes[1]!;
    const inactive = conversation.nodes[2]!;
    root.childSourceNodeIds = [active.sourceNodeId, inactive.sourceNodeId];
    active.childSourceNodeIds = [];
    inactive.parentSourceNodeId = root.sourceNodeId;
    inactive.messageKey = "state.inactive";
    conversation.currentSourceNodeId = active.sourceNodeId;
    conversation.activeSourceNodeIds = [root.sourceNodeId, active.sourceNodeId];
    const revision = await writeCanonicalConversation(
      env,
      conversation,

      null,
      null,
      OWNER_DB_USER_ID,
    );
    const result = await upsertConversationMessages(
      env,
      conversation.id,
      revision.revisionId,
      [{ messageKey: "state.inactive", role: "assistant", text: "updated inactive" }],
      [namespace],
      OWNER_DB_USER_ID,
    );
    const receipt = await completeMemoryUpsert(
      env,
      result,
      [{ messageKey: "state.inactive", role: "assistant", text: "updated inactive" }],
      true,
    );
    expect(receipt.readback_requests).toEqual([
      {
        conversation_id: conversation.id,
        revision_id: result.revisionId,
        offset: 0,
        limit: 100,
        branch: "all",
      },
    ]);
    const stored = await loadCanonicalRevision(env, result.revisionId);
    const updated = stored.conversation.nodes.find((node) => node.messageKey === "state.inactive")!;
    expect(result.messages[0]!.status).toBe("updated");
    expect(updated.sourceNodeId).toBe(inactive.sourceNodeId);
    expect(updated.text).toBe("updated inactive");
    expect(stored.conversation.activeSourceNodeIds).toEqual(conversation.activeSourceNodeIds);
    expect(stored.conversation.currentSourceNodeId).toBe(conversation.currentSourceNodeId);
  });
  it("keeps the committed upsert durable when indexing fails", async () => {
    const namespace = `upsert-queue-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);
    const result = await upsertConversationMessages(
      env,
      seeded.conversation.id,
      seeded.revisionId,
      [{ messageKey: "state.queue", role: "assistant", text: "saved" }],
      [namespace],
      OWNER_DB_USER_ID,
    );
    vi.spyOn(env.INDEX_QUEUE, "send").mockRejectedValue(new Error("queue unavailable"));

    const receipt = await completeMemoryUpsert(
      env,
      result,
      [{ messageKey: "state.queue", role: "assistant", text: "saved" }],
      false,
    );
    expect(receipt.durable).toBe(true);
    expect(receipt.indexing).toMatchObject({
      status: "failed",
      error: { code: "DERIVED_INDEXING", retryable: true },
    });
    expect((await loadCanonicalRevision(env, result.revisionId)).conversation.id).toBe(
      seeded.conversation.id,
    );
  });

  it("keeps the committed upsert durable when verification cannot read R2", async () => {
    const namespace = `upsert-verify-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);
    const result = await upsertConversationMessages(
      env,
      seeded.conversation.id,
      seeded.revisionId,
      [{ messageKey: "state.verify", role: "assistant", text: "saved" }],
      [namespace],
      OWNER_DB_USER_ID,
    );
    const stored = result.revision;
    if (!stored) throw new Error("Expected a committed revision");
    const manifest = await env.MEMORY_BUCKET.get(stored.manifestKey);
    const manifestText = await manifest!.text();
    await env.MEMORY_BUCKET.delete(stored.manifestKey);
    try {
      const receipt = await completeMemoryUpsert(
        env,
        result,
        [{ messageKey: "state.verify", role: "assistant", text: "saved" }],
        true,
      );
      expect(receipt.durable).toBe(true);
      expect(receipt.verification).toMatchObject({
        status: "failed",
        readback_available: false,
        error: { code: "CANONICAL_STORAGE" },
      });
    } finally {
      await env.MEMORY_BUCKET.put(stored.manifestKey, manifestText);
    }
  });
  it("does not upsert a conversation owned by another tenant", async () => {
    const namespace = `upsert-tenant-${crypto.randomUUID()}`;
    const foreignUser = await getOrCreateUser(
      env,
      `upsert-foreign-${crypto.randomUUID()}@example.com`,
    );
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    await grantNamespace(env, foreignUser.id, namespace);
    const foreign = await createMcpConversation({
      title: "Foreign keyed conversation",
      namespace,
      messages: [{ role: "assistant", content: "private" }],
    });
    foreign.nodes[0]!.messageKey = "state.private";
    const stored = await writeCanonicalConversation(env, foreign, null, null, foreignUser.id);

    await expect(
      upsertConversationMessages(
        env,
        foreign.id,
        stored.revisionId,
        [{ messageKey: "state.private", role: "assistant", text: "intrusion" }],
        [namespace],
        OWNER_DB_USER_ID,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("preserves keyed lookup when copying a canonical conversation", async () => {
    const sourceNamespace = `upsert-copy-src-${crypto.randomUUID()}`;
    const targetNamespace = `upsert-copy-dest-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, sourceNamespace);
    await grantNamespace(env, OWNER_DB_USER_ID, targetNamespace);
    const seeded = await seedConversation(sourceNamespace);

    const [copyResult] = await copyConversations(env, {
      userId: OWNER_DB_USER_ID,
      namespaces: [sourceNamespace, targetNamespace],
      targetNamespace,
      idempotencyKey: `upsert-copy-${crypto.randomUUID()}`,
      requests: [{ conversationId: seeded.conversation.id }],
    });
    if (!copyResult || copyResult.status !== "copied") {
      throw new Error("Expected successful conversation copy");
    }

    const copied = await loadCanonicalRevision(env, copyResult.stored.revisionId);
    expect(copied.conversation.nodes.find((node) => node.messageKey === "state.seed")?.text).toBe(
      "seed",
    );
    const lookup = await getMessages(
      env,
      {
        requests: [
          {
            conversation_id: copied.conversation.id,
            revision_id: copyResult.stored.revisionId,
            message_key: "state.seed",
          },
        ],
      },
      [targetNamespace],
      OWNER_DB_USER_ID,
      "upsert-copy-test-secret",
    );
    expect(lookup.results[0]?.status).toBe("ok");
    expect(lookup.results[0]?.message?.messageKey).toBe("state.seed");
    expect(lookup.results[0]?.message?.text).toBe("seed");
  });

  it("preserves keyed lookup when restoring a prior canonical revision", async () => {
    const namespace = `upsert-restore-${crypto.randomUUID()}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const seeded = await seedConversation(namespace);
    const newer = await appendConversation(
      env,
      seeded.conversation.id,
      seeded.revisionId,
      [{ role: "assistant", content: "later" }],
      undefined,
      [namespace],
      OWNER_DB_USER_ID,
    );

    const restored = await restoreConversationRevision(
      env,
      seeded.conversation.id,
      seeded.revisionId,
      newer.revisionId,
      [namespace],
      OWNER_DB_USER_ID,
    );
    expect(restored.revisionId).toBe(seeded.revisionId);
    expect(restored.previousRevisionId).toBe(newer.revisionId);

    const lookup = await getMessages(
      env,
      {
        requests: [
          {
            conversation_id: seeded.conversation.id,
            message_key: "state.seed",
          },
        ],
      },
      [namespace],
      OWNER_DB_USER_ID,
      "upsert-restore-test-secret",
    );
    expect(lookup.results[0]?.status).toBe("ok");
    expect(lookup.results[0]?.revision_id).toBe(seeded.revisionId);
    expect(lookup.results[0]?.message?.messageKey).toBe("state.seed");
    expect(lookup.results[0]?.message?.text).toBe("seed");
  });
});
