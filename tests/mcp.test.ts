import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/domain";
import {
  buildContextCompleteOutputSchema,
  buildContextInputSchema,
  buildContextOutputSchema,
  buildContextRequiredBudgetExceededOutputSchema,
  createMemoryMcpServer,
} from "../src/mcp";

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
      "memory_build_context",
      "memory_copy_conversations",
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
      "memory_build_context",
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
      result.tools.find((tool) => tool.name === "memory_copy_conversations")?.annotations,
    ).toEqual({
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
  it("exposes cursor batch budgets and enforces exactly one first-call input", async () => {
    const client = await connectedClient();
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "memory_get_conversations");
    expect(tool).toBeDefined();
    const inputSchema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(inputSchema.properties?.requests).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 20,
    });
    expect(inputSchema.properties?.cursor).toMatchObject({ type: "string" });
    expect(inputSchema.properties?.max_serialized_bytes).toMatchObject({
      type: "integer",
      minimum: 4096,
      maximum: 49152,
    });
    expect(tool!.description).toMatch(/minimum|4096|4\s*KiB/iu);
    const outputSchema = tool!.outputSchema as {
      properties?: Record<string, unknown>;
    };
    for (const property of [
      "batchId",
      "completed",
      "remaining",
      "nextCursor",
      "usedSerializedBytes",
      "maxSerializedBytes",
    ])
      expect(outputSchema.properties).toHaveProperty(property);
    expect(tool!.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    });

    const request = { conversation_id: crypto.randomUUID() };
    for (const arguments_ of [
      {},
      { requests: [request], cursor: "opaque-cursor" },
      { requests: [request], max_serialized_bytes: 4095 },
      { requests: [request], max_serialized_bytes: 49153 },
    ]) {
      expect(
        (await client.callTool({ name: "memory_get_conversations", arguments: arguments_ }))
          .isError,
      ).toBe(true);
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

  it("validates conversation copy request inputs", async () => {
    const client = await connectedClient();
    const validBase = {
      target_namespace: "target-ns",
      idempotency_key: "idem-1",
      requests: [{ conversation_id: crypto.randomUUID() }],
    };
    const cases: Array<Record<string, unknown>> = [
      {
        ...validBase,
        requests: [],
      },
      {
        ...validBase,
        requests: Array.from({ length: 21 }, () => ({
          conversation_id: crypto.randomUUID(),
        })),
      },
      {
        target_namespace: "target-ns",
        requests: [{ conversation_id: crypto.randomUUID() }],
      },
      {
        ...validBase,
        idempotency_key: "",
      },
      {
        ...validBase,
        idempotency_key: "   ",
      },
      {
        ...validBase,
        target_namespace: "",
      },
      {
        ...validBase,
        target_namespace: "   ",
      },
      {
        ...validBase,
        requests: [
          {
            conversation_id: crypto.randomUUID(),
            revision_id: "invalid",
          },
        ],
      },
      {
        ...validBase,
        requests: [
          {
            conversation_id: crypto.randomUUID(),
            tags: { mode: "merge", add: [], remove: [] },
          },
        ],
      },
      {
        ...validBase,
        verify: "true",
      },
    ];
    for (const args of cases) {
      const result = await client.callTool({ name: "memory_copy_conversations", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
  });
  it("validates context build request inputs and bounds", async () => {
    const client = await connectedClient();
    const validBase = {
      task: "Build context",
      required: [{ selector: { title: "CURRENT" } }],
      budget: { max_estimated_tokens: 1000, max_serialized_bytes: 40000 },
    };

    const cases: Array<Record<string, unknown>> = [
      {},
      { task: "T" },
      { required: [{ selector: { title: "T" } }] },
      { budget: { max_estimated_tokens: 100, max_serialized_bytes: 1000 } },
      { ...validBase, task: "" },
      { ...validBase, task: "   " },
      { ...validBase, task: "x".repeat(1001) },
      { ...validBase, required: [] },
      {
        ...validBase,
        required: Array.from({ length: 21 }, () => ({ selector: { title: "T" } })),
      },
      { ...validBase, required: [{ selector: {} }] },
      {
        ...validBase,
        required: [
          {
            selector: {
              conversation_id: crypto.randomUUID(),
              title: "CURRENT",
            },
          },
        ],
      },
      { ...validBase, required: [{ selector: { conversation_id: "not-a-uuid" } }] },
      { ...validBase, required: [{ selector: { title: "" } }] },
      { ...validBase, required: [{ selector: { title: "   " } }] },
      { ...validBase, required: [{ selector: { title: "T" }, mode: "invalid" }] },
      { ...validBase, required: [{ selector: { title: "T" }, branch: "invalid" }] },
      { ...validBase, required: [{ selector: { title: "T" }, tail_messages: 0 }] },
      { ...validBase, required: [{ selector: { title: "T" }, tail_messages: 101 }] },
      {
        ...validBase,
        budget: { max_estimated_tokens: 0, max_serialized_bytes: 1000 },
      },
      {
        ...validBase,
        budget: { max_estimated_tokens: -1, max_serialized_bytes: 1000 },
      },
      {
        ...validBase,
        budget: { max_estimated_tokens: 1000, max_serialized_bytes: 0 },
      },
      {
        ...validBase,
        budget: { max_estimated_tokens: 1000, max_serialized_bytes: -1 },
      },
      {
        ...validBase,
        budget: { max_estimated_tokens: 1000, max_serialized_bytes: 49153 },
      },
      {
        ...validBase,
        retrieve: Array.from({ length: 9 }, () => ({ query: "Q" })),
      },
      { ...validBase, retrieve: [{ query: "" }] },
      { ...validBase, retrieve: [{ query: "   " }] },
      { ...validBase, retrieve: [{ query: "Q", limit: 0 }] },
      { ...validBase, retrieve: [{ query: "Q", limit: 21 }] },
      { ...validBase, retrieve: [{ query: "Q", context_before: -1 }] },
      { ...validBase, retrieve: [{ query: "Q", context_before: 11 }] },
      { ...validBase, retrieve: [{ query: "Q", context_after: -1 }] },
      { ...validBase, retrieve: [{ query: "Q", context_after: 11 }] },
      { ...validBase, required: [{ selector: { title: "T" }, follow: [{ field: "" }] }] },
      { ...validBase, required: [{ selector: { title: "T" }, follow: [{ field: "   " }] }] },
      {
        ...validBase,
        required: [{ selector: { title: "T" }, follow: [{ field: "f", tail_messages: 0 }] }],
      },
      {
        ...validBase,
        required: [{ selector: { title: "T" }, follow: [{ field: "f", tail_messages: 101 }] }],
      },
      {
        ...validBase,
        required: [{ selector: { title: "T" }, follow: [{ field: "f", mode: "invalid" }] }],
      },
      {
        ...validBase,
        required: [{ selector: { title: "T" }, follow: [{ field: "f", branch: "invalid" }] }],
      },
    ];

    for (const args of cases) {
      const result = await client.callTool({ name: "memory_build_context", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
  });

  it("accepts the issue sample shape for memory_build_context", () => {
    const sampleInput = {
      namespace: "astara_alt_v2",
      task: "Continue the current scene after xxx reviews her resignation letter",
      required: [
        {
          selector: {
            title: "CURRENT",
          },
          mode: "full",
          branch: "active",
          priority: 100,
        },
        {
          selector: {
            title: "CURRENT_SCENE",
          },
          mode: "full",
          branch: "active",
          priority: 100,
        },
        {
          selector: {
            title: "EVENTS_INDEX",
          },
          mode: "full",
          branch: "active",
          priority: 90,
        },
      ],
      retrieve: [
        {
          query: "xxx agency resignation letter Mia professional responsibility",
          tags: ["rp"],
          tag_mode: "all",
          limit: 8,
          context_before: 2,
          context_after: 3,
          priority: 70,
        },
      ],
      budget: {
        max_estimated_tokens: 8000,
        max_serialized_bytes: 49152,
      },
      options: {
        deduplicate: true,
        include_provenance: true,
        include_compiled_text: true,
      },
    };

    const parsed = buildContextInputSchema.safeParse(sampleInput);
    expect(parsed.success).toBe(true);

    const sampleOutput = {
      status: "complete",
      pack_id: "test-pack-id",
      namespace: "astara_alt_v2",
      task: "Continue the current scene after xxx reviews her resignation letter",
      revision_pins: [
        {
          conversation_id: crypto.randomUUID(),
          revision_id: "a".repeat(64),
          title: "CURRENT",
          namespace: "astara_alt_v2",
        },
      ],
      sections: [
        {
          kind: "required",
          request_index: 0,
          title: "CURRENT",
          priority: 100,
          conversation_id: crypto.randomUUID(),
          revision_id: "a".repeat(64),
          messages: [
            {
              source_node_id: "node-1",
              role: "assistant",
              created_at: "2026-09-17T00:00:00.000Z",
              updated_at: null,
              text: "Exact canonical message text",
              conversation_id: crypto.randomUUID(),
              revision_id: "a".repeat(64),
            },
          ],
          estimated_tokens: 1320,
          serialized_bytes: 6240,
        },
      ],
      budget: {
        max_estimated_tokens: 8000,
        used_estimated_tokens: 7140,
        max_serialized_bytes: 49152,
        used_serialized_bytes: 38120,
        estimator: "mempersist-token-estimate-v1",
      },
      omitted: [
        {
          kind: "retrieved",
          conversation_id: crypto.randomUUID(),
          revision_id: "a".repeat(64),
          reason: "budget",
        },
      ],
      degraded: false,
      unavailable: [],
      warnings: [],
      compiled_text: "[MEMORY: CURRENT]\n...",
    };
    const parsedOutput = buildContextOutputSchema.safeParse(sampleOutput);
    expect(parsedOutput.success).toBe(true);
    expect(buildContextCompleteOutputSchema.safeParse(sampleOutput).success).toBe(true);

    const exceededOutput = {
      status: "required_budget_exceeded",
      required_estimated_tokens: 11420,
      required_serialized_bytes: 68100,
      suggested_minimum: {
        max_estimated_tokens: 12000,
        max_serialized_bytes: 72000,
      },
      warnings: [
        {
          code: "REQUIRED_CONTENT_EXCEEDS_MCP_LIMIT",
        },
      ],
      degraded: false,
      unavailable: [],
    };
    const parsedExceeded = buildContextOutputSchema.safeParse(exceededOutput);
    expect(parsedExceeded.success).toBe(true);
    expect(buildContextRequiredBudgetExceededOutputSchema.safeParse(exceededOutput).success).toBe(
      true,
    );
  });

  it("exposes follow in memory_build_context inputSchema and accepts pointer-expansion requests", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "memory_build_context");
    expect(tool).toBeDefined();

    // Verify that the public JSON Schema exposes follow inside required array items
    const schema = tool!.inputSchema as {
      properties?: {
        required?: {
          items?: {
            properties?: {
              follow?: unknown;
            };
          };
        };
      };
    };
    expect(schema.properties?.required?.items?.properties?.follow).toBeDefined();

    const ID_1 = "0191f6e0-1111-7000-8000-000000000001";
    const ID_2 = "0191f6e0-2222-7000-8000-000000000002";
    const ID_3 = "0191f6e0-3333-7000-8000-000000000003";

    // Preferred pointer expansion shape
    const expansionInput = {
      namespace: "test_runtime",
      task: "Continue the active scene",
      required: [
        {
          selector: {
            title: "SYNTHETIC_CURRENT",
            namespace: "test_runtime",
          },
          mode: "full",
          priority: 100,
          follow: [
            {
              field: "current_scene",
              required: true,
              priority: 100,
            },
            {
              field: "active_arc.owner",
              required: true,
              priority: 95,
            },
          ],
        },
      ],
      budget: {
        max_estimated_tokens: 9000,
        max_serialized_bytes: 47000,
      },
    };

    const parsedInput = buildContextInputSchema.safeParse(expansionInput);
    expect(parsedInput.success).toBe(true);

    // Output with expanded_required sections and provenance
    const expansionOutput = {
      status: "complete",
      pack_id: "pack-with-pointer-expansion",
      namespace: "test_runtime",
      task: "Continue the active scene",
      revision_pins: [
        {
          conversation_id: ID_1,
          revision_id: "rev-current",
          title: "SYNTHETIC_CURRENT",
          namespace: "test_runtime",
        },
        {
          conversation_id: ID_2,
          revision_id: "rev-scene",
          title: "SYNTHETIC_CURRENT_SCENE",
          namespace: "test_runtime",
        },
        {
          conversation_id: ID_3,
          revision_id: "rev-arc",
          title: "SYNTHETIC_ACTIVE_ARC",
          namespace: "test_runtime",
        },
      ],
      sections: [
        {
          kind: "required",
          request_index: 0,
          title: "SYNTHETIC_CURRENT",
          priority: 100,
          conversation_id: ID_1,
          revision_id: "rev-current",
          messages: [
            {
              source_node_id: "node-current-1",
              role: "assistant",
              created_at: "2026-09-20T00:00:00.000Z",
              updated_at: null,
              text: `active_arc: SYNTHETIC ACTIVE ARC; owner ${ID_3}; status OPEN\ncurrent_scene: ${ID_2}; status OPEN`,
              conversation_id: ID_1,
              revision_id: "rev-current",
            },
          ],
          estimated_tokens: 100,
          serialized_bytes: 500,
        },
        {
          kind: "expanded_required",
          request_index: 0,
          title: "SYNTHETIC_CURRENT_SCENE",
          priority: 100,
          conversation_id: ID_2,
          revision_id: "rev-scene",
          source_conversation_id: ID_1,
          source_revision_id: "rev-current",
          pointer: "current_scene",
          messages: [
            {
              source_node_id: "node-scene-1",
              role: "assistant",
              created_at: "2026-09-20T00:00:00.000Z",
              updated_at: null,
              text: "Scene content",
              conversation_id: ID_2,
              revision_id: "rev-scene",
              provenance: {
                kind: "expanded_required",
                request_index: 0,
                conversation_id: ID_2,
                revision_id: "rev-scene",
                source_node_id: "node-scene-1",
                source_conversation_id: ID_1,
                source_revision_id: "rev-current",
                pointer: "current_scene",
              },
            },
          ],
          estimated_tokens: 200,
          serialized_bytes: 800,
        },
        {
          kind: "expanded_required",
          request_index: 1,
          title: "SYNTHETIC_ACTIVE_ARC",
          priority: 95,
          conversation_id: ID_3,
          revision_id: "rev-arc",
          source_conversation_id: ID_1,
          source_revision_id: "rev-current",
          pointer: "active_arc.owner",
          messages: [
            {
              source_node_id: "node-arc-1",
              role: "assistant",
              created_at: "2026-09-20T00:00:00.000Z",
              updated_at: null,
              text: "Arc content",
              conversation_id: ID_3,
              revision_id: "rev-arc",
              provenance: {
                kind: "expanded_required",
                request_index: 1,
                conversation_id: ID_3,
                revision_id: "rev-arc",
                source_node_id: "node-arc-1",
                source_conversation_id: ID_1,
                source_revision_id: "rev-current",
                pointer: "active_arc.owner",
              },
            },
          ],
          estimated_tokens: 300,
          serialized_bytes: 900,
        },
      ],
      budget: {
        max_estimated_tokens: 9000,
        used_estimated_tokens: 600,
        max_serialized_bytes: 47000,
        used_serialized_bytes: 2500,
        estimator: "mempersist-token-estimate-v1",
      },
      omitted: [],
      degraded: false,
      unavailable: [],
      warnings: [],
    };

    const parsedOutput = buildContextOutputSchema.safeParse(expansionOutput);
    expect(parsedOutput.success).toBe(true);
    expect(buildContextCompleteOutputSchema.safeParse(expansionOutput).success).toBe(true);
  });
});
