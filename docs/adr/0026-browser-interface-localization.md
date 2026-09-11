# ADR 0026: Browser interface localization

- Status: Accepted
- Date: 2026-09-11

## Context

MemPersist serves public documentation, OAuth consent and status pages, and passwordless email to
English- and Indonesian-speaking users. These surfaces are server rendered in a Cloudflare Worker;
OAuth pages deliberately remain script-free. API, MCP, CLI, storage, and retrieval contracts must
remain stable and language-neutral.

## Decision

The browser experience supports English (`en`) and Indonesian (`id`) through typed, statically
bundled catalogs rather than a third-party runtime. Request-specific locale state is passed
explicitly and is never stored in module globals.

Locale selection uses this precedence:

1. a validated locale on an application-owned magic-link URL;
2. the `__Host-mempersist_lang` browser cookie;
3. `Accept-Language`, including regional tags and quality weights;
4. English as the deterministic fallback.

A script-free language switch writes the secure, host-only, `HttpOnly`, `SameSite=Lax` cookie and
redirects only to a validated same-origin relative path. HTML responses identify the choice with
`lang`, `Content-Language`, and `Vary: Accept-Language, Cookie`. The locale is added to the
application-owned magic-link URL so email and callback errors remain in the selected language when
the link opens in another browser.

The preference is browser-local. It is not stored in D1, OAuth grants, canonical conversations, or
indexes. Protocol-facing OAuth errors, API JSON errors, MCP names/schemas/descriptions, CLI output,
logs, and repository documentation remain English.

## Consequences

- Public pages, accessibility text, OAuth UI, and magic-link email are consistently bilingual.
- OAuth CSP, CSRF, PKCE, one-use token semantics, and machine contracts are unchanged.
- No migration, binding change, reindex, external translation service, or client-side catalog fetch
  is required.
- Shareable locale-prefixed URLs, account-level cross-device preferences, and translated technical
  documentation remain out of scope.
