# Development

## Local loop

1. Install with `yarn install`.
2. Copy `.dev.vars.example` to `.dev.vars` and set `MEMORY_API_TOKEN`.
3. Generate exact Worker/binding types with `yarn types:bindings`.
4. Apply D1 migrations with `yarn db:migrate:local`.
5. Start the Worker with `yarn dev`.

Wrangler simulates D1, R2, and Queues locally. The main configuration marks Workers AI and Vectorize remote; those calls can incur usage. Unit and Workers integration tests use pure logic or local D1/R2 and never call remote AI.

The local database seeds the owner account (`vhie1046@gmail.com`, namespace `personal`) from
migration 0005, so the archive you see in `yarn dev` is the same one the static
`MEMORY_API_TOKEN` protects. New emails entered on the `/authorize` consent page are
provisioned on the fly into isolated namespaces.

Preview the OAuth consent page without a registered client at
`http://localhost:8787/authorize?client_id=DEVMODE` (GET only; submitting the form is not
part of the preview).

## Tests

- `yarn test`: parser, graph, chunking, ranking, JSON streaming, MCP discovery/validation.
- `yarn test:integration`: real Workers runtime with isolated D1/R2 and all migrations.
- `yarn retrieval:evaluate`: focused synthetic multilingual/exact retrieval expectations.
- `yarn verify`: full gate including deploy dry-run.

When a binding changes, rerun `yarn types:bindings`. ESLint rejects floating promises and unsafe types. Prettier owns formatting.

The bounded read-after-write fallback is configured with `RECENT_UNINDEXED_MAX_REVISIONS` (default 8), `RECENT_UNINDEXED_MAX_AGE_SECONDS` (default 86400), and `RECENT_UNINDEXED_MAX_MESSAGES` (default 200). Keep these as non-secret Wrangler variables and change them only with retrieval fixture coverage.

## Database changes

Create the next `migrations/NNNN_description.sql`, use SQLite/D1-compatible SQL and `STRICT` tables, test against fresh local state, and document destructive changes. FTS is explicitly managed in migration 0003 and application code; do not add dashboard-only schema.
