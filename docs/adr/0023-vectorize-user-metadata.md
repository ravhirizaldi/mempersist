# ADR 0023: user_id in vectorize metadata with one-time reindex

- Status: Accepted
- Date: 2026-08-19

## Context

ADR 0022 scoped semantic results through a post-query row-level ownership
filter, keeping Vectorize metadata unchanged. Same-named namespaces across
accounts still matched the metadata filter, wasting topK slots with other
users' candidates before they were dropped.

## Decision

`indexRevision` now writes `user_id` into each vector's metadata, and the
semantic channel filters `user_id: { $eq }` (plus generation and namespace)
inside Vectorize. One reindex of all current revisions runs after deploy so
existing vectors carry the new metadata; FTS/recent channels and the final
row-level ownership filter remain unchanged as defense in depth.

## Consequences

- Vectorize queries no longer see another account's same-named namespace
  candidates at all.
- Until the reindex completes, owner semantic search can return empty results
  (lexical and recent-canonical channels still work); derived data is
  disposable, so a failed reindex can simply be retried.
