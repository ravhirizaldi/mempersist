# MCP

Mempersist uses the official MCP TypeScript SDK v2 and Cloudflare Agents `createMcpHandler` with stateless Streamable HTTP. A fresh server is created per request; no Durable Object or SSE compatibility lane exists.

Endpoint: `https://mempersist.nextostaging.net/mcp`. Browser CORS is disabled. The server caps serialized tool output at 64 KiB and asks callers to narrow pages rather than returning broken/truncated JSON.

## Authentication

- ChatGPT and other interactive MCP clients use OAuth 2.1 authorization code with PKCE S256.
- OAuth discovery, token exchange, refresh, revocation, Client ID Metadata Documents, and dynamic client registration are provided by Cloudflare's official Workers OAuth package.
- The consent page asks the single owner for `MEMORY_API_TOKEN`; that key is validated once and is not returned to the client.
- Developer MCP clients may continue sending `Authorization: Bearer <MEMORY_API_TOKEN>` directly.
- The single V1 scope is `memory`, covering search, retrieval, and intentional writes.

To connect ChatGPT:

1. Enable Developer mode in ChatGPT settings.
2. Add a custom MCP app/plugin with endpoint `https://mempersist.nextostaging.net/mcp`.
3. Complete the OAuth prompt and enter the owner access key on the MemPersist page.
4. Review the discovered tools, then enable the app for a conversation.

Do not paste the owner key into ChatGPT's app configuration. OAuth discovery is exposed at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`.

| Tool                          | Important inputs                               | Result                                                |
| ----------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `memory_search`               | query, limit 1–20, namespace, tags, tag_mode   | compact ranked chunk references and degradation state |
| `memory_get_context`          | chunk ID, before/after 0–10                    | canonical matched ranges and surrounding messages     |
| `memory_get_conversation`     | conversation ID, branch, offset, limit         | paginated active timeline or all graph nodes          |
| `memory_list_conversations`   | cursor, limit, namespace, tags, tag_mode       | metadata and tags only                                |
| `memory_store`                | title, namespace, tags, 1–1000 messages        | durable revision plus queued index job                |
| `memory_append`               | conversation ID, base revision, tags, messages | optimistic durable revision plus queued index job     |
| `memory_update_tags`          | conversation ID, base revision, add/remove     | live tag list after revision-safe mutation            |
| `memory_delete_conversations` | 1–100 unique conversation IDs                  | deleted, missing, and per-ID failures                 |
| `memory_delete_namespace`     | namespace plus an exact `confirm_namespace`    | bounded count, failures, remaining, and completion    |
| `memory_delete_all`           | exact confirmation `DELETE_ALL_MEMORIES`       | bounded count, failures, remaining, and completion    |
| `memory_import_status`        | import UUID                                    | progress, duplicate, or failure metadata              |

Namespace and all-memory deletion process at most 500 conversations per call. If `complete` is
false, repeat the same idempotent tool call; `remaining` reports the current catalog count. Raw
ChatGPT import archives are intentionally retained. A deletion is reported as complete for a
conversation only after its canonical R2 keys have been deleted and its D1 catalog cleanup has
committed.

The intended client pattern is search → select → get context. Administrative retry/reindex/integrity operations remain HTTP/CLI only so ordinary LLM tool calls cannot trigger expensive maintenance accidentally.

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
