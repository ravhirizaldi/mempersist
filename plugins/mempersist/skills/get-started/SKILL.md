---
name: get-started
description: Connect to MemPersist, inspect account-scoped capabilities, and perform a first bounded read or explicitly requested save. Use when a user is new to MemPersist or asks how to set it up.
---

# Get started with MemPersist

Use MemPersist at `https://mempersist.codifiedtech.id/mcp` through an MCP client with OAuth authentication. Never request or expose a developer token in chat.

## Connect and inspect

1. Add the Streamable HTTP endpoint to the MCP client.
2. Complete the client's OAuth consent flow for the user's own account.
3. Call `memory_get_capabilities` first to learn deployed limits and feature flags.
4. Call `memory_list_namespaces` to show only namespaces owned by the authenticated account.
5. Call `memory_stats` with bounded output to show counts and indexing health.
6. Explain that ordinary retrieval is read-only and MemPersist does not intercept or automatically capture chats.

## Try a first read

1. Ask for a topic or exact memory identity. Do not invent one.
2. Call `memory_search` with a bounded limit and byte budget.
3. If the user selects a result, call `memory_get_context` for its original surrounding messages.
4. Report the returned conversation and revision identifiers, exact relevant text, and any missing or degraded result.
5. Follow only returned opaque cursors, sending no changed search filters.

## Save intentionally

1. Ask the user to name the memory and approve the exact content, namespace, and tags.
2. Search first with `memory_search` to avoid duplicate creation.
3. On explicit approval, call `memory_store` with only the approved messages.
4. Report the durable receipt, conversation ID, revision ID, and independent indexing status.
5. If the user did not explicitly approve a write, stop after retrieval and offer the exact save action.

## Keep access safe

- Use only the authenticated account's owned namespaces.
- Never automatically save the current chat or infer facts absent from memory.
- Never request another account's archive.
- Require explicit confirmation and exact scope before any deletion.
- Keep reads and responses bounded with tool limits and serialized-byte budgets.
