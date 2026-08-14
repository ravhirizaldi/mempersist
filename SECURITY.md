# Security

## V1 threat model

Mempersist is a private single-user service containing sensitive historical conversations. The primary risks are unauthorized reads/writes, leaked bearer tokens, malicious or malformed imports, oversized input, content leakage through logs, and accidental deletion of canonical storage.

## Controls

- All `/api/*` traffic requires the static `MEMORY_API_TOKEN`; `/mcp` accepts either that developer token or an OAuth access token issued by this Worker.
- `MEMORY_API_TOKEN` is a Wrangler secret in production and an ignored `.dev.vars` value locally.
- Both token values are SHA-256 hashed before a constant-time comparison.
- ChatGPT uses OAuth 2.1 authorization code with PKCE S256. The official Cloudflare provider stores only hashes of codes and tokens in private KV and encrypts grant props.
- OAuth consent uses a 256-bit double-submit CSRF value in an `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` cookie. Client metadata is HTML-escaped and the page denies framing, external content, and referrers with response headers.
- The owner key entered on the consent page is compared in constant time and is neither persisted nor logged. OAuth access tokens last one hour and refresh tokens use the provider's 30-day default.
- Authentication occurs before protected JSON bodies are parsed.
- JSON writes are limited to 1 MiB, direct imports to 16 MiB, multipart parts to 16 MiB, one parsed conversation to 32 MiB, and MCP responses to 64 KiB.
- Zod validates HTTP and MCP inputs. Import parsing rejects malformed/truncated top-level arrays and records per-conversation permanent failures.
- R2 is private. No public bucket, presigned anonymous upload, or wildcard CORS is configured.
- Structured logs contain event names, request/job IDs, paths, and error categories—not conversation bodies, queries, tokens, or authorization headers.
- Canonical raw and normalized objects are never silently redacted. Any future redacted representation must be separate derived data.

Use a high-entropy token of at least 32 random bytes and rotate it immediately after suspected disclosure. Rotation invalidates static clients and prevents new OAuth approvals; revoke existing OAuth grants separately because already-issued access and refresh tokens are independent. V1 has one owner and one coarse `memory` OAuth scope; add per-tool scopes only when multiple principals actually exist.

## Import privacy

Do not commit real exports or copy them into test fixtures. Synthetic fixtures are the only allowed repository data. Unknown ChatGPT fields remain in the private raw archive/canonical node representation because fidelity is intentional.

## Reporting

Do not include private conversation samples, tokens, account credentials, or raw log payloads in issues. Security fixes that change storage compatibility, authentication, or raw fidelity require an ADR and recovery note.
