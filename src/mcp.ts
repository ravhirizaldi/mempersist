import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createMcpConversation } from "./chatgpt";
import {
  deleteAllMemories,
  deleteConversations,
  deleteNamespace,
  MAX_CONVERSATION_DELETE_BATCH,
} from "./deletion";
import type { AppEnv } from "./domain";
import { enqueueIndex } from "./jobs";
import { getChunkContext, getConversationPage } from "./retrieval";
import { searchMemory } from "./search";
import { appendConversation, listConversations, writeCanonicalConversation } from "./storage";

const messageSchema = z.object({
  role: z.string().min(1).max(40),
  content: z.string().max(1_000_000),
  timestamp: z.iso.datetime().optional(),
});

const conversationIdSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^[a-f0-9]{64}$/u, "Expected a memory conversation ID"),
]);

const conversationIdsSchema = z
  .array(conversationIdSchema)
  .min(1)
  .max(MAX_CONVERSATION_DELETE_BATCH)
  .refine((ids) => new Set(ids).size === ids.length, "Conversation IDs must be unique");

const nonEmptyNamespaceSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => /\S/u.test(value), "Namespace must not be empty");

function toolResult(value: unknown) {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "Response exceeds 64 KiB. Request a smaller page or narrower context.",
          }),
        },
      ],
    };
  }
  return { content: [{ type: "text" as const, text }] };
}

export function createMemoryMcpServer(env: AppEnv): McpServer {
  const server = new McpServer({ name: "mempersist", version: "0.1.0" });

  server.registerTool(
    "memory_search",
    {
      description: "Search durable conversation memory and return compact references.",
      inputSchema: z.object({
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(20).default(8),
        namespace: z.string().min(1).max(100).optional(),
      }),
    },
    async (input) =>
      toolResult(
        await searchMemory(env, {
          query: input.query,
          limit: input.limit,
          ...(input.namespace ? { namespace: input.namespace } : {}),
        }),
      ),
  );

  server.registerTool(
    "memory_get_context",
    {
      description: "Retrieve original messages around one search result chunk.",
      inputSchema: z.object({
        chunk_id: z.string().min(1),
        before: z.number().int().min(0).max(10).default(2),
        after: z.number().int().min(0).max(10).default(2),
      }),
    },
    async ({ chunk_id, before, after }) =>
      toolResult(await getChunkContext(env, chunk_id, before, after)),
  );

  server.registerTool(
    "memory_get_conversation",
    {
      description: "Page through an active timeline or every preserved graph node.",
      inputSchema: z.object({
        conversation_id: z.string().min(1),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        branch: z.enum(["active", "all"]).default("active"),
      }),
    },
    async ({ conversation_id, offset, limit, branch }) =>
      toolResult(await getConversationPage(env, conversation_id, offset, limit, branch)),
  );

  server.registerTool(
    "memory_list_conversations",
    {
      description: "List conversation metadata without transcript bodies.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().optional(),
        namespace: z.string().min(1).max(100).optional(),
      }),
    },
    async (input) =>
      toolResult(
        await listConversations(env, {
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.namespace ? { namespace: input.namespace } : {}),
        }),
      ),
  );

  server.registerTool(
    "memory_store",
    {
      description: "Durably store a new intentional memory before asynchronous indexing.",
      inputSchema: z.object({
        title: z.string().min(1).max(500),
        namespace: z.string().min(1).max(100).default("personal"),
        messages: z.array(messageSchema).min(1).max(1000),
      }),
    },
    async (input) => {
      const conversation = await createMcpConversation(input);
      const stored = await writeCanonicalConversation(env, conversation, null);
      const jobId = await enqueueIndex(env, stored.revisionId);
      return toolResult({
        conversation_id: stored.conversationId,
        revision_id: stored.revisionId,
        durable: true,
        indexing: { status: "queued", job_id: jobId },
      });
    },
  );

  server.registerTool(
    "memory_append",
    {
      description:
        "Append messages with optimistic revision checking; canonical success precedes indexing.",
      inputSchema: z.object({
        conversation_id: z.string().min(1),
        base_revision_id: z.string().min(1),
        messages: z.array(messageSchema).min(1).max(100),
      }),
    },
    async ({ conversation_id, base_revision_id, messages }) => {
      const stored = await appendConversation(env, conversation_id, base_revision_id, messages);
      const jobId = await enqueueIndex(env, stored.revisionId);
      return toolResult({
        conversation_id: conversation_id,
        revision_id: stored.revisionId,
        durable: true,
        indexing: { status: "queued", job_id: jobId },
      });
    },
  );

  server.registerTool(
    "memory_delete_conversations",
    {
      description:
        "Delete up to 100 conversations and their canonical and derived data; reports partial failures.",
      inputSchema: z.object({ conversation_ids: conversationIdsSchema }),
    },
    async ({ conversation_ids }) => toolResult(await deleteConversations(env, conversation_ids)),
  );

  server.registerTool(
    "memory_delete_namespace",
    {
      description: "Delete a namespace in bounded batches after an exact namespace confirmation.",
      inputSchema: z
        .object({
          namespace: nonEmptyNamespaceSchema,
          confirm_namespace: nonEmptyNamespaceSchema,
        })
        .refine((input) => input.namespace === input.confirm_namespace, {
          message: "confirm_namespace must exactly match namespace",
          path: ["confirm_namespace"],
        }),
    },
    async ({ namespace }) => toolResult(await deleteNamespace(env, namespace)),
  );

  server.registerTool(
    "memory_delete_all",
    {
      description:
        "Delete all canonical memories and derived data in bounded batches; raw imports are retained.",
      inputSchema: z.object({ confirm: z.literal("DELETE_ALL_MEMORIES") }),
    },
    async () => toolResult(await deleteAllMemories(env)),
  );

  server.registerTool(
    "memory_import_status",
    {
      description: "Read progress and failures for a ChatGPT import.",
      inputSchema: z.object({ import_id: z.string().uuid() }),
    },
    async ({ import_id }) => {
      const status = await env.MEMORY_DB.prepare(
        `SELECT id, source_type, filename, sha256, status, duplicate_of, checkpoint_ordinal, total_items,
         processed_items, error_code, error_message, created_at, updated_at FROM imports WHERE id = ?`,
      )
        .bind(import_id)
        .first();
      return toolResult(status ?? { error: "Import not found" });
    },
  );
  return server;
}
