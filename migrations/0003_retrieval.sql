PRAGMA foreign_keys = ON;

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  vector_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL REFERENCES conversation_revisions(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES index_generations(id),
  branch_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  conversation_timestamp TEXT,
  namespace TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (revision_id, generation_id, branch_key, ordinal)
) STRICT;

CREATE INDEX chunks_revision_idx ON chunks(revision_id, generation_id, ordinal);
CREATE INDEX chunks_conversation_idx ON chunks(conversation_id, generation_id, conversation_timestamp DESC);
CREATE INDEX chunks_generation_idx ON chunks(generation_id, created_at);

CREATE TABLE chunk_sources (
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL,
  source_sequence INTEGER,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, ordinal)
) STRICT;

CREATE INDEX chunk_sources_node_idx ON chunk_sources(source_node_id, chunk_id);

CREATE VIRTUAL TABLE chunk_fts USING fts5(
  chunk_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
