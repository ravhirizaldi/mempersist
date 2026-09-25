# ADR 0035: Cursor-driven batch conversation reads

- Status: Accepted
- Date: 2026-09-25
- Supersedes: the `memory_get_conversations` batch-pagination portion of [ADR 0027](0027-compact-readback-and-verified-writes.md)

## Context

ADR 0027 introduced compact batch reads with a fixed response ceiling and a continuation
object per request. That shape makes the caller reconstruct scheduling state, can repeatedly
admit the first large request, and allows a later page to resolve a different current head
unless every continuation is copied exactly. It also gives the caller no authenticated,
whole-batch snapshot or bounded way to resume after a response budget is exhausted.

The batch tool needs to remain useful to clients that already know its name and first-call
`requests` shape while making the continuation, snapshot, budget, and fairness rules explicit.

## Decision

### Request and response contract

`memory_get_conversations` has two mutually exclusive call forms:

1. **First call:** `requests` is an array of 1–20 request objects, with optional
   `max_serialized_bytes`.
2. **Continuation:** `cursor` is one opaque cursor string, with optional
   `max_serialized_bytes`.

A call containing both `requests` and `cursor`, or neither, is a validation error. The request
objects retain the existing snake_case fields: `conversation_id`, `offset`, `limit`, `branch`,
and optional `revision_id`. A continuation does not resubmit request objects or per-item
state.

The byte budget is an integer from **4,096** through **49,152** bytes. The default is **32,768**
and the maximum is **49,152**. The minimum is documented as sufficient for the response envelope
and one normal compact message; callers should raise it when their message metadata or text is
larger. The server measures the complete JSON response as UTF-8 bytes, including the envelope,
results, diagnostics, and cursor. Every response is at or below both the requested budget and
49,152 bytes.

The top-level output keeps the tool's established camelCase convention:

```json
{
  "batchId": "<opaque batch id>",
  "results": [],
  "completed": 1,
  "remaining": 2,
  "nextCursor": "<opaque cursor or null>",
  "usedSerializedBytes": 1234,
  "maxSerializedBytes": 32768
}
```

`results` retain input order and include `requestIndex`. `completed` and `remaining` are counts
of request states completed and unfinished in this batch. `nextCursor` is non-null while any
request state remains unfinished and is null only when `remaining` is zero. Individual failures
are represented in their result entry and do not abort other requests.

### Cursor format, authentication, and expiry

The cursor is a URL-safe, opaque, versioned `mempersist` batch-cursor envelope. Its payload contains only
protocol state required to resume the batch:

- normalized request order and request indexes;
- conversation IDs, pinned revision IDs, branch, requested limit, and current offset for every
  unfinished request;
- the round-robin fairness position;
- the batch ID; and
- issuance/expiry and snapshot-validity state.

The envelope is authenticated with HMAC-SHA-256 using the server's `MEMORY_API_TOKEN` secret and
is bound to the authenticated tenant and effective namespace scope. The payload does not expose
user IDs, D1 row IDs, R2 object keys, or other storage metadata. Clients MUST treat the entire
string as opaque and MUST NOT decode, edit, manufacture, or persist assumptions about its wire
encoding.

Version, MAC, tenant scope, expiry, and snapshot validity are checked before any canonical R2
read. The V1 expiry is 15 minutes. Malformed, forged, expired, version-incompatible, and
cross-tenant cursors all return the same bounded generic validation error (`Invalid cursor`),
without revealing which check failed.

### Revision pinning and isolation

Before loading any R2 body for a first call, the server ownership-checks the complete request set
and resolves each request's revision: an explicit `revision_id` must belong to that conversation,
and an omitted revision resolves to the current revision at the batch snapshot. The resulting
revision IDs are placed in cursor state. Later cursor calls read only those pinned revisions,
so writes committed while a client walks the batch cannot mix revisions into one result.

Missing, deleted, foreign, and foreign-revision identifiers are indistinguishable not-found
outcomes. One such outcome is recorded on its result entry while other request states continue.
A failure to load one canonical revision is likewise isolated to that request.

