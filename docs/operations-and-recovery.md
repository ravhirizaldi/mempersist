# Operations and recovery

## Routine inspection

- Import progress: `yarn import:status <id>`
- Retry a known failed job: `yarn retry <job-id>`
- Rebuild current revisions: `yarn reindex`
- R2/D1 pointer audit: `yarn verify:integrity`
- Retrieval fixtures: `yarn retrieval:evaluate`
- Worker logs: `yarn wrangler tail`

Structured logs expose request/job IDs and categories. D1 tables `imports`, `import_items`, `jobs`, `chunk_index_state`, `conversation_head_transitions`, and `search_snapshots` provide durable progress/error state. Cloudflare dashboards provide queue backlog, Worker latency/errors, storage growth, AI usage, and Vectorize counts without an extra monitoring stack.
Dashboard deletion progress is separate in `deletion_jobs`. Namespace jobs remain locked after a
failure; account jobs remain read-only. Fix the recorded error and re-enqueue the job ID rather than
removing the lock or repeating the user's request.

Search emits one content-free summary per request. It includes total and per-stage timings, semantic variant count, indexed/fallback/merged counts, aggregate indexing states, fallback use, and unavailable channels; it never includes the query or conversation text.

Paginated `memory_search` creates one disposable D1 `search_snapshots` row with a 15-minute
expiry. It stores at most 200 compact ranked candidates, `normalized-weighted-v6`, pinned revision
IDs, the effective tenant/filter binding, and bounded retrieval diagnostics. It does not store
canonical bodies or replace the canonical/index stores. Snapshot state is inspected only through
the search response; do not treat it as a backup.

Expired rows are lazily deleted on the first page or a continuation read. There is no cron job or
manual cleanup step. If a D1 inspection is needed, count expired rows without selecting candidate
payloads or user data, and do not manually delete a live snapshot while a request may be using it.
Cleanup failure is a derived-state issue: search can still be retried, and canonical R2 data is
unaffected.

Treat cursors as opaque. A malformed, forged, expired, cross-user, namespace/filter-mismatched, or
ranking-version-incompatible cursor must receive the bounded validation error and must not be
decoded, repaired, or replayed under another account. Start a new first-page search instead. A
continuation supplies only the cursor and new page/byte limits; changing `q` or filters on
`/api/search` is rejected.

### Exact message lookup and recovery

Use `memory_get_messages` when the caller knows the canonical `source_node_id` or exact
`message_key` written by `memory_upsert_messages`. Do not use search ranking, FTS/vector chunks,
titles, offsets, or similar text to guess an identity. Each first-call selector includes a
conversation, optional revision, and exactly one identity selector. The server pins omitted
revisions to the current head for every request before any R2 body load; explicit revisions must
belong to the conversation. The selected revisions remain fixed through continuations, even if a
newer head is committed while the caller is reading.

The lookup is canonical-only and can resolve known nodes on either the active or an inactive
branch. It preserves duplicate ordered requests and isolates failures per result. Missing,
foreign, deleted, or stale conversations, revisions, nodes, and keys intentionally return the same
bounded `NOT_FOUND` behavior. Duplicate canonical message keys are a bounded storage error, not
a reason to choose one matching node. A canonical R2 read may be deduplicated by unique pinned
revision, but this is invisible to callers.

The response uses whole messages and the shared UTF-8 budget: default 32,768 bytes, minimum 4,096,
maximum 49,152. `status: "error"` entries contain a bounded `error`; `status: "oversized"`
entries contain only a bounded `oversized_message` with the public conversation/revision/source-node
(or key) identity and byte count, never text. Partial errors do not invalidate successful entries.
Continue with only `next_cursor` until it is `null`; do not resubmit selectors or retry the same
cursor after a terminal oversized or validation result.

Recovery for an oversized message or canonical read failure is an authorized canonical HTTP read
or account export at the returned conversation and pinned revision. If canonical R2 is missing or
corrupt, restore it from an independent canonical backup and verify the manifest/segment hashes.
Never rebuild exact prose from FTS, Vectorize, D1 chunks, a search snapshot, or an internal R2 key.
The public dashboard/API may show the conversation ID, revision ID, and source-node identity, but
must not expose bucket paths or internal object keys.

Treat the cursor and any readback selector as tenant-bound capabilities, not portable bookmarks.
They are HMAC-signed with `MEMORY_API_TOKEN` and bind the authenticated user and effective
namespaces. Validation occurs before R2 access; malformed, expired, forged, cross-tenant, or
scope-mismatched cursors receive the same bounded validation category and require a new first call.
Do not decode, edit, repair, or store request state in module globals.

If the head changed between UI display and lookup, that is not a lookup failure: omitted revision
selectors use the head pinned when the request began, while explicit revision selectors continue
to address the immutable historical text. If that revision was deleted or is no longer authorized,
report the same not-found result and do not silently substitute the new head.

