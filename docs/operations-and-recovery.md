# Operations and recovery

## Routine inspection

- Import progress: `yarn import:status <id>`
- Retry a known failed job: `yarn retry <job-id>`
- Rebuild current revisions: `yarn reindex`
- R2/D1 pointer audit: `yarn verify:integrity`
- Retrieval fixtures: `yarn retrieval:evaluate`
- Worker logs: `yarn wrangler tail`

Structured logs expose request/job IDs and categories. D1 tables `imports`, `import_items`, `jobs`, `chunk_index_state`, and `conversation_head_transitions` provide durable progress/error state. Cloudflare dashboards provide queue backlog, Worker latency/errors, storage growth, AI usage, and Vectorize counts without an extra monitoring stack.
Dashboard deletion progress is separate in `deletion_jobs`. Namespace jobs remain locked after a
failure; account jobs remain read-only. Fix the recorded error and re-enqueue the job ID rather than
removing the lock or repeating the user's request.

Search emits one content-free summary per request. It includes total and per-stage timings, semantic variant count, indexed/fallback/merged counts, aggregate indexing states, fallback use, and unavailable channels; it never includes the query or conversation text.

## Recovery cases

### Vectorize deleted or model changed

Create the correctly dimensioned replacement index and metadata indexes, update the binding/generation, deploy reviewed code, then enqueue all current revisions. Canonical R2 and D1 revision pointers are sufficient; no re-upload is needed.

### FTS/chunks lost

Run reindex. The combined rebuild deterministically replaces FTS chunks, sources, and vectors. A future split-only optimization is unnecessary until combined AI cost becomes material.

When `ACTIVE_INDEX_GENERATION` changes (for example `chat-turn-v1` → `chat-turn-v2` for the
message-boundary chunking strategy), `yarn reindex` regenerates every current revision into the new
generation and supersedes that revision's old-generation vectors from Vectorize once the new index
completes, so stale vectors are not left behind. Old-generation D1 derived rows are retained per
ADR 0007 (they coexist by generation and are never read by search, which filters on the active
generation); a memory deletion clears vectors and rows for every generation.

### Import/queue crash

Inspect the import/job. Canonical revisions already written are safe. Retry the job; it resumes from the committed ordinal and all writes are idempotent. For DLQ messages, correct the underlying cause before invoking retry.

### Dashboard deletion interrupted or Worker rolled back

Do not delete `deletion_jobs` rows manually. Deploy code that understands migration 0009, inspect
pending/failed rows and their `last_error_*` fields, then send
`{"version":1,"job_id":"<deletion_jobs.id>"}` to the existing `mempersist-import` queue from the
Cloudflare dashboard. Future account jobs safely re-enqueue themselves in at-most-24-hour hops;
duplicate messages are harmless. A namespace remains locked until cleanup finishes. An account
remains read-only until cancellation (pending jobs only) or final erasure.

### Indexing delayed or failed

Recent current revisions remain searchable from canonical R2 while their state is `queued`, `processing`, or `failed`, subject to the configured revision, age, and message limits. Inspect the job and `chunk_index_state`, correct the underlying service failure, then run the existing retry command. The retry returns revision state to `queued`; it does not rewrite canonical data.

Intentional writes return `durable: true` and the committed revision ID even if enqueueing
fails (`indexing.status: "failed"`). Look up the index job in D1 `jobs` by `subject_id` equal
to that revision ID, then retry the job after fixing the cause. If job creation itself
failed, enqueue current revisions through the existing reindex operation. Obtain normal
authorization before remote maintenance; do not resend the conversation write.

### Verified save reports a failure

Retain the durable receipt and read the returned conversation with the exact `revision_id`.
A newer current revision is not evidence that the original save failed. Inspect that
revision's manifest/segment in R2 if readback reports missing data or a checksum mismatch.
Restore missing/corrupt objects from an independent canonical backup; do not reconstruct
original prose from D1 chunks or overwrite a later revision by retrying blindly. A
`readback_error` or `oversizedMessage` requires an authorized canonical HTTP read/export;
it does not mean a committed write vanished. Semantic omissions still require a reviewed
replacement with the latest base revision.

### Revision restore and head-transition recovery

`memory_restore_revision` restores an owned conversation's active head (`current_revision_id` and
`current_node_id`) to a historic canonical revision without creating duplicate revision objects.
Transitions are tracked in D1 `conversation_head_transitions` and immutably logged in R2 under
`canonical/conversations/${conversationId}/transitions/${transitionId}.json` (format
`mempersist.conversation-transition.v1`).

