import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createMcpConversation } from "./chatgpt";
import { deleteConversations, deleteNamespace, MAX_CONVERSATION_DELETE_BATCH } from "./deletion";
import type { AppEnv } from "./domain";
import { completeMemoryWrite } from "./writes";
import {
  boundCompactPage,
  compactConversationPage,
  getChunkContext,
  getConversationPage,
  getConversations,
} from "./retrieval";
import { searchMemory } from "./search";
import { assertAccountWritable, grantNamespace, scopeNamespaces, type Tenant } from "./tenant";
import {
  appendConversation,
  listConversationRevisions,
  listConversations,
  replaceConversation,
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

const readFormatSchema = z.enum(["compact", "canonical"]).default("canonical");
const conversationRequestSchema = z.object({
  conversation_id: conversationIdSchema,
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(100).default(20),
  branch: z.enum(["active", "all"]).default("active"),
  revision_id: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const;

const nullableStringSchema = z.string().nullable();
const compactMessageOutputSchema = z.object({
  sourceNodeId: z.string(),
  role: nullableStringSchema,
  createdAt: nullableStringSchema,
  updatedAt: nullableStringSchema,
  text: z.string(),
});
const canonicalMessageOutputSchema = compactMessageOutputSchema.extend({
  id: z.string(),
  parentSourceNodeId: nullableStringSchema,
  childSourceNodeIds: z.array(z.string()),
  content: z.json(),
  modelSlug: nullableStringSchema,
  metadata: z.json(),
  raw: z.json(),
});
const compactConversationOutputSchema = z.object({
  id: z.string(),
  revisionId: z.string(),
  title: z.string(),
  namespace: z.string(),
  tags: z.array(z.string()),
});
const canonicalConversationOutputSchema = compactConversationOutputSchema.extend({
  sourceType: z.string(),
  sourceId: nullableStringSchema,
  currentSourceNodeId: nullableStringSchema,
  anomalies: z.array(z.string()),
});
const oversizedMessageOutputSchema = z
  .object({ offset: z.number(), sourceNodeId: z.string(), bytes: z.number() })
  .nullable();
const compactPageOutputSchema = z.object({
  conversation: compactConversationOutputSchema,
  messages: z.array(compactMessageOutputSchema),
  offset: z.number(),
  nextOffset: z.number().nullable(),
  total: z.number(),
  oversizedMessage: oversizedMessageOutputSchema,
});
const conversationPageOutputSchema = z.object({
  conversation: z.union([compactConversationOutputSchema, canonicalConversationOutputSchema]),
  messages: z.array(z.union([compactMessageOutputSchema, canonicalMessageOutputSchema])),
  offset: z.number().optional(),
  nextOffset: z.number().nullable(),
  total: z.number(),
  oversizedMessage: oversizedMessageOutputSchema.optional(),
});
const conversationRequestOutputSchema = z.object({
  conversation_id: z.string(),
  offset: z.number(),
  limit: z.number(),
  branch: z.enum(["active", "all"]),
  revision_id: z.string().optional(),
});
const searchOutputSchema = z.object({
  results: z.array(
    z.object({
      conversationId: z.string(),
      revisionId: z.string(),
      chunkId: z.string(),
      title: z.string(),
      snippet: z.string(),
      timestamp: nullableStringSchema,
      namespace: z.string(),
      tags: z.array(z.string()),
      score: z.number(),
      sources: z.array(z.enum(["lexical", "semantic", "recent_canonical"])),
    }),
  ),
  degraded: z.boolean(),
  unavailable: z.array(z.enum(["fts", "semantic", "recent_canonical"])),
});
const contextOutputSchema = z.object({
  chunkId: z.string(),
  revisionId: z.string(),
  conversation: compactConversationOutputSchema.optional(),
  messages: z.array(z.union([compactMessageOutputSchema, canonicalMessageOutputSchema])),
  matchedRanges: z.array(
    z.object({ sourceNodeId: z.string(), charStart: z.number(), charEnd: z.number() }),
  ),
});
const batchOutputSchema = z.object({
  results: z.array(
    z.object({
      requestIndex: z.number(),
      status: z.enum(["ok", "error", "deferred"]),
      continuation: conversationRequestOutputSchema.nullable(),
      page: compactPageOutputSchema.optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
  ),
});
const listConversationsOutputSchema = z.object({
  conversations: z.array(
    z.object({
      id: z.string(),
      source_type: z.string(),
      source_id: nullableStringSchema,
      title: z.string(),
      tags: z.array(z.string()),
      current_revision_id: nullableStringSchema,
      current_node_id: nullableStringSchema,
      created_at: nullableStringSchema,
      updated_at: nullableStringSchema,
      namespace: z.string(),
      user_id: z.string(),
    }),
  ),
  nextCursor: nullableStringSchema,
});
const revisionSummaryOutputSchema = z.object({
  revision_id: z.string(),
  created_at: z.string(),
  node_count: z.number(),
  content_hash: z.string(),
  current: z.boolean(),
});
const revisionHistoryOutputSchema = z.object({
  conversation_id: z.string(),
  current_revision_id: z.string(),
  revisions: z.array(revisionSummaryOutputSchema),
  next_cursor: nullableStringSchema,
});
const verificationOutputSchema = z.object({
  status: z.enum(["passed", "failed"]),
  revision_id: z.string(),
  checked_messages: z.number().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  readback: compactPageOutputSchema.optional(),
  readback_error: z
    .object({ code: z.string(), message: z.string(), offset: z.number() })
    .optional(),
});
const memoryWriteOutputSchema = z.object({
  conversation_id: z.string(),
  revision_id: z.string(),
  durable: z.literal(true),
  indexing: z.union([
    z.object({ status: z.literal("queued"), job_id: z.string() }),
    z.object({
      status: z.literal("failed"),
      error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
    }),
  ]),
  verification: verificationOutputSchema.optional(),
});
const deleteFailureOutputSchema = z.object({
  conversation_id: z.string(),
  stage: z.enum(["tombstone", "canonical", "vectorize", "catalog"]),
  message: z.string(),
});
const deleteConversationsOutputSchema = z.object({
  requested: z.number(),
  deleted: z.array(z.string()),
  missing: z.array(z.string()),
  failed: z.array(deleteFailureOutputSchema),
});
const emptyNamespaceOutputSchema = z.object({
  namespace: z.string(),
  requested: z.number(),
  processed: z.number(),
  deleted: z.number(),
  failed: z.array(deleteFailureOutputSchema),
  remaining: z.number(),
  complete: z.boolean(),
});

function toolResult<T extends object>(value: T) {
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
  return { structuredContent: value, content: [{ type: "text" as const, text }] };
}

export function createMemoryMcpServer(env: AppEnv, tenant: Tenant): McpServer {
  const server = new McpServer({ name: "Ravhi Rizaldi", version: "0.1.0" });

  server.registerTool(
    "memory_search",
    {
      description:
        "Search durable conversation memory and return compact references. Scoped to your namespaces only; the same namespace name in another account is separate and invisible. Tags filter to conversations matching the given tags (tag_mode all = every tag, any = at least one).",
      annotations: readOnlyAnnotations,
      outputSchema: searchOutputSchema,
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
      annotations: readOnlyAnnotations,
      outputSchema: contextOutputSchema,
      inputSchema: z.object({
        chunk_id: z.string().min(1),
        before: z.number().int().min(0).max(10).default(2),
        after: z.number().int().min(0).max(10).default(2),
        format: readFormatSchema,
      }),
    },
    async ({ chunk_id, before, after, format }) =>
      toolResult(
        await getChunkContext(
          env,
          chunk_id,
          before,
          after,
          tenant.namespaces,
          tenant.userId,
          format,
        ),
      ),
  );

  server.registerTool(
    "memory_get_conversation",
    {
      description: "Page through an active timeline or every preserved graph node.",
      annotations: readOnlyAnnotations,
      outputSchema: conversationPageOutputSchema,
      inputSchema: conversationRequestSchema.extend({
        // Preserve the existing single-read ID contract.
        conversation_id: z.string().min(1),
        format: readFormatSchema,
      }),
    },
    async ({ conversation_id, offset, limit, branch, revision_id, format }) => {
      const page = await getConversationPage(
        env,
        conversation_id,
        offset,
        limit,
        branch,
        tenant.namespaces,
        tenant.userId,
        revision_id,
      );
      return toolResult(
        format === "compact" ? boundCompactPage(compactConversationPage(page, offset)) : page,
      );
    },
  );

  server.registerTool(
    "memory_get_conversations",
    {
      description:
        "Read up to 20 known memories in request order as compact pages, with individual errors and explicit continuations. Combined output is at most 48 KiB; follow every continuation, including deferred requests. An oversizedMessage requires a separate read or canonical export; prose is never truncated.",
      annotations: readOnlyAnnotations,
      outputSchema: batchOutputSchema,
      inputSchema: z.object({ requests: z.array(conversationRequestSchema).min(1).max(20) }),
    },
    async ({ requests }) =>
      toolResult(await getConversations(env, requests, tenant.namespaces, tenant.userId)),
  );

  server.registerTool(
    "memory_list_conversations",
    {
      description:
        "List conversation metadata without transcript bodies. Scoped to your namespaces only. Tags filter to conversations matching the given tags (tag_mode all = every tag, any = at least one).",
      annotations: readOnlyAnnotations,
      outputSchema: listConversationsOutputSchema,
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
    "memory_list_revisions",
    {
      description:
        "List the immutable revision history of one owned conversation, newest first, as metadata only. Missing, deleted, and foreign conversations are reported as not found. Pass a returned revision_id to memory_get_conversation to read that revision, and follow next_cursor for older pages.",
      annotations: readOnlyAnnotations,
      outputSchema: revisionHistoryOutputSchema,
      inputSchema: z.object({
        conversation_id: conversationIdSchema,
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).optional(),
      }),
    },
    async (input) => {
      const history = await listConversationRevisions(env, {
        conversationId: input.conversation_id,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        namespaces: tenant.namespaces,
        userId: tenant.userId,
      });
      return toolResult({
        conversation_id: history.conversationId,
        current_revision_id: history.currentRevisionId,
        revisions: history.revisions.map((revision) => ({
          revision_id: revision.revisionId,
          created_at: revision.createdAt,
          node_count: revision.nodeCount,
          content_hash: revision.contentHash,
          current: revision.revisionId === history.currentRevisionId,
        })),
        next_cursor: history.nextCursor,
      });
    },
  );

  server.registerTool(
    "memory_store",
    {
      description:
        "Durably store a new intentional memory before asynchronous indexing. The first write to a new namespace name claims it for your account. Optional verify reloads the committed R2 revision and returns checked compact readback.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      outputSchema: memoryWriteOutputSchema,
      inputSchema: z.object({
        title: z.string().min(1).max(500),
        namespace: z.string().min(1).max(100).default("personal"),
        tags: tagsSchema,
        messages: z.array(messageSchema).min(1).max(1000),
        verify: z.boolean().default(false),
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
      return toolResult(await completeMemoryWrite(env, stored, input.messages, input.verify));
    },
  );

  server.registerTool(
    "memory_append",
    {
      description:
        "Append messages with optimistic revision checking; canonical success precedes indexing. Ownership-checked to your namespaces. Tags add to the conversation's existing tag set. Optional verify returns persisted appended messages and offsets.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      outputSchema: memoryWriteOutputSchema,
      inputSchema: z.object({
        conversation_id: z.string().min(1),
        base_revision_id: z.string().min(1),
        tags: tagsSchema.optional(),
        messages: z.array(messageSchema).min(1).max(100),
        verify: z.boolean().default(false),
      }),
    },
    async ({ conversation_id, base_revision_id, tags, messages, verify }) => {
      const stored = await appendConversation(
        env,
        conversation_id,
        base_revision_id,
        messages,
        tags,
        tenant.namespaces,
        tenant.userId,
      );
      return toolResult(await completeMemoryWrite(env, stored, messages, verify));
    },
  );

  server.registerTool(
    "memory_replace",
    {
      description:
        "Replace a conversation with the complete message list using optimistic revision checking; identity, namespace, title, and tags are preserved. Canonical success precedes indexing. Optional verify checks the committed R2 revision and returns paginated compact readback.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
      outputSchema: memoryWriteOutputSchema,
      inputSchema: z.object({
        conversation_id: conversationIdSchema,
        base_revision_id: z.string().min(1),
        messages: z.array(messageSchema).min(1).max(1000),
        verify: z.boolean().default(false),
      }),
    },
    async ({ conversation_id, base_revision_id, messages, verify }) => {
      const stored = await replaceConversation(
        env,
        conversation_id,
        base_revision_id,
        messages,
        tenant.namespaces,
        tenant.userId,
      );
      return toolResult(await completeMemoryWrite(env, stored, messages, verify));
    },
  );

  server.registerTool(
    "memory_update_tags",
    {
      description:
        "Add or remove conversation tags with optimistic revision checking; base_revision_id must be the current revision. Ownership-checked to your namespaces. Removals apply before additions.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
      outputSchema: z.object({ conversationId: z.string(), tags: z.array(z.string()) }),
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
      outputSchema: deleteConversationsOutputSchema,
      inputSchema: z.object({ conversation_ids: conversationIdsSchema }),
    },
    async ({ conversation_ids }) =>
      toolResult(
        await (async () => {
          await assertAccountWritable(env, tenant.userId);
          return deleteConversations(env, conversation_ids, tenant.namespaces, tenant.userId);
        })(),
      ),
  );

  server.registerTool(
    "memory_empty_namespace",
    {
      description:
        "Delete every conversation in one of your namespaces in bounded batches after an exact namespace confirmation. Ownership of the namespace is kept. Raw imports are retained.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      },
      outputSchema: emptyNamespaceOutputSchema,
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
      await assertAccountWritable(env, tenant.userId, namespace);
      return toolResult(
        await deleteNamespace(env, tenant.userId, scopeNamespaces(tenant, namespace)[0]!),
      );
    },
  );

  server.registerTool(
    "memory_list_namespaces",
    {
      description: "List the namespaces your account owns with conversation counts.",
      annotations: readOnlyAnnotations,
      outputSchema: z.object({
        namespaces: z.array(
          z.object({ namespace: z.string(), conversations: z.number(), default: z.boolean() }),
        ),
      }),
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
      annotations: readOnlyAnnotations,
      outputSchema: z.object({
        namespaces: z.array(
          z.object({
            namespace: z.string(),
            conversations: z.number(),
            messages: z.number(),
            default: z.boolean(),
          }),
        ),
        totals: z.object({ conversations: z.number(), messages: z.number() }),
        indexing: z.object({ pending: z.number(), indexed: z.number() }),
      }),
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
      annotations: readOnlyAnnotations,
      outputSchema: z.object({
        id: z.string().optional(),
        source_type: z.string().optional(),
        filename: z.string().optional(),
        sha256: nullableStringSchema.optional(),
        status: z
          .enum(["uploading", "uploaded", "processing", "complete", "failed", "duplicate"])
          .optional(),
        duplicate_of: nullableStringSchema.optional(),
        checkpoint_ordinal: z.number().optional(),
        total_items: z.number().nullable().optional(),
        processed_items: z.number().optional(),
        error_code: nullableStringSchema.optional(),
        error_message: nullableStringSchema.optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
        error: z.string().optional(),
      }),
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
