# ADR 0025: Unified email continuation

- Status: Accepted
- Date: 2026-08-20
- Supersedes: the user-facing mode selection in ADR 0024

## Context

The passwordless magic-link flow needs to preserve existing users while avoiding a confusing
choice between two buttons that both ask for an email and send a link. The email address already
determines whether the account exists.

## Decision

The OAuth consent page exposes one `Continue with email` action alongside `Cancel`. The server
looks up the normalized email before issuing a challenge:

- An existing `users` row resolves to the internal `login` challenge mode.
- An unknown email resolves to the internal `register` challenge mode.
- A new user is still created only after the one-use magic link is opened.

The stored challenge keeps the resolved internal mode so the callback remains explicit and
existing user IDs, namespaces, conversations, grants, and developer-token access are unchanged.
The response remains generic for ineligible or rate-limited requests.

## Consequences

- Users have one obvious email-first action and cannot choose the wrong registration state.
- Existing archives reconnect by the same normalized email.
- New users do not need a separate registration button; opening the verified link is registration.
- The callback and D1 challenge schema continue to distinguish login from registration internally.
