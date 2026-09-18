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

const resolveMatchSchema = z.object({
  conversation_id: z.string(),
  revision_id: z.string(),
  title: z.string(),
  namespace: z.string(),
  tags: z.array(z.string()),
  updated_at: z.string().nullable(),
});

const resolveResultItemSchema = z.object({
  request_index: z.number().int().min(0),
  status: z.enum(["ok", "not_found", "ambiguous"]),
  matches: z.array(resolveMatchSchema),
  has_more: z.boolean().default(false),
});

const resolveOutputSchema = z.object({
  results: z.array(resolveResultItemSchema),
});

type ResolveOutput = z.infer<typeof resolveOutputSchema>;

type CallResult =
  | { isError: true; text: string; bytes: number }
  | { isError: false; text: string; bytes: number; value: unknown };

const connections: Array<{ client: Client; server: McpServer }> = [];

afterEach(async () => {
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
});

async function connectedClient(tenant: Tenant) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "resolve-test-client", version: "1.0.0" });
  const server = createMemoryMcpServer(env, tenant);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

async function ownerClient() {
  await grantNamespace(env, OWNER_DB_USER_ID, "astara_alt_v2");
  await grantNamespace(env, OWNER_DB_USER_ID, "astara_alt_v3");
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

async function resolveConversationsTool(
  client: Client,
  requests: Array<{
    title: string;
    namespace?: string;
    tags?: string[];
    tag_mode?: "any" | "all";
  }>,
): Promise<ResolveOutput> {
  const value = await callValue(client, "memory_resolve_conversations", { requests });
  return resolveOutputSchema.parse(value);
}

async function seedConversation(options: {
  id?: string;
  title: string;
  namespace: string;
  userId: string;
  revisionId?: string;
  tags?: string[];
  updatedAt?: string | null;
  deletedAt?: string | null;
}) {
  const conversationId = options.id ?? crypto.randomUUID();
  const revisionId =
    options.revisionId ??
    crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const createdAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.MEMORY_DB.prepare(
      `INSERT INTO conversations
       (id, source_type, title, imported_at, namespace, user_id, current_revision_id,
        created_at, updated_at, deleted_at)
       VALUES (?, 'mcp', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      conversationId,
      options.title,
      createdAt,
      options.namespace,
      options.userId,
      revisionId,
      createdAt,
      options.updatedAt ?? createdAt,
      options.deletedAt ?? null,
    ),
    env.MEMORY_DB.prepare(
      `INSERT INTO conversation_revisions
       (id, conversation_id, content_hash, manifest_object_key, node_count, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).bind(
      revisionId,
      conversationId,
      revisionId,
      `canonical/seeded/${revisionId}.json`,
      createdAt,
    ),
    ...(options.tags ?? []).map((tag) =>
      env.MEMORY_DB.prepare(
        "INSERT INTO conversation_tags (conversation_id, tag) VALUES (?, ?)",
      ).bind(conversationId, tag),
    ),
  ];
  await env.MEMORY_DB.batch(statements);
  return { conversationId, revisionId };
}

describe("memory_resolve_conversations integration", () => {
  it("resolves an exact title in an explicit namespace", async () => {
    const client = await ownerClient();
    const seeded = await seedConversation({
      title: "CURRENT",
      namespace: "astara_alt_v2",
      userId: OWNER_DB_USER_ID,
      tags: ["state", "rp"],
    });

    const result = await resolveConversationsTool(client, [
      {
        title: "CURRENT",
        namespace: "astara_alt_v2",
      },
    ]);

    expect(result.results).toHaveLength(1);
    const item = result.results[0]!;
    expect(item.request_index).toBe(0);
    expect(item.status).toBe("ok");
    expect(item.has_more).toBe(false);
    expect(item.matches).toHaveLength(1);
    expect(item.matches[0]).toMatchObject({
      conversation_id: seeded.conversationId,
      revision_id: seeded.revisionId,
      title: "CURRENT",
      namespace: "astara_alt_v2",
    });
    expect(item.matches[0]!.tags.sort()).toEqual(["rp", "state"]);
  });

  it("treats title matching as strictly case-sensitive", async () => {
    const client = await ownerClient();
    await seedConversation({
      title: "CURRENT_SCENE",
      namespace: "astara_alt_v2",
      userId: OWNER_DB_USER_ID,
    });

    const result = await resolveConversationsTool(client, [
      { title: "current_scene", namespace: "astara_alt_v2" },
      { title: "Current_Scene", namespace: "astara_alt_v2" },
      { title: "CURRENT_SCENE", namespace: "astara_alt_v2" },
    ]);

    expect(result.results[0]!.status).toBe("not_found");
    expect(result.results[0]!.matches).toHaveLength(0);

    expect(result.results[1]!.status).toBe("not_found");
    expect(result.results[1]!.matches).toHaveLength(0);

    expect(result.results[2]!.status).toBe("ok");
    expect(result.results[2]!.matches[0]!.title).toBe("CURRENT_SCENE");
  });

  it("matches Unicode titles with exact binary equality", async () => {
    const client = await ownerClient();
    const unicodeTitle = "シーン_CURRENT · Adriana’s Resignation № 42 ✨";
    const seeded = await seedConversation({
      title: unicodeTitle,
      namespace: "astara_alt_v2",
      userId: OWNER_DB_USER_ID,
    });

    const result = await resolveConversationsTool(client, [
      { title: unicodeTitle, namespace: "astara_alt_v2" },
    ]);

    expect(result.results[0]!.status).toBe("ok");
    expect(result.results[0]!.matches[0]!.conversation_id).toBe(seeded.conversationId);
  });

  it("returns ambiguous status when multiple live conversations share the same title", async () => {
    const client = await ownerClient();
    const c1 = await seedConversation({
      title: "DUPLICATE_OWNER",
      namespace: "astara_alt_v2",
      userId: OWNER_DB_USER_ID,
    });
    const c2 = await seedConversation({
      title: "DUPLICATE_OWNER",
      namespace: "astara_alt_v2",
      userId: OWNER_DB_USER_ID,
    });

    const result = await resolveConversationsTool(client, [
      { title: "DUPLICATE_OWNER", namespace: "astara_alt_v2" },
    ]);

    expect(result.results[0]!.status).toBe("ambiguous");
    expect(result.results[0]!.has_more).toBe(false);
    expect(result.results[0]!.matches).toHaveLength(2);
    const ids = result.results[0]!.matches.map((m) => m.conversation_id).sort();
    expect(ids).toEqual([c1.conversationId, c2.conversationId].sort());
  });

  it("filters matches by tags with any and all tag modes", async () => {
    const client = await ownerClient();
    const uniqueTitle = `TAG_TEST_${crypto.randomUUID()}`;
    const c1 = await seedConversation({
      title: uniqueTitle,
      namespace: "astara_alt_v2",
      userId: OWNER_DB_USER_ID,
      tags: ["state", "rp"],
    });
    const c2 = await seedConversation({
      title: uniqueTitle,
      namespace: "astara_alt_v2",
      userId: OWNER_DB_USER_ID,
      tags: ["state", "archive"],
    });

    // tag_mode: "all" with ["state", "rp"] should match only c1
    const resAll = await resolveConversationsTool(client, [
      {
        title: uniqueTitle,
        namespace: "astara_alt_v2",
        tags: ["state", "rp"],
        tag_mode: "all",
      },
    ]);
    expect(resAll.results[0]!.status).toBe("ok");
    expect(resAll.results[0]!.matches[0]!.conversation_id).toBe(c1.conversationId);

    // tag_mode: "any" with ["rp", "archive"] matches both -> ambiguous
    const resAny = await resolveConversationsTool(client, [
      {
        title: uniqueTitle,
        namespace: "astara_alt_v2",
        tags: ["rp", "archive"],
        tag_mode: "any",
      },
    ]);
    expect(resAny.results[0]!.status).toBe("ambiguous");
    expect(resAny.results[0]!.matches).toHaveLength(2);
    expect(resAny.results[0]!.matches.map((m) => m.conversation_id).sort()).toEqual(
      [c1.conversationId, c2.conversationId].sort(),
    );

    // non-existent tag -> not_found
    const resNone = await resolveConversationsTool(client, [
      {
        title: uniqueTitle,
        namespace: "astara_alt_v2",
        tags: ["missing_tag"],
      },
    ]);
    expect(resNone.results[0]!.status).toBe("not_found");
    expect(resNone.results[0]!.matches).toHaveLength(0);
  });

  it("scopes across all owned namespaces when namespace is omitted", async () => {
    const client = await ownerClient();
    const crossTitle = `CROSS_NS_${crypto.randomUUID()}`;
    const inV3 = await seedConversation({
      title: crossTitle,
      namespace: "astara_alt_v3",
      userId: OWNER_DB_USER_ID,
    });

    const result = await resolveConversationsTool(client, [{ title: crossTitle }]);

    expect(result.results[0]!.status).toBe("ok");
    expect(result.results[0]!.matches[0]!.conversation_id).toBe(inV3.conversationId);
    expect(result.results[0]!.matches[0]!.namespace).toBe("astara_alt_v3");
  });

  it("handles duplicate requests in input order with independent results", async () => {
    const client = await ownerClient();
    const title = `DUP_REQ_${crypto.randomUUID()}`;
    const seeded = await seedConversation({
      title,
      namespace: "astara_alt_v2",
      userId: OWNER_DB_USER_ID,
    });

    const result = await resolveConversationsTool(client, [
      { title, namespace: "astara_alt_v2" },
      { title: "NONEXISTENT", namespace: "astara_alt_v2" },
      { title, namespace: "astara_alt_v2" },
    ]);

    expect(result.results).toHaveLength(3);
    expect(result.results[0]!.request_index).toBe(0);
    expect(result.results[0]!.status).toBe("ok");
    expect(result.results[0]!.matches[0]!.conversation_id).toBe(seeded.conversationId);

    expect(result.results[1]!.request_index).toBe(1);
    expect(result.results[1]!.status).toBe("not_found");

    expect(result.results[2]!.request_index).toBe(2);
    expect(result.results[2]!.status).toBe("ok");
    expect(result.results[2]!.matches[0]!.conversation_id).toBe(seeded.conversationId);
  });

  it("excludes tombstoned conversations", async () => {
    const client = await ownerClient();
    const tombstoneTitle = `TOMBSTONE_${crypto.randomUUID()}`;
    await seedConversation({
      title: tombstoneTitle,
      namespace: "astara_alt_v2",
      userId: OWNER_DB_USER_ID,
      deletedAt: new Date().toISOString(),
    });

    const result = await resolveConversationsTool(client, [
      { title: tombstoneTitle, namespace: "astara_alt_v2" },
    ]);

    expect(result.results[0]!.status).toBe("not_found");
    expect(result.results[0]!.matches).toHaveLength(0);
  });

  it("enforces cross-tenant and unowned namespace isolation", async () => {
    const foreignUser = await getOrCreateUser(env, "foreign-tenant@example.com");
    await grantNamespace(env, foreignUser.id, "shared-label");
    await grantNamespace(env, OWNER_DB_USER_ID, "shared-label");

    const ownerClientInst = await connectedClient(await resolveTenant(env, { userId: "owner" }));
    const foreignClient = await connectedClient(
      await resolveTenant(env, { userId: foreignUser.id }),
    );

    const secretTitle = `SHARED_TITLE_${crypto.randomUUID()}`;
    const foreignSeeded = await seedConversation({
      title: secretTitle,
      namespace: "shared-label",
      userId: foreignUser.id,
    });
    const ownerSeeded = await seedConversation({
      title: secretTitle,
      namespace: "shared-label",
      userId: OWNER_DB_USER_ID,
    });

    // Owner resolves secretTitle -> sees ONLY owner's conversation
    const ownerRes = await resolveConversationsTool(ownerClientInst, [
      { title: secretTitle, namespace: "shared-label" },
    ]);
    expect(ownerRes.results[0]!.status).toBe("ok");
    expect(ownerRes.results[0]!.matches[0]!.conversation_id).toBe(ownerSeeded.conversationId);

    // Foreign resolves secretTitle -> sees ONLY foreign user's conversation
    const foreignRes = await resolveConversationsTool(foreignClient, [
      { title: secretTitle, namespace: "shared-label" },
    ]);
    expect(foreignRes.results[0]!.status).toBe("ok");
    expect(foreignRes.results[0]!.matches[0]!.conversation_id).toBe(foreignSeeded.conversationId);

    // Requesting a foreign-only namespace throws authentication/not-accessible error
    await grantNamespace(env, foreignUser.id, "foreign-exclusive-ns");
    const unownedRes = await call(ownerClientInst, "memory_resolve_conversations", {
      requests: [{ title: secretTitle, namespace: "foreign-exclusive-ns" }],
    });
    expect(unownedRes.isError).toBe(true);
  });

  it("resolves a full batch of 20 requests in input order", async () => {
    const client = await ownerClient();
    const batchPrefix = `BATCH_${crypto.randomUUID()}`;
    const seededIds: string[] = [];

    for (let i = 0; i < 20; i++) {
      const title = `${batchPrefix}_${i}`;
      const seeded = await seedConversation({
        title,
        namespace: "astara_alt_v2",
        userId: OWNER_DB_USER_ID,
      });
      seededIds.push(seeded.conversationId);
    }

    const requests = seededIds.map((_, i) => ({
      title: `${batchPrefix}_${i}`,
      namespace: "astara_alt_v2",
    }));

    const result = await resolveConversationsTool(client, requests);
    expect(result.results).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(result.results[i]!.request_index).toBe(i);
      expect(result.results[i]!.status).toBe("ok");
      expect(result.results[i]!.matches[0]!.conversation_id).toBe(seededIds[i]);
    }
  });

  it("bounds ambiguous matches to 50 and indicates has_more", async () => {
    const client = await ownerClient();
    const floodTitle = `FLOOD_${crypto.randomUUID()}`;
    const statements: D1PreparedStatement[] = [];
    const createdAt = new Date().toISOString();

    for (let i = 0; i < 52; i++) {
      const convId = crypto.randomUUID();
      const revId =
        crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      statements.push(
        env.MEMORY_DB.prepare(
          `INSERT INTO conversations
           (id, source_type, title, imported_at, namespace, user_id, current_revision_id, created_at, updated_at)
           VALUES (?, 'mcp', ?, ?, 'astara_alt_v2', ?, ?, ?, ?)`,
        ).bind(convId, floodTitle, createdAt, OWNER_DB_USER_ID, revId, createdAt, createdAt),
        env.MEMORY_DB.prepare(
          `INSERT INTO conversation_revisions
           (id, conversation_id, content_hash, manifest_object_key, node_count, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`,
        ).bind(revId, convId, revId, `canonical/flood/${revId}.json`, createdAt),
      );
    }
    // D1 batch limit in sqlite is high, but chunking batch statements is safe
    for (let j = 0; j < statements.length; j += 40) {
      await env.MEMORY_DB.batch(statements.slice(j, j + 40));
    }

    const result = await resolveConversationsTool(client, [
      { title: floodTitle, namespace: "astara_alt_v2" },
    ]);

    expect(result.results[0]!.status).toBe("ambiguous");
    expect(result.results[0]!.matches).toHaveLength(50);
    expect(result.results[0]!.has_more).toBe(true);
  });
});
