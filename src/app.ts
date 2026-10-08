import { Hono } from "hono";
import { z } from "zod";
import { isAuthorized, unauthorized } from "./auth";
import { createMcpConversation } from "./chatgpt";
import type { AppEnv } from "./domain";
import { AppError } from "./errors";
import {
  isLocale,
  localeCookie,
  localeHeaders,
  resolveLocale,
  safeReturnPath,
  type Locale,
} from "./i18n";
import {
  completeMultipartImport,
  createDirectImport,
  createMultipartImport,
  enqueueAllCurrentRevisions,
  retryJob,
  uploadImportPart,
} from "./jobs";
import {
  assertInlineWriteBudget,
  BATCH_DEFAULT_SERIALIZED_BYTES,
  BATCH_MAX_SERIALIZED_BYTES,
  BATCH_MIN_SERIALIZED_BYTES,
  DEFAULT_SEARCH_ITEMS,
  MAX_APPEND_MESSAGES,
  MAX_BATCH_CURSOR_CHARS,
  MAX_DIRECT_IMPORT_BYTES,
  MAX_INLINE_JSON_WRITE_BYTES,
  MAX_MESSAGE_CONTENT_CHARS,
  MAX_MESSAGE_ROLE_CHARS,
  MAX_MULTIPART_PART_BYTES,
  MAX_NAMESPACE_CHARS,
  MAX_SEARCH_ITEMS,
  MAX_SEARCH_QUERY_CHARS,
  MAX_STORE_MESSAGES,
  MAX_TITLE_CHARS,
  requestTooLargeError,
} from "./limits";
import {
  boundCompactPage,
  compactConversationPage,
  getChunkContext,
  getConversationPage,
  verifyIntegrity,
} from "./retrieval";
import { completeMemoryWrite } from "./writes";
import { searchMemory } from "./search";
import { landingRoutes } from "./landing";
import {
  llmsTxtResponse,
  manifestResponse,
  robotsResponse,
  securityTxtResponse,
  siteCssResponse,
  siteScriptResponse,
  sitemapResponse,
} from "./discovery";
import {
  appendConversation,
  cleanupPreparedCommitBatches,
  listConversations,
  writeCanonicalConversation,
} from "./storage";
import {
  assertAccountWritable,
  grantNamespace,
  OWNER_USER_ID,
  resolveTenant,
  scopeNamespaces,
  type Tenant,
} from "./tenant";

function ownerTenant(env: AppEnv): Promise<Tenant> {
  return resolveTenant(env, { userId: OWNER_USER_ID });
}

type Variables = { requestId: string; locale: Locale };
const app = new Hono<{ Bindings: AppEnv; Variables: Variables }>();

const messageSchema = z.object({
  role: z.string().min(1).max(MAX_MESSAGE_ROLE_CHARS),
  content: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
  timestamp: z.iso.datetime().optional(),
});
const storeSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  namespace: z.string().min(1).max(MAX_NAMESPACE_CHARS).default("personal"),
  messages: z.array(messageSchema).min(1).max(MAX_STORE_MESSAGES),
  verify: z.boolean().default(false),
});
const appendSchema = z.object({
  base_revision_id: z.string().min(1),
  messages: z.array(messageSchema).min(1).max(MAX_APPEND_MESSAGES),
  verify: z.boolean().default(false),
});
const cleanupPreparedCommitBatchesSchema = z
  .object({ older_than: z.iso.datetime().optional() })
  .strict();

app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.set("locale", resolveLocale(c.req.raw));
  await next();
  c.header("X-Request-Id", c.get("requestId"));
  if (!c.res.headers.has("X-Content-Type-Options")) c.header("X-Content-Type-Options", "nosniff");
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

app.use("/api/*", async (c, next) => {
  if (!(await isAuthorized(c.req.raw, c.env))) return unauthorized();
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    await assertAccountWritable(c.env, (await ownerTenant(c.env)).userId);
  }
  await next();
});

