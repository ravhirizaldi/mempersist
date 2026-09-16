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

Migration 0009 adds hashed dashboard challenges/sessions, ownership for imports, and the separately
leased deletion queue. After a rollback, follow the deletion-job re-enqueue procedure in
[operations-and-recovery.md](operations-and-recovery.md); old Worker code will ignore those IDs
rather than marking them complete.

Use Wrangler versions/rollback for Worker code rollback. A code rollback does not roll back D1 migrations or R2 data. Migrations therefore require forward-compatible code and an explicit recovery plan.

Staging is not configured for personal V1. Add a named Wrangler environment only when it has separate real resources and an operator need; remember bindings are not inherited automatically.
