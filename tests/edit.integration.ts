import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpConversation } from "../src/chatgpt";
import type { CanonicalConversation, CanonicalNode } from "../src/domain";
import { MAX_MESSAGE_CONTENT_CHARS } from "../src/limits";
import { createMemoryMcpServer } from "../src/mcp";
import {
  editConversationMessages,
  loadCanonicalRevision,
  writeCanonicalConversation,
} from "../src/storage";
import {
  getOrCreateUser,
  grantNamespace,
  OWNER_DB_USER_ID,
  resolveTenant,
  type Tenant,
} from "../src/tenant";
import { completeMemoryEdit } from "../src/writes";

const compactMessageResult = z.object({
  sourceNodeId: z.string(),
  role: z.string().nullable(),
  text: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const compactPageResult = z.object({
  conversation: z.object({
    id: z.string(),
    revisionId: z.string(),
    title: z.string(),
    namespace: z.string(),
    tags: z.array(z.string()),
  }),
  messages: z.array(compactMessageResult),
  offset: z.number(),
  nextOffset: z.number().nullable(),
  total: z.number(),
  oversizedMessage: z.null(),
});

const canonicalNodeResult = compactMessageResult.extend({
  id: z.string(),
  parentSourceNodeId: z.string().nullable(),
  childSourceNodeIds: z.array(z.string()),
  content: z.json(),
  modelSlug: z.string().nullable(),
  metadata: z.json(),
  raw: z.json(),
});

const canonicalPageResult = z.object({
  conversation: z.object({
    id: z.string(),
    revisionId: z.string(),
    title: z.string(),
    namespace: z.string(),
    tags: z.array(z.string()),
    sourceType: z.string(),
    sourceId: z.string().nullable(),
    currentSourceNodeId: z.string().nullable(),
    anomalies: z.array(z.string()),
  }),
  messages: z.array(canonicalNodeResult),
  offset: z.number().optional(),
  nextOffset: z.number().nullable(),
  total: z.number(),
});

const editReceiptResult = z.object({
  conversation_id: z.string(),
  previous_revision_id: z.string(),
  revision_id: z.string(),
  status: z.enum(["edited", "no_change"]),
  durable: z.literal(true),
  edits: z.array(
    z.object({
      request_index: z.number().int(),
      source_node_id: z.string(),
      operation: z.enum(["replace", "append", "prepend"]),
      status: z.enum(["edited", "unchanged"]),
    }),
  ),
  indexing: z
    .union([
      z.object({ status: z.literal("queued"), job_id: z.string() }),
      z.object({
        status: z.literal("failed"),
        error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
      }),
    ])
    .optional(),
  verification: z
    .object({
      status: z.enum(["passed", "failed"]),
      revision_id: z.string(),
      checked_messages: z.number().optional(),
      readback_available: z.boolean(),
      readback: compactPageResult.optional(),
      readback_error: z
        .object({ code: z.string(), message: z.string(), offset: z.number() })
        .optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    })
    .optional(),
  readback_requests: z
    .array(
      z.object({
        conversation_id: z.string(),
        revision_id: z.string(),
        offset: z.number(),
        limit: z.number(),
        branch: z.enum(["active", "all"]),
      }),
    )
    .optional(),
  omitted: z.array(z.string()).optional(),
  used_serialized_bytes: z.number(),
  max_serialized_bytes: z.number(),
});

const batchResult = z.object({
  results: z.array(
    z.object({
      requestIndex: z.number(),
      status: z.string(),
      page: z
        .object({
          conversation: z.object({ id: z.string(), revisionId: z.string() }),
          messages: z.array(compactMessageResult),
        })
        .optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

type CallResult =
  | { isError: true; text: string; bytes: number }
  | { isError: false; text: string; bytes: number; value: unknown };

type CatalogSnapshot = {
  head: string | null;
  revisions: number;
  jobs: number;
};

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
  const client = new Client({ name: "edit-integration-test", version: "1.0.0" });
  const server = createMemoryMcpServer(env, tenant);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

async function ownerClient(namespace: string): Promise<Client> {
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

function collectBatchTexts(
  target: Map<number, string[]>,
  value: z.infer<typeof batchResult>,
): void {
  for (const entry of value.results) {
    if (entry.page?.messages.length)
      target.set(entry.requestIndex, [
        ...(target.get(entry.requestIndex) ?? []),
        ...entry.page.messages.map((message) => message.text),
      ]);
  }
}

async function catalogSnapshot(conversationId: string): Promise<CatalogSnapshot> {
  const head = await env.MEMORY_DB.prepare(
    "SELECT current_revision_id FROM conversations WHERE id = ?",
  )
    .bind(conversationId)
    .first<{ current_revision_id: string | null }>();
  const revisions = await env.MEMORY_DB.prepare(
    "SELECT COUNT(*) AS total FROM conversation_revisions WHERE conversation_id = ?",
  )
    .bind(conversationId)
    .first<{ total: number }>();
  const jobs = await env.MEMORY_DB.prepare(
    `SELECT COUNT(*) AS total FROM jobs
     WHERE kind = 'index' AND subject_id IN
       (SELECT id FROM conversation_revisions WHERE conversation_id = ?)`,
  )
    .bind(conversationId)
    .first<{ total: number }>();
  return {
    head: head?.current_revision_id ?? null,
    revisions: revisions?.total ?? 0,
    jobs: jobs?.total ?? 0,
  };
}

function branchedConversation(namespace: string): CanonicalConversation {
  const id = crypto.randomUUID();
  const node = (
    sourceNodeId: string,
    parentSourceNodeId: string | null,
    childSourceNodeIds: string[],
    role: string,
    text: string,
    createdAt: string,
    marker: string,
  ): CanonicalNode => ({
    id: `${id}-${sourceNodeId}`,
    sourceNodeId,
    parentSourceNodeId,
    childSourceNodeIds,
    role,
    text,
    content: { content_type: "text", parts: [text] },
    createdAt,
    updatedAt: null,
    modelSlug: role === "assistant" ? `model-${marker}` : null,
    metadata: { marker, nested: { preserved: true } },
    raw: { source: marker, ordinal: sourceNodeId },
  });
  return {
    id,
    sourceType: "chatgpt",
    sourceId: `source-${id}`,
    title: "Synthetic branched edit",
    namespace,
    tags: ["edit", "branches"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    currentSourceNodeId: "active-leaf",
    activeSourceNodeIds: ["root", "active-answer", "active-leaf"],
    nodes: [
      node(
        "root",
        null,
        ["active-answer", "inactive-answer"],
        "user",
        "Choose a branch",
        "2026-01-01T00:00:00.000Z",
        "root",
      ),
      node(
        "active-answer",
        "root",
        ["active-leaf"],
        "assistant",
        "Active answer",
        "2026-01-01T00:00:01.000Z",
        "active",
      ),
      node(
        "active-leaf",
        "active-answer",
        [],
        "user",
        "Active follow-up",
        "2026-01-01T00:00:02.000Z",
        "active-leaf",
      ),
      node(
        "inactive-answer",
        "root",
        ["inactive-leaf"],
        "assistant",
        "Inactive answer",
        "2026-01-01T00:00:03.000Z",
        "inactive",
      ),
      node(
        "inactive-leaf",
        "inactive-answer",
        [],
        "user",
        "Inactive follow-up",
        "2026-01-01T00:00:04.000Z",
        "inactive-leaf",
      ),
    ],
    metadata: { fixture: "branch-preservation", nested: { untouched: true } },
    anomalies: ["synthetic_anomaly:preserve-me"],
    derivedFrom: null,
  };
}

function linearConversation(namespace: string, count: number): CanonicalConversation {
  const id = crypto.randomUUID();
  const nodes: CanonicalNode[] = Array.from({ length: count }, (_, index) => {
    const sourceNodeId = `n-${index}`;
    const parentSourceNodeId = index === 0 ? null : `n-${index - 1}`;
    const childSourceNodeIds = index === count - 1 ? [] : [`n-${index + 1}`];
    const text = `old-${index}`;
    return {
      id: `${id}-node-${index}`,
      sourceNodeId,
      parentSourceNodeId,
      childSourceNodeIds,
      role: index % 2 === 0 ? "user" : "assistant",
      text,
      content: { content_type: "text", parts: [text] },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      updatedAt: null,
      modelSlug: null,
      metadata: {},
      raw: {},
    };
  });
  return {
    id,
    sourceType: "mcp",
    sourceId: null,
    title: `Synthetic ${count}-message edit`,
    namespace,
    tags: [],
    createdAt: nodes[0]?.createdAt ?? null,
    updatedAt: nodes.at(-1)?.createdAt ?? null,
    currentSourceNodeId: nodes.at(-1)?.sourceNodeId ?? null,
    activeSourceNodeIds: nodes.map((node) => node.sourceNodeId),
    nodes,
    metadata: {},
    anomalies: [],
    derivedFrom: null,
  };
}

describe("memory_edit_messages integration", () => {
  it("advertises destructive, non-idempotent write annotations", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient(namespace);
    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === "memory_edit_messages",
    );
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    });
  });

  it("applies replace, append, and prepend with exact Unicode, whitespace, separator, and empty-boundary semantics", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient(namespace);
    const conversation = await createMcpConversation({
      title: "Exact edit semantics",
      namespace,
      messages: [
        { role: "user", content: "replace me" },
        { role: "assistant", content: "left" },
        { role: "user", content: "base" },
        { role: "assistant", content: "tail" },
        { role: "user", content: "" },
        { role: "assistant", content: "stay" },
      ],
    });
    const base = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);
    const exactReplacement = "  雪🙂\n\t preserved  ";
    const receipt = editReceiptResult.parse(
      await callValue(client, "memory_edit_messages", {
        conversation_id: conversation.id,
        base_revision_id: base.revisionId,
        edits: [
          {
            source_node_id: conversation.nodes[0]!.sourceNodeId,
            operation: "replace",
            text: exactReplacement,
          },
          {
            source_node_id: conversation.nodes[1]!.sourceNodeId,
            operation: "append",
            text: "右\t ",
          },
          {
            source_node_id: conversation.nodes[2]!.sourceNodeId,
            operation: "append",
            text: "suffix",
            separator: " | ",
          },
          {
            source_node_id: conversation.nodes[3]!.sourceNodeId,
            operation: "prepend",
            text: "前",
          },
          {
            source_node_id: conversation.nodes[4]!.sourceNodeId,
            operation: "append",
            text: "新",
            separator: "must-not-appear",
          },
          {
            source_node_id: conversation.nodes[5]!.sourceNodeId,
            operation: "prepend",
            text: "",
            separator: "must-not-appear",
          },
        ],
      }),
    );

    expect(receipt.status).toBe("edited");
    expect(receipt.previous_revision_id).toBe(base.revisionId);
    expect(receipt.revision_id).not.toBe(base.revisionId);
    expect(receipt.edits.map((edit) => edit.status)).toEqual([
      "edited",
      "edited",
      "edited",
      "edited",
      "edited",
      "unchanged",
    ]);
    expect(receipt.indexing?.status).toBe("queued");
    expect(receipt.verification).toBeUndefined();

    const page = canonicalPageResult.parse(
      await callValue(client, "memory_get_conversation", {
        conversation_id: conversation.id,
        revision_id: receipt.revision_id,
        branch: "active",
        format: "canonical",
        limit: 100,
      }),
    );
    expect(page.messages.map((message) => message.text)).toEqual([
      exactReplacement,
      "left\n\n右\t ",
      "base | suffix",
      "前\n\ntail",
      "新",
      "stay",
    ]);
  });

  it("edits active and inactive targets while preserving the complete graph and immutable pinned base revision", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient(namespace);
    const conversation = branchedConversation(namespace);
    const base = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);

    const receipt = editReceiptResult.parse(
      await callValue(client, "memory_edit_messages", {
        conversation_id: conversation.id,
        base_revision_id: base.revisionId,
        edits: [
          { source_node_id: "active-answer", operation: "append", text: "active edit" },
          {
            source_node_id: "inactive-answer",
            operation: "prepend",
            text: "inactive edit",
            separator: " :: ",
          },
        ],
      }),
    );
    expect(receipt.edits.map((edit) => edit.status)).toEqual(["edited", "edited"]);

    const current = canonicalPageResult.parse(
      await callValue(client, "memory_get_conversation", {
        conversation_id: conversation.id,
        revision_id: receipt.revision_id,
        branch: "all",
        format: "canonical",
        limit: 100,
      }),
    );
    const active = canonicalPageResult.parse(
      await callValue(client, "memory_get_conversation", {
        conversation_id: conversation.id,
        revision_id: receipt.revision_id,
        branch: "active",
        format: "canonical",
        limit: 100,
      }),
    );
    const pinnedBase = canonicalPageResult.parse(
      await callValue(client, "memory_get_conversation", {
        conversation_id: conversation.id,
        revision_id: base.revisionId,
        branch: "all",
        format: "canonical",
        limit: 100,
      }),
    );

    expect(current.conversation.revisionId).toBe(receipt.revision_id);
    expect(current.conversation.currentSourceNodeId).toBe(conversation.currentSourceNodeId);
    expect(current.conversation.anomalies).toEqual(conversation.anomalies);
    expect(active.messages.map((message) => message.sourceNodeId)).toEqual(
      conversation.activeSourceNodeIds,
    );
    expect(pinnedBase.conversation.revisionId).toBe(base.revisionId);
    expect(pinnedBase.messages).toEqual(conversation.nodes);

    const expectedTextById: Record<string, string> = {
      "active-answer": "Active answer\n\nactive edit",
      "inactive-answer": "inactive edit :: Inactive answer",
    };
    for (const original of conversation.nodes) {
      const revised = current.messages.find(
        (message) => message.sourceNodeId === original.sourceNodeId,
      );
      expect(revised).toBeDefined();
      const expectedText = expectedTextById[original.sourceNodeId];
      if (expectedText === undefined) {
        expect(revised).toEqual(original);
        continue;
      }
      expect(revised!.id).toBe(original.id);
      expect(revised!.sourceNodeId).toBe(original.sourceNodeId);
      expect(revised!.parentSourceNodeId).toBe(original.parentSourceNodeId);
      expect(revised!.childSourceNodeIds).toEqual(original.childSourceNodeIds);
      expect(revised!.role).toBe(original.role);
      expect(revised!.createdAt).toBe(original.createdAt);
      expect(revised!.modelSlug).toBe(original.modelSlug);
      expect(revised!.metadata).toEqual(original.metadata);
      expect(revised!.raw).toEqual(original.raw);
      expect(revised!.text).toBe(expectedText);
      expect(revised!.content).toEqual({
        content_type: "text",
        parts: [expectedText],
      });
      expect(revised!.updatedAt).not.toBe(original.updatedAt);
      expect(revised!.updatedAt).not.toBeNull();
    }

    const stored = await loadCanonicalRevision(env, receipt.revision_id);
    expect(stored.conversation.activeSourceNodeIds).toEqual(conversation.activeSourceNodeIds);
    expect(stored.conversation.currentSourceNodeId).toBe(conversation.currentSourceNodeId);
    expect(stored.conversation.metadata).toEqual(conversation.metadata);
    expect(stored.conversation.anomalies).toEqual(conversation.anomalies);
    expect(stored.conversation.updatedAt).not.toBe(conversation.updatedAt);

    const provenance = stored.conversation.mutation;
    expect(provenance).toBeDefined();
    expect(provenance).toMatchObject({
      operation: "edit_messages",
      previousRevisionId: base.revisionId,
      edits: [
        { sourceNodeId: "active-answer", operation: "append" },
        { sourceNodeId: "inactive-answer", operation: "prepend" },
      ],
    });
    expect(Number.isNaN(Date.parse(provenance!.editedAt))).toBe(false);
    expect(Object.keys(provenance!).sort()).toEqual(
      ["editedAt", "edits", "operation", "previousRevisionId"].sort(),
    );
    expect(provenance!.edits.map((edit) => Object.keys(edit).sort())).toEqual([
      ["operation", "sourceNodeId"],
      ["operation", "sourceNodeId"],
    ]);
    expect(JSON.stringify(provenance)).not.toContain("canonical/");
    expect(JSON.stringify(provenance)).not.toContain("object_key");
  });

  it("returns ordered mixed statuses and verify=true checks every target with targeted readback", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient(namespace);
    const conversation = await createMcpConversation({
      title: "Mixed edit verification",
      namespace,
      messages: [
        { role: "user", content: "unchanged" },
        { role: "assistant", content: "append base" },
        { role: "user", content: "prepend base" },
        { role: "assistant", content: "unrelated" },
      ],
    });
    const base = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);
    const targetedIds = conversation.nodes.slice(0, 3).map((node) => node.sourceNodeId);
    const expectedTexts = ["unchanged", "append base\n\nadded", "first/prepend base"];

    const receipt = editReceiptResult.parse(
      await callValue(client, "memory_edit_messages", {
        conversation_id: conversation.id,
        base_revision_id: base.revisionId,
        verify: true,
        edits: [
          { source_node_id: targetedIds[0], operation: "replace", text: "unchanged" },
          { source_node_id: targetedIds[1], operation: "append", text: "added" },
          {
            source_node_id: targetedIds[2],
            operation: "prepend",
            text: "first",
            separator: "/",
          },
        ],
      }),
    );

    expect(receipt.status).toBe("edited");
    expect(receipt.edits).toEqual([
      {
        request_index: 0,
        source_node_id: targetedIds[0],
        operation: "replace",
        status: "unchanged",
      },
      {
        request_index: 1,
        source_node_id: targetedIds[1],
        operation: "append",
        status: "edited",
      },
      {
        request_index: 2,
        source_node_id: targetedIds[2],
        operation: "prepend",
        status: "edited",
      },
    ]);
    expect(receipt.verification?.status).toBe("passed");
    expect(receipt.verification?.checked_messages).toBe(3);
    expect(receipt.verification?.readback_available).toBe(true);
    expect(receipt.verification?.readback?.messages.map((message) => message.sourceNodeId)).toEqual(
      targetedIds,
    );
    expect(receipt.verification?.readback?.messages.map((message) => message.text)).toEqual(
      expectedTexts,
    );
    expect(
      receipt.verification?.readback?.messages.some(
        (message) => message.sourceNodeId === conversation.nodes[3]!.sourceNodeId,
      ),
    ).toBe(false);
  });

  it("returns no_change without advancing the head, writing a revision, or queuing an index job", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient(namespace);
    const conversation = await createMcpConversation({
      title: "No-op edit",
      namespace,
      messages: [
        { role: "user", content: "same" },
        { role: "assistant", content: "also same" },
      ],
    });
    const base = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);
    const before = await catalogSnapshot(conversation.id);
    const queue = vi.spyOn(env.INDEX_QUEUE, "send");

    const receipt = editReceiptResult.parse(
      await callValue(client, "memory_edit_messages", {
        conversation_id: conversation.id,
        base_revision_id: base.revisionId,
        verify: true,
        edits: [
          {
            source_node_id: conversation.nodes[0]!.sourceNodeId,
            operation: "replace",
            text: "same",
          },
          {
            source_node_id: conversation.nodes[1]!.sourceNodeId,
            operation: "append",
            text: "",
            separator: "ignored",
          },
        ],
      }),
    );

    expect(receipt.status).toBe("no_change");
    expect(receipt.previous_revision_id).toBe(base.revisionId);
    expect(receipt.revision_id).toBe(base.revisionId);
    expect(receipt.edits.map((edit) => edit.status)).toEqual(["unchanged", "unchanged"]);
    expect(receipt.indexing).toBeUndefined();
    expect(receipt.verification?.status).toBe("passed");
    expect(receipt.verification?.checked_messages).toBe(2);
    expect(await catalogSnapshot(conversation.id)).toEqual(before);
    expect(queue).not.toHaveBeenCalled();
  });

  it("rejects duplicate, missing, cross-conversation, structured, and oversized targets atomically", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient(namespace);
    const conversation = await createMcpConversation({
      title: "Atomic invalid edit batches",
      namespace,
      messages: [
        { role: "user", content: "valid" },
        { role: "assistant", content: "structured view" },
        { role: "user", content: "x" },
      ],
    });
    conversation.nodes[1] = {
      ...conversation.nodes[1]!,
      content: {
        content_type: "multimodal_text",
        parts: [{ type: "image", asset_pointer: "synthetic://asset" }],
      },
    };
    const base = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);
    const other = await createMcpConversation({
      title: "Other conversation",
      namespace,
      messages: [{ role: "user", content: "foreign target" }],
    });
    await writeCanonicalConversation(env, other, null, null, OWNER_DB_USER_ID);
    const otherBefore = await catalogSnapshot(other.id);

    const validEdit = {
      source_node_id: conversation.nodes[0]!.sourceNodeId,
      operation: "replace",
      text: "must never commit",
    };
    const cases: Array<{ edits: Array<Record<string, unknown>>; message: string }> = [
      {
        edits: [validEdit, { ...validEdit, text: "duplicate" }],
        message: "source_node_id must be unique",
      },
      {
        edits: [
          validEdit,
          { source_node_id: "missing-node", operation: "replace", text: "missing" },
        ],
        message: "Target message not found",
      },
      {
        edits: [
          validEdit,
          {
            source_node_id: other.nodes[0]!.sourceNodeId,
            operation: "replace",
            text: "foreign",
          },
        ],
        message: "Target message not found",
      },
      {
        edits: [
          validEdit,
          {
            source_node_id: conversation.nodes[1].sourceNodeId,
            operation: "replace",
            text: "lossy rewrite",
          },
        ],
        message: "structured content",
      },
      {
        edits: [
          validEdit,
          {
            source_node_id: conversation.nodes[2]!.sourceNodeId,
            operation: "append",
            text: "z".repeat(MAX_MESSAGE_CONTENT_CHARS),
            separator: "",
          },
        ],
        message: `exceeds ${MAX_MESSAGE_CONTENT_CHARS} characters`,
      },
    ];

    for (const testCase of cases) {
      const before = await catalogSnapshot(conversation.id);
      const queue = vi.spyOn(env.INDEX_QUEUE, "send");
      const result = await call(client, "memory_edit_messages", {
        conversation_id: conversation.id,
        base_revision_id: base.revisionId,
        edits: testCase.edits,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(testCase.message);
      expect(await catalogSnapshot(conversation.id)).toEqual(before);
      expect(await catalogSnapshot(other.id)).toEqual(otherBefore);
      expect(queue).not.toHaveBeenCalled();
      queue.mockRestore();
    }
  });

  it("rejects a stale base, succeeds when retried with the fresh revision, and queues only after CAS", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient(namespace);
    const conversation = await createMcpConversation({
      title: "Edit optimistic concurrency",
      namespace,
      messages: [{ role: "user", content: "v1" }],
    });
    const base = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);
    const targetId = conversation.nodes[0]!.sourceNodeId;
    const first = editReceiptResult.parse(
      await callValue(client, "memory_edit_messages", {
        conversation_id: conversation.id,
        base_revision_id: base.revisionId,
        edits: [{ source_node_id: targetId, operation: "replace", text: "v2" }],
      }),
    );
    const beforeStale = await catalogSnapshot(conversation.id);
    let headAtQueue: string | null = null;
    const queue = vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async () => {
      const row = await env.MEMORY_DB.prepare(
        "SELECT current_revision_id FROM conversations WHERE id = ?",
      )
        .bind(conversation.id)
        .first<{ current_revision_id: string }>();
      headAtQueue = row?.current_revision_id ?? null;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    });

    const stale = await call(client, "memory_edit_messages", {
      conversation_id: conversation.id,
      base_revision_id: base.revisionId,
      edits: [{ source_node_id: targetId, operation: "replace", text: "v3" }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("base_revision_id is stale");
    expect(await catalogSnapshot(conversation.id)).toEqual(beforeStale);
    expect(queue).not.toHaveBeenCalled();

    const retry = editReceiptResult.parse(
      await callValue(client, "memory_edit_messages", {
        conversation_id: conversation.id,
        base_revision_id: first.revision_id,
        edits: [{ source_node_id: targetId, operation: "replace", text: "v3" }],
      }),
    );
    expect(retry.status).toBe("edited");
    expect(retry.previous_revision_id).toBe(first.revision_id);
    expect(headAtQueue).toBe(retry.revision_id);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(await catalogSnapshot(conversation.id)).toEqual({
      head: retry.revision_id,
      revisions: beforeStale.revisions + 1,
      jobs: beforeStale.jobs + 1,
    });
  });

  it("enforces tenant isolation even when another account owns the same namespace name", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    await ownerClient(namespace);
    const conversation = await createMcpConversation({
      title: "Owner-only edit target",
      namespace,
      messages: [{ role: "user", content: "private" }],
    });
    const base = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);
    const otherUser = await getOrCreateUser(
      env,
      `edit-foreign-${crypto.randomUUID().slice(0, 8)}@example.com`,
    );
    await grantNamespace(env, otherUser.id, namespace);
    const otherClient = await connectedClient(await resolveTenant(env, { userId: otherUser.id }));
    const before = await catalogSnapshot(conversation.id);
    const queue = vi.spyOn(env.INDEX_QUEUE, "send");

    const result = await call(otherClient, "memory_edit_messages", {
      conversation_id: conversation.id,
      base_revision_id: base.revisionId,
      edits: [
        {
          source_node_id: conversation.nodes[0]!.sourceNodeId,
          operation: "replace",
          text: "stolen",
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Conversation not found");
    expect(await catalogSnapshot(conversation.id)).toEqual(before);
    expect(queue).not.toHaveBeenCalled();
  });

  it("keeps a verified 100-target receipt under 49,152 bytes", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient(namespace);
    const conversation = linearConversation(namespace, 100);
    const base = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);
    const result = await call(client, "memory_edit_messages", {
      conversation_id: conversation.id,
      base_revision_id: base.revisionId,
      verify: true,
      edits: conversation.nodes.map((node, index) => ({
        source_node_id: node.sourceNodeId,
        operation: "replace",
        text: `edited-${index}`,
      })),
    });
    expect(result.isError).toBe(false);
    if (result.isError) throw new Error(result.text);
    const receipt = editReceiptResult.parse(result.value);

    expect(receipt.edits).toHaveLength(100);
    expect(receipt.edits.every((edit) => edit.status === "edited")).toBe(true);
    expect(receipt.verification?.status).toBe("passed");
    expect(receipt.verification?.checked_messages).toBe(100);
    expect(receipt.verification?.readback?.messages).toHaveLength(100);
    expect(receipt.max_serialized_bytes).toBe(49_152);
    expect(receipt.used_serialized_bytes).toBeLessThanOrEqual(49_152);
    expect(result.bytes).toBe(receipt.used_serialized_bytes);
    expect(result.bytes).toBeLessThanOrEqual(49_152);
  });

  it("returns a durable edited receipt when indexing queue dispatch fails", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient(namespace);
    const conversation = await createMcpConversation({
      title: "Edit queue failure",
      namespace,
      messages: [{ role: "user", content: "before" }],
    });
    const base = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);
    const before = await catalogSnapshot(conversation.id);
    vi.spyOn(env.INDEX_QUEUE, "send").mockRejectedValue(new Error("synthetic queue failure"));

    const receipt = editReceiptResult.parse(
      await callValue(client, "memory_edit_messages", {
        conversation_id: conversation.id,
        base_revision_id: base.revisionId,
        verify: true,
        edits: [
          {
            source_node_id: conversation.nodes[0]!.sourceNodeId,
            operation: "replace",
            text: "after",
          },
        ],
      }),
    );

    expect(receipt.durable).toBe(true);
    expect(receipt.status).toBe("edited");
    expect(receipt.indexing).toMatchObject({
      status: "failed",
      error: { code: "DERIVED_INDEXING", retryable: true },
    });
    expect(receipt.verification?.status).toBe("passed");
    expect(await catalogSnapshot(conversation.id)).toEqual({
      head: receipt.revision_id,
      revisions: before.revisions + 1,
      jobs: before.jobs + 1,
    });
  });

  it("returns a durable receipt when post-commit verification cannot read the new revision", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    await grantNamespace(env, OWNER_DB_USER_ID, namespace);
    const conversation = await createMcpConversation({
      title: "Edit verification failure",
      namespace,
      messages: [{ role: "user", content: "before" }],
    });
    const base = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);
    const result = await editConversationMessages(
      env,
      conversation.id,
      base.revisionId,
      [
        {
          sourceNodeId: conversation.nodes[0]!.sourceNodeId,
          operation: "replace",
          text: "committed before verification",
        },
      ],
      [namespace],
      OWNER_DB_USER_ID,
    );
    if (!result.revision) throw new Error("Expected an edited revision");
    const stored = result.revision;
    const manifest = await env.MEMORY_BUCKET.get(stored.manifestKey);
    if (!manifest) throw new Error("Expected the committed manifest");
    const manifestText = await manifest.text();
    await env.MEMORY_BUCKET.delete(stored.manifestKey);

    try {
      const receipt = await completeMemoryEdit(env, result, true);
      expect(receipt.durable).toBe(true);
      expect(receipt.status).toBe("edited");
      expect(receipt.revision_id).toBe(stored.revisionId);
      expect(receipt.indexing?.status).toBe("queued");
      expect(receipt.verification).toMatchObject({
        status: "failed",
        revision_id: stored.revisionId,
        readback_available: false,
        error: { code: "CANONICAL_STORAGE" },
      });
      expect((await catalogSnapshot(conversation.id)).head).toBe(stored.revisionId);
    } finally {
      await env.MEMORY_BUCKET.put(stored.manifestKey, manifestText);
    }
  });

  it("keeps a shed verified edit durable and recovers an inactive target through the branch-all readback selector", async () => {
    const namespace = `ns-edit-${crypto.randomUUID().slice(0, 8)}`;
    const client = await ownerClient(namespace);
    // A long abandoned branch: only the first two nodes are active, so every later
    // target is inactive and would be missing from an "active" readback selector.
    const linear = linearConversation(namespace, 100);
    const conversation: CanonicalConversation = {
      ...linear,
      activeSourceNodeIds: linear.nodes.slice(0, 2).map((node) => node.sourceNodeId),
      currentSourceNodeId: linear.nodes[1]!.sourceNodeId,
    };
    expect(conversation.activeSourceNodeIds).toHaveLength(2);
    const base = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);

    // ~300 chars per target: the targeted inline readback is ~43 KiB, too large to
    // fit alongside the rest of the receipt envelope, but each recovered message fits.
    const finalTexts = conversation.nodes.map((_, index) => {
      const prefix = `edited-${index}:`;
      return `${prefix}${"x".repeat(300 - prefix.length)}`;
    });

    const receipt = editReceiptResult.parse(
      await callValue(client, "memory_edit_messages", {
        conversation_id: conversation.id,
        base_revision_id: base.revisionId,
        verify: true,
        edits: conversation.nodes.map((node, index) => ({
          source_node_id: node.sourceNodeId,
          operation: "replace",
          text: finalTexts[index]!,
        })),
      }),
    );

    // The durable receipt survives the shed: it names the omitted inline page and
    // stays inside its envelope instead of failing the verified edit.
    expect(receipt.durable).toBe(true);
    expect(receipt.status).toBe("edited");
    expect(receipt.verification?.status).toBe("passed");
    expect(receipt.verification?.readback).toBeUndefined();
    expect(receipt.omitted ?? []).toContain("verification.readback");
    expect(receipt.used_serialized_bytes).toBeLessThanOrEqual(receipt.max_serialized_bytes);

    // The advertised selector must cover the inactive targets the inline page dropped.
    const readbackRequests = receipt.readback_requests ?? [];
    expect(readbackRequests).toHaveLength(1);
    expect(readbackRequests[0]).toMatchObject({
      conversation_id: conversation.id,
      revision_id: receipt.revision_id,
      offset: 0,
      limit: 20,
      branch: "all",
    });

    // A first call with the selector as its requests array, then continuation cursors.
    const recovered = new Map<number, string[]>();
    let page = batchResult.parse(
      await callValue(client, "memory_get_conversations", {
        requests: readbackRequests,
        max_serialized_bytes: 49_152,
      }),
    );
    collectBatchTexts(recovered, page);
    for (let pageNumber = 0; page.nextCursor; pageNumber++) {
      expect(pageNumber).toBeLessThan(20);
      const cursor = page.nextCursor;
      page = batchResult.parse(await callValue(client, "memory_get_conversations", { cursor }));
      collectBatchTexts(recovered, page);
    }
    expect(page.nextCursor).toBeNull();

    const inactiveTarget = conversation.nodes.at(-1)!;
    expect(conversation.activeSourceNodeIds).not.toContain(inactiveTarget.sourceNodeId);
    const recoveredTexts = recovered.get(0) ?? [];
    expect(recoveredTexts).toHaveLength(conversation.nodes.length);
    expect(recoveredTexts).toContain(finalTexts.at(-1));
    expect(recoveredTexts.at(-1)).toBe(finalTexts.at(-1));
  });
});
