# 0012: Tombstone-first memory deletion

- Status: Accepted

## Context

Deleting only D1 rows or only canonical R2 objects can leave ghost search results, orphan derived
data, or queued jobs that recreate chunks. Namespace and all-memory operations must also remain
bounded and report partial failure honestly.

## Decision

Reuse `conversations.deleted_at` as the deletion barrier. Delete each conversation in bounded
revision pages, awaiting canonical R2 deletion before removing its catalog metadata. Delete
Vectorize IDs and explicit FTS rows before D1 cascade cleanup, remove index/reindex jobs, and clear
retained import-item pointers. Keep raw ChatGPT import archives immutable.

Conversation batches are synchronous and limited to 100 IDs. Namespace and all-memory calls page
the catalog and process at most 500 conversations per invocation, returning `remaining` and
`complete` for idempotent continuation. Indexing rechecks current, nondeleted eligibility around
every derived write and removes vectors upserted during a deletion race.

## Consequences

Tombstoned partial deletions disappear immediately from all search channels and retain enough
catalog state for restart. A conversation is reported deleted only after canonical deletion and D1
cleanup succeed. Raw imports can later be reprocessed intentionally, and no deletion job schema or
new runtime service is required.

## Alternatives

A generic delete endpoint was rejected as too easy to misuse. Queue-backed deletion jobs were
deferred because bounded synchronous pages already provide explicit partial results and retries.
Prefix-wide R2 deletion was rejected because catalog-derived immutable keys avoid touching raw or
unrelated objects.
