# ADR 0020: Simple email SaaS authorization with per-user namespaces

- Status: Accepted
- Date: 2026-08-19
- Supersedes: ADR 0008 owner-key consent (authorization step only)

## Context

V1 ships as single-owner developer software: the consent page asks for `MEMORY_API_TOKEN`
and every archive lives under one namespace. The owner wants a simple SaaS flow — enter an
email, get instant access, then authorize a ChatGPT/MCP connection — while keeping the
existing dev token and the existing archive working.

## Decision

The `/authorize` consent page now takes an email instead of the owner access key. Emails are
normalized (trim, lowercase) and mapped deterministically to a user id (SHA-256 of
`user\x1f<email>`). A `users` table records id, email, and the tenant namespace; account
provisioning is an idempotent `INSERT OR IGNORE`, so any email is instantly ready.

Per-user isolation is implemented as namespace pinning: every MCP tool and `/api/*` route
resolves the caller's tenant namespace (OAuth user id → `users.namespace`, legacy
`owner`/static token → `personal`) and forces it through the existing namespace filters in
conversations, chunks, FTS, and Vectorize metadata. ID-addressed reads, appends, tag
updates, and deletions verify the target conversation or chunk belongs to the caller's
namespace before acting. `delete_all_memories` is scoped to the caller's tenant.

The existing archive is bound to `vhie1046@gmail.com`: the migration seeds that user with
namespace `personal`, and the legacy `owner` identity (static bearer token and any grant
issued before this ADR) aliases to it. Existing ChatGPT connections therefore keep working
without re-authorization.

## Consequences

- Email is the only credential: anyone who knows an account email can authorize a client
  for it. There is no password or emailed verification (no mail infrastructure exists).
- `MEMORY_API_TOKEN` remains the developer token for `/api/*`, the CLI import path, and
  static-bearer MCP access; `.dev.vars.example` is unchanged.
- No per-user API tokens are minted; email users get MCP access only.
- D1 remains the only database. PostgreSQL/Hyperdrive would add an external account and
  contradict ADR 0003; the tenant volume fits D1.
- Namespace inputs on MCP tools are accepted for compatibility but are always overridden by
  the caller's tenant namespace. A new user sees an empty archive until they write or import
  into it.

## Alternatives considered

- Per-user bearer tokens: rejected for V1 — adds token storage, rotation, and revocation
  without any current client that needs it.
- Full user_id columns on every table and user-prefixed R2 keys: rejected — the namespace
  dimension already flows through every retrieval path, so pinning it yields the same
  isolation with a smaller, additive change.
- PostgreSQL via Hyperdrive: rejected — D1 already stores the catalog, and this feature
  adds no workload that needs it.
