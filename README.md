# Mempersist

Mempersist is a clean-room, Cloudflare-native long-term memory service for AI conversations. It preserves original ChatGPT exports and normalized conversation graphs in R2, catalogs them in D1, builds disposable lexical and semantic indexes, and exposes compact retrieval and intentional writes through MCP.

It does not silently capture ChatGPT traffic, extract replacement “facts,” provide a SaaS billing layer, or make search indexes canonical. “Unlimited” means no application message quota; Cloudflare limits and billing still apply.

## Architecture

```text
ChatGPT conversations.json / MCP writes
                  |
          validation + IDs
                  |
          R2 canonical archive  <------ export / recovery
                  |
             D1 catalog
                  |
        Cloudflare Queues
          /             \
   D1 FTS5          Workers AI BGE-M3 -> Vectorize
          \             /
       normalized hybrid search
                  |
       HTTP + OAuth-protected MCP
```

R2 is the source of truth. D1 holds operational metadata and the derived FTS representation. Vectorize is disposable. A canonical write succeeds before indexing is queued, and an indexing failure never reports that durable memory was lost.

See [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), and [docs/operations-and-recovery.md](docs/operations-and-recovery.md).

## Prerequisites

- WSL2/Linux, Node.js 22+, Yarn 1.22, and Wrangler 4.x
- A Cloudflare account with Workers, D1, R2, Vectorize, Workers AI, and Queues available
- Wrangler OAuth authentication: `yarn wrangler whoami`

Use Yarn only.

## Setup

```bash
yarn install
cp .dev.vars.example .dev.vars
yarn types:bindings
yarn db:migrate:local
yarn dev
```

Set a long random `MEMORY_API_TOKEN` in `.dev.vars`. Local D1 and R2 are simulated; Workers AI and Vectorize bindings are remote in the main configuration. Unit and integration tests do not call remote AI.

## Cloudflare provisioning

Provisioning is intentionally manual and must be explicitly authorized. Follow [docs/cloudflare-resources.md](docs/cloudflare-resources.md), then add the real D1 `database_id` returned by Wrangler to `wrangler.jsonc`. Never invent IDs or reuse unrelated account resources.

Set the production secret without putting it in source:

```bash
yarn wrangler secret put MEMORY_API_TOKEN
```

Apply migrations and deploy only after review:

```bash
yarn db:migrate:remote
yarn deploy:dry-run
yarn deploy
```

## ChatGPT import

Export data from ChatGPT, extract `conversations.json`, then:

```bash
MEMPERSIST_URL=http://localhost:8787 \
MEMPERSIST_TOKEN='your-token' \
yarn import:chatgpt /path/to/conversations.json
```

Files up to 16 MiB use direct streaming upload. Larger files use 16 MiB R2 multipart parts. The Worker hashes the completed object, preserves it unchanged, detects exact duplicate exports, and processes at most 25 conversations per queue turn. Check progress with:

```bash
MEMPERSIST_TOKEN='your-token' yarn import:status <import-id>
```

See [docs/chatgpt-import.md](docs/chatgpt-import.md).

## MCP

The Streamable HTTP endpoint is `https://<worker>/mcp`. Interactive clients such as ChatGPT
use OAuth 2.1 authorization-code flow with PKCE: the consent page takes an email, sends a
single-use magic link, and completes the connection only after the link is opened. Existing
emails reconnect to their archive; a new archive is created after the first link. The owner archive is
bound to `vhie1046@gmail.com` across all of its namespaces (`personal`, `astara_alt_v2`,
`coding/mempersist`, `test/mempersist-blackbox`); entering that email reconnects to the same
data. Each account can own multiple namespaces, and the same namespace name may exist in
different accounts with fully separated data.
Developer scripts and the CLI may keep sending `MEMORY_API_TOKEN` as a bearer token for the
owner archive.

Email authentication uses the `EMAIL` send binding. The primary endpoint sends from
`AUTH_EMAIL_FROM` (`noreply@mempersist.codifiedtech.id`); the legacy endpoint keeps using
`LEGACY_AUTH_EMAIL_FROM` (`noreply@mempersist.nextostaging.net`).

The public site, OAuth pages, and magic-link email support English and Bahasa Indonesia. Use the
language switcher to persist a browser preference; otherwise MemPersist uses `Accept-Language` and
falls back to English. API, MCP, and CLI contracts remain English.

## Dashboard

Open `/login` for passwordless access to the server-rendered dashboard. It includes archive totals,
a deterministic memory map, revision-pinned canonical conversation reading, display-name editing,
and a streamed lossless export of current memory. Namespace emptying runs asynchronously. Account
deletion has a seven-day cancelable grace period and makes writes read-only while pending.

See [docs/dashboard.md](docs/dashboard.md) and ADR 0028. No frontend framework, extra dependency,
or additional Cloudflare resource is required.

For the deployed Worker, add `https://mempersist.codifiedtech.id/mcp` as a custom MCP app in
ChatGPT Developer mode. ChatGPT discovers OAuth automatically, opens the consent page, and
stores the issued access/refresh tokens. Existing connections keep working after upgrades
without re-authorization. Clients already configured with
`https://mempersist.nextostaging.net/mcp` remain supported; changing one to the primary endpoint
requires one new authorization. Do not paste `MEMORY_API_TOKEN` into ChatGPT's connector settings.

Available tools:

- `memory_search`
- `memory_get_context`
- `memory_get_conversation`
- `memory_get_conversations`
- `memory_list_conversations`
- `memory_list_revisions`
- `memory_list_namespaces`
- `memory_stats`
- `memory_store`
- `memory_append`
- `memory_replace`

`memory_store` and `memory_append` accept optional tags (lowercased, deduplicated, up to 20);
`memory_search` filters by tags with AND semantics and returns each conversation's tags. See
[docs/mcp.md](docs/mcp.md) and ADR 0013.

- `memory_delete_conversations`
- `memory_empty_namespace`
- `memory_import_status`

Search returns compact references; call `memory_get_context` only for selected results. See [docs/mcp.md](docs/mcp.md).

For known memories, `memory_get_conversations` returns up to 20 ordered compact pages within
48 KiB, including explicit errors and continuations. Single reads accept `format: "compact"`;
canonical output remains the default. `memory_list_revisions` returns the immutable revision
history of one owned conversation (metadata only, newest first, cursor-paged), so a client can
pin and read any earlier revision with `memory_get_conversation` instead of relying on a
retained write receipt. Store/append/replace accept `verify: true` to reload the
committed R2 revision and return compact readback with separate indexing/verification status.
See the [RP workflow and reviewable runtime-rule amendment](docs/rp-workflow.md).

## Quality gate

```bash
yarn verify
```

This runs formatting, lint, strict TypeScript (Worker and the `web/mindmap/` browser project), the memory-map bundle freshness check, unit/MCP/retrieval tests, Workers-runtime D1/R2 integration tests, and a Wrangler deploy dry run. No command deploys unless `yarn deploy` is invoked explicitly.

After changing anything under `web/mindmap/`, run `yarn build:mindmap` so the generated `src/mindmap-bundle.ts` matches its sources.

## Operations

```bash
yarn admin search 'api.internal.example'
yarn retry <job-id>
yarn reindex
yarn verify:integrity
```

Reindexing reads canonical R2 data; the ChatGPT export does not need to be uploaded again. D1 migrations are numbered SQL files and must be applied through Wrangler—never by dashboard drift.