To inspect transition history for a conversation:

```sql
SELECT id, previous_revision_id, restored_revision_id, status, created_at, applied_at
FROM conversation_head_transitions
WHERE conversation_id = '<conversation-id>'
ORDER BY created_at DESC;
```

#### Partial transition recovery (R2-only or prepared D1)

If a Worker crashes or experiences a network disconnection after writing the R2 transition JSON
or inserting a `prepared` row in `conversation_head_transitions`, but before executing the D1 CAS:

1. The live head in D1 remains at `previous_revision_id`.
2. The transition record in D1 remains in `status = 'prepared'`.
3. Canonical data in R2 is completely untouched and intact.

**Recovery**: Do not manually delete R2 transition objects or drop D1 rows. Safely resubmit the
`memory_restore_revision` request with the same `(conversation_id, revision_id, base_revision_id)`.
The restore handler detects the prepared transition, uses `putImmutable` to avoid duplicating R2
objects, and atomically commits the D1 compare-and-swap update to `applied`.

#### Stale base revision conflict on restore

If `memory_restore_revision` returns an optimistic concurrency error (`IMPORT_CONFLICT`, HTTP 409):

1. A concurrent write (store, append, replace, or another restore) modified `conversations.current_revision_id`
   after the caller observed the base revision.
2. The D1 `conversation_head_transitions` table records a transition row with `status = 'failed'` to preserve
   an audit trail of the attempted transition.
3. The conversation's active head in D1 remains untouched at the current head; no invalid transition occurs.

**Recovery**: Never force-update D1 catalog pointers. Inspect the conversation's active head using
`memory_list_revisions` or query `SELECT current_revision_id FROM conversations WHERE id = ?`.
Evaluate the recent changes. If restoration to the historic revision is still desired, submit
`memory_restore_revision` using the updated current revision ID as `base_revision_id`. If retrying with
the original parameters, the system resets the transition row status to `prepared` if the base condition aligns.

#### Restore post-commit queue failure or verification failure

When `memory_restore_revision` returns `durable: true` with `indexing.status: "failed"` or
`verification.status: "failed"`:

1. **The head transition is already durably committed** in D1 and R2.
2. **Queue failure**: If indexing could not be enqueued (`error.code: "DERIVED_INDEXING"`), search
   queries may temporarily serve the prior revision until indexed. Recover by finding the job in D1
   `jobs` (`WHERE subject_id = '<restored_revision_id>'`) and running `yarn retry <job-id>`, or
   rebuilding search indexes with `yarn reindex`. Do not resend the restore request or re-upload
   transcripts.
3. **Verification failure**: If post-commit verification fails (`error.code: "CANONICAL_STORAGE"`),
   read the conversation at that exact `revision_id` using `memory_get_conversation`. Run
   `yarn verify:integrity` to check that the canonical manifest and segment hashes in R2 match D1
   catalog records. If canonical R2 objects were damaged or missing, restore them from an independent
   R2 backup. Never delete canonical data or attempt to reconstruct transcripts from search chunks.

#### Safe idempotent retry

Repeating `memory_restore_revision` with the same `(conversation_id, revision_id, base_revision_id)`
after a successful transition is completely safe. The operation detects that the current head matches
`revision_id` and returns the durable receipt without modifying storage or creating duplicate transition
rows.

### D1 loss

Restore the best available D1 export/backup first. FTS virtual tables complicate native export, so keep explicit schema migrations and catalog backup procedures. Canonical manifests contain enough conversation/revision/pointer metadata to build a dedicated catalog reconstruction command; V1's integrity tool detects missing references but does not yet recreate an entirely deleted D1 database. Add full catalog reconstruction before relying on R2 as the only disaster-recovery copy.

### R2 loss

D1 and Vectorize are not backups. Restore R2 from an independent portable export. If no R2 copy exists, canonical fidelity is lost.

## Backups

Periodically copy `raw/` and `canonical/` objects plus a manifest of keys, sizes, SHA-256 values, and formats to independent storage. Export D1 where supported and document the date/generation. Test restore into separate resources. R2 bucket locks should protect canonical prefixes from accidental mutation, but locks do not replace an independent backup.

## Integrity

The explicit integrity command checks every D1 revision manifest pointer and referenced R2 segment. It is intentionally absent from request/search paths. Extend it with checksum re-reading, orphan detection, and Vectorize ID listing when operational scale justifies their cost.
