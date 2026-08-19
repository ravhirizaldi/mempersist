import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createMcpConversation } from "./chatgpt";
import { deleteConversations, deleteNamespace, MAX_CONVERSATION_DELETE_BATCH } from "./deletion";
import type { AppEnv } from "./domain";
import { enqueueIndex } from "./jobs";
import { getChunkContext, getConversationPage } from "./retrieval";
import { searchMemory } from "./search";
import { grantNamespace, scopeNamespaces, type Tenant } from "./tenant";
import {
  appendConversation,
  listConversations,
  updateConversationTags,
  writeCanonicalConversation,
} from "./storage";

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

const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(20).default([]);

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

export function createMemoryMcpServer(env: AppEnv, tenant: Tenant): McpServer {
  const server = new McpServer({ name: "Ravhi Rizaldi", version: "0.1.0" });

  server.registerTool(
    "memory_search",
    {
      description:
        "Search durable conversation memory and return compact references. Scoped to your namespaces only; the same namespace name in another account is separate and invisible. Tags filter to conversations matching the given tags (tag_mode all = every tag, any = at least one).",
      inputSchema: z.object({
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(20).default(8),
        namespace: z.string().min(1).max(100).optional(),
        tags: tagsSchema.optional(),
        tag_mode: z.enum(["any", "all"]).default("all"),
      }),
    },
    async (input) => {
      return toolResult(
        await searchMemory(env, {
          query: input.query,
          limit: input.limit,
          namespaces: scopeNamespaces(tenant, input.namespace),
          userId: tenant.userId,
          ...(input.tags ? { tags: input.tags } : {}),
          tagMode: input.tag_mode,
        }),
      );
    },
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
      toolResult(
        await getChunkContext(env, chunk_id, before, after, tenant.namespaces, tenant.userId),
      ),
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
      toolResult(
        await getConversationPage(
          env,
          conversation_id,
          offset,
          limit,
          branch,
          tenant.namespaces,
          tenant.userId,
        ),
      ),
  );

  server.registerTool(
    "memory_list_conversations",
    {
      description:
        "List conversation metadata without transcript bodies. Scoped to your namespaces only. Tags filter to conversations matching the given tags (tag_mode all = every tag, any = at least one).",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().optional(),
        namespace: z.string().min(1).max(100).optional(),
        tags: tagsSchema.optional(),
        tag_mode: z.enum(["any", "all"]).default("all"),
      }),
    },
    async (input) => {
      return toolResult(
        await listConversations(env, {
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          namespaces: scopeNamespaces(tenant, input.namespace),
          userId: tenant.userId,
          ...(input.tags ? { tags: input.tags } : {}),
          tagMode: input.tag_mode,
        }),
      );
    },
  );

  server.registerTool(
    "memory_store",
    {
      description:
        "Durably store a new intentional memory before asynchronous indexing. The first write to a new namespace name claims it for your account.",
      inputSchema: z.object({
        title: z.string().min(1).max(500),
        namespace: z.string().min(1).max(100).default("personal"),
        tags: tagsSchema,
        messages: z.array(messageSchema).min(1).max(1000),
      }),
    },
    async (input) => {
      const namespace = input.namespace ?? tenant.defaultNamespace;
      if (!tenant.namespaces.includes(namespace)) {
        await grantNamespace(env, tenant.userId, namespace);
      }
      const conversation = await createMcpConversation({
        title: input.title,
        namespace,
        tags: input.tags,
        messages: input.messages,
      });
      const stored = await writeCanonicalConversation(env, conversation, null, null, tenant.userId);
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
        "Append messages with optimistic revision checking; canonical success precedes indexing. Ownership-checked to your namespaces. Tags add to the conversation's existing tag set.",
      inputSchema: z.object({
        conversation_id: z.string().min(1),
        base_revision_id: z.string().min(1),
        tags: tagsSchema.optional(),
        messages: z.array(messageSchema).min(1).max(100),
      }),
    },
    async ({ conversation_id, base_revision_id, tags, messages }) => {
      const stored = await appendConversation(
        env,
        conversation_id,
        base_revision_id,
        messages,
        tags,
        tenant.namespaces,
        tenant.userId,
      );
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
    "memory_update_tags",
    {
      description:
        "Add or remove conversation tags with optimistic revision checking; base_revision_id must be the current revision. Ownership-checked to your namespaces. Removals apply before additions.",
      inputSchema: z
        .object({
          conversation_id: conversationIdSchema,
          base_revision_id: z.string().min(1),
          add: tagsSchema.optional(),
          remove: tagsSchema.optional(),
        })
        .refine((input) => (input.add?.length ?? 0) > 0 || (input.remove?.length ?? 0) > 0, {
          message: "Provide at least one tag in add or remove",
          path: ["add"],
        }),
    },
    async ({ conversation_id, base_revision_id, add, remove }) =>
      toolResult(
        await updateConversationTags(
          env,
          conversation_id,
          base_revision_id,
          add ?? [],
          remove ?? [],
          tenant.namespaces,
          tenant.userId,
        ),
      ),
  );

  server.registerTool(
    "memory_delete_conversations",
    {
      description:
        "Delete up to 100 conversations and their canonical and derived data. Only conversations in your namespaces can be deleted; others are reported as missing.",
      inputSchema: z.object({ conversation_ids: conversationIdsSchema }),
    },
    async ({ conversation_ids }) =>
      toolResult(
        await deleteConversations(env, conversation_ids, tenant.namespaces, tenant.userId),
      ),
  );

  server.registerTool(
    "memory_empty_namespace",
    {
      description:
        "Delete every conversation in one of your namespaces in bounded batches after an exact namespace confirmation. Ownership of the namespace is kept. Raw imports are retained.",
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
    async ({ namespace }) => {
      return toolResult(
        await deleteNamespace(env, tenant.userId, scopeNamespaces(tenant, namespace)[0]!),
      );
    },
  );

  server.registerTool(
    "memory_list_namespaces",
    {
      description: "List the namespaces your account owns with conversation counts.",
      inputSchema: z.object({}),
    },
    async () => {
      const rows = await env.MEMORY_DB.prepare(
        `SELECT un.namespace, COUNT(c.id) AS conversations
         FROM user_namespaces un
         LEFT JOIN conversations c
           ON c.namespace = un.namespace AND c.user_id = un.user_id AND c.deleted_at IS NULL
         WHERE un.user_id = ?
         GROUP BY un.namespace ORDER BY un.namespace`,
      )
        .bind(tenant.userId)
        .all<{ namespace: string; conversations: number }>();
      return toolResult({
        namespaces: rows.results.map((row) => ({
          namespace: row.namespace,
          conversations: row.conversations,
          default: row.namespace === tenant.defaultNamespace,
        })),
      });
    },
  );

  server.registerTool(
    "memory_stats",
    {
      description:
        "Return conversation and message counts per namespace plus indexing health for your account.",
      inputSchema: z.object({}),
    },
    async () => {
      const namespaces = await env.MEMORY_DB.prepare(
        `SELECT un.namespace,
                COUNT(DISTINCT c.id) AS conversations,
                COUNT(n.id) AS messages
         FROM user_namespaces un
         LEFT JOIN conversations c
           ON c.namespace = un.namespace AND c.user_id = un.user_id AND c.deleted_at IS NULL
         LEFT JOIN conversation_revisions r ON r.id = c.current_revision_id
         LEFT JOIN message_nodes n ON n.revision_id = r.id
         WHERE un.user_id = ?
         GROUP BY un.namespace ORDER BY un.namespace`,
      )
        .bind(tenant.userId)
        .all<{ namespace: string; conversations: number; messages: number }>();
      const indexing = await env.MEMORY_DB.prepare(
        `SELECT state.status, COUNT(*) AS n
         FROM chunk_index_state state
         JOIN conversation_revisions r ON r.id = state.revision_id
         JOIN conversations c ON c.id = r.conversation_id
         WHERE c.user_id = ? AND state.generation_id = ?
         GROUP BY state.status`,
      )
        .bind(tenant.userId, env.ACTIVE_INDEX_GENERATION)
        .all<{ status: string; n: number }>();
      const byStatus = new Map(indexing.results.map((row) => [row.status, row.n]));
      const indexed = byStatus.get("indexed") ?? 0;
      const pending =
        (byStatus.get("queued") ?? 0) +
        (byStatus.get("processing") ?? 0) +
        (byStatus.get("failed") ?? 0);
      return toolResult({
        namespaces: namespaces.results.map((row) => ({
          namespace: row.namespace,
          conversations: row.conversations,
          messages: row.messages,
          default: row.namespace === tenant.defaultNamespace,
        })),
        totals: namespaces.results.reduce(
          (totals, row) => ({
            conversations: totals.conversations + row.conversations,
            messages: totals.messages + row.messages,
          }),
          { conversations: 0, messages: 0 },
        ),
        indexing: { pending, indexed },
      });
    },
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