### Keyed message upsert runbook

The deployed capabilities response advertises `features.message_keys: true`; use that capability
rather than treating keyed writes as a future or compatibility-only feature.

`memory_upsert_messages` is the durable mutation for 1–100 keyed text messages in one owned,
non-deleted conversation. Require the caller's exact `base_revision_id` and a role for every item.
Validate each key as 1–128 lowercase ASCII characters matching `[a-z0-9._/-]`, beginning and ending
with an alphanumeric character, and reject duplicate keys in the request before canonical work.
Missing, foreign, deleted, and unowned conversations must remain indistinguishable; do not probe
ownership by retrying with alternate namespaces or selectors.

Before any write, load and integrity-check the pinned complete graph, including inactive branches.
An existing key is updated only in text: source-node ID, role, `createdAt`, graph links, branch
membership, raw fields, and metadata remain unchanged, and `updatedAt` moves only when text changes.
A role mismatch is a whole-request error. A missing key gets a server-generated node ID and
timestamp and is appended after the active current node in request order. The server validates all
items, text limits, and key uniqueness before writing, so one bad item cannot create a partial
revision.

For a changed request, expect one immutable revision. R2 canonical manifest/segment durability
must precede the D1 head CAS against the supplied base; only a successful CAS may enqueue indexing.
A stale base is a conflict and never overwrites the newer head. `status: "no_change"` means no
canonical object, head transition, or index job was written. Treat `durable: true` as authoritative
even when queueing or verification reports failure: retry the indexed revision or read it by its
pinned revision, never resubmit the mutation blindly. When verification is requested, confirm
every keyed item, exact text, role, and canonical hash in the committed revision.

Copy and restore preserve keys as canonical data, not as a separate index. A lossless copy keeps
keys on all active and inactive nodes while assigning destination IDs; restore reactivates the key
set from the selected historical revision. Full exports must include `messageKey`; on import or
restore, rerun key-shape and complete-graph uniqueness checks. If an export, copy, or restore has
malformed or duplicate keys, stop and repair the canonical manifest/segment from an independent
backup. `yarn verify:integrity` is the authority for manifest/segment hashes, malformed segment
line reports, and key violations; never reconstruct keyed messages from FTS, Vectorize, chunks, or
search snapshots.

Use append for new unkeyed transcript entries, `memory_edit_messages` for source-node text edits,
and replace for a complete transcript. Upsert is not an alias for any of these: it never changes
identity, role, graph, metadata, or a stale base.

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

### Atomic batch commit interrupted or replayed

`memory_commit_batch` coordinates 1–20 unique append/replace operations for one
authenticated account. Every operation carries an explicit base revision; operations may target
different namespaces owned by that account, but never another account. `replace` includes the
complete intended transcript, while `append` adds messages and may union tags. A stale,
deleted, foreign, unknown, invalid, or over-budget operation aborts the entire D1 commit:
no conversation head advances and no index job is eligible for enqueueing.

The service prepares immutable canonical R2 manifests and segments before the single D1
transaction. It records the expected prepared objects durably before or while writing them so a
Worker crash can be resumed. R2 cannot roll back, so a failed or interrupted D1 commit may
leave trackable prepared objects while all live heads remain unchanged. This recovery path requires
the numbered `0015_atomic_batch_recovery.sql` migration; apply it remotely before deploying code
that uses the cleanup command or endpoint.

**Runbook**

1. Keep the original `idempotency_key`, operation order, messages, tags, and base revisions.
   Retry the same request after a transient failure; the deterministic preparation path reuses
   existing immutable objects rather than duplicating them.
2. If the batch committed, a replay of the same account/key/material returns the durable
   bounded receipt and creates no revisions or duplicate indexing jobs. If the material or
   bases changed under that key, treat the conflict as intentional and choose a new key only
   for a genuinely new mutation.
3. If a receipt reports `durable: true` with an indexing or verification failure, do not
   resend the batch. Inspect each returned `revision_id`; retry the recorded index jobs or run
   `yarn reindex`, and use the revision-pinned readback/integrity tools to investigate
   verification failures.
4. Do not delete prepared R2 objects or preparation records manually. After confirming that the
   corresponding batch did not commit, run the authenticated operator cleanup:

   ```sh
   yarn admin cleanup-batches
   # Or use an explicit ISO-8601 cutoff:
   yarn admin cleanup-batches 2026-09-01T00:00:00.000Z
   ```

   The equivalent authenticated endpoint is `POST /api/admin/commit-batches/cleanup` with an empty
   body (the default cutoff) or `{"older_than":"2026-09-01T00:00:00.000Z"}`. This operation deletes
   only aged, uncommitted preparations and their unreachable objects; it leaves objects referenced
   by a committed revision intact.

