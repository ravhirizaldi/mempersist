PRAGMA foreign_keys = ON;

CREATE TABLE auth_magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('register', 'login')),
  oauth_request_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE INDEX auth_magic_links_email_created_idx
  ON auth_magic_links(email, created_at DESC);
CREATE INDEX auth_magic_links_expiry_idx
  ON auth_magic_links(expires_at);
