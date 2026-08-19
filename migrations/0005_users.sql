PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  namespace TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

-- Owner archive bound to vhie1046@gmail.com; namespace 'personal' preserves
-- all existing conversations and imports without any data migration.
INSERT INTO users (id, email, namespace, created_at)
SELECT 'e541a1b8fba085f027f1065926b0da4d80226db3d14ad76ec87b8284449e4a8e', 'vhie1046@gmail.com', 'personal', '2026-08-19T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'vhie1046@gmail.com' COLLATE NOCASE);
