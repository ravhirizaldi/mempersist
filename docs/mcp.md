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

| Tool                           | Important inputs                                    | Result                                                            |
| ------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------- |
| `memory_search`                | query, limit 1–20, tags, tag_mode                   | compact ranked chunk references and degradation state             |
| `memory_get_context`           | chunk ID, before/after 0–10                         | canonical matched ranges and surrounding messages                 |
| `memory_get_conversation`      | conversation ID, branch, offset, limit              | paginated active timeline or all graph nodes                      |
| `memory_get_conversations`     | 1–20 conversation requests                          | ordered compact pages, errors, and continuations                  |
| `memory_list_conversations`    | cursor, limit, tags, tag_mode                       | metadata and tags only                                            |
| `memory_list_revisions`        | conversation ID, cursor, limit 1–100                | revision metadata newest first, current head marked               |
| `memory_resolve_conversations` | 1–20 exact titles, optional namespace and tags      | conversation IDs, current revision IDs, and live tags             |
| `memory_list_namespaces`       | —                                                   | namespaces you own with conversation counts                       |
| `memory_stats`                 | —                                                   | per-namespace counts plus indexing health                         |
| `memory_store`                 | title, tags, 1–1000 messages                        | durable revision plus queued index job                            |
| `memory_append`                | conversation ID, base revision, tags, messages      | optimistic durable revision plus queued index job                 |
| `memory_replace`               | conversation ID, base revision, messages            | replacement revision plus queued index job                        |
| `memory_update_tags`           | conversation ID, base revision, add/remove          | live tag list after revision-safe mutation                        |
| `memory_restore_revision`      | conversation ID, revision ID, base revision, verify | restores head to historic revision; durable receipt and index job |
| `memory_delete_conversations`  | 1–100 unique conversation IDs                       | deleted, missing, and per-ID failures                             |
| `memory_empty_namespace`       | matching namespace confirmation pair                | deletes one of your namespaces; bounded, resumable                |
| `memory_import_status`         | import UUID                                         | progress, duplicate, or failure metadata                          |

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
memory, and `memory_restore_revision` to revert to an earlier known good revision without synthesizing
duplicate transcripts. Administrative retry/reindex/integrity operations remain HTTP/CLI only so
ordinary LLM tool calls cannot trigger expensive maintenance accidentally.

## Compact reads and batches

`memory_get_conversation` and `memory_get_context` accept `format: "compact" | "canonical"`.
Omitting it preserves the existing canonical response. Compact messages contain
`sourceNodeId`, `role`, `createdAt`, `updatedAt`, and exact original `text`. Conversation
metadata includes ID, revision ID, title, namespace, and tags. Context reads retain
`matchedRanges`; compact conversation pages add `offset` alongside `nextOffset` and `total`.
Duplicate content parts, raw source objects, and branch graph metadata are omitted only
from the response, never from the archive.

`memory_get_conversations` accepts a `requests` array of 1–20 objects, each with:

- `conversation_id`: a memory UUID or 64-character hexadecimal conversation ID.
- `offset`: nonnegative integer, default 0; `limit`: 1–100, default 20.
- `branch`: `active` (default) or `all`.
- `revision_id`: optional 64-character hexadecimal revision ID for that owned conversation.

The tool always returns compact output as `{ "results": [...] }` in input order. Duplicate
IDs are allowed, for example when requesting different pages. Each entry has `requestIndex`,
`status` (`ok`, `error`, or `deferred`), and `continuation` (a request object or null). Successful
entries include `page`; failures include a categorized, content-free `error`. Missing and
foreign IDs produce the same not-found error, including foreign revision IDs.

Follow every non-null `continuation`, including partial successful pages and deferred
requests, by placing it in the next `requests` array. Continuations include `revision_id`
to keep pages on the same immutable revision. Single conversation reads also accept
`revision_id`, so they can finish a batch or verified-save readback. Ordinary reads without
it still use the current revision. Tags on ordinary reads remain the live catalog tags.

The combined batch JSON is at most 48 KiB; no more than four canonical read chains run at
once. Whole messages are paginated, never truncated. A message too large for its individual
response budget produces `page.oversizedMessage` with `offset`, `sourceNodeId`, and serialized
message `bytes`; `nextOffset` stays on that message. This requires a separate canonical
HTTP read/export, not repeated identical batch calls. Oversized metadata produces an explicit
`RESPONSE_TOO_LARGE` error. Single compact conversation pages also use a 48 KiB budget.
Context responses retain the existing 64 KiB tool guard; narrow before/after when needed.

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
