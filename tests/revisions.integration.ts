import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMemoryMcpServer } from "../src/mcp";
import {
  getOrCreateUser,
  grantNamespace,
  OWNER_DB_USER_ID,
  resolveTenant,
  type Tenant,
} from "../src/tenant";

const historyResult = z.object({
  conversation_id: z.string(),
  current_revision_id: z.string(),
  revisions: z.array(
    z.object({
      revision_id: z.string(),
      created_at: z.string(),
      node_count: z.number(),
      content_hash: z.string(),
      current: z.boolean(),
    }),
  ),
  next_cursor: z.string().nullable(),
});

type History = z.infer<typeof historyResult>;
type CallResult =
  | { isError: true; text: string; bytes: number }
  | { isError: false; text: string; bytes: number; value: unknown };

interface SeededRevision {
  id: string;
  createdAt: string;
  nodeCount: number;
}

const connections: Array<{ client: Client; server: McpServer }> = [];

afterEach(async () => {
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
});

async function connectedClient(tenant: Tenant) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "revision-history-test", version: "1.0.0" });
  const server = createMemoryMcpServer(env, tenant);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

async function ownerClient() {
  await grantNamespace(env, OWNER_DB_USER_ID, "astara_alt_v2");
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

async function listRevisions(client: Client, args: Record<string, unknown>): Promise<History> {
  return historyResult.parse(await callValue(client, "memory_list_revisions", args));
}

// Storage is shared across tests in a file, so every test namespaces its own
// deterministic revision IDs while keeping them orderable within the test.
function revisionIds(): (index: number) => string {
  const prefix = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "").slice(0, 48);
  return (index: number) => `${prefix}${index.toString(16).padStart(16, "0")}`;
}

function revisionStatement(conversationId: string, revision: SeededRevision) {
  return env.MEMORY_DB.prepare(
    `INSERT INTO conversation_revisions
     (id, conversation_id, content_hash, manifest_object_key, node_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    revision.id,
    conversationId,
    revision.id,
    `canonical/seeded/${revision.id}.json`,
    revision.nodeCount,
    revision.createdAt,
  );
}

// Catalog-only fixtures: metadata reads never load revision bodies from R2.
async function seedConversation(options: {
  conversationId: string;
  namespace: string;
  userId: string;
  revisions: SeededRevision[];
  currentRevisionId: string;
  deletedAt?: string | null;
}) {
  const oldest = options.revisions[0]!;
  const newest = options.revisions.at(-1)!;
  const statements: D1PreparedStatement[] = [
    env.MEMORY_DB.prepare(
      `INSERT INTO conversations
       (id, source_type, title, imported_at, namespace, user_id, current_revision_id,
        created_at, updated_at, deleted_at)
       VALUES (?, 'mcp', 'Seeded history', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      options.conversationId,
      oldest.createdAt,
      options.namespace,
      options.userId,
      options.currentRevisionId,
      oldest.createdAt,
      newest.createdAt,
      options.deletedAt ?? null,
    ),
    ...options.revisions.map((revision) => revisionStatement(options.conversationId, revision)),
  ];
  for (let index = 0; index < statements.length; index += 50) {
    await env.MEMORY_DB.batch(statements.slice(index, index + 50));
  }
}

async function addRevision(conversationId: string, revision: SeededRevision) {
  await env.MEMORY_DB.batch([
    revisionStatement(conversationId, revision),
    env.MEMORY_DB.prepare(
      "UPDATE conversations SET current_revision_id = ?, updated_at = ? WHERE id = ?",
    ).bind(revision.id, revision.createdAt, conversationId),
  ]);
}

