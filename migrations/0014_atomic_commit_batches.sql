PRAGMA foreign_keys = ON;

-- Idempotency and restart state for multi-conversation canonical commits. The ledger
-- intentionally stores hashes and catalog metadata only; transcript bodies remain in R2.
CREATE TABLE commit_batches (
  batch_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_hash TEXT NOT NULL,
  material_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'committing', 'committed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  receipt_json TEXT
) STRICT;

CREATE UNIQUE INDEX commit_batches_user_key_idx ON commit_batches(user_id, idempotency_hash);
CREATE INDEX commit_batches_expiry_idx ON commit_batches(status, updated_at);

CREATE TABLE commit_batch_operations (
  batch_id TEXT NOT NULL REFERENCES commit_batches(batch_id) ON DELETE CASCADE,
  request_index INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('append', 'replace')),
  base_revision_id TEXT NOT NULL,
  previous_revision_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  manifest_object_key TEXT NOT NULL,
  segment_object_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'committed')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, request_index),
  UNIQUE (batch_id, conversation_id)
) STRICT;

CREATE INDEX commit_batch_operations_revision_idx ON commit_batch_operations(revision_id);

CREATE TABLE commit_batch_objects (
  batch_id TEXT NOT NULL REFERENCES commit_batches(batch_id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('segment', 'manifest')),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'written')),
  created_at TEXT NOT NULL,
  written_at TEXT,
  PRIMARY KEY (batch_id, object_key)
) STRICT;

CREATE INDEX commit_batch_objects_expiry_idx ON commit_batch_objects(status, created_at);