app.get("/healthz", (c) => c.json({ status: "ok" }));
app.get("/readyz", async (c) => {
  await c.env.MEMORY_DB.prepare("SELECT 1 AS ready").first();
  return c.json({ status: "ready" });
});
app.get("/robots.txt", () => robotsResponse());
app.get("/sitemap.xml", () => sitemapResponse());
app.get("/.well-known/security.txt", () => securityTxtResponse());
app.get("/site.webmanifest", () => manifestResponse());
app.get("/llms.txt", () => llmsTxtResponse());
app.get("/site.css", (c) => siteCssResponse(c.req.query("v")));
app.get("/site.js", (c) => siteScriptResponse(c.req.query("v")));
for (const [path, handler] of Object.entries(landingRoutes)) {
  app.get(path, (c) => handler(c.get("locale")));
}

app.get("/language/:locale", (c) => {
  const locale = c.req.param("locale");
  if (!isLocale(locale)) return c.text("Unsupported locale", 404);
  const target = safeReturnPath(c.req.query("return_to"));
  return new Response(null, {
    status: 303,
    headers: {
      Location: target,
      "Set-Cookie": localeCookie(locale),
      ...localeHeaders(locale),
    },
  });
});

app.get("/api/search", async (c) => {
  const queryParams = c.req.query();
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_ITEMS)
    .default(DEFAULT_SEARCH_ITEMS)
    .parse(queryParams.limit);
  const maxSerializedBytes = z.coerce
    .number()
    .int()
    .min(BATCH_MIN_SERIALIZED_BYTES)
    .max(BATCH_MAX_SERIALIZED_BYTES)
    .default(BATCH_DEFAULT_SERIALIZED_BYTES)
    .parse(queryParams.max_serialized_bytes);
  const cursor = z.string().min(1).max(MAX_BATCH_CURSOR_CHARS).optional().parse(queryParams.cursor);
  const tenant = await ownerTenant(c.env);
  if (cursor !== undefined) {
    if (
      queryParams.q !== undefined ||
      queryParams.namespace !== undefined ||
      queryParams.tags !== undefined ||
      queryParams.tag_mode !== undefined ||
      queryParams.filter !== undefined
    ) {
      throw new AppError(
        "VALIDATION",
        "Search cursor continuation cannot include query or filters",
        400,
      );
    }
    return c.json(
      await searchMemory(c.env, {
        cursor,
        limit,
        maxSerializedBytes,
        paginate: true,
        namespaces: tenant.namespaces,
        userId: tenant.userId,
      }),
    );
  }
  const query = z.string().min(1).max(MAX_SEARCH_QUERY_CHARS).parse(queryParams.q);
  const namespace = z
    .string()
    .min(1)
    .max(MAX_NAMESPACE_CHARS)
    .optional()
    .parse(queryParams.namespace);
  return c.json(
    await searchMemory(c.env, {
      query,
      limit,
      maxSerializedBytes,
      paginate: true,
      namespaces: scopeNamespaces(tenant, namespace),
      userId: tenant.userId,
    }),
  );
});

app.get("/api/conversations", async (c) => {
  const limit = z.coerce.number().int().min(1).max(100).default(20).parse(c.req.query("limit"));
  const cursor = z.string().optional().parse(c.req.query("cursor"));
  const namespace = z
    .string()
    .min(1)
    .max(MAX_NAMESPACE_CHARS)
    .optional()
    .parse(c.req.query("namespace"));
  const tenant = await ownerTenant(c.env);
  const namespaces = scopeNamespaces(tenant, namespace);
  return c.json(
    await listConversations(c.env, {
      limit,
      ...(cursor ? { cursor } : {}),
      namespaces,
      userId: tenant.userId,
    }),
  );
});

