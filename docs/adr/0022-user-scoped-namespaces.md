# ADR 0022: User-scoped namespaces (same name allowed across accounts)

- Status: Accepted
- Date: 2026-08-19
- Supersedes: the global namespace-name uniqueness in ADR 0021

## Context

ADR 0021 made namespace names globally unique so a bare namespace string could
scope data. The owner wants two accounts to be able to use the same friendly
name (e.g. both having a namespace called `ABC`), each isolated from the other.

## Decision

Namespace names are per-user labels. Isolation is `(user_id, namespace)`, not
the namespace string alone:

- `conversations.user_id` records the owning account; existing rows backfill to
  the owner via the migration default, so no data moves.
- `user_namespaces` no longer enforces global uniqueness; the same name can be
  granted to any number of accounts.
- Every data path scopes by the caller's user id: conversation writes,
  ID-addressed reads/appends/tag updates, listing, search row loading, chunk
  context, and all deletion scopes (`WHERE user_id = ? AND namespace IN (...)`).
- The semantic vector channel still filters by namespace metadata, but the
  final row load (`fetchChunkRows`) enforces user + namespace ownership, so
  same-named namespaces of other accounts are never returned. No reindex or
  vectorize metadata change is required.

## Consequences

- User A and user B can each own `ABC` with fully separated data.
- The namespace string alone is no longer an identity; a same-named namespace
  in another account is invisible and undeletable.
- `memory_delete_all` / `memory_delete_namespace` / `memory_delete_conversations`
  now require the caller's user id in addition to the namespace set.
- Owner legacy data keeps working: all pre-existing conversations defaulted to
  the owner's user id.

## Alternatives considered

- User-prefixed stored namespaces (`<user-id>/ABC`): rejected — encoding leaks
  into stored values, breaks existing bare names, and complicates every query.
- Vectorize metadata `user_id` plus full reindex: rejected — the row-level
  ownership filter gives the same isolation without touching disposable
  derived data or running a rebuild.
