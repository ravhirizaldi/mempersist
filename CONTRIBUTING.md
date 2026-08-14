# Contributing

Read [AGENTS.md](AGENTS.md) first. Keep changes small, preserve the R2-canonical/index-derived boundary, and use Yarn only.

```bash
yarn install
cp .dev.vars.example .dev.vars
yarn types:bindings
yarn db:migrate:local
yarn verify
```

Add a numbered D1 migration for schema changes; never edit applied history. Add synthetic tests for parser, chunk/ranking, or MCP changes. Architecture changes require an ADR in `docs/adr/`. Do not deploy or mutate remote Cloudflare resources as part of a code change unless separately authorized.
