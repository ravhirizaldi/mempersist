PRAGMA foreign_keys = ON;

-- Keep the original hash for compatibility while retaining the caller's key for
-- durable idempotency lookups.
ALTER TABLE commit_batches ADD COLUMN idempotency_key TEXT;

-- Legacy rows only retained the hash; use it as their stable unique key.
UPDATE commit_batches SET idempotency_key = idempotency_hash WHERE idempotency_key IS NULL;

CREATE UNIQUE INDEX commit_batches_user_idempotency_key_idx
  ON commit_batches(user_id, idempotency_key);
