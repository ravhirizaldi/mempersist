# ADR 0039: Tenant-bound search snapshot cursors

- Status: Accepted
- Date: 2026-10-02

## Context

`memory_search` combines lexical, semantic, and recent-canonical retrieval. A live offset
pagination scheme would run those channels again for every page. Index completion, revision
writes, tag changes, and ranking changes can then insert, remove, or reorder candidates between
requests, producing duplicates, gaps, changed scores, or a different result for the same query.
An offset also does not prove that a later request belongs to the tenant or filter scope that
created it.

Search pagination therefore needs a bounded server-side snapshot. The snapshot must preserve the
ranking decision without making a second copy of canonical conversation bodies, must remain safe
when a revision is deleted or ownership changes, and must not turn a cursor into a storage or
cross-tenant probe.

## Decision

### 1. D1 stores the bounded search snapshot

A new numbered D1 migration adds `search_snapshots`. Its state is represented by `id`, `user_id`,
`namespaces_json`, `tags_json`, `tag_mode`, `query_hash`, `ranking_version`, `candidate_cap`,
`candidates_json`, `unavailable_json`, `degraded`, `position`, `created_at`, and `expires_at`.
The row therefore contains the session identity, authenticated user binding, exact opaque namespace
identifiers (deduplicated and sorted without Unicode normalization), filter binding, explicit
ranking version, candidate cap, compact serialized ranked candidates, preserved degradation
diagnostics, current position, and creation/expiry timestamps.

The candidate payload contains compact result metadata and the exact pinned revision IDs needed to
render a result. It does not contain canonical message bodies, R2 keys, D1 row IDs, or foreign
resource identifiers. The snapshot is disposable derived state; R2 canonical revisions and the
normal D1 catalog remain authoritative.

The implementation materializes at most **200 ranked candidates**. This is the exact snapshot
candidate cap, independent of the requested page size. If fewer candidates survive the search
filters, only those candidates are stored. The stored order and final scores are not recomputed
for continuation pages.

### 2. Ranking and revision behavior are explicit

The snapshot records ranking version `normalized-weighted-v6`. A first page computes the normal
hybrid search once, records the compact candidates in that order, and pins each candidate's
revision ID. A continuation validates the stored ranking version and reads the pinned candidate
metadata in its original order; it never replaces a pinned revision with a newer head.

Before returning a pinned candidate, continuation checks that the candidate is still an owned,
non-deleted resource in the requested namespace and that its pinned revision remains valid for
search results. A superseded, deleted, missing, or no-longer-owned candidate is omitted rather
than substituted. The response reports only bounded aggregate omission counts and safe reason
categories; it never names a foreign conversation, revision, user, or storage object.

The snapshot also retains the bounded `degraded` and `unavailable` diagnostics from the first
search. A later page cannot silently claim that a retrieval channel was healthy when it was
unavailable during snapshot creation.

### 3. Pages and byte budgets are bounded

Search pages use the shared UTF-8 serialized response budget:

- default: **32,768 bytes**;
- minimum: **4,096 bytes**;
- maximum: **49,152 bytes**.

The response reports `used_serialized_bytes` and `max_serialized_bytes`. Whole result entries are
admitted without truncating their content. A page may therefore contain fewer results than its
item limit when the byte budget is reached. The snapshot's candidate cap and the page byte budget
are separate limits: the former bounds retained ranked state, while the latter bounds each
transport response.

Paginated output may include `results`, `next_cursor`, `snapshot`, `degraded`, `unavailable`,
`used_serialized_bytes`, and `max_serialized_bytes`. The `snapshot` summary exposes the ranking
version, candidate count and cap, timestamps, and bounded omission information—not the stored
candidate payload.

### 4. Cursors are opaque, signed, and tenant-bound

The cursor body carries only a cursor format version, opaque snapshot/session ID, and expiry; the
HMAC binds the authenticated user identity. The D1 row binds the exact namespace identifiers and
filter state (`query_hash`, tags, and tag mode); because continuations use the stored snapshot
scope, the stored session ID can only resume that stored query/filter scope. User IDs, query text,
namespace internals, D1 IDs, R2 keys, candidate lists, scores, and other storage details are not
cursor fields.

The transport supplies the tenant's complete currently authorized namespace set on continuation.
The stored snapshot namespace set is accepted only when it is a subset of that authorized set;
an explicitly supplied narrower namespace filter must exactly match the stored snapshot scope.

The first MCP or HTTP paginated call accepts the existing query/filter inputs plus page and byte
limits. A continuation accepts only the opaque cursor plus page and byte limits. HTTP
`/api/search` may use `q` for the first call, but a continuation cannot change or add a query or
filter. Existing internal `searchMemory` callers used by context and direct tests retain their
non-snapshot behavior unless the caller explicitly requests pagination/snapshot mode.

Every continuation validates the cursor format and HMAC before loading snapshot state. Malformed,
forged, expired, ranking-version-incompatible, cross-user, unauthorized-scope, or filter-mismatched
cursors fail with the same bounded validation category. Validation does not reveal whether a
session, user, candidate, or internal row exists. Cursor strings are opaque to clients; clients
must restart the first search when a cursor is rejected or expired.

### 5. Lifetime and cleanup

Snapshots and cursors have a **15-minute TTL**. `expires_at` is checked on every snapshot read,
including continuation. An expired snapshot is not resumed. The first or continuation snapshot
read lazily deletes expired `search_snapshots` rows, so cleanup does not require a cron trigger or
an additional stateful service. Cleanup is best-effort and does not alter canonical data or
search indexes.

### 6. Migration and rollout

The migration is additive and forward-compatible: it creates only the disposable snapshot store.
Operators apply the new numbered migration before deploying code that can create or continue
search snapshots, then verify that the Worker can read and write the table. A Worker rollback
does not roll back the D1 migration; old code can leave the unused table in place, while a later
forward deployment restores the feature. A ranking-version or candidate-format change must use a
new explicit version and invalidate incompatible continuations rather than interpreting old
payloads under new rules.

## Alternatives considered

### Live offset queries

Rejected. Re-running hybrid retrieval cannot preserve exact order, scores, or revision pins while
indexes, tags, and current revisions change.

### Put the complete candidate set in the cursor

Rejected. It makes cursors large, exposes internal result references, complicates byte limits,
and creates a second client-carried snapshot format. D1 retains the bounded state instead.

### Durable Objects or a live query session

Rejected. A short-lived, bounded D1 row provides the needed state without adding a stateful
runtime dependency. Canonical storage and index workers remain independent of the pagination
session.

### Store canonical bodies in the snapshot

Rejected. It duplicates authoritative R2 content, increases privacy and retention exposure, and
would make snapshot cleanup part of canonical-data recovery.

## Consequences

- Repeated pages preserve the original ranking order, final scores, degradation state, and pinned
  revisions for the life of the snapshot.
- Search pagination adds bounded D1 derived state and one expiry cleanup path, but no cron trigger,
  Durable Object, or R2 write.
- Deletion, supersession, and ownership changes can reduce a later page. Aggregate omission
  reasons explain the change without leaking foreign resources.
- Cursor rejection is intentionally non-recoverable in place: clients restart the search rather
  than receiving a potentially different or unauthorized walk.
- The ranking version, 200-candidate cap, 15-minute TTL, and 4,096/32,768/49,152-byte budgets are
  compatibility values and must change through a reviewed implementation and documentation update.
