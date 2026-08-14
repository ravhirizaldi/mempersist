PRAGMA foreign_keys = ON;

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  raw_object_key TEXT NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'uploaded', 'processing', 'complete', 'failed', 'duplicate')),
  duplicate_of TEXT REFERENCES imports(id),
  checkpoint_ordinal INTEGER NOT NULL DEFAULT -1,
  total_items INTEGER,
  processed_items INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX imports_sha256_complete_idx
  ON imports(source_type, sha256)
  WHERE sha256 IS NOT NULL AND status IN ('complete', 'processing', 'uploaded');
CREATE INDEX imports_status_idx ON imports(status, updated_at);

CREATE TABLE import_files (
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  upload_id TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (import_id, object_key)
) STRICT;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT,
  title TEXT NOT NULL,
  current_revision_id TEXT,
  current_node_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  imported_at TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'personal',
  deleted_at TEXT
) STRICT;

CREATE UNIQUE INDEX conversations_source_idx
  ON conversations(source_type, source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX conversations_updated_idx ON conversations(updated_at DESC, id);
CREATE INDEX conversations_namespace_idx ON conversations(namespace, updated_at DESC);

CREATE TABLE conversation_revisions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  import_id TEXT REFERENCES imports(id),
  content_hash TEXT NOT NULL,
  manifest_object_key TEXT NOT NULL,
  current_node_id TEXT,
  node_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, content_hash)
) STRICT;

CREATE INDEX revisions_conversation_idx ON conversation_revisions(conversation_id, created_at DESC);

CREATE TABLE canonical_segments (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE revision_segments (
  revision_id TEXT NOT NULL REFERENCES conversation_revisions(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES canonical_segments(id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (revision_id, ordinal)
) STRICT;

CREATE TABLE message_nodes (
  id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES conversation_revisions(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL,
  parent_node_id TEXT,
  role TEXT,
  sequence INTEGER,
  is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  created_at TEXT,
  updated_at TEXT,
  model_slug TEXT,
  segment_id TEXT NOT NULL REFERENCES canonical_segments(id),
  line_number INTEGER NOT NULL,
  PRIMARY KEY (revision_id, source_node_id)
) STRICT;

CREATE INDEX message_nodes_revision_sequence_idx ON message_nodes(revision_id, sequence);
CREATE INDEX message_nodes_parent_idx ON message_nodes(revision_id, parent_node_id);

CREATE TABLE conversation_tags (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (conversation_id, tag)
) STRICT;
