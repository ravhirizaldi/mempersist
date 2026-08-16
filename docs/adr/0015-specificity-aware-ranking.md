# 0015: Specificity-aware ranking signals

- Status: Accepted

## Context

A retrieval stress test showed a near-literal heading match losing to a broad semantic
match. For the query `EVENT 16 NEW-COUPLE PHOTOBOX CANONICAL WALLPAPER`, the memory
`[EVENT 16 / NEW-COUPLE PHOTOBOX + CANONICAL WALLPAPER]` ranked below
`[EVENT 12 / VIEN + PRASETYO BECOME ESTABLISHED COUPLE]` because the latter matched the
generic concept `couple` with high semantic similarity. Ranking rewarded raw overlap and
channel confidence but had no explicit notion of how rare a matched term was, whether a
heading specifically covered the query, or whether a structured label such as `EVENT 16`
was named by the query.

## Decision

Extend the existing normalized-weighted scoring model with four bounded components,
leaving all existing components (exact phrase, entity, alias, field, recency, tag,
source confidence/agreement) unchanged:

1. **Heading match** (`headingMatchBoost`, max `0.9`): the heading is the conversation
   title plus any leading bracketed body line such as `[EVENT 16 / ...]`. A heading whose
   normalized text contains the full normalized query (with exact-identifier separators
   collapsed) earns `0.6`; otherwise a phrase in the heading earns `0.35`/`0.5`/`0.6`
   for 2/3/4+ tokens plus `0.4 ×` rare-token heading coverage, capped at `0.9`. Coverage
   is rare-token weighted, so generic headings such as `[CURRENT]` or `[NOTES]` earn
   almost nothing unless the query shares rare terms with them.
2. **Structured labels** (`structuredLabelBoost`, max `0.6`): only numbered labels of a
   recognized kind (`event`, `phase`, `chapter`, `scene`, `act`, `level`, `mission`)
   count, and only when the query names the same label. A matching label in the heading
   earns `0.3`, in the body `0.1`. A bare number in body text earns no structured credit;
   generic markers like `CURRENT` are excluded entirely.
3. **Rare-term specificity** (`specificityBoost`, max `0.5`): candidate-local IDF over
   the bounded candidate set. Each query token (stemmed, stop-word-filtered, excluding
   pure numbers) is weighted `log2((N + 0.5) / (df + 0.5))`; the candidate's matched
   weight divided by the query total, scaled by `0.5`. Tokens present in every candidate
   earn ~0 weight, so `couple` cannot outweigh `photobox`.
4. **Co-occurrence** (`coOccurrenceBoost`, max `0.25`): `0.05` per distinct rare concept
   matched beyond the first. Rewards covering several distinct query concepts without
   double-counting normalization variants (they are one concept).

The query-time strategy identifier advances to `normalized-weighted-v5`. All new
components are visible in the internal `RankingDebug` breakdown and are not exposed to
MCP consumers.

## Consequences

Highly specific exact matches now win decisively over semantically related but generic
memories, while paraphrase retrieval is untouched: semantic confidence still feeds
`sourceConfidence`, and the semantic channel never gets weaker. Rarity is computed per
query over the existing candidate pool, so no index, rebuild, or remote call is added.
Cost is one pass over at most 200 candidate rows with at most 12 query tokens.

## Alternatives

Corpus-wide document frequencies would require a new maintained index; BGE-M3 sparse
vectors would require a new Vectorize index and generation; and a cross-encoder reranker
adds per-query remote inference. Candidate-local IDF captures most of the value within
the existing architecture and degrades gracefully as the pool shrinks (no candidates, no
signal).
