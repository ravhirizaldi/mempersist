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
});
