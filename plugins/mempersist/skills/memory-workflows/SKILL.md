---
name: memory-workflows
description: Search, retrieve, build, and intentionally update MemPersist conversation memory with account scoping, revision safety, explicit consent, and bounded results. Use when a user asks to find, inspect, save, revise, restore, or delete stored memory.
---

# MemPersist memory workflows

Use this skill for explicit memory tasks. Treat ordinary conversation as read-only.

## Retrieve memory

1. Identify the user's topic, requested namespace, and desired output size. Never infer missing memory.
2. Call `memory_search` first when the conversation or exact memory identity is unknown. Set a bounded `limit` and `max_serialized_bytes`.
3. Select only results returned for the authenticated account.
4. Call `memory_get_context` for a selected search hit when the user needs surrounding original messages.
5. Call `memory_get_messages` when the user supplies an exact conversation, revision, source-node, or message-key identity.
6. Call `memory_build_context` when a task needs several required memories or retrieval queries. Set explicit token and serialized-byte budgets.
7. Follow opaque continuation cursors with only the cursor and bounded budget. Do not resend changed filters or treat a cursor as an export.
8. Report exact conversation and revision identifiers. State when no result exists.

## Save or revise memory

1. Require explicit user intent before every durable write. Do not capture, summarize, or save the surrounding chat automatically.
2. Search first before creating a potentially duplicate memory.
3. For a new memory, call `memory_store` with only the user-approved title, tags, and messages.
4. For an existing memory, read its current revision before writing. Use `memory_append` for a genuine continuation, `memory_replace` only with the complete intended transcript, and `memory_edit_messages` for known source nodes.
5. For stable keyed state, resolve or read the exact owned conversation, retain its current `base_revision_id`, then call `memory_upsert_messages`. Preserve the existing role and key shape.
6. For several owners that must advance together, read every affected owner first, then call one `memory_commit_batch` with explicit base revisions and one stable idempotency key.
7. Inspect durable, indexing, and verification results separately. A durable commit remains committed if a later index or verification step fails; do not blindly repeat it.
8. Report the returned revision, receipt status, and any indexing or verification limitation. Never claim a write succeeded without a durable result.

## Restore or delete memory

1. Resolve the exact owned conversation and revision before a restore. Use `memory_restore_revision` only with the current base revision and the user's requested historical revision.
2. Before `memory_delete_conversations`, require `confirm_conversation_ids` to exactly match `conversation_ids` in length, values, and order.
3. Require the exact confirmation pair and namespace scope before `memory_empty_namespace`.
4. Never delete because a user merely mentions cleanup, because memory is old, or because a search returns duplicates.
5. Report deleted identifiers and bounded completion status. Never claim deletion for an unconfirmed or failed operation.

## Safety boundaries

- Use only the authenticated account's owned namespaces. Refuse requests for another account.
- Never invent a memory, owner, conversation ID, revision ID, source node, or message key.
- Keep responses bounded. Prefer compact output, narrow limits, and explicit byte budgets.
- Do not expose tokens, cursors, internal storage keys, or private authorization data.
- Do not call destructive tools during ordinary retrieval.
