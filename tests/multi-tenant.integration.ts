import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMemoryMcpServer } from "../src/mcp";
import {
  getOrCreateUser,
  grantNamespace,
  listUserNamespaces,
  OWNER_DB_USER_ID,
  resolveTenant,
} from "../src/tenant";

async function connectedClient(tenant: Awaited<ReturnType<typeof resolveTenant>>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tenant-test", version: "1.0.0" });
  const server = createMemoryMcpServer(env, tenant);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("same namespace name across accounts stays isolated", () => {
  it("lets the owner and a second user each own namespace astara_alt_v2", async () => {
    await grantNamespace(env, OWNER_DB_USER_ID, "astara_alt_v2");
    const other = await getOrCreateUser(env, "second@example.com");
    await grantNamespace(env, other.id, "astara_alt_v2");
    expect(await listUserNamespaces(env, other.id)).toContain("astara_alt_v2");
  });

  it("keeps conversations separated by user even with the same namespace name", async () => {
    await grantNamespace(env, OWNER_DB_USER_ID, "astara_alt_v2");
    const owner = await resolveTenant(env, { userId: "owner" });
    const ownerClient = await connectedClient(owner);
    const ownerStore = await ownerClient.callTool({
      name: "memory_store",
      arguments: {
        title: "owner memory",
        namespace: "astara_alt_v2",
        messages: [{ role: "user", content: "owner-only content" }],
      },
    });
    expect(ownerStore.isError).toBeFalsy();

    const other = await getOrCreateUser(env, "second@example.com");
    await grantNamespace(env, other.id, "astara_alt_v2");
    const otherTenant = await resolveTenant(env, { userId: other.id });
    const otherClient = await connectedClient(otherTenant);
    const otherStore = await otherClient.callTool({
      name: "memory_store",
      arguments: {
        title: "second-user memory",
        namespace: "astara_alt_v2",
        messages: [{ role: "user", content: "second-user content" }],
      },
    });
    expect(otherStore.isError).toBeFalsy();

    const ownerList = await ownerClient.callTool({
      name: "memory_list_conversations",
      arguments: { namespace: "astara_alt_v2" },
    });
    const ownerTitles = JSON.parse((ownerList.content?.[0] as { text: string })?.text ?? "{}") as {
      conversations: Array<{ title: string }>;
    };
    expect(ownerTitles.conversations.map((c) => c.title)).toEqual(["owner memory"]);

    const otherList = await otherClient.callTool({
      name: "memory_list_conversations",
      arguments: { namespace: "astara_alt_v2" },
    });
    const otherTitles = JSON.parse((otherList.content?.[0] as { text: string })?.text ?? "{}") as {
      conversations: Array<{ title: string }>;
    };
    expect(otherTitles.conversations.map((c) => c.title)).toEqual(["second-user memory"]);

    const ownerNamespaces = await ownerClient.callTool({
      name: "memory_list_namespaces",
      arguments: {},
    });
    const ownerNs = JSON.parse(
      (ownerNamespaces.content?.[0] as { text: string })?.text ?? "{}",
    ) as { namespaces: Array<{ namespace: string; conversations: number; default: boolean }> };
    expect(ownerNs.namespaces).toContainEqual({
      namespace: "astara_alt_v2",
      conversations: 1,
      default: false,
    });

    const ownerStats = await ownerClient.callTool({
      name: "memory_stats",
      arguments: {},
    });
    const stats = JSON.parse((ownerStats.content?.[0] as { text: string })?.text ?? "{}") as {
      totals: { conversations: number; messages: number };
    };
    expect(stats.totals).toEqual({ conversations: 1, messages: 1 });
  });

  it("cannot delete the other user's conversation", async () => {
    const other = await getOrCreateUser(env, "second@example.com");
    await grantNamespace(env, other.id, "astara_alt_v2");
    const otherTenant = await resolveTenant(env, { userId: other.id });
    const otherClient = await connectedClient(otherTenant);
    const stored = await otherClient.callTool({
      name: "memory_store",
      arguments: {
        title: "second-user memory",
        namespace: "astara_alt_v2",
        messages: [{ role: "user", content: "second-user content" }],
      },
    });
    const storedText = (stored.content?.[0] as { text: string })?.text ?? "";
    const conversationId = (JSON.parse(storedText) as { conversation_id: string }).conversation_id;

    const owner = await resolveTenant(env, { userId: "owner" });
    const ownerClient = await connectedClient(owner);
    const deleted = await ownerClient.callTool({
      name: "memory_delete_conversations",
      arguments: { conversation_ids: [conversationId] },
    });
    const deletedText = JSON.parse((deleted.content?.[0] as { text: string })?.text ?? "{}") as {
      requested: number;
      missing: string[];
      deleted: string[];
    };
    expect(deletedText).toMatchObject({ requested: 1, missing: [conversationId], deleted: [] });
  });
});
