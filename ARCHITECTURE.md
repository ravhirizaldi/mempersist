# Architecture

## System shape

Mempersist is one Cloudflare Worker and one TypeScript package. Hono serves a small HTTP API; the official MCP v2 SDK serves stateless Streamable HTTP at `/mcp`; Cloudflare's OAuth provider protects that endpoint and stores grants in KV; the same module consumes import and index queues.

```text
                    +------------------ Worker ------------------+
Client -> token/OAuth -> HTTP/MCP -> domain services -> R2 canonical
           |                           |             + D1 catalog
           +-> OAuth KV                +-> Queue job IDs
                                              |
                         import consumer ------+
                         index consumer -> FTS + AI + Vector
                    +--------------------------------------------+
```

There are no Durable Objects, Workflows, cron triggers, service bindings, external databases, or containers in V1. Queue jobs are bounded and checkpointed, so a Workflow would add state duplication without solving a current problem.

## Canonical versus derived

R2 raw import objects and canonical revision objects are authoritative. A revision manifest points to content-addressed JSONL segments. JSONL preserves every normalized node, source node IDs, parent/children, content, metadata, and raw node fields. The unchanged uploaded export remains the ultimate source artifact.

D1 catalogs imports, revisions, graph metadata, R2 pointers, job state, chunk sources, and FTS text. Vectorize contains embeddings and compact filter/reconstruction metadata. Deleting all `chunks`, `chunk_fts`, `chunk_sources`, `chunk_index_state`, and vectors does not delete memory.

## Write order

1. Validate input and assign stable IDs.
2. Put content-addressed canonical segment in R2.
3. Put immutable revision manifest in R2.
4. Catalog the revision and graph metadata in D1.
5. Record the revision as `queued`, enqueue its index job, and return durable success.
6. Generate chunks and FTS.
7. Generate BGE-M3 embeddings and upsert Vectorize.

Revision indexing moves through `queued`, `processing`, `indexed`, or `failed`. FTS readiness has its own timestamp because lexical indexing may succeed before embeddings fail. Any index error leaves the canonical revision safe and available to the recent-canonical fallback.

## Imports and concurrency

The raw export is streamed to R2 and then streamed again for SHA-256. Large files use R2 multipart upload. A top-level JSON array scanner yields one conversation at a time with a 32 MiB per-conversation safety ceiling. Each queue turn processes 25 conversations and stores an ordinal checkpoint. A retry re-scans earlier bytes but skips committed ordinals; it does not rewrite committed memory.

Queue job rows use short leases and deterministic job IDs. R2 content addressing, revision hashes, D1 conflicts, and Vectorize upserts make duplicate delivery safe. Appends require `base_revision_id`; a stale base returns conflict while the attempted immutable variant remains recoverable.

## Retrieval

FTS, semantic search, and a bounded recent-canonical fallback start concurrently. The fallback selects only current revisions in `queued`, `processing`, or recent `failed` state through D1, then reads those canonical R2 revisions and applies lightweight phrase/term overlap to recent active messages. All channels use the same deterministic chunk IDs, so indexing races merge into one result. Current-revision joins prevent superseded chunks from winning. RRF keeps indexed confidence dominant, exact identifiers and titles receive bounded boosts, and recency contributes at most 3%. Results are limited to two chunks per conversation and return snippets plus IDs. Context retrieval then reads the canonical revision and returns surrounding source messages.

## Generation migration

Chunks record generation, strategy, model, dimensions, revision, and deterministic vector ID. A rebuild reads R2, not the original upload. Model/dimension migrations require a new Vectorize index and generation. For a future zero-downtime switch, temporarily bind old and new indexes, build and validate the new generation, change `ACTIVE_INDEX_GENERATION`, then retire the old binding/index. V1 keeps one active Vectorize binding to avoid unused dual-index code.
