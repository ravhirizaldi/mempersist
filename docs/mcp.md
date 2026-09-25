# MCP

Mempersist uses the official MCP TypeScript SDK v2 and Cloudflare Agents `createMcpHandler` with stateless Streamable HTTP. A fresh server is created per request; no Durable Object or SSE compatibility lane exists.

Primary endpoint: `https://mempersist.codifiedtech.id/mcp`. Browser CORS is disabled. The server caps serialized tool output at 64 KiB and asks callers to narrow pages rather than returning broken/truncated JSON.

The legacy endpoint `https://mempersist.nextostaging.net/mcp` remains active for existing
connections. Leave those clients unchanged to avoid reauthorization; moving one client to the
primary endpoint requires one new authorization for that client.

## Authentication

- ChatGPT and other interactive MCP clients use OAuth 2.1 authorization code with PKCE S256.
- OAuth discovery, token exchange, refresh, revocation, Client ID Metadata Documents, and dynamic client registration are provided by Cloudflare's official Workers OAuth package.
- The consent page asks for an email and offers one `Continue with email` action.
  MemPersist sends a single-use, 15-minute magic link through Cloudflare Email Service. An
  existing email reconnects to its archive; a new user is created only after opening the link.
  The existing owner archive is bound to `vhie1046@gmail.com`.
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

To connect ChatGPT:

1. Enable Developer mode in ChatGPT settings.
2. Add a custom MCP app/plugin with endpoint `https://mempersist.codifiedtech.id/mcp`.
3. Enter the email tied to your MemPersist archive and click `Continue with email`.
4. Open the magic link sent to that email. ChatGPT will finish the OAuth connection.
5. Review the discovered tools, then enable the app for a conversation.

Already-connected ChatGPT clients using the legacy endpoint keep working after deployment.
If you change that endpoint to the primary hostname, re-authorize that client once. Pre-existing
grants continue mapping to the owner archive.

Do not paste `MEMORY_API_TOKEN` into ChatGPT's app configuration; it is for developer API and
CLI use only. OAuth discovery is exposed at `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server`.

## Coding agents (Codex, Claude Code, Cursor, IDE extensions)

MemPersist is a remote Streamable HTTP MCP server, so no `npx` bridge is needed — point the
client at the endpoint URL and authorize with the email tied to your archive.

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

| Tool                           | Important inputs                                                                  | Result                                                            |
| ------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `memory_search`                | query, limit 1–20, tags, tag_mode                                                 | compact ranked chunk references and degradation state             |
| `memory_get_context`           | chunk ID, before/after 0–10                                                       | canonical matched ranges and surrounding messages                 |
| `memory_get_conversation`      | conversation ID, branch, offset, limit                                            | paginated active timeline or all graph nodes                      |
| `memory_get_conversations`     | `requests` or `cursor`, `max_serialized_bytes`                                    | fair, revision-pinned compact batch pages                         |
| `memory_list_conversations`    | cursor, limit, tags, tag_mode                                                     | metadata and tags only                                            |
| `memory_list_revisions`        | conversation ID, cursor, limit 1–100                                              | revision metadata newest first, current head marked               |
| `memory_resolve_conversations` | 1–20 exact titles, optional namespace and tags                                    | conversation IDs, current revision IDs, and live tags             |
| `memory_build_context`         | task, 1–20 required selectors, max 8 retrieve, budgets, options                   | deterministic revision-pinned context pack within token/byte caps |
| `memory_list_namespaces`       | —                                                                                 | namespaces you own with conversation counts                       |
| `memory_stats`                 | —                                                                                 | per-namespace counts plus indexing health                         |
| `memory_store`                 | title, tags, 1–1000 messages                                                      | durable revision plus queued index job                            |
| `memory_append`                | conversation ID, base revision, tags, messages                                    | optimistic durable revision plus queued index job                 |
| `memory_replace`               | conversation ID, base revision, messages                                          | replacement revision plus queued index job                        |
| `memory_update_tags`           | conversation ID, base revision, add/remove                                        | live tag list after revision-safe mutation                        |
| `memory_restore_revision`      | conversation ID, revision ID, base revision, verify                               | restores head to historic revision; durable receipt and index job |
| `memory_copy_conversations`    | target_namespace, create_target_namespace, idempotency_key, 1–20 requests, verify | ordered per-item receipts                                         |
| `memory_delete_conversations`  | 1–100 unique conversation IDs                                                     | deleted, missing, and per-ID failures                             |
| `memory_empty_namespace`       | matching namespace confirmation pair                                              | deletes one of your namespaces; bounded, resumable                |
| `memory_import_status`         | import UUID                                                                       | progress, duplicate, or failure metadata                          |

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
memory, `memory_restore_revision` to revert to an earlier known good revision without synthesizing
duplicate transcripts, and `memory_copy_conversations` for lossless copying into another owned namespace.
Administrative retry/reindex/integrity operations remain HTTP/CLI only so
ordinary LLM tool calls cannot trigger expensive maintenance accidentally.

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
  ]
}
```

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
      "namespace": "astara_alt_v2",
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
          "namespace": "astara_alt_v2",
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
  "namespace": "astara_alt_v2",
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
      "namespace": "astara_alt_v2",
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
  "namespace": "astara_alt_v2",
  "task": "Continue the current scene after xxx reviews her resignation letter",
  "revision_pins": [
    {
      "conversation_id": "0191f6e0-1234-7000-8000-000000000001",
      "revision_id": "<revision-id>",
      "title": "CURRENT",
      "namespace": "astara_alt_v2"
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

`memory_store`, `memory_append`, and `memory_replace` accept `verify: true` (default false).
The response keeps `conversation_id`, `revision_id`, `durable`, and `indexing`, and adds:

```json
{
  "verification": {
    "status": "passed",
    "revision_id": "<the committed revision ID>",
    "checked_messages": 1,
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
  }
}
```

This is a shape illustration; real `messages` contain persisted compact messages that fit
the page. Verification reloads the **specific committed revision from R2**, checks its
content integrity, and compares all intended messages, roles, and supplied timestamps.
Append readback includes only newly appended messages, with their original active offsets.
Store/replace starts at zero. Readback contains at most 100 messages and 48 KiB, with explicit
pagination; verification itself checks all intended messages. Readback tags are the saved
revision snapshot. A `readback_error` reports metadata too large for a bounded readback.

A passed verification can still have a partial or oversized readback. Follow `nextOffset`
using the committed `revision_id` and `format: "compact"` before declaring semantic review
complete. The server cannot detect facts the AI omitted from its own request.

Failures after commit retain `durable: true` and the committed revision ID:

- `verification.status: "failed"` with `error.code: "CANONICAL_STORAGE"` indicates a missing,
  unreadable, mismatched, or integrity-failing committed revision.
- `indexing.status: "failed"` with `error.code: "DERIVED_INDEXING"` means queueing failed.
  A queued status only acknowledges scheduling, not successful eventual indexing.
- Neither failure makes the write disappear or warrants blindly repeating store/append.
  See [recovery](operations-and-recovery.md). Canonical write failures and revision conflicts
  still return tool errors without a success receipt.

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
