ALTER TABLE deletion_jobs
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'empty'
  CHECK (mode IN ('empty', 'delete'));
