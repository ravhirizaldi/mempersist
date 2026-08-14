PRAGMA foreign_keys = ON;

CREATE TABLE chunk_index_state_next (
  revision_id TEXT NOT NULL REFERENCES conversation_revisions(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES index_generations(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'indexed', 'failed')),
  chunk_count INTEGER NOT NULL DEFAULT 0,
  vector_mutation_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  fts_indexed_at TEXT,
  indexed_at TEXT,
  failed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (revision_id, generation_id)
) STRICT;

INSERT INTO chunk_index_state_next (
  revision_id,
  generation_id,
  status,
  chunk_count,
  vector_mutation_id,
  attempts,
  error_code,
  error_message,
  queued_at,
  started_at,
  fts_indexed_at,
  indexed_at,
  failed_at,
  updated_at
)
SELECT
  revision_id,
  generation_id,
  CASE
    WHEN status = 'complete' THEN 'indexed'
    WHEN status = 'failed' OR (status = 'fts_ready' AND (error_code IS NOT NULL OR error_message IS NOT NULL)) THEN 'failed'
    ELSE 'processing'
  END,
  chunk_count,
  vector_mutation_id,
  attempts,
  error_code,
  error_message,
  updated_at,
  updated_at,
  CASE WHEN status IN ('fts_ready', 'complete') THEN updated_at ELSE NULL END,
  indexed_at,
  CASE
    WHEN status = 'failed' OR (status = 'fts_ready' AND (error_code IS NOT NULL OR error_message IS NOT NULL)) THEN updated_at
    ELSE NULL
  END,
  updated_at
FROM chunk_index_state;

DROP TABLE chunk_index_state;
ALTER TABLE chunk_index_state_next RENAME TO chunk_index_state;

CREATE INDEX chunk_index_state_recent_idx
  ON chunk_index_state(generation_id, status, queued_at DESC, revision_id)
  WHERE status IN ('queued', 'processing', 'failed');
