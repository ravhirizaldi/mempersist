import { chunkConversation } from "./chunking";
import type { AppEnv, SearchChunk } from "./domain";
import { CHUNK_STRATEGY, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./domain";
import { AppError, errorDetails } from "./errors";
import { loadCanonicalRevision } from "./storage";

export interface EmbeddingEnv {
  AI: {
    run(
      model: typeof EMBEDDING_MODEL,
      input: { text: string[]; truncate_inputs: false },
    ): Promise<unknown>;
  };
}

export type IndexingEnv = Pick<AppEnv, "MEMORY_DB" | "MEMORY_BUCKET"> &
  EmbeddingEnv & {
    MEMORY_VECTOR: Pick<VectorizeIndex, "deleteByIds" | "upsert">;
  };

function groups<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

function embeddingData(value: unknown): number[][] {
  if (!value || typeof value !== "object") throw new Error("Embedding response is not an object");
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("Embedding response has no data array");
  const rows = data.map((row) => {
    if (
      !Array.isArray(row) ||
      row.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
    ) {
      throw new Error("Embedding response contains a malformed row");
    }
    return row as number[];
  });
  if (rows.some((row) => row.length !== EMBEDDING_DIMENSIONS)) {
    throw new Error(`Embedding dimensions do not equal ${EMBEDDING_DIMENSIONS}`);
  }
  return rows;
}

export async function embedTexts(env: EmbeddingEnv, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const output = await env.AI.run(EMBEDDING_MODEL, { text: texts, truncate_inputs: false });
  return embeddingData(output);
}

export async function ensureGeneration(
  env: Pick<AppEnv, "MEMORY_DB">,
  generationId: string,
): Promise<void> {
  await env.MEMORY_DB.prepare(
    `INSERT INTO index_generations
     (id, status, chunk_strategy, embedding_model, embedding_dimensions, vector_index_name, created_at, activated_at)
     VALUES (?, 'active', ?, ?, ?, 'mempersist-bge-m3-v1', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      generationId,
      CHUNK_STRATEGY,
      EMBEDDING_MODEL,
      EMBEDDING_DIMENSIONS,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
}

async function replaceFtsChunks(
  env: IndexingEnv,
  chunks: SearchChunk[],
  revisionId: string,
  generationId: string,
) {
  const existing = await env.MEMORY_DB.prepare(
    "SELECT id FROM chunks WHERE revision_id = ? AND generation_id = ?",
  )
    .bind(revisionId, generationId)
    .all<{ id: string }>();
  for (const batch of groups(existing.results, 50)) {
    await env.MEMORY_DB.batch(
      batch.flatMap(({ id }) => [
        env.MEMORY_DB.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?").bind(id),
        env.MEMORY_DB.prepare("DELETE FROM chunk_sources WHERE chunk_id = ?").bind(id),
        env.MEMORY_DB.prepare("DELETE FROM chunks WHERE id = ?").bind(id),
      ]),
    );
  }

  const now = new Date().toISOString();
  for (const batch of groups(chunks, 15)) {
    const statements: D1PreparedStatement[] = [];
    for (const chunk of batch) {
      statements.push(
        env.MEMORY_DB.prepare(
          `INSERT INTO chunks
           (id, vector_id, revision_id, conversation_id, generation_id, branch_key, ordinal, title, body,
            token_estimate, conversation_timestamp, namespace, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          chunk.id,
          chunk.vectorId,
          chunk.revisionId,
          chunk.conversationId,
          chunk.generationId,
          chunk.branchKey,
          chunk.ordinal,
          chunk.title,
          chunk.body,
          chunk.tokenEstimate,
          chunk.conversationTimestamp,
          chunk.namespace,
          now,
        ),
        env.MEMORY_DB.prepare(
          "INSERT INTO chunk_fts (chunk_id, title, body) VALUES (?, ?, ?)",
        ).bind(chunk.id, chunk.title, chunk.body),
      );
      for (const [ordinal, source] of chunk.sources.entries()) {
        statements.push(
          env.MEMORY_DB.prepare(
            `INSERT INTO chunk_sources
             (chunk_id, source_node_id, source_sequence, char_start, char_end, ordinal)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(
            chunk.id,
            source.sourceNodeId,
            source.sourceSequence,
            source.charStart,
            source.charEnd,
            ordinal,
          ),
        );
      }
    }
    await env.MEMORY_DB.batch(statements);
  }
}

async function isRevisionIndexable(env: IndexingEnv, revisionId: string): Promise<boolean> {
  const row = await env.MEMORY_DB.prepare(
    `SELECT revision.id
     FROM conversation_revisions revision
     JOIN conversations conversation ON conversation.id = revision.conversation_id
       AND conversation.current_revision_id = revision.id
       AND conversation.deleted_at IS NULL
     WHERE revision.id = ?`,
  )
    .bind(revisionId)
    .first<{ id: string }>();
  return row !== null;
}

async function removeDerivedRevision(
  env: IndexingEnv,
  revisionId: string,
  generationId: string,
  chunks: SearchChunk[],
): Promise<void> {
  const stored = await env.MEMORY_DB.prepare(
    "SELECT id, vector_id FROM chunks WHERE revision_id = ? AND generation_id = ?",
  )
    .bind(revisionId, generationId)
    .all<{ id: string; vector_id: string }>();
  const vectorIds = [
    ...new Set([
      ...stored.results.map((row) => row.vector_id),
      ...chunks.map((chunk) => chunk.vectorId),
    ]),
  ];
  for (const batch of groups(vectorIds, 100)) await env.MEMORY_VECTOR.deleteByIds(batch);
  for (const batch of groups(stored.results, 50)) {
    await env.MEMORY_DB.batch(
      batch.flatMap(({ id }) => [
        env.MEMORY_DB.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?").bind(id),
        env.MEMORY_DB.prepare("DELETE FROM chunks WHERE id = ?").bind(id),
      ]),
    );
  }
}

// After a revision is indexed into its generation, supersede vectors from
// older generations for the same revision so a generation rebuild does not
// leave duplicate stale vectors behind. Best-effort: a cleanup failure logs
// and never marks a successfully indexed revision failed, and the deletion
// path later clears every generation's vectors for the revision anyway.
async function supersedeStaleVectors(
  env: IndexingEnv,
  revisionId: string,
  generationId: string,
): Promise<void> {
  try {
    const rows = await env.MEMORY_DB.prepare(
      "SELECT vector_id FROM chunks WHERE revision_id = ? AND generation_id <> ?",
    )
      .bind(revisionId, generationId)
      .all<{ vector_id: string }>();
    const ids = rows.results.map((row) => row.vector_id);
    for (const batch of groups(ids, 100)) await env.MEMORY_VECTOR.deleteByIds(batch);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "vector_supersede_failed",
        revision_id: revisionId,
        generation_id: generationId,
        error: errorDetails(error).message,
      }),
    );
  }
}

export async function indexRevision(
  env: IndexingEnv,
  revisionId: string,
  generationId: string,
): Promise<number> {
  await ensureGeneration(env, generationId);
  if (!(await isRevisionIndexable(env, revisionId))) {
    await removeDerivedRevision(env, revisionId, generationId, []);
    return 0;
  }
  const now = new Date().toISOString();
  const started = await env.MEMORY_DB.prepare(
    `INSERT INTO chunk_index_state
     (revision_id, generation_id, status, attempts, queued_at, started_at, updated_at)
     SELECT ?, ?, 'processing', 1, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM conversation_revisions revision
       JOIN conversations conversation ON conversation.id = revision.conversation_id
         AND conversation.current_revision_id = revision.id
         AND conversation.deleted_at IS NULL
       WHERE revision.id = ?
     )
     ON CONFLICT(revision_id, generation_id) DO UPDATE SET
       status = 'processing', attempts = attempts + 1, started_at = excluded.started_at,
       failed_at = NULL, error_code = NULL, error_message = NULL, updated_at = excluded.updated_at`,
  )
    .bind(revisionId, generationId, now, now, now, revisionId)
    .run();
  if (started.meta.changes !== 1) {
    await removeDerivedRevision(env, revisionId, generationId, []);
    return 0;
  }

  let chunks: SearchChunk[] = [];
  try {
    const loaded = await loadCanonicalRevision(env, revisionId);
    if (!(await isRevisionIndexable(env, revisionId))) {
      await removeDerivedRevision(env, revisionId, generationId, []);
      return 0;
    }
    chunks = await chunkConversation(loaded.conversation, revisionId, generationId);
    await replaceFtsChunks(env, chunks, revisionId, generationId);
    if (!(await isRevisionIndexable(env, revisionId))) {
      await removeDerivedRevision(env, revisionId, generationId, chunks);
      return 0;
    }
    const ftsIndexedAt = new Date().toISOString();
    await env.MEMORY_DB.prepare(
      `UPDATE chunk_index_state SET chunk_count = ?, fts_indexed_at = ?, updated_at = ?
       WHERE revision_id = ? AND generation_id = ?`,
    )
      .bind(chunks.length, ftsIndexedAt, ftsIndexedAt, revisionId, generationId)
      .run();

    let lastMutationId: string | null = null;
    for (const batch of groups(chunks, 32)) {
      const vectors = await embedTexts(
        env,
        batch.map((chunk) => chunk.body),
      );
      if (!(await isRevisionIndexable(env, revisionId))) {
        await removeDerivedRevision(env, revisionId, generationId, chunks);
        return 0;
      }
      const mutation = await env.MEMORY_VECTOR.upsert(
        batch.map((chunk, index) => ({
          id: chunk.vectorId,
          values: vectors[index] ?? [],
          metadata: {
            chunk_id: chunk.id,
            conversation_id: chunk.conversationId,
            source_type: loaded.manifest.sourceType,
            generation: generationId,
            strategy: CHUNK_STRATEGY,
            namespace: chunk.namespace,
            timestamp: chunk.conversationTimestamp ?? "",
          },
        })),
      );
      lastMutationId =
        "mutationId" in mutation && typeof mutation.mutationId === "string"
          ? mutation.mutationId
          : null;
      if (!(await isRevisionIndexable(env, revisionId))) {
        await removeDerivedRevision(env, revisionId, generationId, chunks);
        return 0;
      }
    }
    if (!(await isRevisionIndexable(env, revisionId))) {
      await removeDerivedRevision(env, revisionId, generationId, chunks);
      return 0;
    }
    const indexedAt = new Date().toISOString();
    await env.MEMORY_DB.prepare(
      `UPDATE chunk_index_state SET status = 'indexed', vector_mutation_id = ?, indexed_at = ?,
       failed_at = NULL, error_code = NULL, error_message = NULL, updated_at = ?
       WHERE revision_id = ? AND generation_id = ?`,
    )
      .bind(lastMutationId, indexedAt, indexedAt, revisionId, generationId)
      .run();
    await supersedeStaleVectors(env, revisionId, generationId);
    return chunks.length;
  } catch (error) {
    if (!(await isRevisionIndexable(env, revisionId))) {
      await removeDerivedRevision(env, revisionId, generationId, chunks);
      return 0;
    }
    const details = errorDetails(error);
    const failedAt = new Date().toISOString();
    await env.MEMORY_DB.prepare(
      `UPDATE chunk_index_state SET status = 'failed', error_code = ?, error_message = ?,
       failed_at = ?, updated_at = ? WHERE revision_id = ? AND generation_id = ?`,
    )
      .bind(
        details.code,
        details.message.slice(0, 1000),
        failedAt,
        failedAt,
        revisionId,
        generationId,
      )
      .run();
    throw new AppError(
      "DERIVED_INDEXING",
      `Canonical revision is safe; indexing failed: ${details.message}`,
      503,
      true,
    );
  }
}
