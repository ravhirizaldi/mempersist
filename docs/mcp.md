# MCP

Mempersist uses the official MCP TypeScript SDK v2 and Cloudflare Agents `createMcpHandler` with stateless Streamable HTTP. A fresh server is created per request; no Durable Object or SSE compatibility lane exists.

Primary endpoint: `https://mempersist.codifiedtech.id/mcp`. Browser CORS is disabled. The server caps serialized tool output at 64 KiB and asks callers to narrow pages rather than returning broken/truncated JSON.

The legacy endpoint remains active for existing connections. Leave those clients unchanged to
avoid reauthorization; moving one client to the primary endpoint requires one new authorization
for that client.

## Authentication

- Interactive MCP clients use OAuth 2.1 authorization code with PKCE S256. The flow is
  client-neutral: any client that speaks remote MCP and follows the `401` challenge works.
- OAuth discovery, token exchange, refresh, revocation, Client ID Metadata Documents, and dynamic client registration are provided by Cloudflare's official Workers OAuth package.
- The consent page asks for an email and offers one `Continue with email` action.
  MemPersist sends a single-use, 15-minute magic link through Cloudflare Email Service. An
  existing email reconnects to its archive; a new user is created only after opening the link.
  The pre-existing owner archive is bound to the address seeded by migration 0005.
- Consent, status pages, and email are available in English and Bahasa Indonesia. The selected
  browser language is carried in the application-owned magic link; OAuth protocol fields and MCP
  contracts remain English.
- Developer MCP clients may continue sending `Authorization: Bearer <MEMORY_API_TOKEN>` directly.
- The single V1 scope is `memory`, covering search, retrieval, and intentional writes.
- Every request is scoped to the caller's own archive. Each account owns one or more
  namespaces; the same namespace name may exist in different accounts with fully separated
  data. A client-supplied `namespace` is honored only when the account owns it, and omitting
  it scopes to every namespace the account owns. `memory_store` claims a new namespace for
  the caller on first write.

To connect a client:

1. Add `https://mempersist.codifiedtech.id/mcp` as a remote (HTTP) MCP server in the client.
   Codex uses `~/.codex/config.toml`; Claude Code uses
   `claude mcp add --transport http mempersist https://mempersist.codifiedtech.id/mcp`; other
   clients expose an equivalent remote-server setting.
2. Start the connection. The client reads the `401` challenge, discovers OAuth, and opens the
   consent page.
3. Enter the email tied to your MemPersist archive and click `Continue with email`.
4. Open the magic link sent to that email. The client finishes the OAuth connection.
5. Review the discovered tools, then enable the server for a conversation.

ChatGPT specifically: enable Developer mode in ChatGPT settings, add the same URL as a custom MCP
app, and complete the same consent flow.

Already-connected clients using the legacy endpoint keep working after deployment.
If you change that endpoint to the primary hostname, re-authorize that client once. Pre-existing
grants continue mapping to the owner archive.

Do not paste `MEMORY_API_TOKEN` into a client's connector or app configuration; it is for
developer API and CLI use only. OAuth discovery is exposed at `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server`.

## Remote MCP clients (Codex, Claude Code, Cursor, IDE extensions, and any other)

MemPersist is a remote Streamable HTTP MCP server, so no `npx` bridge is needed — point the
client at the endpoint URL and authorize with the email tied to your archive. The same URL works
for every remote-capable client, including ChatGPT (Developer mode custom MCP app) and Claude
Desktop; the steps below are only examples of client-side configuration.

Codex (add to `~/.codex/config.toml`, or a project-scoped `.codex/config.toml`):

```toml
[mcp_servers.mempersist]
type = "remote"
url = "https://mempersist.codifiedtech.id/mcp"
# auth = "oauth" is the default; run `codex mcp login mempersist` to authorize
```

Verify with `codex mcp list`. Codex CLI, the ChatGPT desktop app, and the IDE extension share
this configuration.

Claude Code: add the server as an HTTP transport and authorize in the OAuth consent page
(`claude mcp add --transport http mempersist https://mempersist.codifiedtech.id/mcp`, then
complete the email prompt).

See [SKILLS.md](../SKILLS.md) for the memory conventions coding agents should follow
(`project/<slug>` namespaces, search-first workflow, event records).

| Tool                           | Important inputs                                                                              | Result                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `memory_search`                | first call: query, filters, limit 1–20, byte budget; continuation: cursor, limit, byte budget | stable ranked references, snapshot metadata, degradation state                                     |
| `memory_get_context`           | chunk ID, before/after 0–10                                                                   | canonical matched ranges and surrounding messages                                                  |
| `memory_get_conversation`      | conversation ID, branch, offset, limit                                                        | paginated active timeline or all graph nodes                                                       |
| `memory_get_messages`          | `requests` or `cursor`, selectors, `max_serialized_bytes`                                     | exact canonical messages by source node or optional message key; ordered, revision-pinned, bounded |
| `memory_get_conversations`     | `requests` or `cursor`, `max_serialized_bytes`                                                | fair, revision-pinned compact batch pages                                                          |
| `memory_list_conversations`    | cursor, limit, tags, tag_mode                                                                 | metadata and tags only                                                                             |
| `memory_list_revisions`        | conversation ID, cursor, limit 1–100                                                          | revision metadata newest first, current head marked                                                |
| `memory_resolve_conversations` | 1–20 exact titles, optional namespace and tags                                                | conversation IDs, current revision IDs, and live tags                                              |
| `memory_build_context`         | task, 1–20 required selectors, max 8 retrieve, budgets, options                               | deterministic revision-pinned context pack within token/byte caps                                  |
| `memory_list_namespaces`       | —                                                                                             | namespaces you own with conversation counts                                                        |
| `memory_stats`                 | —                                                                                             | per-namespace counts plus indexing health                                                          |
| `memory_get_capabilities`      | —                                                                                             | deployed capability contract: versions, limits, per-tool bounds, flags                             |
| `memory_store`                 | title, tags, 1–1000 messages                                                                  | bounded durable receipt plus queued index job                                                      |
| `memory_upsert_messages`       | conversation ID, required base revision, 1–100 keyed messages, verify                         | atomic keyed insert/update/no-op; bounded durable receipt and optional canonical readback          |
| `memory_commit_batch`          | idempotency key, 1–20 append/replace operations, explicit bases, verify                       | atomic same-account commit; bounded per-operation receipts                                         |
| `memory_append`                | conversation ID, base revision, tags, messages                                                | bounded optimistic durable receipt plus queued index job                                           |
| `memory_replace`               | conversation ID, base revision, messages                                                      | bounded replacement receipt plus queued index job                                                  |
| `memory_edit_messages`         | conversation ID, base revision, 1–100 unique source nodes, edits, verify                      | per-target results; bounded durable receipt and index job                                          |
| `memory_update_tags`           | conversation ID, base revision, add/remove                                                    | live tag list after revision-safe mutation                                                         |
| `memory_restore_revision`      | conversation ID, revision ID, base revision, verify                                           | restores head to historic revision; bounded durable receipt and index job                          |
| `memory_copy_conversations`    | target_namespace, create_target_namespace, idempotency_key, 1–20 requests, verify             | ordered per-item bounded durable receipts                                                          |
| `memory_delete_conversations`  | 1–100 unique conversation IDs                                                                 | deleted, missing, and per-ID failures                                                              |
| `memory_empty_namespace`       | matching namespace confirmation pair                                                          | deletes one of your namespaces; bounded, resumable                                                 |
| `memory_import_status`         | import UUID                                                                                   | progress, duplicate, or failure metadata                                                           |

Every tool advertises an output schema and returns successful structured data in both
`structuredContent` and JSON text content for client compatibility.

Namespace emptying processes at most 500 conversations per call and only touches the
caller's namespaces. If `complete` is
false, repeat the same tool call; `remaining` reports the current catalog count. Raw
ChatGPT import archives are intentionally retained. A deletion is reported as complete for a
conversation only after its canonical R2 keys have been deleted and its D1 catalog cleanup has
committed.

The intended client pattern is search → select → get context. Use `memory_append` for genuine
continuation, `memory_replace` with the complete desired transcript when correcting or superseding a
memory, `memory_edit_messages` to revise the exact text of known messages in place when the complete
transcript is not in context, `memory_restore_revision` to revert to an earlier known good revision without synthesizing
duplicate transcripts, and `memory_copy_conversations` for lossless copying into another owned namespace.
Administrative retry/reindex/integrity operations remain HTTP/CLI only so
ordinary LLM tool calls cannot trigger expensive maintenance accidentally.

## Keyed message upserts

`memory_upsert_messages` stores logical records as canonical message nodes selected by an exact
caller-supplied `message_key`. It is the write counterpart to the optional `message_key` selector
of `memory_get_messages`; resolution uses canonical R2 data, never FTS or Vectorize.

### Annotations

