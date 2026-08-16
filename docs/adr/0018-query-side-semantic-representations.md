# 0018: Query-side semantic representations

- Status: Accepted

## Context

After message-boundary chunking (ADR 0017), Event 16 enters the semantic candidate pool for
English and Indonesian paraphrases, but long or multilingual queries still rank it weakly. The
raw query is embedded verbatim (lexical normalization is never used as embedding input), and the
ranking (ADR 0010/0015, `normalized-weighted-v5`) stays unchanged. Measurement against the live
BGE-M3 embeddings showed the full raw query already scores highest for the target chunk
(0.700 EN / 0.695 ID); naive clause truncation lowered the score (0.636 / 0.613), while appending
canonical concept labels for concepts detected in the query raised it (0.724 / 0.723) and widened
the margin over distractor chunks.

## Decision

1. **Two bounded representations**: the raw query and a concept-anchored variant that appends
   canonical labels (for example `wallpaper lock screen phone background`, `picture photo image`,
   `couple started dating official relationship`) for every controlled concept detected in the
   query. Labels are kept intact as phrases; a label fully covered by the query is dropped, and
   the anchor is capped at 24 tokens. No generative rewriting, no translation, no stop-word
   removal or stemming on embedding input.
2. **One batched embedding call** for both representations, then at most two Vectorize queries
   (each `topK <= min(50, candidateCount)`), so the semantic channel stays bounded.
3. **Union with per-chunk max**: candidates from all representations are deduplicated by chunk ID
   and keep their single best raw score, so a chunk returned by several representations never
   receives artificial repeated credit (`mergeSemanticCandidates`).
4. **Shared controlled concept table** (`semantic-query.ts`) now also drives the ranking alias
   credit, with a new conservative `picture` concept (`picture`/`photo`/`image`/`photograph`/
   `foto`/`gambar`) and two task-listed relationship phrases (`official relationship`,
   `resmi pacaran`). Concepts stay deduplicated; several aliases of one concept never produce
   multiple boosts.
5. **Debug observability**: `SearchResultDebug.semanticVariants` exposes the representations used
   for a search, alongside the existing per-component score breakdown.

## Consequences

Long paraphrases and Indonesian queries gain a stronger, better-anchored semantic score without
changing the ranking weights, exact/specificity behavior, or chunking. Semantic cost rises from
one embedding + one Vectorize query to at most one batched embedding + two Vectorize queries.
Exact, structured, and rare lexical evidence still dominates; semantic relevance now rescues
weak-lexical paraphrases. The embedding model stays `@cf/baai/bge-m3`; direct measurement shows
no material Indonesian weakness (ID full-query cosine 0.695 vs English 0.700 against the Event 16
chunk).
