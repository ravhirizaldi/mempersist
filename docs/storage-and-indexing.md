# Storage, indexing, and retrieval

## R2 layout

```text
raw/imports/<import-id>/source/<filename>
canonical/conversations/<conversation-id>/segments/<sha256>.jsonl
canonical/conversations/<conversation-id>/revisions/<revision-id>.json
```

Raw paths are immutable per import. Segment paths are content-addressed; manifests are immutable revision documents. Canonical JSONL is uncompressed in V1 for portability and straightforward inspection/range evolution. One revision segment per conversation avoids tiny-object request overhead. Compression can be added as a versioned format only after measured storage/operation benefit.

## IDs and revisions

IDs are lowercase SHA-256 hex over domain-separated inputs. ChatGPT conversation IDs derive from source type and source ID; MCP-created conversations use UUIDs. Segment IDs derive from bytes. Revision IDs cover the segment hash, current branch state, and metadata. Chunk IDs cover strategy version, revision, branch, and exact source ranges; vector IDs additionally cover generation.

## Chunking

`chat-turn-v1` preserves message order and roles. It estimates tokens as `ceil(UTF-8 bytes / 3)`, targets 1200 tokens, hard-limits derived chunks at 1800, and overlaps about 150 tokens. Long messages split at paragraph, line/code-line, whitespace, then safe character boundaries. Exact source character ranges are retained. Active history and each alternate leaf path are indexed; alternate paths include one ancestor before divergence.

No canonical text is truncated. If Workers AI rejects a chunk, future retries can bisect the derived chunk without changing canonical storage; a strategy/output change requires a new version.

## Embeddings and indexes

The initial generation uses `@cf/baai/bge-m3`, 1024 dimensions, cosine Vectorize, batches of 32, and `truncate_inputs: false`. Response rows and dimensions are validated before upsert. Generation, strategy, model, dimensions, revision, status, and mutation state live in D1.

Enqueue records revision state as `queued`; a worker attempt marks `processing`; complete FTS and Vectorize work marks `indexed`; and any failure marks `failed` with bounded error metadata. FTS rows and source mappings are written before embeddings, with `fts_indexed_at` recording partial readiness. Canonical R2 data is never rolled back by these transitions.

## Hybrid search

1. Build safe quoted FTS terms.
2. Start D1 FTS, the semantic branch, and the recent-canonical fallback concurrently.
3. Over-fetch `min(50, max(20, limit * 4))` candidates.
4. Drop semantic candidates below `0.35`.
5. For recent current revisions not yet indexed, use D1 state to select at most 8 revisions from the last 24 hours, load their canonical R2 objects, and score at most 200 active messages with exact phrase and normalized term overlap.
6. Fuse matching channels with RRF `1/(60+rank)`, retaining the existing two-channel normalization so one fallback channel cannot outrank healthy lexical-plus-semantic agreement by itself.
7. Add at most `0.08` for an exact identifier and `0.05` for a title match.
8. Apply at most 3% exponentially decaying recency adjustment.
9. Require `0.25` unless an exact body match exists.
10. Return at most two chunks per conversation and 20 results.

Fallback candidate lookup always joins `conversations.current_revision_id`, filters namespace and deletion state, applies an indexed age predicate, and uses a SQL limit before any R2 read. Only active-branch chunks intersecting the newest message budget are scored. Deterministic chunk IDs deduplicate fallback and indexed matches during races.

Failures are explicit in `degraded` and `unavailable`, including `recent_canonical` when canonical fallback reads fail. Direct conversation/context retrieval bypasses all indexes.
