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

The Streamable HTTP endpoint is `https://<worker>/mcp`. Developer scripts may send `MEMORY_API_TOKEN` as a bearer token. Interactive clients such as ChatGPT use OAuth 2.1 authorization-code flow with PKCE; the owner approves the connection on MemPersist's navy consent page using the same access key.

For the deployed Worker, add `https://mempersist.nextostaging.net/mcp` as a custom MCP app in ChatGPT Developer mode. ChatGPT discovers OAuth automatically, opens the consent page, and stores the issued access/refresh tokens. Do not paste `MEMORY_API_TOKEN` into ChatGPT's connector settings.

Available tools:

- `memory_search`
- `memory_get_context`
- `memory_get_conversation`
- `memory_list_conversations`
- `memory_store`
- `memory_append`

`memory_store` and `memory_append` accept optional tags (lowercased, deduplicated, up to 20);
`memory_search` filters by tags with AND semantics and returns each conversation's tags. See
[docs/mcp.md](docs/mcp.md) and ADR 0013.

- `memory_delete_conversations`
- `memory_delete_namespace`
- `memory_delete_all`
- `memory_import_status`

Search returns compact references; call `memory_get_context` only for selected results. See [docs/mcp.md](docs/mcp.md).

## Quality gate

```bash
yarn verify
```

This runs formatting, lint, strict TypeScript, unit/MCP/retrieval tests, Workers-runtime D1/R2 integration tests, and a Wrangler deploy dry run. No command deploys unless `yarn deploy` is invoked explicitly.

## Operations

```bash
yarn admin search 'api.internal.example'
yarn retry <job-id>
yarn reindex
yarn verify:integrity
```

Reindexing reads canonical R2 data; the ChatGPT export does not need to be uploaded again. D1 migrations are numbered SQL files and must be applied through Wrangler—never by dashboard drift.
