# ADR 0041: Exact revision-pinned message lookup

- Status: Accepted
- Date: 2026-10-05

## Context

Search is deliberately approximate. It can identify a relevant conversation or chunk, but a
search score, offset, title, or returned text is not a stable identity for an individual message.
Exact editing, verification, audit, and UI recovery instead need to retrieve one known canonical
message without silently switching to a newer head or exposing storage infrastructure.

Canonical conversations are immutable revision documents in R2. A revision can contain an active
branch and inactive alternate branches, and derived FTS, chunk, and Vectorize records can be
missing, stale, superseded, or unavailable. A lookup must therefore resolve against canonical
storage only, pin revisions before loading bodies, and preserve the caller's ordered request
semantics under a bounded response budget.

Issue #7 may later add writes/upserts for a stable `message_key`. Issue #13 must not implement
those writes, but its read contract should accept the exact issue #7 key shape and length and read
an optional `messageKey` field when present. Existing source-node identity remains the primary
lookup mechanism.

## Decision

### 1. A dedicated read tool and exact selectors

The MCP tool is `memory_get_messages`. Its first call is:

```json
{
  "requests": [
    {
      "conversation_id": "<conversation>",
      "revision_id": "<optional revision>",
      "source_node_id": "<node>"
    }
  ],
  "max_serialized_bytes": 32768
}
```

`requests` contains 1–100 ordered selectors. Each selector has a `conversation_id`, an optional
`revision_id`, and exactly one of `source_node_id` or `message_key`. A source-node ID is limited to
200 characters. `message_key` uses issue #7's exact shape and length for forward compatibility; it
is a read selector only in this ADR. A continuation has exactly one opaque `cursor`, with an
optional `max_serialized_bytes`; it does not resubmit `requests`.

The service resolves an omitted revision to the current conversation head for every request before
loading any canonical R2 body. An explicit revision must belong to the conversation. It then
resolves the selector only in that pinned revision. Missing, deleted, foreign, or invalid
conversation/revision/node/key cases have indistinguishable bounded `NOT_FOUND` behavior. A
canonical revision containing duplicate `messageKey` values returns a bounded canonical-storage
error; the service never chooses one arbitrarily.

### 2. Canonical-only resolution

Lookup reads the canonical revision manifest and segment through the existing integrity-checked
R2 path. It never uses FTS, Vectorize, semantic retrieval, recent-canonical fallback, D1 chunks,
or search snapshots to infer or replace a message. A known source node is valid on either the
active or an inactive branch when its pinned revision is authorized. Branch visibility remains a
projection concern: canonical reads expose the graph, while active projections follow
`activeSourceNodeIds`.

Canonical R2 loads may be deduplicated by unique pinned revision within a call, but output order is
not deduplicated. Duplicate selectors produce duplicate ordered result entries with their own
`request_index`. This makes retries and UI selections deterministic without making the server load
the same immutable body repeatedly.

### 3. Bounded result and error contract

The result envelope uses snake_case at the MCP boundary:

```json
{
  "results": [],
  "next_cursor": null,
  "used_serialized_bytes": 0,
  "max_serialized_bytes": 32768
}
```

Each result contains `request_index`, `status` (`ok`, `error`, or `oversized`),
`conversation_id`, and `revision_id`. An `ok` result contains a complete message projection:

```json
{
  "sourceNodeId": "<node>",
  "messageKey": null,
  "role": "assistant",
  "text": "Exact canonical text",
  "createdAt": "<timestamp>",
  "updatedAt": "<timestamp>"
}
```

The shared serialized UTF-8 budget is 32,768 bytes by default, 4,096 minimum, and 49,152 maximum.
Messages are admitted whole; text is never truncated. An oversized result reports a bounded
`oversized_message` containing public message identity and serialized bytes but never text. Errors
are bounded in `error` and per-request, so one missing, oversized, or storage-failed selector does
not discard successful results. The cursor advances past terminal items and cannot replay an
oversized item forever.

### 4. Signed, tenant-bound continuation and readback

The cursor is opaque, HMAC-signed with the existing `MEMORY_API_TOKEN` secret, and bound to the
authenticated user and effective namespaces. Its state preserves selector order and all pinned
conversation/revision IDs but exposes no user ID, R2 key, D1 row ID, or internal storage detail.
Cursor format, MAC, tenant scope, expiry, and authorization are validated before any R2 body load.
There is no module-global request state.

Malformed, forged, expired, cross-tenant, namespace-mismatched, or otherwise invalid cursors use a
bounded indistinguishable validation error. Clients must restart the first call; they must not
decode, edit, repair, or replay a cursor under another account. Readback through the canonical
HTTP/export surface applies normal authorization again and is not a grant conveyed by the cursor.

### 5. API and browser surfaces

MCP clients use `memory_get_messages` for known exact identities. The browser/dashboard may display
public conversation IDs, pinned revision IDs, source-node IDs, and optional message keys when the
caller is authorized. It may link to an authorized canonical conversation read or export to recover
text that is too large for MCP. API and UI surfaces must never expose internal R2 object keys,
D1 identifiers, search-index records, or a substitute newer head.

If the UI reads without an explicit revision, the server pins the current head at request start;
head changes during the request do not mix revisions into the result. An explicit revision remains
the requested immutable source until deletion or authorization loss. This stale-head behavior is
shown as a bounded not-found/error outcome when the pinned source is no longer available, not as a
silent fallback to current content.

## Alternatives considered

### Resolve through search indexes

Rejected. Search is approximate and derived. Ranking, stale current revisions, index lag, deleted
chunks, or model changes can return the wrong node or silently select a newer revision. Search may
help a caller discover a conversation, but it can never establish exact message identity.

### Resolve from the current head after every page

Rejected. A concurrent write would mix revisions in one ordered request and could return different
text for the same identity. Pinning every revision before the first body load preserves a stable
readback snapshot.

### Put canonical text or R2 keys in the cursor

Rejected. It duplicates authoritative content, increases retention and disclosure risk, makes the
cursor a storage reference, and bypasses canonical authorization. The cursor retains only bounded
opaque continuation state.

### Add a message-key index or implement issue #7 writes now

Rejected. Issue #13 is a read path and needs no derived index or schema migration. Optional
`messageKey` reads are sufficient compatibility for future issue #7 data; issue #7 owns key
creation, uniqueness, and upsert semantics.

### Return a partial or truncated message

Rejected. Exact lookup is used for audit, correction, and recovery. An oversized diagnostic plus an
authorized canonical HTTP/export read preserves exact text without invalid JSON or silent mutation.

## Consequences

- Known source-node identities can recover exact active- or inactive-branch text independently of
  search-index health and without exposing internal storage keys.
- Omitted revisions are stable per call, historical revisions remain addressable, and stale heads
  cannot silently alter a result.
- Batch callers receive ordered duplicate results, isolated partial errors, and predictable whole-
  message byte-budget behavior.
- Continuation cursors are safe to pass only within their authenticated tenant and scope and are
  intentionally non-repairable after rejection or expiry.
- Future issue #7 can add message-key writes without changing this lookup's canonical resolution
  or source-node contract.

## Non-goals

- FTS, Vectorize, semantic search, or any other approximate identity resolution.
- Message-key creation, uniqueness enforcement, upserts, or writes from issue #7.
- A new R2 key format, D1 lookup index, canonical revision format, or branch mutation behavior.
- Cross-tenant reads, cursor portability, automatic rebasing to a newer head, or text truncation.
- Replacing authorized canonical HTTP/export recovery for messages that exceed the MCP byte budget.
