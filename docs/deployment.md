# Deployment

Deployment is a deliberate operator action.

1. Provision resources from [cloudflare-resources.md](cloudflare-resources.md).
2. Put the actual D1 ID in `wrangler.jsonc`; confirm every name with read-only Wrangler listing.
3. Run `yarn types:bindings` and commit the generated type changes.
4. Set `MEMORY_API_TOKEN` using `yarn wrangler secret put MEMORY_API_TOKEN`.
5. Run `yarn verify`.
6. Review pending migrations, then `yarn db:migrate:remote`.
7. Run `yarn deploy`.
8. Verify `/healthz`, authenticated `/readyz`, OAuth protected-resource and authorization-server metadata, MCP discovery with both OAuth and the developer token, a small canonical write, indexing state, search, and context retrieval.

Use Wrangler versions/rollback for Worker code rollback. A code rollback does not roll back D1 migrations or R2 data. Migrations therefore require forward-compatible code and an explicit recovery plan.

Staging is not configured for personal V1. Add a named Wrangler environment only when it has separate real resources and an operator need; remember bindings are not inherited automatically.
