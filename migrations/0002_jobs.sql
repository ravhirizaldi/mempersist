PRAGMA foreign_keys = ON;

CREATE TABLE upload_parts (
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size_bytes INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (import_id, part_number)
) STRICT;

CREATE TABLE import_items (
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  source_conversation_id TEXT,
  conversation_id TEXT,
  revision_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (import_id, ordinal)
) STRICT;

CREATE INDEX import_items_status_idx ON import_items(import_id, status, ordinal);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'index', 'reindex', 'integrity')),
  subject_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  available_at TEXT NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX jobs_claim_idx ON jobs(status, available_at, lease_expires_at);
CREATE INDEX jobs_subject_idx ON jobs(kind, subject_id, created_at DESC);

CREATE TABLE index_generations (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('building', 'active', 'retired', 'failed')),
  chunk_strategy TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  vector_index_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT
) STRICT;

CREATE TABLE chunk_index_state (
  revision_id TEXT NOT NULL REFERENCES conversation_revisions(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES index_generations(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'fts_ready', 'complete', 'failed')),
  chunk_count INTEGER NOT NULL DEFAULT 0,
  vector_mutation_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  indexed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (revision_id, generation_id)
) STRICT;

CREATE INDEX chunk_index_state_status_idx ON chunk_index_state(generation_id, status, updated_at);

