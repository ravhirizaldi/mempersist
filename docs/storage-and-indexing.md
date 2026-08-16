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

1. Build safe quoted FTS terms: a full-token phrase, each raw token, a stemmed-token prefix when
   the stem differs, and a last-token prefix; stop words are excluded. See ADR 0014.
2. Start D1 FTS, the semantic branch, and the recent-canonical fallback concurrently.
3. Over-fetch `min(50, max(20, limit * 4))` candidates, or `min(200, max(20, limit * 8))` when the
   search filters by tags.
4. Drop semantic candidates below `0.35`, then normalize accepted similarity scores to `0.5..1.0`.
5. For recent current revisions not yet indexed, use D1 state to select at most 8 revisions from the last 24 hours, load their canonical R2 objects, and score at most 200 active messages with exact phrase, normalized meaningful-token, safe singular/stem, and compact operational-alias overlap.
6. Normalize lexical rank with `61/(60+rank)` and recent-canonical overlap to `0..1`. Use the strongest channel as source confidence, plus at most `0.10` for agreement across channels, so channel count cannot automatically outrank stronger content evidence.
7. Add explainable content boosts: `1.0` for a full query or exact named phrase, an additional `0.35` entity boost, up to `0.80` for another exact multi-token phrase, `0.40` for an exact identifier, up to `0.45` for normalized-token overlap, `0.15` for a true alias match, `0.15` for a matching labeled field, and at most `0.25` for matching conversation tags.
   7b. Add specificity signals: up to `0.9` for heading coverage (title or bracketed body
   heading; `0.6` when the heading contains the full normalized query), up to `0.6` for
   a query-named structured label such as `EVENT 16` (`0.3` in a heading, `0.1` in body
   text only), up to `0.5` for candidate-local IDF-weighted rare-term coverage, and up
   to `0.25` for covering several distinct rare concepts. See ADR 0015.
8. Add at most `0.10` as an exponentially decaying recency boost.
9. Require `0.25` unless an exact body match exists. Ranking strategy `normalized-weighted-v5` keeps component scores available internally for deterministic tests, but public responses expose only the final score.
10. Return at most two chunks per conversation and 20 results.

Tag filters on `memory_search` use AND semantics over `conversation_tags` and are applied after the
candidate merge, so they constrain every channel (FTS, semantic, recent-canonical) uniformly, and
the expanded pool keeps them from underfilling. Tags are intentionally absent from chunk bodies and
embeddings; the D1 catalog join is the query-time signal, and the bounded tag boost keeps strong
text matches dominant.

Fallback candidate lookup always joins `conversations.current_revision_id`, filters namespace and deletion state, applies an indexed age predicate, and uses a SQL limit before any R2 read. Only active-branch chunks intersecting the newest message budget are scored. Deterministic chunk IDs deduplicate fallback and indexed matches during races.

Failures are explicit in `degraded` and `unavailable`, including `recent_canonical` when canonical fallback reads fail. Direct conversation/context retrieval bypasses all indexes.

The operational alias table is intentionally small and concept-based. It covers responsibility,
packet loss, connectivity/outage, redundancy, maintenance scheduling, network-edge devices, and
links/connections. Alias credit is awarded only when query and memory use different phrases for the
same concept; repeating the same broad word does not create extra evidence. Search still performs
only the existing query embedding for the semantic channel and never embeds recent canonical
candidate bodies synchronously.

## Deletion consistency

Conversation deletion first sets the existing D1 `deleted_at` tombstone, immediately excluding the
memory from FTS, Vectorize result hydration, and recent-canonical selection. It then processes 25
revisions at a time: delete canonical manifest and segment keys from R2, request Vectorize deletion
in batches of 100 IDs, and atomically remove FTS rows, revision/index state, jobs, chunks, sources,
and catalog rows. A conversation row is removed only after every revision page succeeds. Partial
failure leaves the tombstone and remaining catalog pointers in place so the same request resumes
idempotently.

Namespace and all-memory tools page D1 by 50 conversation IDs and process at most 500 per call.
They never load an entire namespace or bucket listing into memory. Raw import objects and import
records remain unchanged; only their conversation/revision pointers are cleared. Index workers
verify that a revision still exists, is current, and is not tombstoned before FTS writes, before and
after each Vectorize upsert, and before completion. A stale queue message whose job was deleted is
acknowledged as a no-op, while a genuinely leased job still retries.
