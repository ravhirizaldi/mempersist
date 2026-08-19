import { Hono } from "hono";
import { z } from "zod";
import { isAuthorized, unauthorized } from "./auth";
import { createMcpConversation } from "./chatgpt";
import type { AppEnv } from "./domain";
import { AppError } from "./errors";
import {
  completeMultipartImport,
  createDirectImport,
  createMultipartImport,
  enqueueAllCurrentRevisions,
  enqueueIndex,
  retryJob,
  uploadImportPart,
} from "./jobs";
import { getChunkContext, getConversationPage, verifyIntegrity } from "./retrieval";
import { searchMemory } from "./search";
import { appendConversation, listConversations, writeCanonicalConversation } from "./storage";
import {
  grantNamespace,
  OWNER_USER_ID,
  resolveTenant,
  scopeNamespaces,
  type Tenant,
} from "./tenant";

function ownerTenant(env: AppEnv): Promise<Tenant> {
  return resolveTenant(env, { userId: OWNER_USER_ID });
}

type Variables = { requestId: string };
const app = new Hono<{ Bindings: AppEnv; Variables: Variables }>();

const messageSchema = z.object({
  role: z.string().min(1).max(40),
  content: z.string().max(1_000_000),
  timestamp: z.iso.datetime().optional(),
});
const storeSchema = z.object({
  title: z.string().min(1).max(500),
  namespace: z.string().min(1).max(100).default("personal"),
  messages: z.array(messageSchema).min(1).max(1000),
});
const appendSchema = z.object({
  base_revision_id: z.string().min(1),
  messages: z.array(messageSchema).min(1).max(100),
});

app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  await next();
  c.header("X-Request-Id", c.get("requestId"));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
});

app.use("/api/*", async (c, next) => {
  if (!(await isAuthorized(c.req.raw, c.env))) return unauthorized();
  await next();
});

app.get("/healthz", (c) => c.json({ status: "ok" }));
app.get("/readyz", async (c) => {
  await c.env.MEMORY_DB.prepare("SELECT 1 AS ready").first();
  return c.json({ status: "ready" });
});

app.get("/api/search", async (c) => {
  const query = z.string().min(1).max(2000).parse(c.req.query("q"));
  const limit = z.coerce.number().int().min(1).max(20).default(8).parse(c.req.query("limit"));
  const namespace = z.string().min(1).max(100).optional().parse(c.req.query("namespace"));
  const tenant = await ownerTenant(c.env);
  const namespaces = scopeNamespaces(tenant, namespace);
  return c.json(await searchMemory(c.env, { query, limit, namespaces, userId: tenant.userId }));
});

app.get("/api/conversations", async (c) => {
  const limit = z.coerce.number().int().min(1).max(100).default(20).parse(c.req.query("limit"));
  const cursor = z.string().optional().parse(c.req.query("cursor"));
  const namespace = z.string().min(1).max(100).optional().parse(c.req.query("namespace"));
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
  return c.json(
    await getConversationPage(
      c.env,
      c.req.param("id"),
      offset,
      limit,
      branch,
      tenant.namespaces,
      tenant.userId,
    ),
  );
});

app.get("/api/chunks/:id/context", async (c) => {
  const before = z.coerce.number().int().min(0).max(10).default(2).parse(c.req.query("before"));
  const after = z.coerce.number().int().min(0).max(10).default(2).parse(c.req.query("after"));
  const tenant = await ownerTenant(c.env);
  return c.json(
    await getChunkContext(
      c.env,
      c.req.param("id"),
      before,
      after,
      tenant.namespaces,
      tenant.userId,
    ),
  );
});

app.post("/api/memories", async (c) => {
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > 1024 * 1024) throw new AppError("VALIDATION", "JSON body exceeds 1 MiB", 413);
  const input = storeSchema.parse(await c.req.json());
  const tenant = await ownerTenant(c.env);
  const namespace = input.namespace ?? tenant.defaultNamespace;
  if (!tenant.namespaces.includes(namespace)) {
    await grantNamespace(c.env, tenant.userId, namespace);
  }
  const conversation = await createMcpConversation({ ...input, namespace });
  const stored = await writeCanonicalConversation(c.env, conversation, null, null, tenant.userId);
  const jobId = await enqueueIndex(c.env, stored.revisionId);
  return c.json(
    {
      conversation_id: stored.conversationId,
      revision_id: stored.revisionId,
      durable: true,
      indexing: { status: "queued", job_id: jobId },
    },
    201,
  );
});

app.post("/api/conversations/:id/append", async (c) => {
  const input = appendSchema.parse(await c.req.json());
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
  const jobId = await enqueueIndex(c.env, stored.revisionId);
  return c.json({
    revision_id: stored.revisionId,
    durable: true,
    indexing: { status: "queued", job_id: jobId },
  });
});

app.post("/api/imports/direct", async (c) => {
  const lengthHeader = c.req.header("content-length");
  const length = lengthHeader ? Number(lengthHeader) : null;
  if (length === null || !Number.isFinite(length) || length <= 0) {
    throw new AppError("VALIDATION", "Content-Length is required for direct imports", 411);
  }
  if (length > 16 * 1024 * 1024) {
    throw new AppError("VALIDATION", "Direct import limit is 16 MiB; use multipart upload", 413);
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
  if (length !== null && length > 16 * 1024 * 1024) {
    throw new AppError("VALIDATION", "Multipart part exceeds 16 MiB", 413);
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
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
});

export default app;
