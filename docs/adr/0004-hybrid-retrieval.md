# 0004: Hybrid lexical and semantic retrieval

- Status: Accepted

## Context

History contains multilingual prose and exact identifiers that embeddings alone may miss.

## Decision

Query D1 FTS5 and Vectorize, fuse with RRF, apply small exact/title boosts and a capped recency tie-breaker, then retrieve canonical context on demand.

## Consequences

Search degrades to either channel and remains useful for hostnames, errors, names, and paraphrases. Ranking constants become tested compatibility settings.

## Alternatives

Vector-only search was rejected for exact strings. FTS-only was rejected for multilingual paraphrase. Learned reranking was deferred because it adds cost and opaque behavior without V1 evidence.
