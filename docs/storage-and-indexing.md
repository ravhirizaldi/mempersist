# Storage, indexing, and retrieval

## R2 layout

```text
raw/imports/<import-id>/source/<filename>
canonical/conversations/<conversation-id>/segments/<sha256>.jsonl
canonical/conversations/<conversation-id>/revisions/<revision-id>.json
```

Raw paths are immutable per import. Segment paths are content-addressed; manifests are immutable revision documents. Canonical JSONL is uncompressed in V1 for portability and straightforward inspection/range evolution. One revision segment per conversation avoids tiny-object request overhead. Compression can be added as a versioned format only after measured storage/operation benefit.

## IDs and revisions

IDs are lowercase SHA-256 hex over domain-separated inputs. ChatGPT conversation IDs derive from source type and source ID; MCP-created conversations use UUIDs. Segment IDs derive from bytes. Revision IDs cover the segment hash, current branch state, and metadata. Chunk IDs cover strategy version, generation, revision, branch, and exact source ranges; vector IDs additionally cover generation.

## Chunking

`chat-turn-v2` preserves message order and roles. It estimates tokens as `ceil(UTF-8 bytes / 3)` and keeps one canonical message/node as its own semantic chunk by default, so container memories such as `ASTARA_ALT_V2_EVENTS` (one event per message) get one vector per event instead of several events packed toward a token target. Only tiny adjacent messages (each at most 64 estimated tokens) may share a chunk, bounded to 320 tokens and 6 messages per group, so short back-and-forth fragments stay searchable without merging real event-sized messages. An individual oversized message splits at 1800 estimated tokens (a safety ceiling, not a target size), preferring paragraph breaks whose next line starts a markdown heading, then any paragraph, line, and word boundary; split parts of one message never overlap or mix other messages. Exact source character ranges are retained per part. Active history and each alternate leaf path are indexed; alternate paths include one ancestor before divergence.

No canonical text is truncated. If Workers AI rejects a chunk, future retries can bisect the derived chunk without changing canonical storage; a strategy/output change requires a new version.

## Embeddings and indexes

The initial generation uses `@cf/baai/bge-m3`, 1024 dimensions, cosine Vectorize, batches of 32, and `truncate_inputs: false`. Response rows and dimensions are validated before upsert. Generation, strategy, model, dimensions, revision, status, and mutation state live in D1.

Enqueue records revision state as `queued`; a worker attempt marks `processing`; complete FTS and Vectorize work marks `indexed`; and any failure marks `failed` with bounded error metadata. FTS rows and source mappings are written before embeddings, with `fts_indexed_at` recording partial readiness. Canonical R2 data is never rolled back by these transitions.

## Hybrid search

1. Build safe quoted FTS terms: a full-token phrase, each raw token, a stemmed-token prefix when
   the stem differs, and a last-token prefix; stop words are excluded. See ADR 0014.
2. Start D1 FTS, the semantic branch, and the recent-canonical fallback concurrently.
   2b. The semantic branch embeds at most two deterministic representations of the raw query in
   one batched call: the query itself and a concept-anchored variant appending canonical labels
   for concepts detected in the query (`wallpaper lock screen phone background`, `picture photo
image`, `couple started dating official relationship`, ...). Candidates from each Vectorize
   query are unioned and deduplicated by chunk ID, keeping the single best raw score per chunk,
   so repeated representation matches never inflate a candidate. See ADR 0018.
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
9. Require `0.25` unless an exact body match exists. Ranking strategy `normalized-weighted-v6` keeps component scores available internally for deterministic tests, but public responses expose only the final score.
   9b. Make semantic influence evidence-sensitive: generic token overlap and rare-term
   specificity are scaled by `lexicalEvidence` (exact/heading/structured signals, rare
   non-entity content-token IDF, capped entity credit), and the semantic score gains
   `(1 - lexicalEvidence) × conceptCoverage` extra weight. Weak entity-only overlap
   no longer outranks a strong semantic match; exact evidence keeps semantic purely
   complementary. See ADR 0019.
10. Return at most five chunks per conversation (container conversations hold one chunk per
    granular event under `chat-turn-v2`, so a query can legitimately surface several events
    from one log) and 20 results. The single strongest semantic candidate (raw Vectorize score
    at least `0.5`) is additionally guaranteed one page slot, so a paraphrase whose top match
    is diluted by lexical common-word matches still surfaces.

Tag filters on `memory_search` use AND semantics over `conversation_tags` and are applied after the
candidate merge, so they constrain every channel (FTS, semantic, recent-canonical) uniformly, and
the expanded pool keeps them from underfilling. Tags are intentionally absent from chunk bodies and
embeddings; the D1 catalog join is the query-time signal, and the bounded tag boost keeps strong
text matches dominant.
The semantic channel clamps its Vectorize `topK` to 50 (the platform hard cap), so large or
tag-filtered candidate pools never cause the semantic channel to fail outright.

Tag filters also support `tag_mode: "any"` on search and on conversation listing (SQL tag-set
membership), always combined with namespace isolation. Tag mutation goes through
`memory_update_tags` with optimistic revision checking; revisions are never rewritten for
tag-only changes, so the live tag set lives in `conversation_tags` while each manifest keeps its
revision-time snapshot. See ADR 0016.

Paraphrase recall is aided by two compact operational alias concepts (phone-background and
relationship, English plus Indonesian variants) using the existing alias credit rules, and by the
semantic channel, which never embeds canonical bodies synchronously. `searchMemory` accepts an
internal debug flag that attaches the per-result component breakdown for tests and diagnosis;
the MCP schema does not expose it. The semantic channel is retried once on transient failure and
accepts raw similarities from `0.30` (normalized floor `0.5`), so borderline cross-lingual
paraphrase matches are admitted without raising semantic weight.

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
