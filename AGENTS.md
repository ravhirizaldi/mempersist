# AGENTS.md

This file is the operational contract for every human or AI coding session in this repository.

## Mission and boundaries

Mempersist stores high-fidelity AI conversation history, retrieves compact original context, and accepts intentional MCP writes. ChatGPT native export is the primary ingestion path. V1 is single-user developer software.

Do not add automatic ChatGPT interception, LLM fact extraction, a dashboard, billing, organizations, speculative multi-tenancy, containers, or unrelated ETL sources unless explicitly requested. Do not copy Engram source, schemas, tests, comments, structure, or implementation details; this is a clean-room project.

## Architectural invariants

1. Original imports and normalized canonical revisions live durably in R2.
2. D1 is the catalog and derived lexical store, never the only transcript archive.
3. Vectorize, FTS, chunks, and embeddings are disposable derived data.
4. Canonical R2 writes complete before D1 catalog success; cataloging completes before indexing is considered queued.
5. Index failure must not roll back or misreport a canonical write.
6. Every vector and FTS row maps to deterministic chunk and canonical source ranges.
7. Imports and queue handlers are idempotent, resumable, and safe under at-least-once delivery.
8. Deterministic IDs, content hashes, revisions, chunk strategy, model, and generation are explicit.
9. Alternate ChatGPT branches and unknown source fields remain recoverable.
10. Architecture-changing work is never hidden in a refactor.

## Technology rules

- Yarn only; do not use npm, pnpm, or Bun.
- TypeScript, ES modules, strict TypeScript, Cloudflare Workers runtime.
- Hono for HTTP, official MCP v2 SDK, Zod at trust boundaries, Vitest.
- Modern ESLint flat config and Prettier.
- Prefer Web APIs and Cloudflare bindings. Node APIs require `nodejs_compat` support and a concrete need.
- No `any`, double casts, floating promises, request state in module globals, or placeholder production TODOs.
- Reuse existing modules before adding dependencies or abstractions.

## Cloudflare rules

- For platform-sensitive changes, read the installed Cloudflare skills and current official documentation first.
- Use `wrangler.jsonc` as configuration source of truth and run `yarn types:bindings` after binding changes.
- Never invent resource IDs or silently reuse account resources.
- Never deploy, provision, mutate remote resources, set secrets, or apply remote migrations without explicit authorization.
- All D1 schema changes require a new numbered migration. Never edit an already-applied migration.
- Use bindings inside Workers, not Cloudflare REST calls.
- Queue messages contain IDs, not conversation bodies. Assume at-least-once, unordered delivery.
- Do not add Durable Objects, Workflows, cron triggers, or service bindings without an ADR and measured need.

## Module boundaries

- `chatgpt.ts`, `json-stream.ts`: untrusted source parsing and lossless normalization.
- `storage.ts`: canonical R2 and D1 catalog writes/reads.
- `chunking.ts`: pure deterministic derived chunk construction.
- `indexing.ts`, `search.ts`: disposable indexes and ranking.
- `jobs.ts`: uploads, durable jobs, Queue orchestration, retries.
- `retrieval.ts`: canonical context/page reconstruction.
- `mcp.ts`, `app.ts`, `oauth.ts`: presentation and authentication only; no duplicated business rules.
- `index.ts`: Worker transport dispatch and queue entrypoint only.

Keep errors categorized with `AppError`. Validate every external JSON/query/path input. Log structured event metadata only—never conversation content, search queries, authorization headers, or secrets.

## Storage rules

- Never alter an uploaded raw object. New variants get new import IDs and keys.
- Canonical keys are content-addressed or immutable revision paths.
- Do not store one R2 object per token/message. Current unit is one conversation revision segment.
- Do not add large canonical bodies to D1. `chunks.body` is explicitly disposable search data.
- R2 references, SHA-256 values, and manifest formats are compatibility contracts.
- Append requires a base revision and optimistic concurrency.
- Redaction, summaries, entities, or facts may only be optional derived layers; raw/canonical data remains unchanged.

## Search rules

Changes to the embedding model, dimensions, chunk strategy, token estimator, RRF constant, semantic threshold, recency boost, exact/title boosts, FTS query construction, Vectorize metadata, or deduplication require:

1. deterministic unit tests;
2. retrieval-quality fixture expectations;
3. documentation update;
4. an ADR when compatibility or rebuild behavior changes;
5. a new generation/strategy identifier when old and new output differ.

Never silently truncate canonical content to fit an embedding model. Split derived chunks. Search must expose degradation when a retrieval channel fails.

## Security rules

- Secrets only through Wrangler secrets or ignored `.dev.vars`; never source/config/history.
- Authenticate before parsing protected request bodies.
- Compare bearer tokens in constant time after fixed-size hashing.
- Keep MCP OAuth on authorization code with PKCE S256. Preserve OAuth discovery metadata, CSRF protection, exact resource audiences, and static-token compatibility unless an ADR explicitly replaces them.
- Keep R2 private, deny browser CORS by default, bound request/part/MCP response sizes.
- Avoid logging personally sensitive conversation/query content.
- Synthetic test data only; private user history never enters the repository.

## Required checks

Before a task is complete, run:

```bash
yarn format:check
yarn lint
yarn typecheck
yarn test
yarn test:integration
yarn deploy:dry-run
```

For D1 work, also apply migrations to a fresh local database with `yarn db:migrate:local`. For retrieval changes, run `yarn retrieval:evaluate`. For binding changes, run `yarn types:bindings` and ensure the generated file is current.

## Documentation and ADRs

Update README/runbooks when commands, bindings, environment variables, import formats, MCP tools, or recovery behavior change. Add or supersede an ADR for significant architecture decisions; do not rewrite accepted history. Document destructive migration and recovery steps explicitly.

## Definition of done

- Requested behavior is implemented without speculative scope.
- Canonical-data safety and index-disposability invariants still hold.
- Trust boundaries are validated; errors distinguish canonical failure from derived failure.
- Migrations, generated binding types, tests, commands, and docs agree.
- All required checks pass with no dead code, secrets, private fixtures, placeholder IDs, or required TODOs.
- Remote actions occurred only with explicit authorization and are reported precisely.