describe("memory_list_revisions", () => {
  it("lists committed revisions and marks the current head", async () => {
    const client = await ownerClient();
    const receipt = z.object({ conversation_id: z.string(), revision_id: z.string() }).parse(
      await callValue(client, "memory_store", {
        title: "Revision history runtime",
        namespace: "personal",
        messages: [{ role: "user", content: "First turn" }],
      }),
    );
    const appendReceipt = z.object({ revision_id: z.string() }).parse(
      await callValue(client, "memory_append", {
        conversation_id: receipt.conversation_id,
        base_revision_id: receipt.revision_id,
        messages: [{ role: "assistant", content: "Second turn" }],
      }),
    );

    const history = await listRevisions(client, { conversation_id: receipt.conversation_id });
    expect(history.conversation_id).toBe(receipt.conversation_id);
    expect(history.current_revision_id).toBe(appendReceipt.revision_id);
    expect(history.revisions).toHaveLength(2);
    expect(history.next_cursor).toBeNull();
    expect(history.revisions.filter((revision) => revision.current)).toEqual([
      expect.objectContaining({ revision_id: appendReceipt.revision_id }),
    ]);
    expect(new Set(history.revisions.map((revision) => revision.node_count))).toEqual(
      new Set([1, 2]),
    );
    for (const revision of history.revisions) {
      expect(revision.revision_id).toMatch(/^[a-f0-9]{64}$/u);
      expect(revision.content_hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(Date.parse(revision.created_at)).not.toBeNaN();
    }

    // Metadata only: no R2 keys, user identifiers, or other storage details.
    expect(Object.keys(history).sort()).toEqual([
      "conversation_id",
      "current_revision_id",
      "next_cursor",
      "revisions",
    ]);
    expect(Object.keys(history.revisions[0]!).sort()).toEqual([
      "content_hash",
      "created_at",
      "current",
      "node_count",
      "revision_id",
    ]);
  });

  it("returns a revision id that pins that historical revision", async () => {
    const client = await ownerClient();
    const receipt = z.object({ conversation_id: z.string(), revision_id: z.string() }).parse(
      await callValue(client, "memory_store", {
        title: "Historical read",
        namespace: "personal",
        messages: [{ role: "user", content: "Original turn" }],
      }),
    );
    await callValue(client, "memory_append", {
      conversation_id: receipt.conversation_id,
      base_revision_id: receipt.revision_id,
      messages: [{ role: "assistant", content: "Later turn" }],
    });

    const history = await listRevisions(client, { conversation_id: receipt.conversation_id });
    const historical = history.revisions.find((revision) => !revision.current);
    expect(historical).toBeDefined();

    const body = z
      .object({
        conversation: z.object({ revisionId: z.string() }),
        messages: z.array(z.object({ text: z.string() })),
      })
      .parse(
        await callValue(client, "memory_get_conversation", {
          conversation_id: receipt.conversation_id,
          revision_id: historical!.revision_id,
          format: "compact",
        }),
      );
    expect(body.conversation.revisionId).toBe(historical!.revision_id);
    expect(body.messages.map((message) => message.text)).toEqual(["Original turn"]);
  });

  it("orders deterministically and pages without skipping or repeating rows", async () => {
    const revisionId = revisionIds();
    const client = await ownerClient();
    const conversationId = crypto.randomUUID();
    // Three revisions share a timestamp: only the (created_at, id) tie-break separates them.
    await seedConversation({
      conversationId,
      namespace: "personal",
      userId: OWNER_DB_USER_ID,
      revisions: [
        { id: revisionId(1), createdAt: "2026-01-01T00:00:01.000Z", nodeCount: 1 },
        { id: revisionId(2), createdAt: "2026-01-01T00:00:02.000Z", nodeCount: 2 },
        { id: revisionId(3), createdAt: "2026-01-01T00:00:02.000Z", nodeCount: 3 },
        { id: revisionId(4), createdAt: "2026-01-01T00:00:02.000Z", nodeCount: 4 },
        { id: revisionId(5), createdAt: "2026-01-01T00:00:03.000Z", nodeCount: 5 },
      ],
      currentRevisionId: revisionId(5),
    });

    const expected = [revisionId(5), revisionId(4), revisionId(3), revisionId(2), revisionId(1)];
    const full = await listRevisions(client, { conversation_id: conversationId, limit: 100 });
    expect(full.revisions.map((revision) => revision.revision_id)).toEqual(expected);
    expect(
      full.revisions.filter((revision) => revision.current).map((revision) => revision.revision_id),
    ).toEqual([revisionId(5)]);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await listRevisions(client, {
        conversation_id: conversationId,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      walked.push(...page.revisions.map((revision) => revision.revision_id));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(expected.length);
  });

  it("keeps later pages stable when revisions land mid-pagination", async () => {
    const revisionId = revisionIds();
    const client = await ownerClient();
    const conversationId = crypto.randomUUID();
    await seedConversation({
      conversationId,
      namespace: "personal",
      userId: OWNER_DB_USER_ID,
      revisions: [1, 2, 3, 4].map((index) => ({
        id: revisionId(index),
        createdAt: `2026-02-0${index}T00:00:00.000Z`,
        nodeCount: index,
      })),
      currentRevisionId: revisionId(4),
    });

    const first = await listRevisions(client, { conversation_id: conversationId, limit: 2 });
    expect(first.revisions.map((revision) => revision.revision_id)).toEqual([
      revisionId(4),
      revisionId(3),
    ]);
    expect(first.current_revision_id).toBe(revisionId(4));
    expect(
      first.revisions
        .filter((revision) => revision.current)
        .map((revision) => revision.revision_id),
    ).toEqual([revisionId(4)]);
    expect(first.next_cursor).not.toBeNull();

    // (a) shares the cursor row's timestamp with a smaller ID, so it sorts after the
    // cursor boundary; (b) is strictly newer than every page-1 row. Neither may appear.
    await addRevision(conversationId, {
      id: revisionId(0),
      createdAt: "2026-02-03T00:00:00.000Z",
      nodeCount: 10,
    });
    await addRevision(conversationId, {
      id: revisionId(9),
      createdAt: "2026-02-09T00:00:00.000Z",
      nodeCount: 9,
    });

    const second = await listRevisions(client, {
      conversation_id: conversationId,
      limit: 2,
      cursor: first.next_cursor!,
    });
    expect(second.revisions.map((revision) => revision.revision_id)).toEqual([
      revisionId(2),
      revisionId(1),
    ]);
    expect(second.current_revision_id).toBe(revisionId(4));
    expect(second.revisions.filter((revision) => revision.current)).toEqual([]);
    expect(second.next_cursor).toBeNull();

    // A fresh walk sees the live history, including both new revisions.
    const refreshed = await listRevisions(client, { conversation_id: conversationId });
    expect(refreshed.current_revision_id).toBe(revisionId(9));
    expect(refreshed.revisions.map((revision) => revision.revision_id)).toEqual([
      revisionId(9),
      revisionId(4),
      revisionId(3),
      revisionId(0),
      revisionId(2),
      revisionId(1),
    ]);
    expect(refreshed.revisions.filter((revision) => revision.current)).toHaveLength(1);
  });

  it("returns an empty page past the end of the history", async () => {
    const revisionId = revisionIds();
    const client = await ownerClient();
    const conversationId = crypto.randomUUID();
    await seedConversation({
      conversationId,
      namespace: "personal",
      userId: OWNER_DB_USER_ID,
      revisions: [{ id: revisionId(1), createdAt: "2026-03-01T00:00:00.000Z", nodeCount: 1 }],
      currentRevisionId: revisionId(1),
    });

    const page = await listRevisions(client, { conversation_id: conversationId, limit: 1 });
    expect(page.revisions).toHaveLength(1);
    expect(page.next_cursor).toBeNull();

    // White-box cursor for the oldest returned row: its boundary is valid, and nothing
    // sorts after it, so the next page is an empty end-of-history page.
    const past = await listRevisions(client, {
      conversation_id: conversationId,
      limit: 1,
      cursor: btoa(
        `${revisionId(1)}\u001f${revisionId(1)}\u001f2026-03-01T00:00:00.000Z\u001f${revisionId(1)}`,
      ),
    });
    expect(past.revisions).toEqual([]);
    expect(past.next_cursor).toBeNull();
    expect(past.current_revision_id).toBe(revisionId(1));
  });

  it("treats a live catalog row with empty revision history as not found", async () => {
    const client = await ownerClient();
    const conversationId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.MEMORY_DB.prepare(
      `INSERT INTO conversations
       (id, source_type, title, imported_at, namespace, user_id, created_at, updated_at)
       VALUES (?, 'mcp', 'Empty history', ?, 'personal', ?, ?, ?)`,
    )
      .bind(conversationId, now, OWNER_DB_USER_ID, now, now)
      .run();

    const result = await call(client, "memory_list_revisions", {
      conversation_id: conversationId,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Conversation not found");
  });

  it("keeps a 100-revision page inside the MCP output guard", async () => {
    const revisionId = revisionIds();
    const client = await ownerClient();
    const conversationId = crypto.randomUUID();
    await seedConversation({
      conversationId,
      namespace: "personal",
      userId: OWNER_DB_USER_ID,
      revisions: Array.from({ length: 100 }, (_, index) => ({
        id: revisionId(1_000 + index),
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, index)).toISOString(),
        nodeCount: index + 1,
      })),
      currentRevisionId: revisionId(1_099),
    });

    const result = await call(client, "memory_list_revisions", {
      conversation_id: conversationId,
      limit: 100,
    });
    expect(result.isError).toBe(false);
    expect(result.bytes).toBeLessThan(64 * 1024);
    if (result.isError) throw new Error(result.text);
    const history = historyResult.parse(result.value);
    expect(history.revisions).toHaveLength(100);
    expect(history.next_cursor).toBeNull();
    expect(history.revisions.filter((revision) => revision.current)).toHaveLength(1);
  });

  it("hides foreign, deleted, missing, and unowned-namespace conversations identically", async () => {
    const revisionId = revisionIds();
    const owner = await ownerClient();
    const conversationId = z.object({ conversation_id: z.string() }).parse(
      await callValue(owner, "memory_store", {
        title: "Owner secret",
        namespace: "astara_alt_v2",
        messages: [{ role: "user", content: "owner-only content" }],
      }),
    ).conversation_id;

    const other = await getOrCreateUser(env, "second@example.com");
    await grantNamespace(env, other.id, "astara_alt_v2");
    const otherClient = await connectedClient(await resolveTenant(env, { userId: other.id }));

    const foreign = await call(otherClient, "memory_list_revisions", {
      conversation_id: conversationId,
    });
    const missing = await call(owner, "memory_list_revisions", {
      conversation_id: crypto.randomUUID(),
    });

    const unownedNamespaceId = crypto.randomUUID();
    await seedConversation({
      conversationId: unownedNamespaceId,
      namespace: "not_granted",
      userId: OWNER_DB_USER_ID,
      revisions: [{ id: revisionId(7), createdAt: "2026-04-01T00:00:00.000Z", nodeCount: 1 }],
      currentRevisionId: revisionId(7),
    });
    const unownedNamespace = await call(owner, "memory_list_revisions", {
      conversation_id: unownedNamespaceId,
    });

    expect(
      z.object({ deleted: z.array(z.string()) }).parse(
        await callValue(owner, "memory_delete_conversations", {
          conversation_ids: [conversationId],
        }),
      ).deleted,
    ).toEqual([conversationId]);
    const tombstoned = await call(owner, "memory_list_revisions", {
      conversation_id: conversationId,
    });

    for (const result of [foreign, missing, unownedNamespace, tombstoned]) {
      expect(result.isError).toBe(true);
    }
    const messages = new Set([foreign.text, missing.text, unownedNamespace.text, tombstoned.text]);
    expect(messages.size).toBe(1);
    expect([...messages][0]).not.toContain("revision");

    // The other account still resolves its own same-named namespace normally.
    const otherHistory = await listRevisions(otherClient, {
      conversation_id: z.object({ conversation_id: z.string() }).parse(
        await callValue(otherClient, "memory_store", {
          title: "Second account memory",
          namespace: "astara_alt_v2",
          messages: [{ role: "user", content: "second-user content" }],
        }),
      ).conversation_id,
    });
    expect(otherHistory.revisions).toHaveLength(1);
  });

  it("rejects malformed identifiers, limits, and cursors", async () => {
    const client = await ownerClient();
    const receipt = z.object({ conversation_id: z.string(), revision_id: z.string() }).parse(
      await callValue(client, "memory_store", {
        title: "Cursor validation",
        namespace: "personal",
        messages: [{ role: "user", content: "Turn" }],
      }),
    );
    await callValue(client, "memory_append", {
      conversation_id: receipt.conversation_id,
      base_revision_id: receipt.revision_id,
      messages: [{ role: "assistant", content: "Second turn" }],
    });

    const schemaCases: Array<Record<string, unknown>> = [
      {},
      { conversation_id: "not-a-memory-id" },
      { conversation_id: receipt.conversation_id, limit: 0 },
      { conversation_id: receipt.conversation_id, limit: 101 },
      { conversation_id: receipt.conversation_id, limit: 1.5 },
      { conversation_id: receipt.conversation_id, cursor: "" },
      { conversation_id: receipt.conversation_id, cursor: 5 },
    ];
    for (const args of schemaCases) {
      const result = await call(client, "memory_list_revisions", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }

    for (const cursor of ["not-base64!!", "Zm9v"]) {
      const result = await call(client, "memory_list_revisions", {
        conversation_id: receipt.conversation_id,
        cursor,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe("Invalid cursor");
    }

    const first = await listRevisions(client, {
      conversation_id: receipt.conversation_id,
      limit: 1,
    });
    expect(first.next_cursor).not.toBeNull();
    const cursorParts = atob(first.next_cursor!).split("\u001f");
    expect(cursorParts).toHaveLength(4);

    const fakeRevisionId = revisionIds()(99);
    const forgedAnchor = [...cursorParts];
    forgedAnchor[0] = fakeRevisionId;
    const forgedCurrent = [...cursorParts];
    forgedCurrent[1] = fakeRevisionId;
    for (const cursor of [forgedAnchor, forgedCurrent]) {
      const result = await call(client, "memory_list_revisions", {
        conversation_id: receipt.conversation_id,
        cursor: btoa(cursor.join("\u001f")),
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe("Invalid cursor");
    }

    const second = await listRevisions(client, {
      conversation_id: receipt.conversation_id,
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.revisions).toHaveLength(1);
    expect(second.current_revision_id).toBe(first.current_revision_id);
  });
});
