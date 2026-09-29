# Contributing

MemPersist is a single-owner Cloudflare Worker that stores conversation memory canonically in R2
and indexes it in D1. Two rules decide most review outcomes: **R2 canonical data is the only
source of truth**, and **every chunk, FTS row, and vector is disposable**. [AGENTS.md](AGENTS.md)
is the full operational contract — read it first; this page is the short version.

## Scope

- One Worker, one TypeScript package, official tooling: Hono for HTTP, MCP v2 for tools, Zod at
  trust boundaries, Vitest for tests, Wrangler for everything Cloudflare.
- Yarn only. No npm, pnpm, or Bun. Node APIs need `nodejs_compat` and a concrete reason.
- Keep the change requested and small. Fixes, hardening, and docs are welcome; speculative
  abstraction, new Cloudflare services (Durable Objects, Workflows, cron triggers, service
  bindings), new dependencies, and unrelated ETL sources are not, unless an ADR and a measured
  need come with them.
- This is a clean-room project. Do not copy Engram source, schemas, tests, comments, or structure.
- Real exports, credentials, and private conversation content never enter the repository. Synthetic
  fixtures only.

## Set up

```bash
yarn install
cp .dev.vars.example .dev.vars   # MEMORY_API_TOKEN; .dev.vars is gitignored
yarn types:bindings              # regenerate binding types after wrangler.jsonc changes
yarn db:migrate:local            # apply D1 migrations to the local database
yarn dev                         # Worker on http://localhost:8787
```

Requires WSL2/Linux, Node.js 22+, Yarn 1.22, and an authenticated Wrangler 4.x. The local loop,
local MCP clients, and the browser surfaces are covered in
[docs/development.md](docs/development.md).

## Where code goes

| Module                         | Owns                                                |
| ------------------------------ | --------------------------------------------------- |
| `chatgpt.ts`, `json-stream.ts` | Untrusted source parsing, lossless normalization    |
| `storage.ts`                   | Canonical R2 writes, D1 catalog reads and writes    |
| `chunking.ts`                  | Pure deterministic chunk construction               |
| `indexing.ts`, `search.ts`     | Disposable indexes and ranking                      |
| `jobs.ts`                      | Uploads, durable jobs, Queue orchestration, retries |
| `retrieval.ts`                 | Canonical context and page reconstruction           |
| `mcp.ts`, `app.ts`, `oauth.ts` | Presentation and authentication                     |
| `index.ts`                     | Worker transport dispatch and queue entrypoint      |

Reuse what is already here before adding anything. A second convention for a job that already has
one is the most common reason a patch gets sent back.

## The change loop

1. Branch from `main`.
2. Make the change, including the tests and docs it implies (`Requirements by change type` below).
3. Run `yarn verify`.
4. Commit with an imperative, prefixed subject: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`.
5. Open a pull request. There is no CI and no PR template, so the PR body is the record: what
   changed, why, and the exact commands you ran. Merges are squash merges; delete the branch.

`yarn verify` runs, in order: `format:check`, `types:bindings:check`, `lint`, `typecheck`,
`typecheck:web` (the `web/mindmap/` browser project), `check:mindmap`, unit and MCP tests, the
Workers-runtime integration tests, and `deploy:dry-run`. Nothing deploys — `yarn deploy` is a
separate, separately authorized action.

## Requirements by change type

| Change                                                                                                                                                      | Also required                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 schema                                                                                                                                                   | A new numbered migration in `migrations/`; never edit an applied one; `yarn db:migrate:local` against a fresh database                                                                                                             |
| Bindings or `wrangler.jsonc`                                                                                                                                | `yarn types:bindings`, then commit the regenerated types                                                                                                                                                                           |
| Embedding model, dimensions, chunk strategy, token estimator, RRF constant, semantic threshold, boosts, FTS construction, Vectorize metadata, deduplication | Deterministic unit tests, retrieval fixture expectations, a docs update, a new generation or strategy identifier whenever output changes, and an ADR when rebuild or compatibility behavior changes; run `yarn retrieval:evaluate` |
| Search or ranking                                                                                                                                           | A test that fails when the ranking rule breaks, not a snapshot of whatever it currently returns                                                                                                                                    |
| MCP tool surface                                                                                                                                            | A Zod schema plus the capability-document contract; `tests/mcp.test.ts` and `tests/capabilities.test.ts` stay green                                                                                                                |
| Canonical R2 layout, hashes, manifest format, revision or chunk identifiers                                                                                 | An ADR plus matching recovery steps in [docs/operations-and-recovery.md](docs/operations-and-recovery.md)                                                                                                                          |
| Queue or job behavior                                                                                                                                       | Idempotent and resumable under at-least-once delivery; messages carry IDs, never conversation bodies                                                                                                                               |
| Import parser                                                                                                                                               | Synthetic fixtures for the malformed, truncated, duplicate, and unknown-field cases, plus the parser ceiling in [docs/chatgpt-import.md](docs/chatgpt-import.md)                                                                   |
| `web/mindmap/`                                                                                                                                              | `yarn build:mindmap`, so the generated bundle matches its sources                                                                                                                                                                  |
| Anything that changes commands, bindings, environment variables, import formats, MCP tools, or recovery behavior                                            | The README and the matching `docs/` page in the same pull request                                                                                                                                                                  |

Significant architecture decisions get an ADR in [docs/adr/](docs/adr/) named
`NNNN-kebab-title.md` with the next free number. Accepted ADRs are history: supersede them with a
new one rather than rewriting them.

## Tests

- Unit tests are deterministic and isolated. Integration tests live in `tests/*.integration.ts` and
  run inside the Workers runtime with D1 and R2 bindings.
- Test behavior a caller can observe: boundaries, invariants, precedence, error shapes, transitions.
  Do not test wiring, forwarding, or that a copy equals its input.
- Paste real conversation content into no fixture, ever.

## Security and authorization

- Never commit secrets. `.dev.vars` is ignored; production secrets live in Wrangler secrets.
- Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public issue
  containing reproduction detail.
- These require explicit authorization before you run them: `yarn deploy`, `yarn db:migrate:remote`,
  writing or reading secrets, provisioning or mutating any remote Cloudflare resource, publishing a
  version to the MCP registry, and deleting remote data.
