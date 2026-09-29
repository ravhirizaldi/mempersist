# Security

## Scope

This document covers the production Worker at `https://mempersist.codifiedtech.id`: its HTTP API,
the OAuth-protected MCP endpoint, the consent and magic-link pages, the server-rendered dashboard,
and the Queue handlers. V1 is single-user software — one account owns one or more namespaces, and
every request is scoped to that account. Cloudflare platform security, third-party MCP clients, and
the ChatGPT export format itself are outside this document.

## Assets

| Asset                                   | Where                                         | Why it matters                                                  |
| --------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| Canonical conversation revisions        | R2, private bucket                            | The archive; the only copy treated as truth                     |
| Catalog and derived indexes             | D1                                            | Operational state; chunk bodies are disposable, still sensitive |
| OAuth grants, access and refresh tokens | Cloudflare KV via the official OAuth provider | Live access to the archive                                      |
| Dashboard sessions and magic links      | D1, stored as hashes only                     | The same access, from a browser                                 |
| `MEMORY_API_TOKEN`                      | Wrangler secret, ignored `.dev.vars`          | Full owner access; bypasses OAuth                               |
| Exports                                 | Streamed to the authenticated caller          | A complete copy of the archive                                  |

## Threat model

Primary risks, in the order this project reasons about them:

1. Unauthorized reads or writes of another account's archive.
2. A leaked or stolen token, session, or magic link.
3. Email guessing used to take over an existing archive.
4. Abusive or accidental deletion of canonical data.
5. A malicious or malformed import: oversized, truncated, hostile JSON.
6. Content leaking through logs, error messages, index metadata, or search results.
7. Dependency or supply-chain compromise in the Worker bundle.

Non-goals for V1: defense against a compromised Cloudflare account or dashboard, end-to-end
encryption (the Worker must read content to chunk and index it), per-tool OAuth scopes, MFA beyond
possession of the magic link, and protection of the operator's own machine.

## Trust boundaries

| Surface                                               | Authentication                                                     | Notes                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `/mcp`                                                | OAuth 2.1 access token, or `MEMORY_API_TOKEN` as a developer token | Stateless Streamable HTTP; browser CORS off            |
| `/api/*`                                              | `MEMORY_API_TOKEN` only; non-GET also requires a writable account  | CLI and automation                                     |
| `/authorize`, `/oauth/token`, `/oauth/register`       | OAuth provider; consent completed through a magic link             | PKCE S256, scope `memory`, exact resource audience     |
| `/login`, `/dashboard*`                               | Passwordless magic link, then `__Host-mempersist_session`          | Server-rendered; session-derived CSRF                  |
| `/healthz`, `/readyz`, public pages, `/.well-known/*` | None                                                               | No conversation data; `/readyz` issues only `SELECT 1` |

Rules that hold across all of them:

- Authentication happens before a protected request body is parsed.
- Every read and write is scoped to the authenticated account; a supplied `namespace` is honored
  only when that account owns it.
- MCP batch cursors are HMAC-authenticated, bound to the tenant and to pinned revisions, valid for
  15 minutes, and expose no user IDs, D1 row IDs, R2 keys, or storage metadata.

## Authentication and sessions

- **Magic links.** 256-bit random token, stored only as a SHA-256 hash, single-use, valid 15
  minutes, at most five outstanding per email per window. An existing email reconnects to its
  archive; an unknown email creates an isolated account only after the link is opened.
- **OAuth.** Authorization code with PKCE S256, dynamic client registration, Client ID Metadata
  Documents, the single scope `memory`, and an exact resource audience. The flow is client-neutral,
  so any compliant remote MCP client can connect. Cloudflare's provider stores only hashes of codes
  and tokens in private KV and encrypts grant props. Token lifetimes are the provider defaults,
  which this project does not override: one-hour access tokens, 30-day refresh tokens.
- **Static token.** `MEMORY_API_TOKEN` (at least 32 random bytes) is compared as a SHA-256 digest in
  constant time and always maps to the owner archive. It is for the CLI, scripts, and automation —
  never for a connector UI.