5. If the same batch remains ambiguous after a Worker restart, retry the exact request rather
   than constructing a different operation set. The idempotency record and deterministic material
   identify whether preparation can resume, the batch committed, or the key conflicts.

This is a recovery boundary, not an external distributed transaction: it cannot roll back
immutable R2 data, coordinate another account, or make queue/index workers part of the D1
transaction. Derived-index repair is always post-commit.

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
`indexing.status` is a required receipt field (ADR 0036), so it is reported even when the response
budget forces other receipt detail to be shed.

### Search snapshot continuation fails or omits candidates

An expired, forged, malformed, tenant-bound, filter-bound, or incompatible cursor is not
repairable. Restart the first search with the intended query and filters; do not retry by editing
the cursor or by supplying a different user's cursor. A ranking-version mismatch similarly
requires a fresh search, because interpreting the old ranked payload under a new strategy could
change order and scores.

If a later page reports stale, deleted, superseded, missing, or no-longer-owned candidates, treat
the bounded omission counts/reasons as the complete diagnostic. The service intentionally does not
replace those pinned revisions with newer revisions or reveal the foreign resource. A fresh search
can discover currently eligible revisions. Deleting a conversation or namespace does not require
snapshot repair and must never restore data from a snapshot.

If D1 loses `search_snapshots`, pagination state is lost but canonical R2 revisions, catalog state,
FTS, and Vectorize are unaffected. Restart searches after D1 recovery. Do not reconstruct
snapshots from search chunks or canonical bodies, and do not treat a snapshot export as a backup.

### Verified save reports a failure

Retain the durable receipt and read the returned conversation with the exact `revision_id`.
A newer current revision is not evidence that the original save failed. A committed receipt with
`verification.status: "failed"` is likewise not a lost commit: never blindly replay a mutation the
receipt reports as `durable: true` (ADR 0036). Inspect that revision's manifest/segment in R2 if
readback reports missing data or a checksum mismatch.
Restore missing/corrupt objects from an independent canonical backup; do not reconstruct
original prose from D1 chunks or overwrite a later revision by retrying blindly. A
`readback_error` or `oversizedMessage` requires an authorized canonical HTTP read/export;
it does not mean a committed write vanished. Semantic omissions still require a reviewed
replacement with the latest base revision.

### Inline readback shed from a mutation receipt

Mutation receipts are bounded by construction, so a large verification readback is shed from the
receipt instead of failing the response (ADR 0036). Shedding is always disclosed and never removes
commit identity: `durable`, `revision_id`, `indexing.status`, `verification.status`, and
`verification.readback_available` are present on every receipt, and each removed field path is
listed in `omitted`. A shed readback is not evidence that verification failed, and no readback text
is lost.

Recover the shed readback through the receipt's own selectors:

1. Read `omitted`. `verification.readback` in that list means inline readback was removed.
2. Send the entries of `readback_requests` as the `requests` array of a first-call
   `memory_get_conversations` (1–20 selectors, exactly the shape the tool accepts).
3. Repeat `memory_get_conversations({ cursor: nextCursor })` with only that cursor until
   `nextCursor` is `null`. Each selector is pinned to the committed `revision_id`, so the walk
   cannot drift to a newer head.
4. If `readback_requests` is absent or empty, the item was not verified with `verify: true` or
   reported `verification.readback_available: false`; read the conversation directly with the
   receipt's `conversation_id` and `revision_id`.
5. `verification.readback_error` (`code: "RESPONSE_TOO_LARGE"`) means the server could not produce a
   compact page at the recorded `offset`; use an authorized canonical HTTP read/export for that
   revision instead of retrying the mutation.

Selectors carry only identifiers the receipt already returned and are rechecked by the read tool
under the caller's normal authorization. `readback_requests` is reconstructible from the required
`conversation_id`/`revision_id`, so no receipt cursor needs to be persisted server-side.

### Oversized inline request rejected (`REQUEST_TOO_LARGE`)

An inline write whose complete serialized request exceeds the deployed inline ceiling is rejected
before any canonical work, with HTTP status 413 (MCP: a tool result with `isError: true` and no
`structuredContent`) and a stable `REQUEST_TOO_LARGE` object carrying `request_bytes`,
`max_request_bytes`, and — when the item count is known — a conservative `suggested_max_items`.
Nothing is written, queued, or indexed, so there is no partial state to repair and no receipt to
retain. This is a request-shape failure, not a storage failure: split the mutation into smaller
`memory_append` calls, or resubmit with fewer or smaller messages, rather than retrying the same
body. `suggested_max_items` assumes average-sized items, so a retry with differently sized messages
can still be rejected; treat it as an upper bound to shrink toward. The deployed ceilings are
reported by `memory_get_capabilities`; see [MCP](mcp.md) for the transport-specific envelope.

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
