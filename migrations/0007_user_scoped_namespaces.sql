PRAGMA foreign_keys = ON;

-- Conversations now record the owning user. Namespace names are per-user
-- labels and may repeat across accounts; isolation is (user_id, namespace).
-- Existing conversations all belong to the owner, so the default backfills them.
ALTER TABLE conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT 'e541a1b8fba085f027f1065926b0da4d80226db3d14ad76ec87b8284449e4a8e';

CREATE INDEX conversations_user_idx ON conversations(user_id, updated_at DESC);

-- Drop the global namespace-name uniqueness: same name is allowed per user.
CREATE TABLE user_namespaces_new (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, namespace)
) STRICT;

INSERT INTO user_namespaces_new (user_id, namespace, created_at)
SELECT user_id, namespace, created_at FROM user_namespaces;

DROP TABLE user_namespaces;
ALTER TABLE user_namespaces_new RENAME TO user_namespaces;
