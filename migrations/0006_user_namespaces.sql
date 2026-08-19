PRAGMA foreign_keys = ON;

CREATE TABLE user_namespaces (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, namespace)
) STRICT;

CREATE INDEX user_namespaces_namespace_idx ON user_namespaces(namespace);

-- Bind every namespace that already exists to the owner account under its
-- current name, so vhie1046@gmail.com keeps the full existing archive.
INSERT INTO user_namespaces (user_id, namespace, created_at)
SELECT 'e541a1b8fba085f027f1065926b0da4d80226db3d14ad76ec87b8284449e4a8e', namespace, '2026-08-19T00:00:00.000Z'
FROM conversations
WHERE namespace NOT IN (
  SELECT namespace FROM user_namespaces WHERE user_id = 'e541a1b8fba085f027f1065926b0da4d80226db3d14ad76ec87b8284449e4a8e'
)
GROUP BY namespace;

-- Owner default namespace for tools that do not specify one.
INSERT INTO user_namespaces (user_id, namespace, created_at)
SELECT 'e541a1b8fba085f027f1065926b0da4d80226db3d14ad76ec87b8284449e4a8e', 'personal', '2026-08-19T00:00:00.000Z'
WHERE NOT EXISTS (
  SELECT 1 FROM user_namespaces
  WHERE user_id = 'e541a1b8fba085f027f1065926b0da4d80226db3d14ad76ec87b8284449e4a8e' AND namespace = 'personal'
);
