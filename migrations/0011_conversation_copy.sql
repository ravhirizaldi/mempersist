PRAGMA foreign_keys = ON;

DROP INDEX IF EXISTS conversations_source_idx;
CREATE INDEX conversations_source_lookup_idx
  ON conversations(source_type, source_id);

CREATE TABLE conversation_copy_operations (
  user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  material_hash TEXT NOT NULL,
  target_namespace TEXT NOT NULL,
  copied_at TEXT NOT NULL,
  requests_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
) STRICT;