- **Consent page.** A 256-bit double-submit CSRF value in an `HttpOnly`, `Secure`, `SameSite=Lax`
  `__Host-` cookie; client metadata is HTML-escaped; the page denies framing and referrers and sets
  a restrictive CSP.
- **Dashboard session.** A 30-day `__Host-mempersist_session` cookie (`Secure`, `HttpOnly`,
  `SameSite=Lax`), same-origin form checks with a session-derived CSRF value, `no-store`, a nonce
  CSP, and no framing.
- **Deletion pending.** Scheduling account deletion immediately makes every API, MCP, import, and
  dashboard write return `409 DELETION_PENDING`; reads, export, logout, and cancellation remain
  available through the grace period.

## Input limits

Every external input is validated with Zod at its boundary, and oversized input fails closed with a
structured error instead of being silently truncated.

| Limit                             | Value                 |
| --------------------------------- | --------------------- |
| Inline JSON write                 | 1 MiB                 |
| Direct import body                | 16 MiB                |
| Multipart part                    | 16 MiB                |
| Single parsed conversation        | 32 MiB                |
| MCP tool output                   | 64 KiB                |
| MCP aggregate serialized response | 49,152 bytes (48 KiB) |

## Storage and logging

- R2 is private: no public bucket, no presigned anonymous upload, no wildcard CORS.
- Canonical raw and normalized objects are never silently redacted. Any future redacted form must
  be separate derived data.
- Derived data — chunks, FTS rows, vectors — can be deleted and rebuilt at any time, so an index
  compromise is contained by rebuilding instead of by restoring the archive.
- Structured logs carry event names, request and job IDs, paths, and error categories. Conversation
  bodies, search queries, tokens, and authorization headers are never logged.

## Accepted risks and limitations

What this design deliberately does not defend against:

- **Index bodies are sensitive.** FTS chunk text lives in D1 and is protected by the same account
  boundary as the catalog, not by a second layer.
- **One coarse scope.** Every granted client receives every tool, including destructive ones.
  Per-tool scopes arrive only when multiple principals exist.
- **Email possession is the only factor.** Whoever can read the connected inbox can reconnect to the
  archive; an unknown email is created as a separate, empty account.
- **Rotation is not revocation.** Rotating `MEMORY_API_TOKEN` invalidates static clients and blocks
  new approvals, but already-issued OAuth access and refresh tokens keep working. Revoke those
  grants separately.
- **No application-level rate limiting** beyond the per-email magic-link cap; Cloudflare's platform
  protections are the outer layer.
- **One operator.** There is no separation of duties between whoever deploys the Worker and whoever
  owns the archive.

## Operational procedures

- Rotate `MEMORY_API_TOKEN` immediately after suspected disclosure (`wrangler secret put`).
- Revoke a client's OAuth grants when that client is distrusted — deleting its configuration does
  not revoke its tokens. Account deletion revokes every paginated grant before erasing data.
- Treat the seven-day deletion grace period as an undo window, never as a backup: see
  [docs/operations-and-recovery.md](docs/operations-and-recovery.md).
- After each deploy, confirm `/.well-known/security.txt` still resolves, that its `Expires` date
  (currently 2027-09-21) stays in the future, and that the `/security` policy page matches this
  document.

## Reporting a vulnerability

Report privately through GitHub Security Advisories at
<https://github.com/ravhirizaldi/mempersist/security/advisories/new> — the same channel the deployed
`/.well-known/security.txt` advertises.

Include the affected surface (`/api/*`, `/mcp`, OAuth, dashboard, or import), a minimal
reproduction, the impact you believe it has, and the commit or version you tested. If advisory
creation is unavailable to you for any reason, open an issue containing no exploit detail and ask
for a private channel first.

Do not include real conversation content, tokens, account credentials, or raw log payloads.
Reports are handled best-effort by a single maintainer, and there is no bug bounty. Testing against
an account you provisioned yourself is welcome; do not access another person's archive, degrade the
service, or destroy data. Security fixes that change storage compatibility, authentication, or raw
fidelity require an ADR and a recovery note.

## Import privacy

Never commit a real export or copy one into a fixture — synthetic fixtures are the only repository
data. The uploaded object is never mutated, and unknown ChatGPT fields stay in the private raw
archive and canonical node representation because fidelity is intentional.
