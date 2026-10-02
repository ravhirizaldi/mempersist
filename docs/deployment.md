# Deployment

Deployment is a deliberate operator action.

1. Provision resources from [cloudflare-resources.md](cloudflare-resources.md).
2. Put the actual D1 ID in `wrangler.jsonc`; confirm every name with read-only Wrangler listing.
3. Run `yarn types:bindings` and commit the generated type changes.
4. Set `MEMORY_API_TOKEN` using `yarn wrangler secret put MEMORY_API_TOKEN`.
5. Confirm both Email Service sender domains are onboarded and `AUTH_EMAIL_FROM` plus
   `LEGACY_AUTH_EMAIL_FROM` are verified sender addresses configured in `wrangler.jsonc`.
6. Run `yarn verify`.
7. Review pending migrations, then `yarn db:migrate:remote`.
8. Run `yarn deploy`.
9. Verify `/healthz`, authenticated `/readyz`, OAuth protected-resource and authorization-server metadata, MCP discovery with both OAuth and the developer token, both browser languages and the secure language switch, localized magic-link email for a new and existing email, `/login`, dashboard session/logout, an export, a small canonical write, indexing state, search, and context retrieval.

Before a search-cursor rollout, review the new numbered D1 migration for the additive
`search_snapshots` table and apply it remotely before deploying code that creates or continues
snapshots. Confirm the table is available to the Worker and that the migration did not alter
canonical tables or R2 data. The migration is disposable pagination state; do not backfill it from
canonical content.

After deployment, exercise one authenticated first-page search and its cursor continuation at the
default and a reduced byte budget. Confirm `normalized-weighted-v6`, the 200-candidate cap, the
15-minute expiry, bounded omission/degradation fields, and `used_serialized_bytes`/
`max_serialized_bytes`. Verify that a malformed or altered cursor is rejected, that a cursor
cannot be used by another tenant or with changed `q`/filters, and that an expired snapshot causes
a fresh search rather than a page from live offsets. Check that expired rows are lazily removed on
snapshot reads and that no query, cursor payload, user ID, D1 ID, or R2 key appears in logs.

Public discovery endpoints are served by the Worker and should remain reachable without
authentication: `/robots.txt`, `/sitemap.xml`, `/.well-known/security.txt`, and
`/site.webmanifest`. The sitemap lists only the public documentation routes; private dashboard,
API, OAuth, MCP, and health routes are excluded from crawling.

Migration 0009 adds hashed dashboard challenges/sessions, ownership for imports, and the separately
leased deletion queue. After a rollback, follow the deletion-job re-enqueue procedure in
[operations-and-recovery.md](operations-and-recovery.md); old Worker code will ignore those IDs
rather than marking them complete.

Use Wrangler versions/rollback for Worker code rollback. A code rollback does not roll back D1 migrations or R2 data. Migrations therefore require forward-compatible code and an explicit recovery plan.

Staging is not configured for personal V1. Add a named Wrangler environment only when it has separate real resources and an operator need; remember bindings are not inherited automatically.
