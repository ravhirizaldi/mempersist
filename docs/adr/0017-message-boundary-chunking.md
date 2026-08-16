# 0017: Message-boundary semantic chunking

- Status: Accepted

## Context

`chat-turn-v1` packed derived units toward a 1200-token target, so a container memory such as
`ASTARA_ALT_V2_EVENTS` (one event per canonical message) produced vectors that mixed several
independent events, and a paraphrase for one event had to match a blended multi-event vector.
Exact and specificity ranking handled queries that name the event, but natural English and
Indonesian paraphrases still missed because the relevant event never entered the semantic
candidate pool as a clean single-event vector. Alias and reranking credit cannot compensate for a
missing candidate.

## Decision

1. **`chat-turn-v2`**: one canonical message/node becomes one semantic chunk by default. Token
   limits are a safety ceiling, not a target; an individual message splits only past 1800
   estimated tokens, preferring paragraph breaks whose next line starts a markdown heading so
   headed sections stay intact. Split parts of one message never overlap or absorb other messages.
2. **Conservative micro grouping**: consecutive units each at most 64 estimated tokens may share a
   chunk, bounded to 320 tokens and 6 units, so trivial fragments stay searchable without merging
   real event-sized messages.
3. **Chunk IDs now cover generation**: chunk IDs derive from strategy, generation, revision,
   branch, and source ranges, so a revision reindexed into a new generation coexists with its
   old-generation D1 rows (ADR 0007) instead of colliding on `chunks.id`. Vector IDs already
   covered generation.
4. **Generation rebuild**: reindexing into a new generation (bump `ACTIVE_INDEX_GENERATION`)
   regenerates chunks from canonical R2 and, after a revision reaches `indexed`, supersedes that
   revision's old-generation Vectorize records (best-effort deletion; a failure logs
   `vector_supersede_failed` and never fails the revision). Canonical R2/D1 data is untouched, and
   the existing per-revision job model keeps the rebuild bounded and resumable.
5. **No model change**: the first reindex reuses `@cf/baai/bge-m3` (1024-d, same Vectorize index).
   Only a measured residual failure after fine-grained reindexing would justify an embedding-model
   decision.
6. **Result assembly**: per-conversation page slots rise from three (ADR 0016) to five, because
   per-event chunking makes several events of one container log legitimate answers to one query,
   and the strongest semantic candidate (raw score at least `0.5`) is guaranteed one page slot.
   The guarantee is bounded to a single slot, never changes per-candidate scores, and lets
   paraphrase queries surface their top semantic match even when lexical common-word matches push
   it below the cutoff.

## Consequences

`ACTIVE_INDEX_GENERATION` moves to `bge-m3-chat-turn-v2`; search filters by the active generation
so old and new vectors cannot produce duplicate or conflicting candidates. Per-event vectors
increase chunk/vector counts for container memories (bounded per revision by message count) and
increase index-time embedding calls correspondingly. Exact, specificity, and generic lexical
ranking components are unchanged (`normalized-weighted-v5`). No schema, migration, or new resource
is required; a chunk-strategy/output change is versioned by the strategy and generation IDs.
