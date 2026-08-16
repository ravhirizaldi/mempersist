# 0014: Phrase- and prefix-aware FTS query construction

- Status: Accepted

## Context

ADR 0011 normalized ranking text and stems tokens for ranking, but the FTS query still used raw
quoted tokens only. Singular/plural and verb-variant queries such as "dragons" did not match chunks
containing "dragon", because FTS5 unicode61 does not stem. Stop words were emitted as ordinary query
terms, so "how is the gateway" asked FTS to match "is" and "the", flooding the lexical channel with
low-value candidates. Multi-token queries had no phrase term, so adjacent meaning was not rewarded
beyond plain token co-occurrence. Tag-filtered searches also used the same 50-candidate pool as
unfiltered searches, which could starve results under an AND predicate.

## Decision

Build the FTS MATCH expression in `queryTerms` as an OR of:

1. the full normalized meaningful-token phrase, quoted, when the query has at least two tokens;
2. each quoted raw token;
3. a quoted stemmed-token prefix (e.g. `"dragon"*` for "dragons") when the stem differs and is at
   least four characters;
4. a quoted last-token prefix for search-as-you-type morphological recall.

Stop words are excluded before term construction, so a stop-word-only query yields no FTS terms and
the lexical channel degrades to empty rather than matching everything. Tag-filtered searches expand
the candidate pool from `min(50, max(20, limit * 4))` to `min(200, max(20, limit * 8))` so the
post-merge AND tag predicate cannot underfill. The ranking strategy identifier advances to
`normalized-weighted-v4`; ranking math, chunks, embeddings, Vectorize metadata, and canonical
objects are unchanged, so no index rebuild is required.

## Consequences

Morphological variants and adjacent phrases are more recallable and more precisely ranked, stop
words no longer pollute BM25, and tag-filtered searches keep their recall. Prefix terms can add
noise, bounded by the FTS candidate limit and the existing 0.25 minimum score; the phrase term is a
subset of its tokens and therefore adds no new false candidates. Deterministic unit tests cover the
exact term construction, and integration tests cover morphological recall and phrase ranking.

## Alternatives

A custom FTS5 tokenizer with real stemming, BGE-M3 sparse vectors, and a cross-encoder reranker
were rejected for V1: a custom tokenizer changes the FTS schema and requires a rebuild, sparse
vectors need a new Vectorize index and generation, and cross-encoder reranking adds remote
inference latency per query. Prefix terms capture most of the morphological value today.
