import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpConversation } from "../src/chatgpt";
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
  restoreConversationRevision,
  writeCanonicalConversation,
  type CanonicalTransitionRecord,
} from "../src/storage";
import { completeMemoryRestore } from "../src/writes";

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

const restoreReceiptResult = z.object({
  conversation_id: z.string(),
  previous_revision_id: z.string(),
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
  verification: z
    .object({
      status: z.enum(["passed", "failed"]),
      revision_id: z.string(),
      checked_messages: z.number().optional(),
      readback: pageResult.optional(),
      error: z.unknown().optional(),
    })
    .optional(),
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
  const client = new Client({ name: "restore-integration-test", version: "1.0.0" });
  const server = createMemoryMcpServer(env, tenant);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

async function ownerClient(namespace = "restore-test-ns"): Promise<Client> {
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

describe("memory_restore_revision integration", () => {
  it("successfully restores to an older revision with byte-equivalent canonical readback, preserving conversation identity and tags", async () => {
    const ns = `ns-restore-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, ns);
    const client = await ownerClient(ns);

    const initialMessages = [
      {
        role: "user",
        content: 'Original rule: keep the gate open.\n"Quoted" \\ 雨 🌙',
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        role: "assistant",
        content: "Edge memory configuration complete.",
        timestamp: "2026-01-01T00:01:00.000Z",
      },
    ];
    const initialConv = await createMcpConversation({
      title: "Edge Deployment Project",
      namespace: ns,
      tags: ["edge", "deployment", "v1"],
      messages: initialMessages,
    });
    const stored1 = await writeCanonicalConversation(
      env,
      initialConv,
      null,
      null,
      OWNER_DB_USER_ID,
    );
    const rev1 = stored1.revisionId;

    const appendedMessages = [
      {
        role: "user",
        content: "Append note: adding multi-region routing.",
        timestamp: "2026-01-02T00:00:00.000Z",
      },
      {
        role: "assistant",
        content: "Multi-region routing activated.",
        timestamp: "2026-01-02T00:01:00.000Z",
      },
    ];
    const stored2 = await appendConversation(env, initialConv.id, rev1, appendedMessages, [
      "edge",
      "deployment",
      "v2-live",
    ]);
    const rev2 = stored2.revisionId;
    expect(rev2).not.toBe(rev1);

    // Call memory_restore_revision to restore back to rev1
    const rawReceipt = await callValue(client, "memory_restore_revision", {
      conversation_id: initialConv.id,
      revision_id: rev1,
      base_revision_id: rev2,
      verify: true,
    });
    const receipt = restoreReceiptResult.parse(rawReceipt);

    expect(receipt.conversation_id).toBe(initialConv.id);
    expect(receipt.previous_revision_id).toBe(rev2);
    expect(receipt.revision_id).toBe(rev1);
    expect(receipt.durable).toBe(true);
    expect(receipt.indexing.status).toBe("queued");
    expect(receipt.indexing.job_id).toBeDefined();
    expect(receipt.verification?.status).toBe("passed");
    expect(receipt.verification?.revision_id).toBe(rev1);

    // Verify canonical readback matches rev1 messages exactly
    const readCanonical = await callValue(client, "memory_get_conversation", {
      conversation_id: initialConv.id,
      format: "canonical",
    });
    const parsedCanonical = pageResult.parse(readCanonical);
    expect(parsedCanonical.conversation.revisionId).toBe(rev1);
    expect(parsedCanonical.conversation.title).toBe("Edge Deployment Project");
    expect(parsedCanonical.conversation.namespace).toBe(ns);
    expect(parsedCanonical.conversation.tags).toEqual(["edge", "deployment", "v1", "v2-live"]);
    expect(parsedCanonical.messages.map((m) => ({ role: m.role, text: m.text }))).toEqual(
      initialMessages.map((m) => ({ role: m.role, text: m.content })),
    );

    // Verify compact readback matches rev1 messages
    const readCompact = await callValue(client, "memory_get_conversation", {
      conversation_id: initialConv.id,
      format: "compact",
    });
    const parsedCompact = pageResult.parse(readCompact);
    expect(parsedCompact.conversation.revisionId).toBe(rev1);
    expect(parsedCompact.messages.map((m) => m.text)).toEqual(
      initialMessages.map((m) => m.content),
    );

    // Verify D1 state: current_revision_id is rev1
    const convRow = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id, title, namespace FROM conversations WHERE id = ?",
    )
      .bind(initialConv.id)
      .first<{ current_revision_id: string; title: string; namespace: string }>();
    expect(convRow?.current_revision_id).toBe(rev1);
    expect(convRow?.title).toBe("Edge Deployment Project");
    expect(convRow?.namespace).toBe(ns);

    // Verify canonical revisions were NOT mutated or duplicated
    const revRows = await env.MEMORY_DB.prepare(
      "SELECT COUNT(*) AS total FROM conversation_revisions WHERE conversation_id = ?",
    )
      .bind(initialConv.id)
      .first<{ total: number }>();
    expect(revRows?.total).toBe(2);

    // Verify durable transition record in D1
    const transitions = await env.MEMORY_DB.prepare(
      "SELECT * FROM conversation_head_transitions WHERE conversation_id = ? ORDER BY created_at DESC",
    )
      .bind(initialConv.id)
      .all<{
        id: string;
        previous_revision_id: string;
        restored_revision_id: string;
        operation: string;
        status: string;
        transition_object_key: string;
      }>();
    expect(transitions.results).toHaveLength(1);
    const trans = transitions.results[0]!;
    expect(trans.previous_revision_id).toBe(rev2);
    expect(trans.restored_revision_id).toBe(rev1);
    expect(trans.operation).toBe("restore");
    expect(trans.status).toBe("applied");

    // Verify R2 immutable transition object
    const r2Obj = await env.MEMORY_BUCKET.get(trans.transition_object_key);
    expect(r2Obj).not.toBeNull();
    const transitionJson = JSON.parse(await r2Obj!.text()) as CanonicalTransitionRecord;
    expect(transitionJson.format).toBe("mempersist.conversation-transition.v1");
    expect(transitionJson.conversationId).toBe(initialConv.id);
    expect(transitionJson.previousRevisionId).toBe(rev2);
    expect(transitionJson.restoredRevisionId).toBe(rev1);
    expect(transitionJson.operation).toBe("restore");
  });

  it("rejects stale base revision conflicts and leaves conversation head unchanged", async () => {
    const ns = `ns-restore-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, ns);
    const client = await ownerClient(ns);

    const conv = await createMcpConversation({
      title: "Optimistic Concurrency Test",
      namespace: ns,
      messages: [{ role: "user", content: "Original message" }],
    });
    const stored1 = await writeCanonicalConversation(env, conv, null, null, OWNER_DB_USER_ID);
    const rev1 = stored1.revisionId;

    const stored2 = await appendConversation(env, conv.id, rev1, [
      { role: "user", content: "Second message" },
    ]);
    const rev2 = stored2.revisionId;

    // Call restore with stale base_revision_id = rev1 (when current is rev2)
    const result = await call(client, "memory_restore_revision", {
      conversation_id: conv.id,
      revision_id: rev1,
      base_revision_id: rev1,
    });
    expect(result.isError).toBe(true);

    // Verify current head remains rev2
    const current = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id FROM conversations WHERE id = ?",
    )
      .bind(conv.id)
      .first<{ current_revision_id: string }>();
    expect(current?.current_revision_id).toBe(rev2);

    // Verify no transition row was applied
    const transitions = await env.MEMORY_DB.prepare(
      "SELECT COUNT(*) AS total FROM conversation_head_transitions WHERE conversation_id = ? AND status = 'applied'",
    )
      .bind(conv.id)
      .first<{ total: number }>();
    expect(transitions?.total).toBe(0);
  });

  it("rejects unrelated or non-existent revisions without leaking conversation existence", async () => {
    const ns = `ns-restore-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, ns);
    const client = await ownerClient(ns);

    // Create Conversation A (with revA1 and revA2)
    const convA = await createMcpConversation({
      title: "Conversation A",
      namespace: ns,
      messages: [{ role: "user", content: "Msg A1" }],
    });
    const storedA1 = await writeCanonicalConversation(env, convA, null, null, OWNER_DB_USER_ID);
    const storedA2 = await appendConversation(env, convA.id, storedA1.revisionId, [
      { role: "user", content: "Msg A2" },
    ]);

    // Create Conversation B (with revB1)
    const convB = await createMcpConversation({
      title: "Conversation B",
      namespace: ns,
      messages: [{ role: "user", content: "Msg B1" }],
    });
    const storedB1 = await writeCanonicalConversation(env, convB, null, null, OWNER_DB_USER_ID);

    // Attempt to restore Conversation A using Conversation B's revision
    const unrelatedResult = await call(client, "memory_restore_revision", {
      conversation_id: convA.id,
      revision_id: storedB1.revisionId,
      base_revision_id: storedA2.revisionId,
    });
    expect(unrelatedResult.isError).toBe(true);

    // Attempt to restore Conversation A using a fabricated revision ID
    const fakeRevisionId = "f".repeat(64);
    const fakeResult = await call(client, "memory_restore_revision", {
      conversation_id: convA.id,
      revision_id: fakeRevisionId,
      base_revision_id: storedA2.revisionId,
    });
    expect(fakeResult.isError).toBe(true);

    // Attempt to restore a non-existent conversation ID
    const fakeConvId = crypto.randomUUID();
    const missingConvResult = await call(client, "memory_restore_revision", {
      conversation_id: fakeConvId,
      revision_id: storedA1.revisionId,
      base_revision_id: storedA2.revisionId,
    });
    expect(missingConvResult.isError).toBe(true);

    // Verify Conversation A head is unchanged
    const headA = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id FROM conversations WHERE id = ?",
    )
      .bind(convA.id)
      .first<{ current_revision_id: string }>();
    expect(headA?.current_revision_id).toBe(storedA2.revisionId);
  });

  it("enforces strict tenant isolation and forbids foreign restore requests", async () => {
    const ns = `ns-restore-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, ns);

    // Owner creates conversation
    const ownerConv = await createMcpConversation({
      title: "Owner Private Memory",
      namespace: ns,
      messages: [{ role: "user", content: "Secret plan" }],
    });
    const stored1 = await writeCanonicalConversation(env, ownerConv, null, null, OWNER_DB_USER_ID);
    const stored2 = await appendConversation(env, ownerConv.id, stored1.revisionId, [
      { role: "user", content: "Updated plan" },
    ]);

    // Create a second user / foreign tenant
    const otherUser = await getOrCreateUser(
      env,
      `second-${crypto.randomUUID().slice(0, 6)}@example.com`,
    );
    await grantNamespace(env, otherUser.id, ns);
    const otherTenant = await resolveTenant(env, { userId: otherUser.id });
    const otherClient = await connectedClient(otherTenant);

    // Foreign user tries to restore owner's conversation
    const foreignRestore = await call(otherClient, "memory_restore_revision", {
      conversation_id: ownerConv.id,
      revision_id: stored1.revisionId,
      base_revision_id: stored2.revisionId,
    });
    expect(foreignRestore.isError).toBe(true);

    // Verify Owner's conversation head is intact
    const head = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id FROM conversations WHERE id = ?",
    )
      .bind(ownerConv.id)
      .first<{ current_revision_id: string }>();
    expect(head?.current_revision_id).toBe(stored2.revisionId);
  });

  it("handles repeated identical restore calls idempotently", async () => {
    const ns = `ns-restore-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, ns);
    const client = await ownerClient(ns);

    const conv = await createMcpConversation({
      title: "Idempotent Restore Test",
      namespace: ns,
      messages: [{ role: "user", content: "V1 content" }],
    });
    const stored1 = await writeCanonicalConversation(env, conv, null, null, OWNER_DB_USER_ID);
    const stored2 = await appendConversation(env, conv.id, stored1.revisionId, [
      { role: "user", content: "V2 content" },
    ]);

    // First restore: from rev2 back to rev1 with base rev2
    const firstReceipt = restoreReceiptResult.parse(
      await callValue(client, "memory_restore_revision", {
        conversation_id: conv.id,
        revision_id: stored1.revisionId,
        base_revision_id: stored2.revisionId,
        verify: true,
      }),
    );
    expect(firstReceipt.revision_id).toBe(stored1.revisionId);
    expect(firstReceipt.previous_revision_id).toBe(stored2.revisionId);
    expect(firstReceipt.durable).toBe(true);

    // Second restore with same base/target (retry of previous transition)
    const retryReceipt = restoreReceiptResult.parse(
      await callValue(client, "memory_restore_revision", {
        conversation_id: conv.id,
        revision_id: stored1.revisionId,
        base_revision_id: stored2.revisionId,
        verify: true,
      }),
    );
    expect(retryReceipt.revision_id).toBe(stored1.revisionId);
    expect(retryReceipt.durable).toBe(true);

    // Restore when current head is already rev1 with base rev1
    const noopReceipt = restoreReceiptResult.parse(
      await callValue(client, "memory_restore_revision", {
        conversation_id: conv.id,
        revision_id: stored1.revisionId,
        base_revision_id: stored1.revisionId,
        verify: true,
      }),
    );
    expect(noopReceipt.revision_id).toBe(stored1.revisionId);
    expect(noopReceipt.durable).toBe(true);

    // Verify canonical revisions count remains exactly 2
    const count = await env.MEMORY_DB.prepare(
      "SELECT COUNT(*) AS n FROM conversation_revisions WHERE conversation_id = ?",
    )
      .bind(conv.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("commits durable restore receipt even when indexing queue dispatch fails", async () => {
    const ns = `ns-restore-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, ns);
    const client = await ownerClient(ns);

    const conv = await createMcpConversation({
      title: "Queue Failure Test",
      namespace: ns,
      messages: [{ role: "user", content: "Initial queue test" }],
    });
    const stored1 = await writeCanonicalConversation(env, conv, null, null, OWNER_DB_USER_ID);
    const stored2 = await appendConversation(env, conv.id, stored1.revisionId, [
      { role: "user", content: "Appended queue test" },
    ]);

    // Mock INDEX_QUEUE.send to reject
    vi.spyOn(env.INDEX_QUEUE, "send").mockRejectedValue(new Error("Queue offline / unreachable"));

    const rawReceipt = await callValue(client, "memory_restore_revision", {
      conversation_id: conv.id,
      revision_id: stored1.revisionId,
      base_revision_id: stored2.revisionId,
      verify: true,
    });
    const receipt = restoreReceiptResult.parse(rawReceipt);

    // Assert durable is true and indexing is failed
    expect(receipt.durable).toBe(true);
    expect(receipt.revision_id).toBe(stored1.revisionId);
    expect(receipt.indexing.status).toBe("failed");
    expect(receipt.indexing.error?.retryable).toBe(true);
    expect(receipt.verification?.status).toBe("passed");

    // Verify D1 head was durably updated
    const head = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id FROM conversations WHERE id = ?",
    )
      .bind(conv.id)
      .first<{ current_revision_id: string }>();
    expect(head?.current_revision_id).toBe(stored1.revisionId);
  });

  it("returns durable receipt when post-restore verification encounters readback failure", async () => {
    const ns = `ns-restore-${crypto.randomUUID().slice(0, 8)}`;
    const conv = await createMcpConversation({
      title: "Verification Failure Test",
      namespace: ns,
      messages: [{ role: "user", content: "Verification base" }],
    });
    const stored1 = await writeCanonicalConversation(env, conv, null, null, OWNER_DB_USER_ID);
    const stored2 = await appendConversation(env, conv.id, stored1.revisionId, [
      { role: "user", content: "Verification append" },
    ]);

    // Directly invoke restoreConversationRevision to get RestoredRevision
    const restored = await restoreConversationRevision(
      env,
      conv.id,
      stored1.revisionId,
      stored2.revisionId,
      [ns],
      OWNER_DB_USER_ID,
    );
    expect(restored.revisionId).toBe(stored1.revisionId);
    expect(restored.previousRevisionId).toBe(stored2.revisionId);

    // Corrupt or delete the manifest object temporarily to trigger verification failure
    const originalManifest = await env.MEMORY_BUCKET.get(stored1.manifestKey);
    const manifestText = await originalManifest!.text();
    await env.MEMORY_BUCKET.delete(stored1.manifestKey);

    try {
      const receipt = await completeMemoryRestore(env, restored, true);
      expect(receipt.durable).toBe(true);
      expect(receipt.revision_id).toBe(stored1.revisionId);
      expect(receipt.previous_revision_id).toBe(stored2.revisionId);
      expect(receipt.verification?.status).toBe("failed");
    } finally {
      // Restore manifest for clean state
      await env.MEMORY_BUCKET.put(stored1.manifestKey, manifestText);
    }

    // Verify D1 head remains durably restored
    const head = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id FROM conversations WHERE id = ?",
    )
      .bind(conv.id)
      .first<{ current_revision_id: string }>();
    expect(head?.current_revision_id).toBe(stored1.revisionId);
  });

  it("recovers safely from a prepared R2 transition state on retry", async () => {
    const ns = `ns-restore-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, ns);
    const client = await ownerClient(ns);

    const conv = await createMcpConversation({
      title: "Prepared State Recovery Test",
      namespace: ns,
      messages: [{ role: "user", content: "Prepared test v1" }],
    });
    const stored1 = await writeCanonicalConversation(env, conv, null, null, OWNER_DB_USER_ID);
    const stored2 = await appendConversation(env, conv.id, stored1.revisionId, [
      { role: "user", content: "Prepared test v2" },
    ]);

    const transitionId = await domainId(
      "transition",
      conv.id,
      stored2.revisionId,
      stored1.revisionId,
    );
    const transitionKey = `canonical/conversations/${conv.id}/transitions/${transitionId}.json`;
    const now = new Date().toISOString();

    // Simulate partial failure: R2 object and D1 'prepared' row exist, but head was not updated
    const transitionRecord: CanonicalTransitionRecord = {
      format: "mempersist.conversation-transition.v1",
      transitionId,
      conversationId: conv.id,
      operation: "restore",
      previousRevisionId: stored2.revisionId,
      restoredRevisionId: stored1.revisionId,
      userId: OWNER_DB_USER_ID,
      createdAt: now,
    };
    await env.MEMORY_BUCKET.put(transitionKey, JSON.stringify(transitionRecord));
    await env.MEMORY_DB.prepare(
      `INSERT INTO conversation_head_transitions
       (id, conversation_id, previous_revision_id, restored_revision_id, operation, user_id, transition_object_key, status, created_at, applied_at)
       VALUES (?, ?, ?, ?, 'restore', ?, ?, 'prepared', ?, NULL)
       ON CONFLICT(id) DO UPDATE SET status = 'prepared'`,
    )
      .bind(
        transitionId,
        conv.id,
        stored2.revisionId,
        stored1.revisionId,
        OWNER_DB_USER_ID,
        transitionKey,
        now,
      )
      .run();

    // Verify D1 head is still at rev2 before retry
    const preHead = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id FROM conversations WHERE id = ?",
    )
      .bind(conv.id)
      .first<{ current_revision_id: string }>();
    expect(preHead?.current_revision_id).toBe(stored2.revisionId);

    // Retry the restore operation via MCP tool
    const rawReceipt = await callValue(client, "memory_restore_revision", {
      conversation_id: conv.id,
      revision_id: stored1.revisionId,
      base_revision_id: stored2.revisionId,
      verify: true,
    });
    const receipt = restoreReceiptResult.parse(rawReceipt);

    expect(receipt.durable).toBe(true);
    expect(receipt.revision_id).toBe(stored1.revisionId);
    expect(receipt.previous_revision_id).toBe(stored2.revisionId);

    // Verify D1 head transitioned to rev1
    const postHead = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id FROM conversations WHERE id = ?",
    )
      .bind(conv.id)
      .first<{ current_revision_id: string }>();
    expect(postHead?.current_revision_id).toBe(stored1.revisionId);

    // Verify transition status transitioned from prepared to applied
    const transitionRow = await env.MEMORY_DB.prepare(
      "SELECT status, applied_at FROM conversation_head_transitions WHERE id = ?",
    )
      .bind(transitionId)
      .first<{ status: string; applied_at: string | null }>();
    expect(transitionRow?.status).toBe("applied");
    expect(transitionRow?.applied_at).not.toBeNull();
  });
});
