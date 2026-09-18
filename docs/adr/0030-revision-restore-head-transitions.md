# ADR 0030: Revision restore head transitions

- Status: Accepted
- Date: 2026-09-18

## Context

Conversations in MemPersist evolve through immutable canonical revisions created by store, append,
and replace operations. Each revision produces an immutable segment JSONL file and a canonical
manifest in R2, tracked by D1 catalog pointers (`conversations.current_revision_id` and
`conversations.current_node_id`).

Users and AI agents occasionally need to revert or restore a conversation to an earlier known good
state (for example, undoing unintended changes, recovering from problematic prompt expansions, or
resetting an RP scenario). Prior to this ADR, returning to an earlier state required reading back
historic transcript messages and submitting a full `memory_replace`. That approach had severe
drawbacks:

1. **Storage duplication**: It generated a brand new canonical revision with identical transcript
   nodes and duplicate segment data in R2, increasing storage overhead.
2. **Lineage distortion**: Creating a new revision disguised a restoration as a new content mutation,
   altering content hashes and complicating auditability.
3. **Concurrency risks**: Blindly updating head pointers without optimistic concurrency or durable
   transition records risked lost updates, race conditions against concurrent writes, and
   desynchronized search index states.

A first-class restore operation must safely reposition the active head to an existing canonical
revision while guaranteeing optimistic concurrency, preserving immutable revision integrity, recording
a durable audit trail across R2 and D1, and keeping search indexes synchronized.

## Decision

### 1. Immutable canonical revision reuse and head-only transition

Restoring a conversation changes only its active head pointers in the D1 operational catalog
(`conversations.current_revision_id`, `conversations.current_node_id`, and `conversations.updated_at`).
It **never** creates a new canonical revision, duplicates segment JSONL files, or mutates or deletes
existing canonical revision objects in R2. The target revision's existing manifest and segments are
reused directly.

The conversation's immutable identity (`conversations.id`), source mapping, title, namespace, live tags,
and initial creation timestamp are fully preserved.

### 2. Deterministic transition identity

Every restore operation derives a deterministic transition ID using domain separation and SHA-256:

$$\text{transitionId} = \text{domainId}(\text{"transition"}, \text{conversationId}, \text{baseRevisionId}, \text{revisionId})$$

Because this identifier is a pure function of the conversation, expected base revision, and target
restored revision, retrying the exact same restore operation yields the identical transition ID.

### 3. Immutable R2 transition record before D1 CAS

To maintain an immutable, durable audit trail of all head movements outside the relational database,
the Worker writes an immutable transition JSON document to R2 before modifying D1:

- **R2 Object Key**: `canonical/conversations/${conversationId}/transitions/${transitionId}.json`
- **Format**: `mempersist.conversation-transition.v1`
- **Payload**:
  ```json
  {
    "format": "mempersist.conversation-transition.v1",
    "transitionId": "<transitionId>",
    "conversationId": "<conversationId>",
    "operation": "restore",
    "previousRevisionId": "<baseRevisionId>",
    "restoredRevisionId": "<revisionId>",
    "userId": "<userId>",
    "createdAt": "<ISO timestamp>"
  }
  ```

The write uses `putImmutable`, ensuring that concurrent or repeated attempts never overwrite existing
transition records.

### 4. D1 transition ledger and compare-and-swap (CAS)

Migration `0010_restore_head_transitions.sql` introduces the `conversation_head_transitions` table:

````sql
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

The restore operation records a `prepared` transition row in D1:

```sql
INSERT INTO conversation_head_transitions
  (id, conversation_id, previous_revision_id, restored_revision_id, operation, user_id, transition_object_key, status, created_at, applied_at)
  VALUES (?, ?, ?, ?, 'restore', ?, ?, 'prepared', ?, NULL)
  ON CONFLICT(id) DO UPDATE SET status = 'prepared' WHERE status != 'applied';
````

It then executes a compare-and-swap (CAS) update on the conversations table:

```sql
UPDATE conversations
SET current_revision_id = ?,
    current_node_id = ?,
    updated_at = ?
