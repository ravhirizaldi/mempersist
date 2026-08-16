# 0019: Evidence-sensitive semantic weighting in hybrid reranking

- Status: Accepted

## Context

ADR 0015 made rare-term lexical evidence dominant and ADR 0018 fixed paraphrase
candidate coverage, but long natural paraphrases still ranked weakly: a memory
matching only broad entities or generic words (Adriana, Ravhi, HP, pronouns)
could outrank the semantically strongest candidate purely through lexical rank
plus generic overlap boosts. Event 16 ranked #7/#10 for English and Indonesian
phone-background paraphrases while entering the semantic pool with a strong
Vectorize score.

## Decision

Advance the query-time strategy identifier to `normalized-weighted-v6` and make
the relative influence of the semantic channel evidence-sensitive:

1. **Lexical evidence** (`lexicalEvidence`, `0..1`) measures how well the
   candidate's lexical match explains the query: exact/heading/structured-label
   signals, candidate-local IDF weight over matched non-entity content tokens,
   and a small capped credit for matched proper-noun entities (`0.05` each,
   max `0.25`). Proper nouns are detected by mixed-case capitalization; ALL-CAPS
   queries carry no case signal and keep every token as content.
2. **Gated weak boosts**: generic token overlap and rare-term specificity are
   scaled by `lexicalEvidence`, so weak generic/entity overlap can no longer
   accumulate into a dominant lexical score. Exact, heading, structured-label,
   alias, field, and co-occurrence signals stay ungated.
3. **Semantic lift** (`semanticLift`): the normalized semantic score gains
   `(1 - lexicalEvidence) × conceptCoverage` additional weight. Concept coverage
   requires the candidate text to share at least one alias of each detected
   query concept, so a high Vectorize score over unrelated surface text earns
   no lift, and a strong exact lexical match keeps the semantic channel purely
   complementary.
4. Pronouns, determiners, prepositions, auxiliaries, and Indonesian function
   words join the query stop-word set so generic phrase matches (for example
   `her phone`) stop producing strong lexical phrase boosts.

Semantic channel candidate union, chunking, embeddings, Vectorize metadata,
and indexing are unchanged; no rebuild or generation change is required.

## Consequences

Strong exact/structured/rare lexical matches keep their existing dominant
scale; weak generic lexical overlap loses to strong semantic matches; and a
high semantic score over unrelated surface text earns no lift. Regression
tests pin the exact query, rare-term query, English/Indonesian paraphrases,
and the generic entity-overlap case. Component scores remain internal and the
public response shape is unchanged.

## Alternatives

A global `semanticWeight` increase was rejected because it weakens exact and
structured lexical retrieval everywhere. Generative query rewriting and
cross-encoder reranking were rejected as expensive, remote, and non-deterministic.
