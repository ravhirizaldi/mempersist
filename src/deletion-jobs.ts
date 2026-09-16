import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { deleteAllMemories, deleteNamespace } from "./deletion";
import type { AppEnv, JobMessage } from "./domain";
import { errorDetails } from "./errors";

const DAY_SECONDS = 86_400;
const ACCOUNT_GRACE_MS = 7 * DAY_SECONDS * 1000;
const LEASE_MS = 10 * 60 * 1000;
const IMPORT_BATCH = 25;

type DeletionOAuth = Pick<OAuthHelpers, "listUserGrants" | "revokeGrant">;

interface DeletionJob {
  id: string;
  kind: "namespace" | "account";
  user_id: string;
  namespace: string | null;
  status: "pending" | "running" | "failed";
  phase: "delete" | "grants" | "conversations" | "imports" | "final";
  due_at: string;
}

function delayUntil(dueAt: string, now: Date): number {
  return Math.max(1, Math.min(DAY_SECONDS, Math.ceil((Date.parse(dueAt) - now.valueOf()) / 1000)));
}

async function enqueue(env: AppEnv, jobId: string, delaySeconds?: number): Promise<void> {
  await env.IMPORT_QUEUE.send(
    { version: 1, job_id: jobId } satisfies JobMessage,
    delaySeconds ? { delaySeconds } : undefined,
  );
}

