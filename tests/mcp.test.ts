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
    const server = createMemoryMcpServer({} as AppEnv, {
      userId: "owner",
      defaultNamespace: "personal",
      namespaces: ["personal"],
    });
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
      "memory_delete_conversations",
      "memory_empty_namespace",
      "memory_get_context",
      "memory_get_conversation",
      "memory_get_conversations",
      "memory_import_status",
      "memory_list_conversations",
      "memory_list_namespaces",
      "memory_list_revisions",
      "memory_replace",
      "memory_resolve_conversations",
      "memory_restore_revision",
      "memory_search",
      "memory_stats",
      "memory_store",
      "memory_update_tags",
    ]);
    const readOnlyAnnotations = {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    };
    for (const name of [
      "memory_search",
      "memory_get_context",
      "memory_get_conversation",
      "memory_get_conversations",
      "memory_list_conversations",
      "memory_list_namespaces",
      "memory_list_revisions",
      "memory_resolve_conversations",
      "memory_stats",
      "memory_import_status",
    ]) {
      expect(result.tools.find((tool) => tool.name === name)?.annotations).toEqual(
        readOnlyAnnotations,
      );
    }
    expect(result.tools.find((tool) => tool.name === "memory_replace")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    });
    expect(
      result.tools.find((tool) => tool.name === "memory_restore_revision")?.annotations,
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    });
    expect(result.tools.find((tool) => tool.name === "memory_update_tags")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    });
    expect(result.tools.find((tool) => tool.name === "memory_store")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    });
    expect(result.tools.find((tool) => tool.name === "memory_append")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    });
    expect(
      result.tools.find((tool) => tool.name === "memory_delete_conversations")?.annotations,
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    });
    expect(
      result.tools.find((tool) => tool.name === "memory_empty_namespace")?.annotations,
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    });
    for (const tool of result.tools) {
      expect(tool.outputSchema, tool.name).toMatchObject({ type: "object" });
    }
  });

  it("rejects malformed tool arguments before business logic", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "", limit: 999 },
    });
    expect(result.isError).toBe(true);
  });

  it("validates batch bounds, pagination, read formats, and verification flags", async () => {
    const client = await connectedClient();
    for (const requests of [
      [],
      Array.from({ length: 21 }, () => ({ conversation_id: crypto.randomUUID() })),
      [{ conversation_id: "invalid" }],
      [{ conversation_id: crypto.randomUUID(), offset: -1 }],
      [{ conversation_id: crypto.randomUUID(), limit: 101 }],
      [{ conversation_id: crypto.randomUUID(), branch: "unknown" }],
      [{ conversation_id: crypto.randomUUID(), revision_id: "invalid" }],
    ]) {
      expect(
        (await client.callTool({ name: "memory_get_conversations", arguments: { requests } }))
          .isError,
      ).toBe(true);
    }
    expect(
      (
        await client.callTool({
          name: "memory_get_conversation",
          arguments: { conversation_id: "id", format: "summary" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "memory_store",
          arguments: {
            title: "Test",
            messages: [{ role: "user", content: "test" }],
            verify: "true",
          },
        })
      ).isError,
    ).toBe(true);
  });

  it("requires exact destructive confirmations", async () => {
    const client = await connectedClient();
    const namespace = await client.callTool({
      name: "memory_empty_namespace",
      arguments: { namespace: "astara_alt", confirm_namespace: "astara-alt" },
    });
    const emptyNamespace = await client.callTool({
      name: "memory_empty_namespace",
      arguments: { namespace: "   ", confirm_namespace: "   " },
    });

    expect(namespace.isError).toBe(true);
    expect(emptyNamespace.isError).toBe(true);
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

  it("validates revision history inputs", async () => {
    const client = await connectedClient();
    const cases: Array<Record<string, unknown>> = [
      {},
      { conversation_id: "not-a-memory-id" },
      { conversation_id: crypto.randomUUID(), limit: 0 },
      { conversation_id: crypto.randomUUID(), limit: 101 },
      { conversation_id: crypto.randomUUID(), limit: "20" },
      { conversation_id: crypto.randomUUID(), cursor: "" },
      { conversation_id: crypto.randomUUID(), cursor: null },
    ];
    for (const args of cases) {
      const result = await client.callTool({ name: "memory_list_revisions", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
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

  it("validates complete replacement inputs", async () => {
    const client = await connectedClient();
    const emptyMessages = await client.callTool({
      name: "memory_replace",
      arguments: {
        conversation_id: crypto.randomUUID(),
        base_revision_id: "a".repeat(64),
        messages: [],
      },
    });
    const malformedConversation = await client.callTool({
      name: "memory_replace",
      arguments: {
        conversation_id: "not-a-memory-id",
        base_revision_id: "a".repeat(64),
        messages: [{ role: "user", content: "x" }],
      },
    });

    expect(emptyMessages.isError).toBe(true);
    expect(malformedConversation.isError).toBe(true);
  });

  it("requires an add or remove tag list on memory_update_tags", async () => {
    const client = await connectedClient();
    const empty = await client.callTool({
      name: "memory_update_tags",
      arguments: { conversation_id: crypto.randomUUID(), base_revision_id: "a".repeat(64) },
    });
    const invalid = await client.callTool({
      name: "memory_update_tags",
      arguments: {
        conversation_id: crypto.randomUUID(),
        base_revision_id: "a".repeat(64),
        add: [""],
      },
    });
    expect(empty.isError).toBe(true);
    expect(invalid.isError).toBe(true);
  });

  it("validates conversation resolve request inputs", async () => {
    const client = await connectedClient();
    const emptyRequests = await client.callTool({
      name: "memory_resolve_conversations",
      arguments: { requests: [] },
    });
    const emptyTitle = await client.callTool({
      name: "memory_resolve_conversations",
      arguments: { requests: [{ title: "" }] },
    });
    const whitespaceTitle = await client.callTool({
      name: "memory_resolve_conversations",
      arguments: { requests: [{ title: "   " }] },
    });
    const tooManyRequests = await client.callTool({
      name: "memory_resolve_conversations",
      arguments: {
        requests: Array.from({ length: 21 }, (_, index) => ({ title: `Title ${index}` })),
      },
    });
    expect(emptyRequests.isError).toBe(true);
    expect(emptyTitle.isError).toBe(true);
    expect(whitespaceTitle.isError).toBe(true);
    expect(tooManyRequests.isError).toBe(true);
  });

  it("validates revision restore request inputs", async () => {
    const client = await connectedClient();
    const cases: Array<Record<string, unknown>> = [
      {},
      {
        conversation_id: "not-a-memory-id",
        revision_id: "a".repeat(64),
        base_revision_id: "b".repeat(64),
      },
      { conversation_id: crypto.randomUUID() },
      { conversation_id: crypto.randomUUID(), revision_id: "" },
      {
        conversation_id: crypto.randomUUID(),
        revision_id: "invalid",
        base_revision_id: "b".repeat(64),
      },
      {
        conversation_id: crypto.randomUUID(),
        revision_id: "A".repeat(64),
        base_revision_id: "b".repeat(64),
      },
      { conversation_id: crypto.randomUUID(), revision_id: "a".repeat(64) },
      { conversation_id: crypto.randomUUID(), revision_id: "a".repeat(64), base_revision_id: "" },
      {
        conversation_id: crypto.randomUUID(),
        revision_id: "a".repeat(64),
        base_revision_id: "invalid",
      },
      {
        conversation_id: crypto.randomUUID(),
        revision_id: "a".repeat(64),
        base_revision_id: "B".repeat(64),
      },
      {
        conversation_id: crypto.randomUUID(),
        revision_id: "a".repeat(64),
        base_revision_id: "b".repeat(64),
        verify: "not-a-boolean",
      },
    ];
    for (const args of cases) {
      const result = await client.callTool({ name: "memory_restore_revision", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
  });
});
