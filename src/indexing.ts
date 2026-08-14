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
    MEMORY_VECTOR: Pick<VectorizeIndex, "upsert">;
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

export async function indexRevision(
  env: IndexingEnv,
  revisionId: string,
  generationId: string,
): Promise<number> {
  await ensureGeneration(env, generationId);
  const now = new Date().toISOString();
  await env.MEMORY_DB.prepare(
    `INSERT INTO chunk_index_state
     (revision_id, generation_id, status, attempts, queued_at, started_at, updated_at)
     VALUES (?, ?, 'processing', 1, ?, ?, ?)
     ON CONFLICT(revision_id, generation_id) DO UPDATE SET
       status = 'processing', attempts = attempts + 1, started_at = excluded.started_at,
       failed_at = NULL, error_code = NULL, error_message = NULL, updated_at = excluded.updated_at`,
  )
    .bind(revisionId, generationId, now, now, now)
    .run();

  try {
    const loaded = await loadCanonicalRevision(env, revisionId);
    const chunks = await chunkConversation(loaded.conversation, revisionId, generationId);
    await replaceFtsChunks(env, chunks, revisionId, generationId);
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
    }
    const indexedAt = new Date().toISOString();
    await env.MEMORY_DB.prepare(
      `UPDATE chunk_index_state SET status = 'indexed', vector_mutation_id = ?, indexed_at = ?,
       failed_at = NULL, error_code = NULL, error_message = NULL, updated_at = ?
       WHERE revision_id = ? AND generation_id = ?`,
    )
      .bind(lastMutationId, indexedAt, indexedAt, revisionId, generationId)
      .run();
    return chunks.length;
  } catch (error) {
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
