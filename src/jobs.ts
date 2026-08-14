import { domainId, digestStream } from "./crypto";
import type { AppEnv, JobMessage } from "./domain";
import { errorDetails } from "./errors";
import { normalizeChatGptConversation } from "./chatgpt";
import { streamJsonArray } from "./json-stream";
import { writeCanonicalConversation } from "./storage";
import { ensureGeneration, indexRevision } from "./indexing";

interface ImportRow {
  id: string;
  filename: string;
  raw_object_key: string;
  sha256: string | null;
  status: string;
  checkpoint_ordinal: number;
}

interface JobRow {
  id: string;
  kind: "import" | "index" | "reindex" | "integrity";
  subject_id: string;
  payload_json: string;
  status: string;
}

interface IndexPayload {
  revisionId: string;
  generationId: string;
}

function safeFilename(filename: string): string {
  return filename.replaceAll(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 180) || "conversations.json";
}

async function insertJob(
  env: AppEnv,
  job: { id: string; kind: JobRow["kind"]; subjectId: string; payload: object },
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.MEMORY_DB.prepare(
    `INSERT INTO jobs
     (id, kind, subject_id, payload_json, status, available_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(job.id, job.kind, job.subjectId, JSON.stringify(job.payload), now, now, now)
    .run();
  return result.meta.changes === 1;
}

async function markIndexQueued(
  env: AppEnv,
  revisionId: string,
  generationId: string,
): Promise<void> {
  await ensureGeneration(env, generationId);
  const now = new Date().toISOString();
  await env.MEMORY_DB.prepare(
    `INSERT INTO chunk_index_state
     (revision_id, generation_id, status, queued_at, updated_at)
     VALUES (?, ?, 'queued', ?, ?)
     ON CONFLICT(revision_id, generation_id) DO UPDATE SET
       status = 'queued', chunk_count = 0, vector_mutation_id = NULL,
       queued_at = excluded.queued_at, started_at = NULL, fts_indexed_at = NULL,
       indexed_at = NULL, failed_at = NULL, error_code = NULL, error_message = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(revisionId, generationId, now, now)
    .run();
}

export async function enqueueImport(env: AppEnv, importId: string): Promise<string> {
  const jobId = await domainId("import-job", importId);
  const created = await insertJob(env, {
    id: jobId,
    kind: "import",
    subjectId: importId,
    payload: { importId },
  });
  if (created) await env.IMPORT_QUEUE.send({ version: 1, job_id: jobId } satisfies JobMessage);
  return jobId;
}

export async function enqueueIndex(
  env: AppEnv,
  revisionId: string,
  generationId = env.ACTIVE_INDEX_GENERATION,
  force = false,
): Promise<string> {
  const jobId = await domainId("index-job", revisionId, generationId);
  const created = await insertJob(env, {
    id: jobId,
    kind: "index",
    subjectId: revisionId,
    payload: { revisionId, generationId },
  });
  if (force && !created) {
    await env.MEMORY_DB.prepare(
      `UPDATE jobs SET status = 'pending', available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
       last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), new Date().toISOString(), jobId)
      .run();
  }
  if (created || force) {
    await markIndexQueued(env, revisionId, generationId);
    await env.INDEX_QUEUE.send({ version: 1, job_id: jobId } satisfies JobMessage);
  }
  return jobId;
}

async function finalizeUploadedImport(
  env: AppEnv,
  importId: string,
): Promise<{ duplicateOf: string | null; sha256: string }> {
  const row = await env.MEMORY_DB.prepare(
    "SELECT id, filename, raw_object_key, sha256, status, checkpoint_ordinal FROM imports WHERE id = ?",
  )
    .bind(importId)
    .first<ImportRow>();
  if (!row) throw new Error("Import not found");
  const object = await env.MEMORY_BUCKET.get(row.raw_object_key);
  if (!object) throw new Error("Uploaded R2 object is missing");
  const checksum = await digestStream(object.body);
  const duplicate = await env.MEMORY_DB.prepare(
    `SELECT id FROM imports WHERE source_type = 'chatgpt' AND sha256 = ? AND id <> ?
     AND status IN ('uploaded', 'processing', 'complete') ORDER BY created_at LIMIT 1`,
  )
    .bind(checksum, importId)
    .first<{ id: string }>();
  const now = new Date().toISOString();
  if (duplicate) {
    await env.MEMORY_DB.prepare(
      "UPDATE imports SET sha256 = ?, status = 'duplicate', duplicate_of = ?, updated_at = ? WHERE id = ?",
    )
      .bind(checksum, duplicate.id, now, importId)
      .run();
    return { duplicateOf: duplicate.id, sha256: checksum };
  }
  await env.MEMORY_DB.prepare(
    "UPDATE imports SET sha256 = ?, status = 'uploaded', updated_at = ? WHERE id = ?",
  )
    .bind(checksum, now, importId)
    .run();
  await env.MEMORY_DB.prepare(
    "UPDATE import_files SET sha256 = ?, size_bytes = ? WHERE import_id = ? AND object_key = ?",
  )
    .bind(checksum, object.size, importId, row.raw_object_key)
    .run();
  await enqueueImport(env, importId);
  return { duplicateOf: null, sha256: checksum };
}

export async function createDirectImport(
  env: AppEnv,
  stream: ReadableStream<Uint8Array>,
  filename: string,
  contentLength: number | null,
): Promise<{ importId: string; duplicateOf: string | null; sha256: string }> {
  const importId = crypto.randomUUID();
  const key = `raw/imports/${importId}/source/${safeFilename(filename)}`;
  const now = new Date().toISOString();
  await env.MEMORY_DB.batch([
    env.MEMORY_DB.prepare(
      `INSERT INTO imports
       (id, source_type, filename, raw_object_key, status, created_at, updated_at)
       VALUES (?, 'chatgpt', ?, ?, 'uploading', ?, ?)`,
    ).bind(importId, filename, key, now, now),
    env.MEMORY_DB.prepare(
      `INSERT INTO import_files (import_id, object_key, kind, size_bytes, created_at)
       VALUES (?, ?, 'original', ?, ?)`,
    ).bind(importId, key, contentLength, now),
  ]);
  await env.MEMORY_BUCKET.put(key, stream, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      import_id: importId,
      source_type: "chatgpt",
      original_filename: safeFilename(filename),
    },
  });
  const finalized = await finalizeUploadedImport(env, importId);
  return { importId, ...finalized };
}

export async function createMultipartImport(
  env: AppEnv,
  filename: string,
): Promise<{ importId: string; uploadId: string; objectKey: string }> {
  const importId = crypto.randomUUID();
  const objectKey = `raw/imports/${importId}/source/${safeFilename(filename)}`;
  const upload = await env.MEMORY_BUCKET.createMultipartUpload(objectKey, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      import_id: importId,
      source_type: "chatgpt",
      original_filename: safeFilename(filename),
    },
  });
  const now = new Date().toISOString();
  await env.MEMORY_DB.batch([
    env.MEMORY_DB.prepare(
      `INSERT INTO imports
       (id, source_type, filename, raw_object_key, status, created_at, updated_at)
       VALUES (?, 'chatgpt', ?, ?, 'uploading', ?, ?)`,
    ).bind(importId, filename, objectKey, now, now),
    env.MEMORY_DB.prepare(
      `INSERT INTO import_files (import_id, object_key, kind, upload_id, created_at)
       VALUES (?, ?, 'original', ?, ?)`,
    ).bind(importId, objectKey, upload.uploadId, now),
  ]);
  return { importId, uploadId: upload.uploadId, objectKey };
}

export async function uploadImportPart(
  env: AppEnv,
  importId: string,
  partNumber: number,
  stream: ReadableStream<Uint8Array>,
  contentLength: number | null,
): Promise<{ etag: string }> {
  const file = await env.MEMORY_DB.prepare(
    "SELECT object_key, upload_id FROM import_files WHERE import_id = ? AND kind = 'original'",
  )
    .bind(importId)
    .first<{ object_key: string; upload_id: string | null }>();
  if (!file?.upload_id) throw new Error("Multipart import not found");
  const upload = env.MEMORY_BUCKET.resumeMultipartUpload(file.object_key, file.upload_id);
  const part = await upload.uploadPart(partNumber, stream);
  await env.MEMORY_DB.prepare(
    `INSERT INTO upload_parts (import_id, part_number, etag, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(import_id, part_number) DO UPDATE SET etag = excluded.etag,
     size_bytes = excluded.size_bytes, created_at = excluded.created_at`,
  )
    .bind(importId, partNumber, part.etag, contentLength, new Date().toISOString())
    .run();
  return { etag: part.etag };
}

export async function completeMultipartImport(
  env: AppEnv,
  importId: string,
): Promise<{ importId: string; duplicateOf: string | null; sha256: string }> {
  const file = await env.MEMORY_DB.prepare(
    "SELECT object_key, upload_id FROM import_files WHERE import_id = ? AND kind = 'original'",
  )
    .bind(importId)
    .first<{ object_key: string; upload_id: string | null }>();
  if (!file?.upload_id) throw new Error("Multipart import not found");
  const parts = await env.MEMORY_DB.prepare(
    "SELECT part_number, etag FROM upload_parts WHERE import_id = ? ORDER BY part_number",
  )
    .bind(importId)
    .all<{ part_number: number; etag: string }>();
  if (!parts.results.length) throw new Error("No multipart upload parts found");
  const upload = env.MEMORY_BUCKET.resumeMultipartUpload(file.object_key, file.upload_id);
  await upload.complete(
    parts.results.map((part) => ({ partNumber: part.part_number, etag: part.etag })),
  );
  const finalized = await finalizeUploadedImport(env, importId);
  return { importId, ...finalized };
}

async function processImportBatch(env: AppEnv, importId: string): Promise<boolean> {
  const row = await env.MEMORY_DB.prepare(
    "SELECT id, filename, raw_object_key, sha256, status, checkpoint_ordinal FROM imports WHERE id = ?",
  )
    .bind(importId)
    .first<ImportRow>();
  if (!row) throw new Error("Import not found");
  if (row.status === "duplicate" || row.status === "complete") return true;
  const object = await env.MEMORY_BUCKET.get(row.raw_object_key);
  if (!object) throw new Error("Original import object is missing from R2");
  await env.MEMORY_DB.prepare(
    "UPDATE imports SET status = 'processing', updated_at = ? WHERE id = ?",
  )
    .bind(new Date().toISOString(), importId)
    .run();

  let ordinal = -1;
  let processedThisRun = 0;
  for await (const rawConversation of streamJsonArray(object.body)) {
    ordinal += 1;
    if (ordinal <= row.checkpoint_ordinal) continue;
    try {
      const normalized = await normalizeChatGptConversation(rawConversation);
      const stored = await writeCanonicalConversation(env, normalized, importId);
      await env.MEMORY_DB.prepare(
        `INSERT INTO import_items
         (import_id, ordinal, source_conversation_id, conversation_id, revision_id, status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'complete', ?)
         ON CONFLICT(import_id, ordinal) DO UPDATE SET conversation_id = excluded.conversation_id,
         revision_id = excluded.revision_id, status = 'complete', error_code = NULL, error_message = NULL,
         updated_at = excluded.updated_at`,
      )
        .bind(
          importId,
          ordinal,
          normalized.sourceId,
          normalized.id,
          stored.revisionId,
          new Date().toISOString(),
        )
        .run();
      if (stored.created) await enqueueIndex(env, stored.revisionId);
    } catch (error) {
      const details = errorDetails(error);
      await env.MEMORY_DB.prepare(
        `INSERT INTO import_items
         (import_id, ordinal, status, error_code, error_message, updated_at)
         VALUES (?, ?, 'failed', ?, ?, ?)
         ON CONFLICT(import_id, ordinal) DO UPDATE SET status = 'failed', error_code = excluded.error_code,
         error_message = excluded.error_message, updated_at = excluded.updated_at`,
      )
        .bind(
          importId,
          ordinal,
          details.code,
          details.message.slice(0, 1000),
          new Date().toISOString(),
        )
        .run();
      if (details.retryable) throw error;
    }
    processedThisRun += 1;
    await env.MEMORY_DB.prepare(
      `UPDATE imports SET checkpoint_ordinal = ?, processed_items = processed_items + 1, updated_at = ? WHERE id = ?`,
    )
      .bind(ordinal, new Date().toISOString(), importId)
      .run();
    if (processedThisRun >= 25) return false;
  }
  await env.MEMORY_DB.prepare(
    `UPDATE imports SET status = 'complete', total_items = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(ordinal + 1, new Date().toISOString(), importId)
    .run();
  return true;
}

async function claimJob(env: AppEnv, jobId: string): Promise<JobRow | null> {
  const now = new Date();
  const owner = crypto.randomUUID();
  const expires = new Date(now.valueOf() + 30_000).toISOString();
  const result = await env.MEMORY_DB.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status <> 'complete' AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
  )
    .bind(owner, expires, now.toISOString(), jobId, now.toISOString())
    .run();
  if (result.meta.changes !== 1) return null;
  return env.MEMORY_DB.prepare(
    "SELECT id, kind, subject_id, payload_json, status FROM jobs WHERE id = ?",
  )
    .bind(jobId)
    .first<JobRow>();
}

export async function processJobMessage(env: AppEnv, message: JobMessage): Promise<void> {
  const job = await claimJob(env, message.job_id);
  if (!job) {
    const existing = await env.MEMORY_DB.prepare("SELECT status FROM jobs WHERE id = ?")
      .bind(message.job_id)
      .first<{ status: string }>();
    if (!existing || existing.status === "complete") return;
    throw new Error("Job is leased; retry later");
  }
  try {
    let complete = true;
    if (job.kind === "import") {
      complete = await processImportBatch(env, job.subject_id);
    } else if (job.kind === "index" || job.kind === "reindex") {
      const payload = JSON.parse(job.payload_json) as IndexPayload;
      await indexRevision(env, payload.revisionId, payload.generationId);
    }
    if (complete) {
      await env.MEMORY_DB.prepare(
        `UPDATE jobs SET status = 'complete', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
      )
        .bind(new Date().toISOString(), job.id)
        .run();
    } else {
      await env.MEMORY_DB.prepare(
        `UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, available_at = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(new Date().toISOString(), new Date().toISOString(), job.id)
        .run();
      await env.IMPORT_QUEUE.send({ version: 1, job_id: job.id } satisfies JobMessage);
    }
  } catch (error) {
    const details = errorDetails(error);
    await env.MEMORY_DB.prepare(
      `UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
       last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(details.code, details.message.slice(0, 1000), new Date().toISOString(), job.id)
      .run();
    throw error;
  }
}

export async function retryJob(env: AppEnv, jobId: string): Promise<void> {
  const job = await env.MEMORY_DB.prepare(
    "SELECT id, kind, subject_id, payload_json, status FROM jobs WHERE id = ?",
  )
    .bind(jobId)
    .first<JobRow>();
  if (!job) throw new Error("Job not found");
  await env.MEMORY_DB.prepare(
    `UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, available_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(new Date().toISOString(), new Date().toISOString(), jobId)
    .run();
  if (job.kind === "index" || job.kind === "reindex") {
    const payload = JSON.parse(job.payload_json) as IndexPayload;
    await markIndexQueued(env, payload.revisionId, payload.generationId);
  }
  const queue = job.kind === "import" ? env.IMPORT_QUEUE : env.INDEX_QUEUE;
  await queue.send({ version: 1, job_id: jobId } satisfies JobMessage);
}

export async function enqueueAllCurrentRevisions(env: AppEnv): Promise<number> {
  const rows = await env.MEMORY_DB.prepare(
    "SELECT current_revision_id FROM conversations WHERE deleted_at IS NULL AND current_revision_id IS NOT NULL",
  ).all<{ current_revision_id: string }>();
  for (const row of rows.results)
    await enqueueIndex(env, row.current_revision_id, env.ACTIVE_INDEX_GENERATION, true);
  return rows.results.length;
}
