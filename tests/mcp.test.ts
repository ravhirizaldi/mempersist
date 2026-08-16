import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/domain";
import { createMemoryMcpServer } from "../src/mcp";

describe("MCP server", () => {
  const connections: Array<{ client: Client; server: ReturnType<typeof createMemoryMcpServer> }> =
    [];

  afterEach(async () => {
    for (const connection of connections.splice(0)) {
      await connection.client.close();
      await connection.server.close();
    }
  });

  async function connectedClient(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mempersist-test", version: "1.0.0" });
    const server = createMemoryMcpServer({} as AppEnv);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, server });
    return client;
  }

  it("discovers the compact V1 tool surface", async () => {
    const client = await connectedClient();
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "memory_append",
      "memory_delete_all",
      "memory_delete_conversations",
      "memory_delete_namespace",
      "memory_get_context",
      "memory_get_conversation",
      "memory_import_status",
      "memory_list_conversations",
      "memory_search",
      "memory_store",
    ]);
  });

  it("rejects malformed tool arguments before business logic", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "", limit: 999 },
    });
    expect(result.isError).toBe(true);
  });

  it("requires exact destructive confirmations", async () => {
    const client = await connectedClient();
    const namespace = await client.callTool({
      name: "memory_delete_namespace",
      arguments: { namespace: "astara_alt", confirm_namespace: "astara-alt" },
    });
    const emptyNamespace = await client.callTool({
      name: "memory_delete_namespace",
      arguments: { namespace: "   ", confirm_namespace: "   " },
    });
    const all = await client.callTool({
      name: "memory_delete_all",
      arguments: { confirm: "delete all" },
    });

    expect(namespace.isError).toBe(true);
    expect(emptyNamespace.isError).toBe(true);
    expect(all.isError).toBe(true);
  });

  it("validates deletion IDs and the maximum batch size", async () => {
    const client = await connectedClient();
    const tooMany = await client.callTool({
      name: "memory_delete_conversations",
      arguments: { conversation_ids: Array.from({ length: 101 }, () => crypto.randomUUID()) },
    });
    const duplicate = crypto.randomUUID();
    const duplicates = await client.callTool({
      name: "memory_delete_conversations",
      arguments: { conversation_ids: [duplicate, duplicate] },
    });
    const malformed = await client.callTool({
      name: "memory_delete_conversations",
      arguments: { conversation_ids: ["not-a-memory-id"] },
    });

    expect(tooMany.isError).toBe(true);
    expect(duplicates.isError).toBe(true);
    expect(malformed.isError).toBe(true);
  });

  it("validates tag inputs on store, append, and search", async () => {
    const client = await connectedClient();
    const tooMany = await client.callTool({
      name: "memory_store",
      arguments: {
        title: "Arc",
        tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
        messages: [{ role: "user", content: "x" }],
      },
    });
    const empty = await client.callTool({
      name: "memory_store",
      arguments: { title: "Arc", tags: [""], messages: [{ role: "user", content: "x" }] },
    });
    const blank = await client.callTool({
      name: "memory_store",
      arguments: { title: "Arc", tags: ["   "], messages: [{ role: "user", content: "x" }] },
    });
    const nonString = await client.callTool({
      name: "memory_store",
      arguments: { title: "Arc", tags: [42], messages: [{ role: "user", content: "x" }] },
    });
    const longTag = await client.callTool({
      name: "memory_append",
      arguments: {
        conversation_id: crypto.randomUUID(),
        base_revision_id: "a".repeat(64),
        tags: ["x".repeat(65)],
        messages: [{ role: "user", content: "x" }],
      },
    });
    const searchTooMany = await client.callTool({
      name: "memory_search",
      arguments: { query: "arc", tags: Array.from({ length: 21 }, (_, index) => `t${index}`) },
    });

    expect(tooMany.isError).toBe(true);
    expect(empty.isError).toBe(true);
    expect(blank.isError).toBe(true);
    expect(nonString.isError).toBe(true);
    expect(longTag.isError).toBe(true);
    expect(searchTooMany.isError).toBe(true);
  });
});