app.get("/api/conversations/:id", async (c) => {
  const offset = z.coerce.number().int().min(0).default(0).parse(c.req.query("offset"));
  const limit = z.coerce.number().int().min(1).max(100).default(20).parse(c.req.query("limit"));
  const branch = z.enum(["active", "all"]).default("active").parse(c.req.query("branch"));
  const tenant = await ownerTenant(c.env);
  const format = z.enum(["compact", "canonical"]).default("canonical").parse(c.req.query("format"));
  const revisionId = z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional()
    .parse(c.req.query("revision_id"));
  const page = await getConversationPage(
    c.env,
    c.req.param("id"),
    offset,
    limit,
    branch,
    tenant.namespaces,
    tenant.userId,
    revisionId,
  );
  return c.json(
    format === "compact" ? boundCompactPage(compactConversationPage(page, offset)) : page,
  );
});

app.get("/api/chunks/:id/context", async (c) => {
  const before = z.coerce.number().int().min(0).max(10).default(2).parse(c.req.query("before"));
  const after = z.coerce.number().int().min(0).max(10).default(2).parse(c.req.query("after"));
  const format = z.enum(["compact", "canonical"]).default("canonical").parse(c.req.query("format"));
  const tenant = await ownerTenant(c.env);
  return c.json(
    await getChunkContext(
      c.env,
      c.req.param("id"),
      before,
      after,
      tenant.namespaces,
      tenant.userId,
      format,
    ),
  );
});

app.post("/api/memories", async (c) => {
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_INLINE_JSON_WRITE_BYTES) {
    throw requestTooLargeError(
      `JSON body exceeds the ${MAX_INLINE_JSON_WRITE_BYTES} byte inline write limit; split the messages across multiple requests`,
      length,
      MAX_INLINE_JSON_WRITE_BYTES,
    );
  }
  const input = storeSchema.parse(await c.req.json());
  assertInlineWriteBudget(JSON.stringify(input), input.messages.length);
  const tenant = await ownerTenant(c.env);
  const namespace = input.namespace ?? tenant.defaultNamespace;
  if (!tenant.namespaces.includes(namespace)) {
    await grantNamespace(c.env, tenant.userId, namespace);
  }
  const conversation = await createMcpConversation({ ...input, namespace });
  const stored = await writeCanonicalConversation(c.env, conversation, null, null, tenant.userId);
  return c.json(await completeMemoryWrite(c.env, stored, input.messages, input.verify), 201);
});

app.post("/api/conversations/:id/append", async (c) => {
  const input = appendSchema.parse(await c.req.json());
  assertInlineWriteBudget(JSON.stringify(input), input.messages.length);
  const tenant = await ownerTenant(c.env);
  const stored = await appendConversation(
    c.env,
    c.req.param("id"),
    input.base_revision_id,
    input.messages,
    undefined,
    tenant.namespaces,
    tenant.userId,
  );
  const result = await completeMemoryWrite(c.env, stored, input.messages, input.verify);
  return c.json({
    revision_id: result.revision_id,
    durable: result.durable,
    indexing: result.indexing,
    ...(result.verification ? { verification: result.verification } : {}),
    ...(result.readback_requests ? { readback_requests: result.readback_requests } : {}),
    ...(result.omitted ? { omitted: result.omitted } : {}),
    used_serialized_bytes: result.used_serialized_bytes,
    max_serialized_bytes: result.max_serialized_bytes,
  });
});

app.post("/api/imports/direct", async (c) => {
  const lengthHeader = c.req.header("content-length");
  const length = lengthHeader ? Number(lengthHeader) : null;
  if (length === null || !Number.isFinite(length) || length <= 0) {
    throw new AppError("VALIDATION", "Content-Length is required for direct imports", 411);
  }
  if (length > MAX_DIRECT_IMPORT_BYTES) {
    throw requestTooLargeError(
      `Direct import body exceeds the ${MAX_DIRECT_IMPORT_BYTES} byte limit; use multipart upload instead`,
      length,
      MAX_DIRECT_IMPORT_BYTES,
    );
  }
  if (!c.req.raw.body) throw new AppError("VALIDATION", "Import body is required", 400);
  const filename = c.req.header("x-filename") ?? "conversations.json";
  return c.json(await createDirectImport(c.env, c.req.raw.body, filename, length), 202);
});