export async function scheduleNamespaceDeletion(
  env: AppEnv,
  userId: string,
  namespace: string,
  now = new Date(),
): Promise<string> {
  const jobId = crypto.randomUUID();
  const timestamp = now.toISOString();
  const results = await env.MEMORY_DB.batch([
    env.MEMORY_DB.prepare(
      `INSERT INTO deletion_jobs
       (id, kind, user_id, namespace, status, phase, due_at, created_at, updated_at)
       SELECT ?, 'namespace', ?, ?, 'pending', 'delete', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM user_namespaces
         WHERE user_id = ? AND namespace = ? AND deletion_job_id IS NULL
       )`,
    ).bind(jobId, userId, namespace, timestamp, timestamp, timestamp, userId, namespace),
    env.MEMORY_DB.prepare(
      `UPDATE user_namespaces SET deletion_job_id = ?
       WHERE user_id = ? AND namespace = ? AND deletion_job_id IS NULL`,
    ).bind(jobId, userId, namespace),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new Error("Namespace is missing or already being emptied");
  }
  await enqueue(env, jobId);
  return jobId;
}

export async function scheduleAccountDeletion(
  env: AppEnv,
  userId: string,
  now = new Date(),
): Promise<{ jobId: string; dueAt: string }> {
  const jobId = crypto.randomUUID();
  const createdAt = now.toISOString();
  const dueAt = new Date(now.valueOf() + ACCOUNT_GRACE_MS).toISOString();
  const results = await env.MEMORY_DB.batch([
    env.MEMORY_DB.prepare(
      `INSERT INTO deletion_jobs
       (id, kind, user_id, status, phase, due_at, created_at, updated_at)
       SELECT ?, 'account', ?, 'pending', 'grants', ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND deletion_job_id IS NULL)`,
    ).bind(jobId, userId, dueAt, createdAt, createdAt, userId),
    env.MEMORY_DB.prepare(
      "UPDATE users SET deletion_job_id = ? WHERE id = ? AND deletion_job_id IS NULL",
    ).bind(jobId, userId),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new Error("Account deletion is already pending");
  }
  await enqueue(env, jobId, DAY_SECONDS);
  return { jobId, dueAt };
}

export async function cancelAccountDeletion(
  env: AppEnv,
  userId: string,
  jobId: string,
): Promise<boolean> {
  const results = await env.MEMORY_DB.batch([
    env.MEMORY_DB.prepare(
      `UPDATE users SET deletion_job_id = NULL
       WHERE id = ? AND deletion_job_id = ? AND EXISTS (
         SELECT 1 FROM deletion_jobs
         WHERE id = ? AND user_id = ? AND kind = 'account' AND status = 'pending'
       )`,
    ).bind(userId, jobId, jobId, userId),
    env.MEMORY_DB.prepare(
      "DELETE FROM deletion_jobs WHERE id = ? AND user_id = ? AND kind = 'account' AND status = 'pending'",
    ).bind(jobId, userId),
  ]);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
}

async function claimJob(env: AppEnv, jobId: string, now: Date): Promise<DeletionJob | null> {
  const owner = crypto.randomUUID();
  const timestamp = now.toISOString();
  const result = await env.MEMORY_DB.prepare(
    `UPDATE deletion_jobs SET status = 'running', attempts = attempts + 1,
       lease_owner = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND (
       status IN ('pending', 'failed') OR (status = 'running' AND lease_expires_at < ?)
     )`,
  )
    .bind(owner, new Date(now.valueOf() + LEASE_MS).toISOString(), timestamp, jobId, timestamp)
    .run();
  if (result.meta.changes !== 1) return null;
  return env.MEMORY_DB.prepare(
    "SELECT id, kind, user_id, namespace, status, phase, due_at FROM deletion_jobs WHERE id = ?",
  )
    .bind(jobId)
    .first<DeletionJob>();
}

async function continueJob(
  env: AppEnv,
  job: DeletionJob,
  phase: DeletionJob["phase"],
): Promise<void> {
  await env.MEMORY_DB.prepare(
    `UPDATE deletion_jobs SET status = 'pending', phase = ?, lease_owner = NULL,
     lease_expires_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = ?
     WHERE id = ?`,
  )
    .bind(phase, new Date().toISOString(), job.id)
    .run();
  await enqueue(env, job.id);
}

async function failJob(env: AppEnv, jobId: string, error: unknown): Promise<void> {
  const details = errorDetails(error);
  await env.MEMORY_DB.prepare(
    `UPDATE deletion_jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
     last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(details.code, details.message.slice(0, 1000), new Date().toISOString(), jobId)
    .run();
}

async function deleteImportBatch(env: AppEnv, userId: string): Promise<boolean> {
  const imports = await env.MEMORY_DB.prepare(
    "SELECT id, raw_object_key FROM imports WHERE user_id = ? ORDER BY id LIMIT ?",
  )
    .bind(userId, IMPORT_BATCH)
    .all<{ id: string; raw_object_key: string }>();
  if (!imports.results.length) return true;
  for (const item of imports.results) {
    const files = await env.MEMORY_DB.prepare(
      "SELECT object_key FROM import_files WHERE import_id = ? ORDER BY object_key",
    )
      .bind(item.id)
      .all<{ object_key: string }>();
    const keys = [
      ...new Set([item.raw_object_key, ...files.results.map((file) => file.object_key)]),
    ];
    if (keys.length) await env.MEMORY_BUCKET.delete(keys);
    await env.MEMORY_DB.prepare("DELETE FROM imports WHERE id = ? AND user_id = ?")
      .bind(item.id, userId)
      .run();
  }
  return imports.results.length < IMPORT_BATCH;
}

async function finishAccountDeletion(env: AppEnv, job: DeletionJob): Promise<void> {
  const user = await env.MEMORY_DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(job.user_id)
    .first<{ email: string }>();
  if (!user) {
    await env.MEMORY_DB.prepare("DELETE FROM deletion_jobs WHERE user_id = ?")
      .bind(job.user_id)
      .run();
    return;
  }
  await env.MEMORY_DB.batch([
    env.MEMORY_DB.prepare("DELETE FROM auth_magic_links WHERE email = ?").bind(user.email),
    env.MEMORY_DB.prepare("DELETE FROM dashboard_magic_links WHERE email = ?").bind(user.email),
    env.MEMORY_DB.prepare("DELETE FROM dashboard_sessions WHERE user_id = ?").bind(job.user_id),
    env.MEMORY_DB.prepare("DELETE FROM user_namespaces WHERE user_id = ?").bind(job.user_id),
    env.MEMORY_DB.prepare("DELETE FROM users WHERE id = ?").bind(job.user_id),
    env.MEMORY_DB.prepare("DELETE FROM deletion_jobs WHERE user_id = ?").bind(job.user_id),
  ]);
}

async function processClaimed(env: AppEnv, job: DeletionJob, oauth: DeletionOAuth): Promise<void> {
  if (job.kind === "namespace") {
    const result = await deleteNamespace(env, job.user_id, job.namespace!);
    if (result.failed.length)
      throw new Error(result.failed[0]?.message ?? "Namespace deletion failed");
    if (!result.complete) return continueJob(env, job, "delete");
    await env.MEMORY_DB.batch([
      env.MEMORY_DB.prepare(
        "UPDATE user_namespaces SET deletion_job_id = NULL WHERE user_id = ? AND namespace = ? AND deletion_job_id = ?",
      ).bind(job.user_id, job.namespace, job.id),
      env.MEMORY_DB.prepare("DELETE FROM deletion_jobs WHERE id = ?").bind(job.id),
    ]);
    return;
  }

  if (job.phase === "grants") {
    const grants = await oauth.listUserGrants(job.user_id, { limit: 50 });
    await Promise.all(grants.items.map((grant) => oauth.revokeGrant(grant.id, job.user_id)));
    return continueJob(env, job, grants.items.length ? "grants" : "conversations");
  }
  if (job.phase === "conversations") {
    const namespaces = await env.MEMORY_DB.prepare(
      "SELECT namespace FROM user_namespaces WHERE user_id = ? ORDER BY namespace",
    )
      .bind(job.user_id)
      .all<{ namespace: string }>();
    const result = await deleteAllMemories(
      env,
      job.user_id,
      namespaces.results.map((row) => row.namespace),
    );
    if (result.failed.length)
      throw new Error(result.failed[0]?.message ?? "Account deletion failed");
    return continueJob(env, job, result.complete ? "imports" : "conversations");
  }
  if (job.phase === "imports") {
    return continueJob(env, job, (await deleteImportBatch(env, job.user_id)) ? "final" : "imports");
  }
  await finishAccountDeletion(env, job);
}

export async function processDeletionJobMessage(
  env: AppEnv,
  message: JobMessage,
  oauth: DeletionOAuth,
  now = new Date(),
): Promise<boolean> {
  const pending = await env.MEMORY_DB.prepare(
    "SELECT id, kind, user_id, namespace, status, phase, due_at FROM deletion_jobs WHERE id = ?",
  )
    .bind(message.job_id)
    .first<DeletionJob>();
  if (!pending) return false;
  if (Date.parse(pending.due_at) > now.valueOf()) {
    await enqueue(env, pending.id, delayUntil(pending.due_at, now));
    return true;
  }
  const job = await claimJob(env, pending.id, now);
  if (!job) return true;
  try {
    await processClaimed(env, job, oauth);
  } catch (error) {
    await failJob(env, job.id, error);
    throw error;
  }
  return true;
}