- `readOnlyHint`: `false`
- `destructiveHint`: `true` (an existing keyed node's text may be replaced; prior revisions remain immutable)
- `openWorldHint`: `false`
- `idempotentHint`: `false` (a successful call advances the revision and replaying its base is stale)

### Input

```json
{
  "conversation_id": "<owned conversation ID>",
  "base_revision_id": "<required expected current revision ID>",
  "messages": [
    {
      "message_key": "state.relationship",
      "role": "assistant",
      "text": "Ravhi and Adriana are currently at home."
    },
    {
      "message_key": "state.current_location",
      "role": "assistant",
      "text": "Akasa Residence."
    }
  ],
  "verify": true
}
```

`conversation_id` must be owned and writable, and `base_revision_id` is mandatory: it must match
the current head rather than implicitly selecting one. `messages` contains 1–100 unique keys.
Each `message_key` is exact, with 1–128 lowercase ASCII characters matching
`[a-z0-9._/-]`, beginning and ending with a letter or digit; no whitespace, normalization, or
case folding is performed. `role` and complete text are required. Timestamps, graph edges,
source-node IDs, metadata, structured parts, attachments, and tool calls are not accepted.

### Semantics and output

Existing keys replace text in their exact canonical nodes while preserving source-node identity,
role, creation time, graph position, branch membership, and unrelated metadata. A role mismatch
rejects the entire request. Missing keys append keyed text nodes after the active current node in
request order with server-assigned IDs and timestamps. All entries are validated before any write.

An all-unchanged request returns `status: "no_change"` with the current revision and queues no
canonical revision or index job. Any insert or text change creates exactly one new revision;
per-key results report `inserted`, `updated`, or `unchanged`. A stale base, invalid or duplicate
key, foreign conversation, duplicate canonical key, role mismatch, or oversized entry aborts the
whole request without a partial write.

Every successful mutation returns a bounded durable receipt with the previous and committed
revision IDs, per-key source-node/status results, and independent indexing status. With
`verify: true`, the server reloads the committed R2 revision, checks canonical integrity plus every
requested key, role, and text, and includes bounded verification/readback details. Readback is
limited to affected messages and follows the existing receipt budget; durability remains true if
indexing or verification fails after the canonical head transition. Indexing is queued only after
that transition succeeds.

Keys are immutable for the lifetime of a keyed node and unique across a conversation's complete
canonical graph, including inactive branches. Copy, restore, export, recovery, compact reads,
context provenance, and integrity checks preserve or validate `messageKey`; unkeyed messages
remain unchanged and do not gain inferred keys.

## Atomic append/replace batches

`memory_commit_batch` coordinates 1–20 operations across distinct conversations. It is the
recommended MCP surface when several owners must advance together; ordinary `memory_append` and
`memory_replace` remain appropriate for one conversation.

### Annotations

- `readOnlyHint`: `false`
- `destructiveHint`: `true` (each replace supersedes its conversation head; prior revisions remain immutable)
- `openWorldHint`: `false`
- `idempotentHint`: `true` when replayed with the same idempotency material; a changed key payload conflicts

### Input

```json
{
  "idempotency_key": "rp-save-2026-10-02T12:00:00Z",
  "operations": [
    {
      "operation": "append",
      "conversation_id": "<owner conversation ID>",
      "base_revision_id": "<explicit current revision ID>",
      "messages": [{ "role": "assistant", "content": "The gate is closed." }],
      "tags": ["state"]
    },
    {
      "operation": "replace",
      "conversation_id": "<another owner conversation ID>",
      "base_revision_id": "<explicit current revision ID>",
      "messages": [{ "role": "user", "content": "Complete replacement transcript" }]
    }
  ],
  "verify": true
}
```

- `idempotency_key` is required, non-empty, and identifies the complete material and base
  revisions. Keep it stable when retrying an ambiguous request.
- `operations` contains 1–20 unique conversation IDs. Every operation requires an explicit
  `base_revision_id`; an omitted base is invalid rather than an implicit current-head write.
- `append` adds new message nodes after the pinned base and may include tags, which are unioned
  with the existing conversation tags. `replace` requires the complete intended transcript and
  does not accept tags. The two operations cannot target the same conversation in one request.
- The authenticated account supplies tenant scope. Operations may span namespaces owned by that
  account; no per-operation namespace or user ID is accepted. Foreign, deleted, or unknown
  conversations are uniform `NOT_FOUND` outcomes.
- `verify` is optional and defaults to `false`; when true, every committed revision is reloaded
  and checked against canonical R2 and the intended messages.
- The complete parsed input is measured as UTF-8 JSON before canonical work. The deployed
  aggregate inline write ceiling applies; a rejection writes no R2, D1, queue, or index state.

### Output

```json
{
  "batch_id": "<opaque batch ID>",
  "status": "committed",
  "durable": true,
  "results": [
    {
      "request_index": 0,
      "conversation_id": "<owner conversation ID>",
      "previous_revision_id": "<base revision ID>",
      "revision_id": "<new revision ID>",
      "durable": true,
      "derived": { "status": "materialized" },
      "indexing": { "status": "queued", "job_id": "<job ID>" },
      "verification": {
        "status": "passed",
        "revision_id": "<new revision ID>",
        "checked_messages": 1,
        "readback_available": true
      }
    }
  ],
  "used_serialized_bytes": 2140,
  "max_serialized_bytes": 49152
}
```

`results` preserve operation order and expose only public conversation/revision identifiers and
post-commit states. They never contain user IDs, R2 keys, D1 row IDs, prepared-object keys, or
internal transition keys. `readback_requests` and `omitted` are included when receipt fitting
sheds optional detail; selectors are revision-pinned and can be sent to
`memory_get_conversations`. The receipt is bounded by the shared 49,152-byte UTF-8 budget.

Canonical R2 objects are prepared first and durably tracked so a Worker restart can resume the
same deterministic preparation. One D1 `batch()` transaction then inserts catalog rows and
advances every expected head only when every base matches. A stale or invalid operation advances
none. Derived message-node and tag materialization runs after this commit, and indexing is queued
independently from it. A derived-materialization failure reports
`derived.status: "failed"` with retryable `DERIVED_MATERIALIZATION` details, still queues indexing,
and leaves the receipt pending so replay retries materialization. Queue/verification failures are
reported as post-commit `indexing.status: "failed"` or `verification.status: "failed"` while
`durable` remains true. Replaying identical material under the same account/key returns the
stored durable receipt or the same prepared/committed result without duplicate revisions/jobs;
changed material under that key conflicts. The final catalog commit stays one atomic D1 batch and
rejects more than 100 statements; registration and derived-row batches stay at 50 statements or
fewer.

Prepared objects are not a rollback mechanism: R2 is immutable, and D1/queue are not an
external distributed transaction. Do not manually delete preparation records or R2 objects.
Use the reviewed cleanup path for aged, uncommitted preparations only. This tool intentionally
does not support cross-account commits or rollback of an immutable canonical revision.

## Runtime capabilities and aggregate byte budgets

`memory_get_capabilities` is a read-only tool — `readOnlyHint: true`, `destructiveHint: false`,
`openWorldHint: false`, `idempotentHint: true` — with an empty input object. It returns the deployed
capability contract, assembled from the same constants the transports enforce, so a reported limit
cannot drift from its enforcement. Its output schema mirrors `memoryCapabilities()` exactly. It
exposes no secret binding names, account, bucket, database, or queue identifiers, and no plan or
pricing metadata. A `features` flag states protocol availability, never authorization: a true flag
grants no access to another account's namespaces, and no flag implies administrative capability.

Output:

```json
{
  "protocol_version": "1",
  "capabilities_version": "2026-10-05",
  "limits": {
    "max_tool_output_bytes": 65536,
    "recommended_tool_output_bytes": 49152,
    "max_inline_json_write_bytes": 1048576,
    "max_direct_import_bytes": 16777216,
    "max_multipart_part_bytes": 16777216,
    "max_message_content_chars": 1000000,
    "max_receipt_bytes": 49152
  },
  "tools": {
    "memory_search": {
      "max_items": 20,
      "default_items": 8,
      "default_response_bytes": 32768,
      "max_response_bytes": 49152,
      "supports_cursor": true
    },
    "memory_get_conversations": {
      "max_items": 20,
      "default_response_bytes": 32768,
      "max_response_bytes": 49152,
      "supports_cursor": true
    },
    "memory_commit_batch": {
      "max_items": 20,
      "max_request_bytes": 1048576,
      "supports_verify": true
    },
    "memory_append": {
      "max_items": 100,
      "max_request_bytes": 1048576,
      "supports_verify": true
    },
    "memory_upsert_messages": {
      "max_items": 100,
      "max_request_bytes": 1048576,
      "supports_verify": true
    },
    "memory_edit_messages": {
      "max_items": 100,
      "max_request_bytes": 1048576,
      "supports_verify": true
    }
  },
  "features": {
    "revision_pinning": true,
    "verified_writes": true,
    "cursor_reads": true,
    "message_keys": true,
    "atomic_multi_conversation_commit": true
  }
}
```

`tools` lists every tool with a bounded item count, response budget, or verification flag, using
only the fields `max_items`, `default_items`, `max_request_bytes`, `max_response_bytes`,
`default_response_bytes`, `max_tail_messages`, `supports_cursor`, and `supports_verify`.

`features.message_keys: true` means keyed message creation and upsert are available. The
`memory_upsert_messages` contract above requires an explicit base revision and preserves exact
canonical identity while `memory_get_messages` accepts the corresponding `message_key` selector.

### Versions

Both identifiers are scoped to the deployed Worker version and are identical for every caller; they
never describe the caller's data volume, account, or Cloudflare billing plan.

- `protocol_version` (`1`) identifies the shape of this document and of the rejection object
  described below. It changes only when a field is removed, renamed, or changes meaning: an additive
  optional field keeps the current value, a breaking shape change increments it.
- `capabilities_version` (`2026-10-05`) identifies the set of enforced limits. It changes when any
  reported value or feature flag changes, including a change made in another module. Any change to a
  value reported by `memory_get_capabilities` updates `capabilities_version` in the same change, plus
  the documentation that quotes the value.

### Aggregate byte budgets

Aggregate budgets are measured in UTF-8 bytes, never `String.prototype.length`, and are checked
before any canonical work — before `writeCanonicalConversation`, `appendConversation`,
`replaceConversation`, queue enqueue, or any embedding call. A rejected request writes nothing and
leaves canonical-data invariants unchanged.

- **MCP:** the bytes of the complete serialized tool input as the transport receives it, produced by
  `JSON.stringify` of the parsed input and measured with `TextEncoder`, so roles, timestamps, tags,
  keys, and the envelope are all counted.
- **HTTP inline JSON writes:** the same measurement of the parsed body, plus the existing
  `content-length` guard as a pre-parse defense for an oversized body.
- **HTTP import routes:** the `content-length` of the streamed body or part, unchanged in mechanism.

The same measured ceiling applies to inline JSON writes on both transports —
`max_inline_json_write_bytes` (1,048,576 bytes, 1 MiB) — so an MCP `memory_store` that HTTP would
reject is rejected identically. Import ceilings stay transport-specific because those routes stream
to R2 rather than holding a parsed object: `max_direct_import_bytes` (16,777,216 bytes, 16 MiB) for a
direct body and `max_multipart_part_bytes` (16,777,216 bytes, 16 MiB) per multipart part. The
recommended response budget is `recommended_tool_output_bytes` (49,152 bytes, 48 KiB), below the
`max_tool_output_bytes` transport guard of 65,536 bytes (64 KiB).

### Rejection shape

Every aggregate rejection is an `AppError` with code `REQUEST_TOO_LARGE`, status `413`, and
`retryable: false`. Its details are stable:

```json
{
  "code": "REQUEST_TOO_LARGE",
  "request_bytes": 1824100,
  "max_request_bytes": 1048576,
  "suggested_max_items": 42
}
```

`suggested_max_items` is `floor(item_count * max_request_bytes / request_bytes)`, clamped to at
least 1, and is omitted when the item count is unknown (a pre-parse `content-length` reject and a
streamed import body). It is a conservative proportional estimate, never a guarantee: it assumes
every item is the size of the average item in the rejected request, so a retry with differently
sized messages can still be rejected. Treat it as an upper bound to shrink toward, not a promise.

Transport envelopes differ:

- **HTTP:** `{ "error": { "code", "message", "request_bytes", "max_request_bytes", "suggested_max_items" } }`
  with status `413`, produced by the existing `app.onError` handler merging `AppError.details`.
- **MCP:** `isError: true` with a single text content block containing the same JSON object plus a
  human-readable `message`, and no `structuredContent`, because an error result must not claim the
  tool's declared output schema.

Validation still follows Zod input validation: schemas reject malformed input, and the byte budget
only rejects well-formed requests that are too large to accept.

## Search and cursor pagination

`memory_search` performs hybrid search across the authenticated account's owned namespaces. Its MCP
input schema requires exactly one of a first-page `query` (up to 2,000 characters) or an opaque
continuation `cursor`. The first call accepts:

- `limit`: 1–20 results, default 8.
- `namespace`: optional owned namespace; omitting it searches all namespaces owned by the account.
- `tags`: optional normalized conversation tags, with `tag_mode: "all"` (default) or `"any"`.
- `max_serialized_bytes`: optional UTF-8 response budget, default 32,768; minimum 4,096 and
  maximum 49,152. The complete response envelope, including results, snapshot metadata,
  diagnostics, and `next_cursor`, is measured.

The first call creates a snapshot when pagination is requested. A response has the following shape:

```json
{
  "results": [
    {
      "conversationId": "<conversation ID>",
      "revisionId": "<pinned revision ID>",
      "chunkId": "<chunk ID>",
      "title": "Deployment recovery",
      "snippet": "Exact compact result text",
      "timestamp": "2026-09-17T00:00:00.000Z",
      "namespace": "project/example",
      "tags": ["runbook"],
      "score": 0.88,
      "sources": ["lexical", "semantic"]
    }
  ],
  "next_cursor": "<opaque cursor or null>",
  "snapshot": {
    "ranking_version": "<ranking version>",
    "candidate_count": 42,
    "candidate_cap": 200,
    "created_at": "2026-10-02T12:00:00.000Z",
    "expires_at": "2026-10-02T12:15:00.000Z",
    "omitted": {
      "stale": 1,
      "deleted": 0,
      "ownership": 0,
      "unknown": 0
    }
  },
  "degraded": false,
  "unavailable": [],
  "used_serialized_bytes": 1234,
  "max_serialized_bytes": 32768
}
```

Non-paginated compatibility responses may omit `next_cursor`, `snapshot`,
`used_serialized_bytes`, and `max_serialized_bytes`; the pagination fields are present when the
MCP or HTTP request asks for paginated search.

When `next_cursor` is non-null, send a continuation with only the opaque `cursor`, `limit`, and
`max_serialized_bytes`. Do not send `query`, `namespace`, `tags`, or `tag_mode` again. The snapshot
preserves the first call's exact ranking, scores, and order, and pins each candidate to its result
revision. Continuations retain the first call's `degraded` and `unavailable` values. `snapshot`
reports the explicit ranking version, bounded candidate count and cap, creation and expiry times,
and safe omission counts/reasons for candidates that cannot be returned.

Search cursors are signed, versioned, tenant/user-bound, and bound to the normalized namespace and tag
filters. They contain no user IDs, D1 row IDs, R2 keys, or other internal storage identifiers.
Validate a cursor before reading a snapshot. Malformed, forged, expired, ranking-version
incompatible, and cross-account cursors all return the same bounded `Invalid cursor` validation
error. Expired snapshot rows are lazily removed when read. A continuation never replaces a pinned
candidate with a live search result: deleted, stale, or no-longer-owned candidates are omitted and
reported only through bounded safe diagnostics.

`degraded` is true when one or more search sources could not participate; `unavailable` identifies
the unavailable source categories without exposing backend details. These diagnostics are retained
across pages. A snapshot does not make canonical content available: use `memory_get_context` or a
revision-pinned conversation read for a selected result.

The HTTP `/api/search` route exposes the same snapshot contract with `q` for the first-call query
and `cursor` for continuation, plus the page, filter, and byte-budget parameters. During a cursor
walk, query and filter values must be omitted or match the original request exactly; changed
values are rejected. Search snapshots and cursors are transport pagination state only: they are not
canonical export cursors, and internal/context search calls do not create one unless pagination is
explicitly requested by MCP or HTTP.

```text
GET /api/search?q=deployment%20recovery&namespace=project%2Fexample&limit=8&max_serialized_bytes=32768
GET /api/search?cursor=<opaque-cursor>&limit=8&max_serialized_bytes=32768
```

HTTP clients may include the original `q` and filters on a continuation only when they are
unchanged; omitting them avoids an accidental filter mismatch.

If a cursor expires or is rejected, start a new first-call search. Do not retry a rejected cursor
with a different query or filter set.

## Compact reads and batches

`memory_get_conversation` and `memory_get_context` accept `format: "compact" | "canonical"`.
Omitting it preserves the existing canonical response. Compact messages contain
`sourceNodeId`, `role`, `createdAt`, `updatedAt`, and exact original `text`. Conversation
metadata includes ID, revision ID, title, namespace, and tags. Context reads retain
`matchedRanges`; compact conversation pages add `offset` alongside `nextOffset` and `total`.
Duplicate content parts, raw source objects, and branch graph metadata are omitted only
from the response, never from the archive.

`memory_get_conversations` has two call forms:

- **First call:** `requests` is an array of 1–20 objects, with optional
  `max_serialized_bytes`.
- **Continuation:** `cursor` is one opaque cursor string, with optional
  `max_serialized_bytes`.

Send exactly one of `requests` or `cursor`; sending both or neither is a validation error.
The first-call request objects retain their snake_case fields:

- `conversation_id`: a memory UUID or 64-character hexadecimal conversation ID.
- `offset`: nonnegative integer, default 0; `limit`: 1–100, default 20.
- `branch`: `active` (default) or `all`.
- `revision_id`: optional 64-character hexadecimal revision ID for that owned conversation.

`max_serialized_bytes` is an optional integer from 4,096 through 49,152. It defaults to
32,768. The server measures the complete response envelope as UTF-8 JSON bytes, including
results, diagnostics, and the cursor, and guarantees that `usedSerializedBytes` is no greater
than both the requested budget and 49,152. The minimum is sized for the envelope plus one
normal compact message; use a larger budget for unusually large metadata or text.

Every response uses the established camelCase output convention:

```json
{
  "batchId": "<batch id>",
  "results": [],
  "completed": 1,
  "remaining": 2,
  "nextCursor": "<opaque cursor or null>",
  "usedSerializedBytes": 1234,
  "maxSerializedBytes": 32768
}
```

`results` retain input order and include `requestIndex`. `completed` and `remaining` count
request states finished and unfinished in this batch. Individual results may be `ok`, `error`,
or `deferred`; an error is content-free and isolated to that request. Missing, deleted, and
foreign conversation or revision IDs return the same not-found outcome. Successful results
include compact `page` data. A compatibility `continuation` request may remain in a result,
including its `revision_id`, but it is not the primary scheduling API.

The first response of a batch lists every requested `requestIndex`. A cursor response is
sparse: it contains only the results touched on that page, so an omitted index is neither a
failure nor a completion. Untouched indexes remain represented by `remaining` and by the
authenticated `nextCursor` state, and the batch is finished only when `nextCursor` is null.

On the first call, the server ownership-checks the entire request set and pins every resolved
current revision before loading any canonical R2 body. An explicit `revision_id` is validated
as a member of its conversation and is pinned as supplied. Later calls with `nextCursor` keep
those revision pins, so concurrent writes cannot mix revisions into one batch. The cursor is a
URL-safe, versioned, HMAC-authenticated string bound with `MEMORY_API_TOKEN` to the tenant and
valid for 15 minutes.
It carries normalized request order, request indexes, conversation/revision pins, branch,
requested limit, offsets for unfinished requests, batch ID, fairness position, and expiry /
snapshot-validity state; it exposes no user IDs, D1 row IDs, R2 keys, or storage metadata.
Validate it before any canonical read. Malformed, forged, expired, incompatible, and
cross-tenant cursors all return the bounded generic `Invalid cursor` validation error.

Admission is deterministic round-robin from the saved fairness position. The server emits whole
compact messages only, preserves stable message order, and advances every request state that
cannot fit. `nextCursor` is non-null while `remaining` is nonzero; call the tool again with
`{ "cursor": nextCursor }` and the same or a new valid budget until it becomes null. Do not
resubmit `requests` or follow every per-item continuation as the primary workflow. A new
`requests` call starts a new batch and snapshot.

An oversized message is never truncated or returned in the batch. The bounded
`page.oversizedMessage` diagnostic contains `conversationId`, `revisionId`, `sourceNodeId`,
`offset`, and serialized message `bytes`, with no text. The top-level cursor advances past that
message so repeating the same cursor cannot loop. Legacy page consumers may still receive the
older `offset`, `sourceNodeId`, and `bytes` fields. Recover complete content with an authorized
canonical HTTP read such as `/api/conversations/:id?format=canonical&revision_id=...&offset=...`,
or with the account canonical export; do not retry an identical batch page as recovery.

### Exact canonical message lookup

`memory_get_messages` is a read-only source-node lookup that can also match a stable key written by
`memory_upsert_messages` or present in other canonical data. It never uses FTS or Vectorize; the
upsert writer and this exact reader both resolve keys against canonical data.

The first call accepts 1–100 ordered `requests`; a continuation accepts one
opaque `cursor`. Send exactly one of `requests` or `cursor`, plus optional
`max_serialized_bytes`:

```json
{
  "requests": [
    {
      "conversation_id": "<conversation ID>",
      "revision_id": "<optional revision ID>",
      "source_node_id": "<source node ID>"
    },
    {
      "conversation_id": "<conversation ID>",
      "message_key": "state.relationship"
    }
  ],
  "max_serialized_bytes": 32768
}
```

Every selector requires `conversation_id`, may include `revision_id`, and must
include exactly one of `source_node_id` or `message_key`. A `source_node_id`
is at most 200 characters. `message_key` follows issue #7's exact shipped key contract: 1–128
characters, lowercase ASCII letters, digits, `.`, `_`, `/`, and `-` only, with a letter or digit
at both ends. No normalization is performed. `message_key` reads the optional canonical
`messageKey` created by keyed writes and is compatible with unkeyed messages.

When `revision_id` is omitted, the server pins the current revision for every
request before loading any R2 body. An explicit revision must belong to the
conversation. Canonical R2 loads are deduplicated by unique pinned revision,
but duplicate selectors remain duplicate ordered result entries. Resolution
uses only the selected canonical revision. Missing, foreign, deleted, or
unknown conversations, revisions, keys, and source nodes have
indistinguishable bounded `NOT_FOUND` behavior. Duplicate canonical keys
return a bounded canonical-storage error; the reader never chooses one.

The response uses snake_case at the envelope and result levels:

```json
{
  "results": [
    {
      "request_index": 0,
      "status": "ok",
      "conversation_id": "<conversation ID>",
      "revision_id": "<revision ID>",
      "message": {
        "sourceNodeId": "<source node ID>",
        "messageKey": null,
        "role": "assistant",
        "text": "The exact canonical message text.",
        "createdAt": "2026-10-05T00:00:00.000Z",
        "updatedAt": "2026-10-05T00:00:00.000Z"
      }
    }
  ],
  "next_cursor": null,
  "used_serialized_bytes": 412,
  "max_serialized_bytes": 32768
}
```

Each result retains `request_index`, `conversation_id`, and `revision_id`.
`status` is `ok`, `error`, or `oversized`; errors contain bounded `error`
data. Successful `message` projections contain whole messages with
`sourceNodeId`, `messageKey` (a string or `null`), `role`, `text`, `createdAt`,
and `updatedAt`. Whole messages are admitted as units: text is never
truncated. An oversized result contains bounded `oversized_message` identity
and serialized-byte metadata without text.

The serialized response budget defaults to 32,768 bytes and accepts 4,096
through 49,152 bytes. `used_serialized_bytes` is measured over the complete
UTF-8 response, including results, diagnostics, and cursor. Continuations
preserve selector order and pinned conversation/revision IDs. Their cursor is
opaque, HMAC-signed with `MEMORY_API_TOKEN`, and bound to the authenticated
user and namespaces; validate it before any canonical load. Malformed,
forged, expired, incompatible, or cross-tenant cursors return bounded
validation errors without exposing storage or tenant identifiers.

Issue #7 remains out of scope for this read contract: the current
implementation accepts keyed selectors and reads optional `messageKey` fields
when present, but does not add keyed upsert writes.

Single conversation reads still accept `revision_id` and `format: "compact" | "canonical"`.
Ordinary reads without a revision use the current revision, and their tags remain the live
catalog tags. Context responses retain the existing 64 KiB tool guard.

HTTP conversation/context reads support the same `format` query parameter; the conversation
endpoint also accepts `revision_id`. HTTP canonical reads keep their existing behavior.

## Revision history

`memory_list_revisions` exposes the immutable revision history of one owned conversation as
metadata, newest first. Input: `conversation_id` (memory UUID or 64-character hexadecimal ID),
`limit` (1–100, default 20), and an opaque `cursor`.

```json
{
  "conversation_id": "<conversation ID>",
  "current_revision_id": "<the current revision ID>",
  "revisions": [
    {
      "revision_id": "<revision ID>",
      "created_at": "2026-09-17T00:00:00.000Z",
      "node_count": 42,
      "content_hash": "<content hash>",
      "current": true
    }
  ],
  "next_cursor": null
}
```

Rows are ordered by `(created_at DESC, revision_id DESC)`, and `next_cursor` carries that
whole key, so following it neither skips nor repeats rows when revisions share a timestamp.
The cursor also pins the first page's snapshot anchor and current head. Revisions committed
while a client walks the history appear only in a fresh walk; every continuation keeps the
same `current_revision_id` even if the live head changes concurrently.

Exactly one revision in the pinned history is current. The page containing that revision marks
it `current: true`; older pages legitimately contain no `current: true` row while retaining the
same top-level `current_revision_id`.

Metadata only: transcript bodies are never reconstructed from D1. Pass a returned `revision_id`
to `memory_get_conversation` to read that exact revision, which is how an earlier state is
reviewed or recovered without a retained write receipt. The tool is read-only; it never
mutates, deletes, or reindexes history, and it stays inside the 64 KiB tool guard.

Missing, deleted, foreign, empty-history, and not-owned-namespace conversations produce the same
not-found error, so a revision ID or conversation ID from another account reveals nothing.
Malformed, forged, and stale continuation cursors return `Invalid cursor`.

## Revision restore

`memory_restore_revision` safely restores the active head of an owned conversation (`current_revision_id`
and `current_node_id` in D1) to a previously committed revision of that same conversation. Unlike
`memory_replace`, it never synthesizes a new revision manifest, never copies or duplicates segment
JSONL files in R2, and never mutates or deletes historic revision records. It reuses existing immutable
canonical objects directly.

### Annotations

- `readOnlyHint`: `false`
- `destructiveHint`: `true` (repoints the live active head to an earlier state)
- `openWorldHint`: `false`
- `idempotentHint`: `true`

### Inputs

```json
{
  "conversation_id": "<conversation ID>",
  "revision_id": "<target revision ID to restore>",
  "base_revision_id": "<expected current revision ID>",
  "verify": true
}
```

- `conversation_id`: memory UUID or 64-character hexadecimal conversation ID.
- `revision_id`: 64-character hexadecimal revision ID of a historic revision belonging to this conversation.
- `base_revision_id`: 64-character hexadecimal revision ID representing the caller's expected current head.
- `verify`: optional boolean (default `false`). When `true`, reloads the restored canonical revision from R2,
  validates segment integrity hashes, confirms D1 head pointer alignment, and returns a bounded compact readback.

### Output

```json
{
  "conversation_id": "<conversation ID>",
  "previous_revision_id": "<base revision ID>",
  "revision_id": "<restored revision ID>",
  "durable": true,
  "indexing": {
    "status": "queued",
    "job_id": "<job ID>"
  },
  "verification": {
    "status": "passed",
    "revision_id": "<restored revision ID>",
    "checked_messages": 42,
    "readback": {
      "conversation": {
        "id": "<conversation ID>",
        "revisionId": "<restored revision ID>",
        "title": "RP Campaign",
        "namespace": "personal",
        "tags": ["rp", "act-1"]
      },
      "messages": [
        {
          "sourceNodeId": "<node ID>",
          "role": "user",
          "text": "The party approaches the gate.",
          "createdAt": "2026-09-17T00:00:00.000Z",
          "updatedAt": null
        }
      ],
      "offset": 0,
      "nextOffset": null,
      "total": 42,
      "oversizedMessage": null
    }
  }
}
```

### Concurrency, Tenancy, and Security Semantics

1. **Optimistic concurrency**: The restore executes a D1 compare-and-swap (CAS) matching
   `conversations.current_revision_id = base_revision_id`. If the live head changed concurrently (due to
   an append, replace, or another restore), the CAS fails with an optimistic concurrency error
   (`IMPORT_CONFLICT`, HTTP 409). Stale writes or stale restores cannot overwrite concurrent updates.
2. **Tenancy and ownership validation**:
   - Asserts account and namespace write eligibility (`assertAccountWritable`). Locked or pending-deletion
     accounts/namespaces reject the restore.
   - The conversation must belong to the authenticated caller's account and an owned namespace.
   - The target `revision_id` must be an existing revision of that exact conversation in `conversation_revisions`.
   - Missing, deleted, foreign-account, or unrelated revision IDs return a uniform `NOT_FOUND` error,
     preventing metadata or existence leakage across tenants.
3. **Preserved metadata**: The conversation ID, creation timestamp, live title, namespace, and live tags
   remain untouched. Only `current_revision_id`, `current_node_id`, and `updated_at` are updated.
4. **Deterministic transition audit trail**:
   - Derives `transitionId = domainId("transition", conversationId, baseRevisionId, revisionId)`.
   - Writes an immutable transition record to R2 at
     `canonical/conversations/${conversationId}/transitions/${transitionId}.json`
     (format `mempersist.conversation-transition.v1`) prior to D1 CAS.
   - Records the transition state in D1 `conversation_head_transitions` (`prepared` → `applied` on success,
     or `failed` if CAS detects a concurrent modification).
5. **Idempotence**: Repeating the same restore with the same `(conversation_id, revision_id, base_revision_id)`
   after it has succeeded is a clean no-op that returns the durable receipt.
6. **Derived indexing and verification separation**:
   - A background index job is enqueued for the restored revision.
   - If queueing or verification encounters an error after the D1 head CAS succeeds, the response preserves
     `durable: true` with `indexing.status: "failed"` or `verification.status: "failed"`. The restore itself
     is committed and durable. See [recovery](operations-and-recovery.md).

## Message editing

`memory_edit_messages` edits the text of 1–100 existing messages inside one owned conversation
without resubmitting the complete transcript. It loads and integrity-checks the exact
`base_revision_id` from canonical R2 storage, validates every edit against the complete canonical
graph, persists a new immutable revision, and only then advances the D1 head with the same
optimistic compare-and-swap used by `memory_append`, `memory_replace`, and
`memory_restore_revision`. Every non-targeted node, inactive branch, graph relationship, raw field,
and anomaly is preserved; the previous revision and its original text remain immutable and readable
through revision-pinned reads. The new revision durably records edit provenance (`edit_messages`,
its base revision, the targeted source nodes and operations, and the edit timestamp) inside the
hash-covered canonical segment; it is absent on every non-edit revision and exposes no internal
storage keys through MCP.

Use it for a typo fix, a factual correction, a prepended notice, or appended content on a message
whose `source_node_id` is already known. Use `memory_append` for new message nodes and
`memory_replace` only when the complete desired transcript is in hand.

### Annotations

- `readOnlyHint`: `false`
- `destructiveHint`: `true` (supersedes current message text; the prior revision stays readable)
- `openWorldHint`: `false`
- `idempotentHint`: `false` (a successful request advances the head, so replaying the same
  `base_revision_id` conflicts)

### Inputs

```json
{
  "conversation_id": "<conversation ID>",
  "base_revision_id": "<expected current revision ID>",
  "edits": [
    {
      "source_node_id": "<source node ID>",
      "operation": "replace",
      "text": "Complete replacement text"
    },
    {
      "source_node_id": "<another source node ID>",
      "operation": "append",
      "text": "Additional content",
      "separator": "\n\n"
    }
  ],
  "verify": true
}
```

- `conversation_id`: memory UUID or 64-character hexadecimal conversation ID.
- `base_revision_id`: required 64-character hexadecimal revision ID the caller expects to be current.
- `edits`: 1–100 edits for one conversation. Every `source_node_id` must be unique within the
  request; two edits to the same node are rejected as an input validation error.
  `source_node_id` is the exact canonical node ID exposed by compact and canonical reads.
- `operation`: exactly `replace`, `append`, or `prepend`.
- `text`: exact input, never a regex, diff, or fuzzy patch; at most `max_message_content_chars`
  (1,000,000) characters.
- `separator`: accepted only for `append` and `prepend`; defaults to `"\n\n"` and is limited to 64
  characters. `replace` with a `separator` is rejected as an input validation error.
- `verify`: optional boolean (default `false`), consistent with the other verified writes.

Only message text is editable. Node identities (`source_node_id`), roles, and each node's
`createdAt` are preserved, as are graph structure, parent/child relationships, branch membership,
active-path position, titles, tags, namespaces, ownership, and metadata; none of these are accepted
as input. Server-managed timestamps advance on change: every changed target's node `updatedAt` and
the conversation `updatedAt` are set to the edit time, while unchanged targets keep their existing
`updatedAt`. A `no_change` request commits nothing and leaves all timestamps untouched. User IDs,
namespace-owner IDs, R2 keys, manifest or segment keys, and internal node IDs are never accepted.

### Deterministic text semantics

For existing text `E`, supplied text `T`, and effective separator `S`:

- `replace`: result is `T`.
- `append`: result is `E + S + T`.
- `prepend`: result is `T + S + E`.

If either adjacent value is empty, `S` is omitted at that boundary: appending to an empty message
yields `T`, prepending to an empty message yields `T`, and for `append`/`prepend` an empty `T`
leaves `E` unchanged. The server never trims, normalizes whitespace, parses Markdown, infers
headings, or reinterprets Unicode; only the existing canonical message validation and size limits
apply. Empty final text is valid when it passes that validation.

### Output

```json
{
  "conversation_id": "<conversation ID>",
  "previous_revision_id": "<base revision ID>",
  "revision_id": "<new revision ID>",
  "status": "edited",
  "edits": [
    {
      "request_index": 0,
      "source_node_id": "<source node ID>",
      "operation": "replace",
      "status": "edited"
    },
    {
      "request_index": 1,
      "source_node_id": "<another source node ID>",
      "operation": "append",
      "status": "unchanged"
    }
  ],
  "durable": true,
  "indexing": {
    "status": "queued",
    "job_id": "<job ID>"
  },
  "verification": {
    "status": "passed",
    "revision_id": "<new revision ID>",
    "checked_messages": 2,
    "readback_available": true,
    "readback": {
      "conversation": {
        "id": "<conversation ID>",
        "revisionId": "<new revision ID>",
        "title": "Synthetic state",
        "namespace": "personal",
        "tags": []
      },
      "messages": [
        {
          "sourceNodeId": "<source node ID>",
          "role": "assistant",
          "text": "Final exact message text",
          "createdAt": "2026-09-11T00:00:00.000Z",
          "updatedAt": "2026-10-02T00:00:00.000Z"
        }
      ],
      "offset": 0,
      "nextOffset": null,
      "total": 2,
      "oversizedMessage": null
    }
  },
  "used_serialized_bytes": 2048,
  "max_serialized_bytes": 49152
}
```

`status` is `edited` when at least one target changed and `no_change` when none did. Every requested
target appears in `edits`, in the same order as the request, with `request_index` (its zero-based
position in the submitted `edits` array), `source_node_id`, `operation`, and its own `status` of
`edited` or `unchanged`. `indexing` is present only when a new revision was committed, so a
`no_change` receipt omits it. Readback contains only the targeted messages, not the full
conversation. `verification.checked_messages` counts the targets the server compared, and
`verification.readback_available` is present whenever verification ran; when the targeted page
exceeds the readback budget, verification still passes and returns `verification.readback_error`
instead of an inline page.

### Atomicity and no-op behavior

- The request is atomic for the conversation. If any target is missing, duplicated, foreign,
  malformed, oversized, or unsupported, no revision is created and no head changes.
- If every computed final text exactly equals its current text, the receipt has
  `status: "no_change"` with `revision_id` equal to the current revision, every edit is
  `unchanged`, and no indexing job is queued.
- If only some edits are unchanged, the changed edits are applied in one new revision and the
  unchanged targets are reported explicitly.
- The tool performs no substring matching, offsets, regular expressions, diffs, or semantic
  similarity, and never inserts, deletes, moves, or reorders message nodes.

### Unsupported content

V1 edits messages whose canonical content is safely representable as text. If an edit would discard
or ambiguously rewrite tool calls, attachments, multimodal parts, or other unsupported structured
content, the whole request fails with `UNSUPPORTED_MESSAGE_CONTENT` and nothing is written. The
server never coerces unsupported content silently.

### Concurrency, tenancy, and retry

1. **Optimistic concurrency**: the head update executes a D1 compare-and-swap matching
   `conversations.current_revision_id = base_revision_id`, and the base is re-validated at the head
   transition rather than only when the R2 revision loads. A stale `base_revision_id` fails with
   `IMPORT_CONFLICT` (HTTP 409) and cannot overwrite concurrent work; the prepared revision is never
   reachable as current and is never enqueued for indexing.
2. **Retry guidance**: after a conflict, read the current revision (`memory_get_conversation` or
   `memory_list_revisions`), review the target nodes and their current text again, recompute the
   intended edits, and submit a new request with the new `base_revision_id`. Never blindly replay the
   same edit against a different head.
3. **Tenancy and ownership**: the conversation is scoped to the authenticated user and an owned
   namespace, and account/namespace writability is enforced before any canonical work begins. Missing,
   deleted, foreign, and unowned conversations return the same `NOT_FOUND` error, so a foreign
   `base_revision_id` or `source_node_id` reveals nothing about whether it exists. Errors never include
   previous message text.

### Durability, indexing, and verification

- The new revision is persisted to R2 before the D1 head advances, and the normal indexing job is
  queued only after the head transition succeeds. Derived FTS and Vectorize results resolve to the new
  current revision, so text from an older revision is not returned as current memory.
- Canonical durability is authoritative even when queueing fails: a committed edit returns
  `durable: true` with `indexing.status: "failed"` and `indexing.error.code: "DERIVED_INDEXING"`, and
  remains recoverable through normal retry or reindex operations. A queued status only acknowledges
  scheduling.
- `verify: true` reloads the committed revision from R2, validates canonical integrity, and compares
  the final text of every requested target, including targets whose inline readback was omitted.
- The receipt is the shared bounded mutation receipt produced by the same builder as the other write
  tools: maximum 49,152 bytes (48 KiB), identity/durable/status fields never shed, and verbose data
  shed in the documented ladder order with shed paths listed in `omitted`. Inline readback is greedy
  and targeted; when it does not fit, the receipt carries revision-pinned `readback_requests`
  selectors that are directly usable as `memory_get_conversations` first-call `requests` (loop
  `nextCursor` until `null`). Edit selectors pin `branch: "all"`, so a target on an inactive branch
  remains reachable; oversized readback therefore never becomes a post-commit tool error.
  See [Verified writes](#verified-writes) and ADR 0036.

## Conversation copy

`memory_copy_conversations` performs a lossless canonical copy of 1–20 owned conversations into
another namespace owned by the same account. It loads the source R2 canonical revision directly
(preserving inactive branches, raw source payloads, metadata, timestamps, and anomalies), mints a
new destination conversation ID and new message-node IDs, attaches first-class `derivedFrom`
provenance, and guarantees idempotency through D1 tracking. Source conversations and source R2
objects remain completely immutable.

### Annotations

- `readOnlyHint`: `false`
- `destructiveHint`: `false`
- `openWorldHint`: `false`
- `idempotentHint`: `true`

### Inputs

```json
{
  "target_namespace": "project/forked-service",
  "create_target_namespace": false,
  "idempotency_key": "copy-2026-09-18-001",
  "verify": true,
  "requests": [
    {
      "conversation_id": "<source conversation ID>",
      "revision_id": "<optional source revision ID>",
      "title": "Forked Project Memory",
      "tags": {
        "mode": "inherit",
        "add": ["fork"],
        "remove": ["upstream"]
      }
    }
  ]
}
```

- `target_namespace`: destination namespace name. Must be owned by the authenticated account unless
  `create_target_namespace: true` is set.
- `create_target_namespace`: optional boolean (default `false`). When `false`, copying to an unowned
  namespace returns an `AUTHENTICATION` 403 error (`Namespace is not accessible to this account`). When
  `true`, automatically grants and claims the target namespace for the caller.
- `idempotency_key`: non-empty string (1–128 characters) identifying the batch operation.
- `verify`: optional boolean (default `false`). When `true`, reloads each copied canonical revision from
  R2, validates segment integrity and manifest provenance, confirms D1 head pointer alignment, and
  returns a bounded compact readback.
- `requests`: array of 1–20 copy request objects:
  - `conversation_id`: source conversation ID (UUID or 64-character hexadecimal ID).
  - `revision_id`: optional 64-character hexadecimal revision ID. If omitted, pins the source conversation's
    `current_revision_id` at the start of the copy operation.
  - `title`: optional title override (1–500 characters). When omitted, inherits the source revision title.
  - `tags`: optional tag specification object (default `{ mode: "inherit", add: [], remove: [] }`):
    - `mode`: `"inherit"` (starts from the source revision's canonical tags) or `"replace"` (starts from `[]`).
    - `add`: array of normalized tags to add (up to 20).
    - `remove`: array of normalized tags to remove (up to 20).
    - Tags are applied as `remove` then `add`, then normalized. If the resulting tag count exceeds 20,
      the item fails with `VALIDATION`.

### Output

Output returns ordered per-item receipts matching the input `requests` array:

```json
{
  "results": [
    {
      "request_index": 0,
      "status": "copied",
      "durable": true,
      "source_conversation_id": "<source conversation ID>",
      "source_revision_id": "<pinned source revision ID>",
      "conversation_id": "<new destination conversation ID>",
      "revision_id": "<new destination revision ID>",
      "indexing": {
        "status": "queued",
        "job_id": "<job ID>"
      },
      "verification": {
        "status": "passed",
        "revision_id": "<new destination revision ID>",
        "checked_messages": 42,
        "readback_available": true,
        "readback": {
          "conversation": {
            "id": "<destination conversation ID>",
            "revisionId": "<destination revision ID>",
            "title": "Forked Project Memory",
            "namespace": "project/forked-service",
            "tags": ["fork"]
          },
          "messages": [
            {
              "sourceNodeId": "<node ID>",
              "role": "user",
              "text": "Starting the forked service architecture.",
              "createdAt": "2026-09-18T00:00:00.000Z",
              "updatedAt": null
            }
          ],
          "offset": 0,
          "nextOffset": null,
          "total": 42,
          "oversizedMessage": null
        }
      }
    },
    {
      "request_index": 1,
      "status": "failed",
      "source_conversation_id": "<missing conversation ID>",
      "error": {
        "code": "NOT_FOUND",
        "message": "Conversation not found"
      }
    }
  ],
  "readback_requests": [
    {
      "conversation_id": "<new destination conversation ID>",
      "revision_id": "<new destination revision ID>",
      "offset": 0,
      "limit": 20,
      "branch": "active"
    }
  ],
  "used_serialized_bytes": 4096,
  "max_serialized_bytes": 49152
}
```

The envelope fields are shared by every write tool; see [Verified writes](#verified-writes) for the
full contract. In brief:

- `results` retains input order and `request_index`. A committed item reports `durable: true` together
  with its destination `conversation_id`/`revision_id`; a failed item reports only `error` (message
  capped at construction). `verification.readback_available` is always present when verification ran,
  even if no inline `verification.readback` fits — read that page through the batch read tool instead.
- `readback_requests` holds one selector per item that is durably committed, verified, and has
  `verification.readback_available: true`: `conversation_id`, `revision_id`, `offset` (0 for copies),
  `limit` 20, and `branch: "active"`. These objects are exactly a valid first-call `requests` payload
  for `memory_get_conversations`; passing them back returns the pinned canonical pages, and looping its
  `nextCursor` until `null` completes the readback. It is absent when no item qualifies. (Copy,
  store, append, replace, and restore selectors pin `branch: "active"`; `memory_edit_messages`
  selectors instead pin `branch: "all"` so inactive-branch targets stay reachable — see
  [Verified writes](#verified-writes).)
- `omitted` lists the field paths shed to fit the budget; it is absent when nothing was shed.
- `used_serialized_bytes` and `max_serialized_bytes` report the exact serialized size of this receipt and
  the budget it was fitted against.

### Semantics and Invariants

1. **Source revision pinning and immutability**:
   - For requests omitting `revision_id`, MemPersist pins the source conversation's current head
     (`current_revision_id`) in D1 before performing any destination R2 writes. Subsequent retries
     reuse the stored pin even if the source head advances concurrently.
   - Source D1 records (`current_revision_id`, title, tags) and source R2 objects are never mutated.
2. **Deterministic identities and full-graph preservation**:
   - Destination conversation ID is deterministically minted:
     `domainId("copy-conversation", userId, idempotencyKey, String(requestIndex), sourceConversationId, pinnedRevisionId, targetNamespace)`.
   - Message node IDs are re-derived: `domainId("message-node", destConversationId, sourceNodeId)`.
   - Source node relationships (`sourceNodeId`, `parentSourceNodeId`, `childSourceNodeIds`,
     `currentSourceNodeId`, `activeSourceNodeIds`), inactive branches, raw payloads, custom metadata,
     timestamps, and anomalies are preserved verbatim.
3. **First-class provenance**:
   - The destination canonical conversation and revision manifest record `derivedFrom`:
     ```json
     {
       "operation": "copy",
       "conversationId": "<source conversation ID>",
       "revisionId": "<pinned revision ID>",
       "namespace": "<source namespace>",
       "copiedAt": "2026-09-18T00:00:00.000Z"
     }
     ```
   - `copiedAt` is captured when the idempotency operation begins and persisted in D1, ensuring
     identical canonical bytes and stable revision hashes across retries.
4. **Idempotency replay vs conflict**:
   - Operations are recorded in D1 `conversation_copy_operations` keyed by `(user_id, idempotency_key)`.
   - A SHA-256 hash of the normalized request material detects conflicts. Replaying the identical
     request returns the existing destination receipts. Reusing the same `idempotency_key` with
     different material (different target namespace, titles, revisions, or tags) returns an
     `IMPORT_CONFLICT` (HTTP 409) tool error.
5. **Namespace ownership and creation**:
   - Target namespaces must belong to the caller's account. Unowned target namespaces return 403
     `AUTHENTICATION` unless `create_target_namespace: true` is provided to claim the namespace.
   - Same-account copies across owned namespaces are supported, including copying into the source namespace.
6. **Cross-namespace search visibility**:
   - Copied conversations exist as distinct canonical entities. A `memory_search` scoped to the source
     namespace returns the source; a search scoped to the target namespace returns the destination;
     and a search covering both owned namespaces may return matches from both.
7. **Independent indexing and verification**:
   - Canonical R2 persistence and D1 catalog registration complete before background indexing or
     verification run.
   - Failures during indexing queueing or verification return `indexing.status: "failed"` or
     `verification.status: "failed"` without invalidating the committed destination conversation.
   - A committed item keeps `durable: true` regardless of a later indexing or verification failure, and
     its receipt is bounded per the [Verified writes](#verified-writes) contract.

## Exact-title conversation resolution

`memory_resolve_conversations` resolves known conversation owners by exact title without semantic
search. It returns conversation IDs, current revision IDs, and live catalog tags so callers can
immediately batch canonical reads with `memory_get_conversations`.

Input: `requests` (array of 1–20 objects):

```json
{
  "requests": [
    {
      "title": "CURRENT",
      "namespace": "project/example",
      "tags": ["state"],
      "tag_mode": "all"
    }
  ]
}
```

- `title`: exact, case-sensitive binary string comparison against stored canonical titles. Lookup does not trim whitespace.
- `namespace`: optional; when omitted, searches across all namespaces owned by the authenticated tenant. Unowned namespaces return an authentication error.
- `tags`: optional tag filter (up to 20 normalized tags).
- `tag_mode`: `"all"` (must match every tag) or `"any"` (must match at least one tag). Default is `"all"`.

Output:

```json
{
  "results": [
    {
      "request_index": 0,
      "status": "ok",
      "matches": [
        {
          "conversation_id": "<conversation-id>",
          "revision_id": "<current-revision-id>",
          "title": "CURRENT",
          "namespace": "project/example",
          "tags": ["state"],
          "updated_at": "2026-09-17T00:00:00.000Z"
        }
      ],
      "has_more": false
    }
  ]
}
```

- `status`: `"ok"` (exactly one match), `"not_found"` (no matches), or `"ambiguous"` (multiple matches).
- `matches`: array of matched conversation metadata, bounded to a maximum of 50 matches per request. Ambiguous results are never resolved by an implicit heuristic such as recency.
- `has_more`: `true` when more matches exist beyond the 50-match cap.
- Deterministic and read-only: excludes tombstones (`deleted_at IS NULL`), requires a valid current revision head (`current_revision_id IS NOT NULL`), and never accesses R2, Vectorize, or Workers AI.

## Context pack builder

`memory_build_context` compiles a deterministic, revision-pinned context pack from required canonical
conversations and optional hybrid-search evidence within explicit estimated-token and serialized-byte budgets.
It replaces repeated client-side orchestration across exact owner resolution, batch canonical reads,
hybrid search, context retrieval around chunks, structural deduplication, relevance/authority ordering,
and budget fitting with a single server-side call.

The tool is extractive-only and strictly read-only: it never uses an LLM to summarize, rewrite, or infer
facts, never arbitrates canon, never persists context packs, and never writes to D1, R2, or Vectorize.

### Annotations

- `readOnlyHint`: `true`
- `destructiveHint`: `false`
- `openWorldHint`: `false`
- `idempotentHint`: `true`

### Inputs

```json
{
  "namespace": "project/example",
  "task": "Continue the current scene after xxx reviews her resignation letter",
  "required": [
    {
      "selector": {
        "title": "CURRENT"
      },
      "mode": "full",
      "branch": "active",
      "priority": 100
    },
    {
      "selector": {
        "conversation_id": "0191f6e0-1234-7000-8000-000000000001"
      },
      "mode": "tail",
      "tail_messages": 20,
      "branch": "active",
      "priority": 90
    }
  ],
  "retrieve": [
    {
      "query": "xxx agency resignation letter Mia professional responsibility",
      "namespace": "project/example",
      "tags": ["rp"],
      "tag_mode": "all",
      "limit": 8,
      "context_before": 2,
      "context_after": 3,
      "priority": 70
    }
  ],
  "budget": {
    "max_estimated_tokens": 8000,
    "max_serialized_bytes": 49152
  },
  "options": {
    "deduplicate": true,
    "include_provenance": true,
    "include_compiled_text": true
  }
}
```

- `namespace`: optional; when omitted, scopes to all namespaces owned by the authenticated account. When provided, must be an account-owned namespace.
- `task`: non-empty descriptive task string (1–1000 characters). Used as pack metadata and for deterministic pack identity; not silently converted to a search query.
- `required`: array of 1–20 required conversation selectors:
  - `selector`: object containing exactly one of:
    - `conversation_id`: memory UUID or 64-character hexadecimal ID of an owned conversation.
    - `title`: exact case-sensitive binary title string (1–500 characters, no whitespace trimming) to resolve in owned namespaces. Follows `memory_resolve_conversations` semantics and fails explicitly with an error if missing or ambiguous.
    - Optional `namespace`, `tags` (up to 20), and `tag_mode` (`"all"` | `"any"`) to qualify title resolution.
  - `mode`: `"full"` (include all messages in the selected branch) or `"tail"` (include trailing messages).
  - `tail_messages`: positive integer (default 20, max 100) when `mode: "tail"`.
  - `branch`: `"active"` (default, active linear timeline) or `"all"` (all graph nodes in canonical order).
  - `priority`: integer priority for section ordering (higher values ordered first).
  - `follow`: optional array of 1–10 pointer follow configurations for deterministic cross-conversation expansion:
    - `field`: string field path in structured text (e.g. `"current_scene"`, `"active_arc.owner"`). Matches structured line key-value patterns (case-insensitive) or JSON properties. The newest occurrence on the active timeline is strictly authoritative: if a newer message explicitly clears the field (`none`, `null`, `cleared`, `""`) or contains an invalid ID, it will not resurrect an older pointer from earlier messages.
    - `required`: boolean (default `true`); when `true`, missing, cleared, malformed, or inaccessible pointer targets fail the request; when `false`, records a diagnostic warning and omits the section gracefully under budget pressure.
    - `priority`: integer priority for section ordering (default 100).
    - `mode`: `"full"` | `"tail"` (default `"full"`).
    - `branch`: `"active"` | `"all"` (default `"active"`).
    - `tail_messages`: positive integer (1–100, default 20) when `mode: "tail"`.
    - `follow`: optional nested follow array (up to 3 levels deep). Total follow targets across the entire request must not exceed 20.
  - **Budget tiers and authority ordering**:
    1. Tier 1: Explicit required conversations (non-evictable, participate in `required_budget_exceeded` checks).
    2. Tier 2: Required expanded conversations (`required: true`) (non-evictable, participate in `required_budget_exceeded` checks).
    3. Tier 3: Optional expanded conversations (`required: false`) (admitted into remaining budget; omitted with warning if budget is exceeded).
    4. Tier 4: Optional hybrid search retrieval evidence (admitted into remaining budget after expanded sections; evictable under budget pressure).
- `retrieve`: optional array of 0–8 hybrid search retrieval requests:
  - `query`: non-empty search query string.
  - `namespace`: optional namespace scope for this query.
  - `tags`: optional array of up to 20 normalized tags.
  - `tag_mode`: `"all"` (default) or `"any"`.
  - `limit`: number of search hits to retrieve (1–20, default 8).
  - `context_before`: number of surrounding messages before each hit (0–10, default 1).
  - `context_after`: number of surrounding messages after each hit (0–10, default 1).
  - `priority`: integer priority for section ordering.
- `budget`:
  - `max_estimated_tokens`: positive integer upper bound for estimated tokens.
  - `max_serialized_bytes`: positive integer upper bound for total serialized response bytes, at most `49152` (48 KiB) to guarantee response fits within the 64 KiB tool guard with envelope headroom.
- `options`:
  - `deduplicate`: boolean (default `true`). When `true`, deduplicates messages structurally by `(conversation_id, revision_id, source_node_id)`. Required placements take precedence, and overlapping retrieved evidence is attached to provenance rather than duplicating text.
  - `include_provenance`: boolean (default `true`). When `true`, attaches detailed retrieval provenance (`kind`, `request_index`, `conversation_id`, `revision_id`, `source_node_id`, `chunk_ids`, `score`, `sources`) to messages. Core identity (`conversation_id`, `revision_id`, `source_node_id`) is always included on every message even if this option is `false`.
  - `include_compiled_text`: boolean (default `true`). When `true`, generates a deterministic plain-text context projection.

### Output

#### Successful context pack (`status: "complete"`)

```json
{
  "status": "complete",
  "pack_id": "<deterministic-pack-id>",
  "namespace": "project/example",
  "task": "Continue the current scene after xxx reviews her resignation letter",
  "revision_pins": [
    {
      "conversation_id": "0191f6e0-1234-7000-8000-000000000001",
      "revision_id": "<revision-id>",
      "title": "CURRENT",
      "namespace": "project/example"
    }
  ],
  "sections": [
    {
      "kind": "required",
      "request_index": 0,
      "title": "CURRENT",
      "priority": 100,
      "conversation_id": "0191f6e0-1234-7000-8000-000000000001",
      "revision_id": "<revision-id>",
      "messages": [
        {
          "source_node_id": "<source-node-id>",
          "role": "assistant",
          "created_at": "2026-09-17T00:00:00.000Z",
          "updated_at": null,
          "text": "Exact canonical message text",
          "conversation_id": "0191f6e0-1234-7000-8000-000000000001",
          "revision_id": "<revision-id>",
          "provenance": {
            "kind": "required",
            "request_index": 0,
            "conversation_id": "0191f6e0-1234-7000-8000-000000000001",
            "revision_id": "<revision-id>",
            "source_node_id": "<source-node-id>"
          }
        }
      ],
      "estimated_tokens": 1320,
      "serialized_bytes": 6240
    },
    {
      "kind": "retrieved",
      "request_index": 0,
      "title": "Mia Agency Resignation Context",
      "priority": 70,
      "conversation_id": "0191f6e0-5678-7000-8000-000000000002",
      "revision_id": "<retrieved-revision-id>",
      "messages": [
        {
          "source_node_id": "<retrieved-node-id>",
          "role": "user",
          "created_at": "2026-09-14T00:00:00.000Z",
          "updated_at": null,
          "text": "Mia submitted the resignation letter citing professional responsibility.",
          "conversation_id": "0191f6e0-5678-7000-8000-000000000002",
          "revision_id": "<retrieved-revision-id>",
          "provenance": {
            "kind": "retrieved",
            "request_index": 0,
            "conversation_id": "0191f6e0-5678-7000-8000-000000000002",
            "revision_id": "<retrieved-revision-id>",
            "source_node_id": "<retrieved-node-id>",
            "chunk_ids": ["<chunk-id>"],
            "score": 0.88,
            "sources": ["bm25", "vector"]
          }
        }
      ],
      "estimated_tokens": 680,
      "serialized_bytes": 3100,
      "matched_chunk_ids": ["<chunk-id>"],
      "matched_ranges": [
        {
          "source_node_id": "<retrieved-node-id>",
          "char_start": 0,
          "char_end": 74
        }
      ]
    }
  ],
  "budget": {
    "max_estimated_tokens": 8000,
    "used_estimated_tokens": 2000,
    "max_serialized_bytes": 49152,
    "used_serialized_bytes": 10540,
    "estimator": "mempersist-token-estimate-v1"
  },
  "omitted": [
    {
      "kind": "retrieved",
      "conversation_id": "0191f6e0-9999-7000-8000-000000000003",
      "revision_id": "<omitted-revision-id>",
      "reason": "budget"
    }
  ],
  "degraded": false,
  "unavailable": [],
  "warnings": [],
  "compiled_text": "[REQUIRED MEMORY: CURRENT]\nconversation_id: 0191f6e0-1234-7000-8000-000000000001\nrevision_id: <revision-id>\n\nExact canonical message text\n\n[RETRIEVED EVIDENCE: Mia Agency Resignation Context]\nconversation_id: 0191f6e0-5678-7000-8000-000000000002\nrevision_id: <retrieved-revision-id>\nmatched_chunk_ids: <chunk-id>\n\nMia submitted the resignation letter citing professional responsibility."
}
```

#### Required budget overflow (`status: "required_budget_exceeded"`)

If the required content alone exceeds `max_estimated_tokens` or `max_serialized_bytes`, the tool
returns a bounded diagnostic without leaking canonical text:

```json
{
  "status": "required_budget_exceeded",
  "required_estimated_tokens": 11420,
  "required_serialized_bytes": 52800,
  "suggested_minimum": {
    "max_estimated_tokens": 12000,
    "max_serialized_bytes": 54000
  },
  "warnings": [
    {
      "code": "REQUIRED_CONTENT_EXCEEDS_MCP_LIMIT",
      "message": "Required content serialized bytes (52800) exceeds maximum MCP budget of 49152 bytes"
    }
  ],
  "degraded": false,
  "unavailable": []
}
```

When `suggested_minimum.max_serialized_bytes` exceeds 49,152 bytes, the warning code
`REQUIRED_CONTENT_EXCEEDS_MCP_LIMIT` advises the caller to switch required modes from `"full"` to `"tail"`
or page the conversation using `memory_get_conversations` rather than requesting the entire conversation in a
single context pack.

### Semantics and Invariants

1. **Exact selectors and revision pinning**:
   - Every required selector is validated to have exactly one of `conversation_id` or `title`.
   - Title selectors execute exact, case-sensitive binary string comparison against stored canonical titles
     scoped to the tenant and owned namespaces. A title matching zero conversations returns a `NOT_FOUND`
     error; matching multiple conversations returns an `AMBIGUOUS_TITLE` error. Titles are never resolved
     by implicit heuristics like recency.
   - All required conversations have their `current_revision_id` pinned in D1 before any canonical R2
     loading begins. Concurrent appends, replacements, or restores cannot cause a pack to read mismatched
     or half-updated revisions.
   - Canonical revisions are loaded from R2 in bounded waves of 4 concurrent requests.
2. **Branch and mode semantics**:
   - `branch: "active"` (default) follows the conversation's linear active branch (`activeSourceNodeIds`).
   - `branch: "all"` loads all nodes in the revision graph in canonical order.
   - `mode: "full"` selects all messages in the branch.
   - `mode: "tail"` selects the last `tail_messages` whole messages (default 20).
3. **Revision-pinned retrieval and degradation**:
   - Up to 8 hybrid search retrieval requests run concurrently after required revision pinning.
   - Searches are strictly scoped to the tenant and owned namespaces.
   - Retrieved chunks load context messages from the exact `revision_id` returned by the search result,
     never from the current live head. Stale or unreadable retrieved revisions are recorded in `omitted`
     with `reason: "stale_revision"` or `"unavailable"` rather than failing the pack.
   - Required canonical loading does not depend on FTS, Vectorize, or Workers AI. Search degradation or
     outage sets `degraded: true` and populates `unavailable` without reporting canonical data loss.
4. **Structural deduplication**:
   - Deduplication key is `(conversation_id, revision_id, source_node_id)`.
   - Required messages always take precedence over retrieved messages.
   - When a retrieved chunk overlaps an already-included required message, the message is retained in its
     required section and retrieval evidence (`chunk_ids`, `score`, `sources`) is attached to its
     provenance without duplicating the text.
   - Two distinct source nodes with identical text are preserved as distinct messages.
5. **Deterministic authority and ordering**:
   - Required sections always outrank retrieved sections.
   - Required sections are ordered by: `priority DESC`, `request_index ASC`, and canonical message order.
   - Retrieved sections are ordered by: `priority DESC`, `score DESC`, `request_index ASC`, and stable
     identifiers (`conversation_id`, `revision_id`, `chunk_id`, `source_node_id`).
   - The ordering is 100% deterministic and reproducible across independent runs.
6. **Dual token and byte budgeting**:
   - Whole messages are greedily fitted into both `max_estimated_tokens` and `max_serialized_bytes`.
     Messages are never truncated or sliced.
   - The serialized-byte budget accounts for the entire JSON envelope, including message provenance,
     revision pins, omissions, diagnostics, and optional compiled text.
   - `max_serialized_bytes` is capped at `49152` (48 KiB).
   - If required content fits, optional retrieved candidates that do not fit both budgets are placed in
     `omitted` with `reason: "budget"`.
   - If an individual message exceeds the entire budget, a structured diagnostic with its source identity
     and byte size is emitted without leaking message text.
7. **Deterministic pack identity (`pack_id`)**:
   - `pack_id` is a deterministic domain hash (`domainId` SHA-256) computed over the builder version,
     normalized inputs, pinned revision IDs, search generation, selected sections, and compiled text.
   - The same inputs against the same revision state produce the identical `pack_id`.
8. **Deterministic compiled text**:
   - When `include_compiled_text: true`, produces a plain text projection containing section headers
     (`[REQUIRED MEMORY: <title>]`, `[RETRIEVED EVIDENCE: <title>]`), conversation and revision IDs, and
     verbatim message text.
   - Contains no inferred prose, no synthetic summaries, and no content absent from the structured sections.
9. **Extractive-only and no-write guarantee**:
   - Completely read-only and ephemeral: performs no D1 writes, no R2 writes, no Vectorize operations,
     and enqueues no indexing jobs.
   - Does not invoke any LLM or generative model: purely extractive compilation.

## Verified writes

`memory_store`, `memory_append`, `memory_replace`, `memory_commit_batch`,
`memory_edit_messages`, and `memory_restore_revision` accept `verify: true` (default false).
Every write, verified or not, returns a **bounded mutation receipt**: the durable outcome of the
mutation plus its post-commit indexing and verification state. Single-conversation writes keep
`conversation_id`, `previous_revision_id`, `revision_id`, `durable`, and `indexing`; a batch
uses `batch_id`, `status: "committed"`, `durable`, and ordered `results` with those per-operation
fields, adding verification blocks when requested:

```json
{
  "conversation_id": "<conversation ID>",
  "revision_id": "<the committed revision ID>",
  "durable": true,
  "indexing": {
    "status": "queued",
    "job_id": "<job ID>"
  },
  "verification": {
    "status": "passed",
    "revision_id": "<the committed revision ID>",
    "checked_messages": 1,
    "readback_available": true,
    "readback": {
      "conversation": {
        "id": "<conversation ID>",
        "revisionId": "<the committed revision ID>",
        "title": "Synthetic state",
        "namespace": "personal",
        "tags": []
      },
      "messages": [
        {
          "sourceNodeId": "<persisted source node ID>",
          "role": "assistant",
          "text": "The gate is closed.",
          "createdAt": "2026-09-11T00:00:00.000Z",
          "updatedAt": null
        }
      ],
      "offset": 0,
      "nextOffset": null,
      "total": 1,
      "oversizedMessage": null
    }
  },
  "used_serialized_bytes": 2048,
  "max_serialized_bytes": 49152
}
```

This is a shape illustration; real `messages` contain persisted compact messages that fit
the page. Verification reloads the **specific committed revision from R2**, checks its
content integrity, and compares all intended messages, roles, and supplied timestamps
(`memory_edit_messages` supplies none, so it instead re-checks each target's preserved role and
`createdAt`).
Append readback includes only newly appended messages, with their original active offsets. A
batch append item follows the same rule; a batch replace item starts at zero. Store/replace
starts at zero, and message editing returns only the targeted messages, in compact form.
Readback contains at most 100 messages and 48 KiB, with explicit
pagination; verification itself checks all intended messages. Readback tags are the saved
revision snapshot. `verification.readback_available` is always present when verification ran:
`false` means no inline readback was produced, and `verification.readback_error`
(`{ code, message, offset }`) explains why for that page offset.

A passed verification can still have a partial or oversized readback. Follow `nextOffset`
using the committed `revision_id` and `format: "compact"` before declaring semantic review
complete. The server cannot detect facts the AI omitted from its own request.

### Receipt contract

Every write tool emits the same bounded receipt, including `memory_commit_batch` and each
per-item receipt of `memory_copy_conversations`. The envelope is flat for singles
(`memory_store`/`memory_append`/`memory_replace`/`memory_edit_messages`/`memory_restore_revision`)
and `batch_id`/`status`/`results`-wrapped for `memory_commit_batch` and bulk copy; both add
`readback_requests` and `omitted` only when they are non-empty, plus `used_serialized_bytes` and
`max_serialized_bytes` always.

The budget is a documented safe maximum of **49,152 bytes (48 KiB)**, below the 64 KiB MCP
`toolResult` guard. `max_serialized_bytes` echoes the budget actually used. When a receipt would
exceed it, the server sheds optional (verbose) data in this exact order, recording each shed
field path in `omitted`:

1. inline `verification.readback` (and `verification.readback_error`) per item;
2. `readback_requests` → emptied;
3. `verification.readback_error` → dropped everywhere;
4. `verification.checked_messages` → dropped;
5. `indexing.error` → dropped;
6. `indexing.job_id` → dropped;
7. `source_revision_id` → dropped;
8. `source_conversation_id` → dropped;
9. `error.message` → truncated to 80 characters;
10. `error.message` → dropped entirely (`error.code` retained).

For a batch, `batch_id`, top-level `status`, and top-level `durable` are also never shed.
Within each result these fields are never shed: `request_index`, `status`,
`conversation_id`, `previous_revision_id`, `revision_id`, `durable`, `indexing.status`,
`verification.status`, `verification.revision_id`, `verification.readback_available`, and
`error.code`. `readback_requests` entries are exactly a valid first-call `requests` payload for
`memory_get_conversations` (`conversation_id`, `revision_id`, `offset`, `limit` 20, and
`branch`); `offset` is the verification page offset (0 for copies and batch items). `branch` is
`"active"` for `memory_store`, `memory_append`, `memory_replace`, `memory_commit_batch`,
`memory_restore_revision`, and each `memory_copy_conversations` item, but `"all"` for
`memory_edit_messages`, whose targets may sit on an inactive branch that an active-branch page
would omit. Passing these selectors back and looping `nextCursor` until `null` completes readback
that was shed from the receipt.

Because the envelope is measured and shed before serialization, this holds even when verbose data
does not fit. A durable committed mutation never becomes a generic response-size error; the 64 KiB
`toolResult` guard remains only as defense in depth.

### Failure and retry semantics

Failures after the canonical commit still return `durable: true` with the committed revision
identity and a categorized error, so a committed write is never lost to a later step. For a
batch, inspect each result's indexing and verification state independently.

- `verification.status: "failed"` with `error.code: "CANONICAL_STORAGE"` indicates a missing,
  unreadable, mismatched, or integrity-failing committed revision.
- `indexing.status: "failed"` with `error.code: "DERIVED_INDEXING"` (`{ code, message, retryable }`)
  means queueing failed. A queued status only acknowledges scheduling, not successful eventual
  indexing.

`memory_commit_batch` and `memory_copy_conversations` are idempotent: replaying identical
material with the same account-scoped `idempotency_key` returns the existing durable receipt or
result without duplicate revisions or jobs. Changed material under an existing batch key is a
bounded conflict. The non-idempotent tools (`memory_store`, `memory_append`, `memory_replace`,
`memory_edit_messages`, `memory_restore_revision`) must inspect the current head before
retrying, so a durable commit is not duplicated. Canonical write failures and revision conflicts
still return tool errors without a success receipt. See [recovery](operations-and-recovery.md).

HTTP store and append also accept `verify` and use the same post-commit reporting.
See [RP workflow and proposed runtime-rule amendment](rp-workflow.md).

## Tags

Tags are optional conversation-level strings on `memory_store` and `memory_append`. They are
trimmed, lowercased, deduplicated, capped at 20 tags of 64 characters each, and stored in both the
canonical revision manifest (revision-time snapshot) and the `conversation_tags` D1 table (live
source of truth). `memory_append` adds tags to the existing set (union); a plain append without
tags leaves them untouched. `memory_update_tags` adds/removes tags with optimistic revision
checking (removals apply before additions). `memory_search` and `memory_list_conversations`
accept `tags` plus `tag_mode: "all" | "any"` (default `all`); `memory_get_conversation` returns
the live tags in its metadata. Matching tags add a bounded ranking boost of at most 0.25. Tags
are conversation-level routing labels (`rp`, `events`, `chronology`), not per-event concepts:
granular event tags inside one container conversation are out of scope, and hashtags in body text
are never parsed.