### Fair admission and whole-message paging

The server admits unfinished request states in deterministic round-robin order starting at the
saved fairness position. It preserves each request's message order and admits complete compact
messages only; text is never truncated. The admission loop reserves the serialized envelope and
only commits a message when the complete UTF-8 response remains within budget. It advances the
fairness position in the cursor after each response, so a large request cannot monopolize the
budget and a request that can make progress is not starved.

A result may retain the legacy per-item `continuation` object, including its pinned
`revision_id`, as a compatibility aid. It is not the primary workflow: new clients call the
next page with only `nextCursor`. The cursor state advances every unfinished request, including
one deferred by the byte budget, and never repeats a completed page body.

The first response of a batch lists every requested `requestIndex`, even when the full request
listing leaves no room for a message and every entry is deferred. Cursor responses are sparse:
they contain only the request states touched on that page, so omitted indexes are neither
failures nor completions and remain represented by `remaining` and the authenticated cursor.
Sparse rendering is what lets a 20-request batch make progress at the documented 4,096-byte
minimum. A cursor continuation that cannot admit any whole message or diagnostic and cannot
advance any request state returns a bounded `RESPONSE_TOO_LARGE` terminal result for one
unfinished request instead of replaying an equivalent cursor, so a caller whose metadata alone
exceeds the budget is told to raise `max_serialized_bytes` rather than looping.

### Oversized messages and recovery

A message that cannot fit even when admitted alone produces a bounded
`page.oversizedMessage` diagnostic with:

```json
{
  "conversationId": "<conversation id>",
  "revisionId": "<revision id>",
  "sourceNodeId": "<source node id>",
  "offset": 12,
  "bytes": 98765
}
```

No message text is returned or truncated. The corresponding request state advances past the
oversized message in the top-level cursor, so retrying the same cursor cannot loop on it. Where
legacy page consumers are still supported, `offset`, `sourceNodeId`, and `bytes` remain available
in the established per-page oversized shape.

Clients that need the complete oversized message use an authorized canonical HTTP read,
for example `/api/conversations/:id?format=canonical&revision_id=...&offset=...`, or the
account's canonical export. The batch tool is a compact, bounded projection and is not a
canonical-body recovery channel.

### Compatibility and migration

The tool name and first-call `requests` array remain stable. Existing clients may continue
following non-null per-item `continuation` values and receive the legacy page fields where the
server can provide them. New clients SHOULD ignore those continuations for scheduling, keep the
returned `nextCursor`, and repeat:

```text
call memory_get_conversations({ cursor: nextCursor })
until nextCursor is null
```

A new call with `requests` starts a fresh batch and therefore a fresh revision snapshot; it is
not a way to refresh an existing cursor walk.

## Security and non-goals

- Tenant binding and HMAC authentication prevent a caller from altering request order, offsets,
  revision pins, fairness state, or batch identity, or using a cursor in another tenant.
- Generic validation and not-found errors avoid turning cursors, conversation IDs, or revision
  IDs into cross-tenant existence or storage probes.
- Expiry limits replay and bounds the lifetime of pinned revision metadata. A cursor is not a
  bearer grant beyond the tenant that authenticated it.
- The cursor is not a durable job, a server-side session, or a substitute for authorization on
  canonical HTTP/export reads. It does not provide cross-tenant reads, live-head tracking,
  message truncation, summarization, or multi-batch atomicity.
- No canonical format, D1 schema, R2 key layout, migration, index generation, or write behavior
  changes. ADR 0027's compact projections and verified-write behavior remain in force except for
  the superseded batch continuation and budget rules.

## Consequences

- Clients can implement one small cursor loop and rely on deterministic, fair progress across up
  to 20 requests.
- Concurrent writes cannot change a batch's pinned transcript, while a fresh first call still
  observes the current heads.
- UTF-8 accounting makes the response ceiling enforceable for non-ASCII content as well as ASCII.
- Oversized content remains recoverable without leaking or silently modifying canonical text, at
  the cost of one explicit canonical HTTP/export read when compact delivery is impossible.
