# ADR 0024: Registration-first magic-link MCP authentication

- Status: Accepted
- Date: 2026-08-20
- Supersedes: the authorization behavior in ADR 0020

## Context

The MCP OAuth consent page previously created a D1 user as soon as an email was entered.
That allowed authorization based on email knowledge alone. MemPersist now has Cloudflare
Email Service enabled for `noreply@mempersist.nextostaging.net` and needs passwordless
authentication without changing existing users or the legacy developer token.

## Decision

The `/authorize` page offers explicit `Register` and `Sign in` actions. Both actions create a
short-lived, single-use challenge only when the requested state is valid:

- `Register` accepts an email absent from `users`.
- `Sign in` accepts an email already present in `users`.

The challenge stores a SHA-256 token hash and the validated OAuth/PKCE request in D1. The email
contains the raw token in a link under `/auth/magic-link`. The callback atomically consumes the
challenge, creates a new user only for registration, and resumes the original OAuth request.

Existing `users` rows are grandfathered as registered. Existing namespaces, conversations,
OAuth grants, and `MEMORY_API_TOKEN` access remain unchanged. `/api/*` remains bearer-token
authenticated; browser sessions and per-user API tokens remain out of scope.

## Consequences

- Possession of the registered email account is required for new OAuth authorization.
- Magic links expire after 15 minutes and cannot be replayed.
- D1 stores temporary authentication state but never stores raw magic-link tokens.
- Email delivery failure leaves canonical memory and user data untouched.
- Users must request a new magic link when starting a new OAuth authorization after a grant is
  expired or revoked; no separate MemPersist browser session is introduced.
