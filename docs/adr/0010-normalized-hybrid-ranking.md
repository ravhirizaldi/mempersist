# 0010: Normalized hybrid search ranking

- Status: Accepted

## Context

ADR 0004 fused lexical and semantic ranks with RRF. ADR 0009 added recent canonical retrieval using the same per-channel contribution. A result found by both indexed channels therefore received about twice the base score of a recent-canonical-only result, even when the latter contained the query's exact named entity. The fallback's content score was used to order fallback candidates but discarded during the final merge.

## Decision

Normalize lexical rank, semantic similarity, and recent-canonical content overlap independently. Use the strongest normalized channel as source confidence, add only a small cross-channel agreement boost, then add deterministic exact phrase, identifier, token-overlap, and recency signals. Deduplicate by deterministic chunk ID before ranking and keep `current_revision_id` as a hard eligibility gate.

The query-time strategy identifier is `normalized-weighted-v1`. Ranking diagnostics remain internal and the public search response shape is unchanged.

## Consequences

A highly relevant queued, processing, or failed canonical revision can rank above a weaker indexed result. Indexed lexical and semantic agreement remains useful without being an automatic two-to-one advantage. Public score values and ordering change, but chunks, embeddings, Vectorize metadata, D1 schema, and canonical objects do not, so no index-generation bump or rebuild is required.

## Alternatives

Raw score comparison was rejected because FTS, Vectorize, and canonical overlap use different scales. Learned reranking was rejected because it adds cost and opacity without V1 evidence. Equal summation of normalized channels was rejected because it preserves the channel-count bias.
