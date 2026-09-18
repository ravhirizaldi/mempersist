PRAGMA foreign_keys = ON;

CREATE TABLE conversation_head_transitions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  previous_revision_id TEXT NOT NULL,
  restored_revision_id TEXT NOT NULL REFERENCES conversation_revisions(id),
  operation TEXT NOT NULL CHECK (operation IN ('restore')),
  user_id TEXT NOT NULL REFERENCES users(id),
  transition_object_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'applied', 'failed')),
  created_at TEXT NOT NULL,
  applied_at TEXT
) STRICT;

CREATE INDEX conversation_head_transitions_conversation_idx
  ON conversation_head_transitions(conversation_id, created_at DESC);
CREATE INDEX conversation_head_transitions_user_idx
  ON conversation_head_transitions(user_id, created_at DESC);
