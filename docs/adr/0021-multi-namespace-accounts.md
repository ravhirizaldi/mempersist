# ADR 0021: Multi-namespace accounts with validated namespace scoping

- Status: Accepted
- Date: 2026-08-19
- Supersedes: the single-namespace pinning decision in ADR 0020

## Context

Per-user isolation in ADR 0020 pinned every request to exactly one namespace per
account. The owner's real archive lives in several namespaces created before the
SaaS switch (`astara_alt_v2`, `coding/mempersist`, `test/mempersist-blackbox`,
plus the `personal` default), and the owner wants those folders to remain
addressable by name under `vhie1046@gmail.com`.

## Decision

A `user_namespaces` table maps accounts to as many namespaces as they own.
Namespace names are globally unique across the deployment, so a namespace string
is itself an ownership claim: two accounts can never share or collide on the same
name.

- Provisioning (`getOrCreateUser`) grants the account's deterministic default
  namespace (the owner keeps `personal`; new accounts use their user id).
- The owner migration binds every namespace already present in `conversations`
  to the owner account under its existing name — no conversations move, no
  reindex runs.
- MCP tools and `/api/*` resolve the caller's namespace set from OAuth/static
  identity. A client-supplied namespace is honored only if the caller owns it;
  omitting it scopes reads to every namespace the caller owns (restores the
  pre-SaaS "search everything of mine" behavior).
- Writing into a new namespace via `memory_store` or `/api/memories` claims it
  for the caller; claiming a name another account already owns fails with 403.
- Deletion (`memory_delete_all`, `memory_delete_namespace`,
  `memory_delete_conversations`) and ID-addressed reads/appends/tag updates are
  guarded by the caller's namespace set, never by a bare string.

## Consequences

- The owner's existing archive is fully reachable again under its original
  namespace names through the owner email and the static token.
- New accounts stay isolated: they only ever see namespaces they own, and they
  cannot squat names the owner (or anyone else) already claimed.
- Namespace names are now a shared, unique namespace across tenants; a friendly
  name taken by one account is unavailable to others.
- Search/retrieval internals filter by a namespace set (FTS `IN`, Vectorize
  `$in`) instead of a single equality, so cross-namespace queries remain one
  ranked pass.
- No conversation or index data is rewritten; the change is additive D1 schema
  plus per-request scoping.

## Alternatives considered

- Owner sees every namespace in the database: rejected — leaks future tenants'
  data into the owner scope.
- Migrating all conversations into one `personal` namespace: rejected — destroys
  the owner's folder organization and requires a full reindex.
- User-prefixed synthetic namespace names: rejected — breaks the existing
  namespace names the owner already uses.
