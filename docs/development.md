# Development

## Local loop

1. Install with `yarn install`.
2. Copy `.dev.vars.example` to `.dev.vars` and set `MEMORY_API_TOKEN`.
3. Generate exact Worker/binding types with `yarn types:bindings`.
4. Apply D1 migrations with `yarn db:migrate:local`.
5. Start the Worker with `yarn dev`.

Wrangler simulates D1, R2, and Queues locally. The main configuration marks Workers AI and Vectorize remote; those calls can incur usage. Unit and Workers integration tests use pure logic or local D1/R2 and never call remote AI.

The local database seeds the owner account (the address bound in migration 0005, namespace
`personal`), so the archive you see in `yarn dev` is the same one the static
`MEMORY_API_TOKEN` protects. New emails entered on the `/authorize` consent page must
complete registration through the emailed magic link before their isolated namespace is
created.

The Worker uses the `EMAIL` send binding and chooses `AUTH_EMAIL_FROM` or
`LEGACY_AUTH_EMAIL_FROM` from the authorization request hostname. Both sender domains must be
onboarded to Cloudflare Email Service before testing delivery.

Preview the OAuth consent page without a registered client at
`http://localhost:8787/authorize?client_id=DEVMODE` (GET only; submitting the form is not
part of the preview).

## Browser pages

Public pages (`/`, `/whitepaper`, `/architecture`, `/security`, `/adrs`, `/about`)
use the shared warm monochrome foundation in `src/ui.ts`. Public layout and browser
enhancements live in `src/site.ts`; page content stays in `src/landing.ts`.
Native Web Animations and IntersectionObserver provide short entry transitions,
with no animation dependency or CDN JavaScript. Reduced-motion preferences are
honored, including changes while the page is open. Google Fonts are optional;
system fallbacks keep the layout usable if external fonts are blocked.

All browser pages support `en` and `id`. The language switch calls `/language/:locale` and writes
the secure `__Host-mempersist_lang` cookie; without it, request negotiation uses
`Accept-Language` and then English. Check every route in both languages. Verify the switch with
JavaScript disabled and confirm that a switched `/authorize` URL preserves all OAuth query
parameters.

The homepage includes a labeled illustrative memory lifecycle and copy controls
for the endpoint and client configuration. The decision log filters locally, with
result counts and an empty state. Copy failures select the original text for manual
copying. No browser-side archive requests, analytics, or persistent state are added.
Without JavaScript, navigation, all setup instructions, examples, and decisions
remain visible; script-dependent controls stay hidden.

Consent and connection-status pages in `src/oauth.ts` share the foundation but remain
script-free and external-asset-free under their existing restrictive CSP. Privacy
details use native disclosure, Cancel bypasses email validation, and short/zoomed
viewports scroll rather than clipping the form. OAuth, CSRF, PKCE, and email delivery
behavior are unchanged.

For visual checks without remote bindings, use `yarn dev --local --port 8787`.
Check all six public routes in English and Indonesian, `/authorize?client_id=DEVMODE`, and
`/auth/magic-link` (the missing-link error screen). Do not submit the preview form
or send real email. Verify narrow viewports, keyboard navigation, copy success and
failure, ADR filtering/clear, reduced motion, and disabled JavaScript. OAuth status
variants and validation are also covered by the Workers integration suite.

## Memory map client

`/dashboard/mindmap` is the only page with a bundled browser dependency. Its sources live in
`web/mindmap/` under their own strict `tsconfig.json` with the DOM library, so the Worker
`tsconfig.json` stays free of DOM types. Cytoscape.js is bundled by `yarn build:mindmap` into the
generated `src/mindmap-bundle.ts`, which `src/dashboard.ts` inlines inside the existing script
nonce; the CSP keeps `default-src 'none'` and no CDN is used.

1. Edit `web/mindmap/client.ts`, `graph.ts`, `tooltip.ts`, or `types.ts`.
2. Run `yarn typecheck:web`.
3. Run `yarn build:mindmap` and commit the regenerated `src/mindmap-bundle.ts`.
4. `yarn check:mindmap` (also part of `yarn verify`) fails if the bundle is stale.

`buildMindmapGraph` is pure and unit-tested in `tests/mindmap.test.ts`; the rendered page is covered
by `tests/dashboard.integration.ts`. Prettier and ESLint ignore the generated bundle.

## Tests

- `yarn test`: parser, graph, chunking, ranking, JSON streaming, MCP discovery/validation.
- `yarn test:integration`: real Workers runtime with isolated D1/R2 and all migrations.
- `yarn retrieval:evaluate`: focused synthetic multilingual/exact retrieval expectations.
- `yarn verify`: full gate including deploy dry-run.

When a binding changes, rerun `yarn types:bindings`. ESLint rejects floating promises and unsafe types. Prettier owns formatting.

The bounded read-after-write fallback is configured with `RECENT_UNINDEXED_MAX_REVISIONS` (default 8), `RECENT_UNINDEXED_MAX_AGE_SECONDS` (default 86400), and `RECENT_UNINDEXED_MAX_MESSAGES` (default 200). Keep these as non-secret Wrangler variables and change them only with retrieval fixture coverage.

## Database changes

Create the next `migrations/NNNN_description.sql`, use SQLite/D1-compatible SQL and `STRICT` tables, test against fresh local state, and document destructive changes. FTS is explicitly managed in migration 0003 and application code; do not add dashboard-only schema.