WHERE id = ? AND current_revision_id = ?;
```

- **Success**: Upon modifying exactly 1 row, the transition row status is updated to `applied` with an
  `applied_at` timestamp.
- **CAS Failure**: If the CAS modifies 0 rows (for example, if a concurrent append, replace, or restore
  changed the active head), the transition row status is updated to `failed` to preserve a durable audit
  trail of the unsuccessful transition attempt, and an `AppError("IMPORT_CONFLICT", ...)` is raised.

### 5. Optimistic concurrency and stale bases

The restore operation requires an explicit `base_revision_id` corresponding to the caller's expected
current head. If the current `current_revision_id` in D1 does not match `base_revision_id` (either
detected during initial load or during the D1 CAS), the operation fails with the repository's standard
optimistic concurrency error code `IMPORT_CONFLICT` (HTTP 409). This prevents restoring over concurrent
writes or conflicting head updates.

### 6. Idempotent repeats and recovery

If a restore request is repeated with the same `(conversationId, revisionId, baseRevisionId)` after the
transition has already succeeded (`conversations.current_revision_id == revisionId` and the transition
status is `applied`), the operation succeeds idempotently and returns the stored transition receipt
without creating duplicate records or throwing an error.

If a previous attempt failed due to an interrupted connection or stale CAS, a subsequent retry safely
resets a non-applied transition row back to `prepared` via `ON CONFLICT(id) DO UPDATE SET status = 'prepared' WHERE status != 'applied'`
and re-attempts the CAS.

### 7. Tenancy, security, and ownership validation

Before initiating storage actions:

- **Account & namespace write guards**: `assertAccountWritable(env, userId, namespace)` verifies that
  the account and target namespace are active and not undergoing deletion or administrative lock.
- **Conversation ownership**: The conversation must exist, have `deleted_at IS NULL`, belong to the
  authenticated `userId`, and reside in an authorized namespace for that account.
- **Revision membership**: The target `revision_id` must belong to that specific conversation in
  `conversation_revisions`.
- **Existence masking**: Missing, deleted, foreign-account, or cross-conversation revision IDs return
  a uniform `NOT_FOUND` error, preventing existence leakage or timing side-channels across tenants.

### 8. Asynchronous derived indexing separation

Restoring the head changes the active revision that should be surfaced in hybrid search. Restoring
enqueues an indexing job via `enqueueIndex(env, restoredRevisionId)` after the D1 head transition
commits.

Indexing failure does not roll back or invalidate the committed head transition. In the event of a
queue failure, the operation returns `durable: true` with `indexing.status: "failed"` and a retryable
error.

### 9. Verification (`verify: true`)

Callers may request post-commit verification by passing `verify: true`. Verification:

1. Reloads the target canonical revision from R2.
2. Validates segment SHA-256 hashes against manifest records.
3. Confirms that D1 `conversations.current_revision_id` matches the restored revision ID.
4. Generates a compact readback bounded to 48 KiB JSON.

Post-commit verification failure returns `durable: true` alongside `verification.status: "failed"` and
the specific error code (`CANONICAL_STORAGE`), preserving the durable receipt.

## Failure Taxonomy & Operational Outcomes

| Failure Scenario             | Database / Storage State                                                                                     | Result to Caller                                       | Recovery Action                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **R2-only transition write** | R2 transition object exists; D1 head unchanged at `baseRevisionId`.                                          | Error / request abort.                                 | Safe to retry with same parameters. Retry finds or re-writes R2 object and completes D1 CAS.                    |
| **D1 CAS conflict**          | D1 head modified concurrently; `current_revision_id != base_revision_id`; transition status marked `failed`. | `IMPORT_CONFLICT` error (HTTP 409); D1 head unchanged. | Inspect current head via `memory_list_revisions`; supply updated `base_revision_id`.                            |
| **Queue failure**            | D1 head committed to `restoredRevisionId`; transition `applied`; index queue failed.                         | `durable: true`, `indexing.status: "failed"`.          | Head is durably restored. Do not repeat restore; enqueue index job via `yarn retry <job-id>` or `yarn reindex`. |
| **Verification failure**     | D1 head committed; target revision R2 readback or integrity check failed.                                    | `durable: true`, `verification.status: "failed"`.      | Head is durably restored. Inspect R2 canonical objects and run `yarn verify:integrity`.                         |
| **Idempotent retry**         | D1 head already at `restoredRevisionId`; transition already `applied`.                                       | `durable: true`, `indexing.status: "queued"`.          | Operation completes cleanly with no duplicate data.                                                             |

## Consequences

- **Zero data duplication**: Reverting across any number of revisions reuses existing R2 canonical
  segments and manifests without increasing bucket usage.
- **Auditable head transitions**: Both R2 transition logs and D1 `conversation_head_transitions` record
  every head movement with user attribution, timestamps, and previous/restored revision pointers.
- **Race-free restoration**: Optimistic CAS prevents clobbering concurrent appends or updates.
- **Index consistency**: Enqueueing derived indexing ensures search queries immediately reflect the
  restored revision's nodes and embeddings.
- **Tool contract consistency**: Matches the existing MCP durable write, verification, and pagination
  patterns established in ADR 0027.
