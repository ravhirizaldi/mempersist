# Operations and recovery

## Routine inspection

- Import progress: `yarn import:status <id>`
- Retry a known failed job: `yarn retry <job-id>`
- Rebuild current revisions: `yarn reindex`
- R2/D1 pointer audit: `yarn verify:integrity`
- Retrieval fixtures: `yarn retrieval:evaluate`
- Worker logs: `yarn wrangler tail`

Structured logs expose request/job IDs and categories. D1 tables `imports`, `import_items`, `jobs`, and `chunk_index_state` provide durable progress/error state. Cloudflare dashboards provide queue backlog, Worker latency/errors, storage growth, AI usage, and Vectorize counts without an extra monitoring stack.

Search emits one content-free summary only when fallback candidates or channel failures exist. It includes indexed/fallback/merged counts, aggregate indexing states, fallback use, and unavailable channels; it never includes the query or conversation text.

## Recovery cases

### Vectorize deleted or model changed

Create the correctly dimensioned replacement index and metadata indexes, update the binding/generation, deploy reviewed code, then enqueue all current revisions. Canonical R2 and D1 revision pointers are sufficient; no re-upload is needed.

### FTS/chunks lost

Run reindex. The combined rebuild deterministically replaces FTS chunks, sources, and vectors. A future split-only optimization is unnecessary until combined AI cost becomes material.

### Import/queue crash

Inspect the import/job. Canonical revisions already written are safe. Retry the job; it resumes from the committed ordinal and all writes are idempotent. For DLQ messages, correct the underlying cause before invoking retry.

### Indexing delayed or failed

Recent current revisions remain searchable from canonical R2 while their state is `queued`, `processing`, or `failed`, subject to the configured revision, age, and message limits. Inspect the job and `chunk_index_state`, correct the underlying service failure, then run the existing retry command. The retry returns revision state to `queued`; it does not rewrite canonical data.

### D1 loss

Restore the best available D1 export/backup first. FTS virtual tables complicate native export, so keep explicit schema migrations and catalog backup procedures. Canonical manifests contain enough conversation/revision/pointer metadata to build a dedicated catalog reconstruction command; V1's integrity tool detects missing references but does not yet recreate an entirely deleted D1 database. Add full catalog reconstruction before relying on R2 as the only disaster-recovery copy.

### R2 loss

D1 and Vectorize are not backups. Restore R2 from an independent portable export. If no R2 copy exists, canonical fidelity is lost.

## Backups

Periodically copy `raw/` and `canonical/` objects plus a manifest of keys, sizes, SHA-256 values, and formats to independent storage. Export D1 where supported and document the date/generation. Test restore into separate resources. R2 bucket locks should protect canonical prefixes from accidental mutation, but locks do not replace an independent backup.

## Integrity

The explicit integrity command checks every D1 revision manifest pointer and referenced R2 segment. It is intentionally absent from request/search paths. Extend it with checksum re-reading, orphan detection, and Vectorize ID listing when operational scale justifies their cost.
