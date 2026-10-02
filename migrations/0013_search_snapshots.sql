PRAGMA foreign_keys = ON;
CREATE TABLE search_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespaces_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  tag_mode TEXT NOT NULL CHECK (tag_mode IN ('any', 'all')),
  query_hash TEXT NOT NULL,
  ranking_version TEXT NOT NULL,
  candidate_cap INTEGER NOT NULL,
  candidates_json TEXT NOT NULL,
  unavailable_json TEXT NOT NULL,
  degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX search_snapshots_expiry_idx ON search_snapshots(expires_at);
CREATE INDEX search_snapshots_owner_idx ON search_snapshots(user_id, created_at);
