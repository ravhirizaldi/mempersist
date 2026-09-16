PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN deletion_job_id TEXT;
ALTER TABLE user_namespaces ADD COLUMN deletion_job_id TEXT;
ALTER TABLE imports ADD COLUMN user_id TEXT REFERENCES users(id);

UPDATE imports
SET user_id = 'e541a1b8fba085f027f1065926b0da4d80226db3d14ad76ec87b8284449e4a8e'
WHERE user_id IS NULL;

CREATE INDEX imports_user_idx ON imports(user_id, created_at DESC);

CREATE TABLE dashboard_magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE INDEX dashboard_magic_links_email_created_idx
  ON dashboard_magic_links(email, created_at DESC);
CREATE INDEX dashboard_magic_links_expiry_idx ON dashboard_magic_links(expires_at);

CREATE TABLE dashboard_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX dashboard_sessions_user_idx ON dashboard_sessions(user_id, expires_at);
CREATE INDEX dashboard_sessions_expiry_idx ON dashboard_sessions(expires_at);

CREATE TABLE deletion_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('namespace', 'account')),
  user_id TEXT NOT NULL,
  namespace TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'failed')),
  phase TEXT NOT NULL CHECK (phase IN ('delete', 'grants', 'conversations', 'imports', 'final')),
  due_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'namespace' AND namespace IS NOT NULL AND phase = 'delete') OR
         (kind = 'account' AND namespace IS NULL))
) STRICT;

CREATE INDEX deletion_jobs_claim_idx ON deletion_jobs(status, due_at, lease_expires_at);
CREATE INDEX deletion_jobs_user_idx ON deletion_jobs(user_id, created_at DESC);