app.post("/api/imports/multipart", async (c) => {
  const input = z.object({ filename: z.string().min(1).max(255) }).parse(await c.req.json());
  return c.json(await createMultipartImport(c.env, input.filename), 201);
});

app.put("/api/imports/:id/parts/:part", async (c) => {
  const part = z.coerce.number().int().min(1).max(10_000).parse(c.req.param("part"));
  const lengthHeader = c.req.header("content-length");
  const length = lengthHeader ? Number(lengthHeader) : null;
  if (length !== null && length > MAX_MULTIPART_PART_BYTES) {
    throw requestTooLargeError(
      `Multipart part exceeds the ${MAX_MULTIPART_PART_BYTES} byte limit; split the upload into smaller parts`,
      length,
      MAX_MULTIPART_PART_BYTES,
    );
  }
  if (!c.req.raw.body) throw new AppError("VALIDATION", "Part body is required", 400);
  return c.json(await uploadImportPart(c.env, c.req.param("id"), part, c.req.raw.body, length));
});

app.post("/api/imports/:id/complete", async (c) =>
  c.json(await completeMultipartImport(c.env, c.req.param("id")), 202),
);

app.get("/api/imports/:id", async (c) => {
  const row = await c.env.MEMORY_DB.prepare(
    `SELECT id, source_type, filename, sha256, status, duplicate_of, checkpoint_ordinal, total_items,
     processed_items, error_code, error_message, created_at, updated_at FROM imports WHERE id = ?`,
  )
    .bind(c.req.param("id"))
    .first();
  if (!row) throw new AppError("NOT_FOUND", "Import not found", 404);
  const failures = await c.env.MEMORY_DB.prepare(
    "SELECT ordinal, error_code, error_message FROM import_items WHERE import_id = ? AND status = 'failed' ORDER BY ordinal LIMIT 100",
  )
    .bind(c.req.param("id"))
    .all();
  return c.json({ ...row, failures: failures.results });
});

app.post("/api/admin/jobs/:id/retry", async (c) => {
  await retryJob(c.env, c.req.param("id"));
  return c.json({ status: "queued" }, 202);
});

app.post("/api/admin/reindex", async (c) =>
  c.json({ queued: await enqueueAllCurrentRevisions(c.env) }, 202),
);
app.get("/api/admin/integrity", async (c) => c.json(await verifyIntegrity(c.env)));
app.post("/api/admin/commit-batches/cleanup", async (c) => {
  const body = await c.req.text();
  let parsedBody: unknown = {};
  if (body.trim()) {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      throw new AppError("VALIDATION", "Request body must be valid JSON", 400);
    }
  }
  const input = cleanupPreparedCommitBatchesSchema.parse(parsedBody);
  const olderThan = input.older_than ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const deletedObjects = await cleanupPreparedCommitBatches(c.env, olderThan);
  return c.json({ deleted_objects: deletedObjects, older_than: olderThan });
});

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404));
app.onError((error, c) => {
  const appError = error instanceof AppError ? error : null;
  const status = appError?.status ?? (error instanceof z.ZodError ? 400 : 500);
  const code =
    appError?.code ?? (error instanceof z.ZodError ? "VALIDATION" : "RETRYABLE_INFRASTRUCTURE");
  const message =
    error instanceof z.ZodError
      ? z.prettifyError(error)
      : (appError?.message ?? "Internal server error");
  console.error(
    JSON.stringify({
      message: "request_failed",
      request_id: c.get("requestId"),
      code,
      path: c.req.path,
    }),
  );
  return new Response(JSON.stringify({ error: { code, message, ...(appError?.details ?? {}) } }), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
});

export default app;
