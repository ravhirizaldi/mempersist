# 0011: Paraphrase-aware recent-canonical ranking

- Status: Accepted

## Context

ADR 0009 made recent canonical revisions searchable before asynchronous indexing, and ADR 0010
normalized channel scores. Exact entities ranked well, but operational paraphrases such as `PIC`
versus `responsible person` or `WAN outage` versus `internet failure` could still miss because the
fallback used literal meaningful-token overlap.

## Decision

Normalize Unicode, case, punctuation, and hyphens; apply conservative singular and verb stemming;
remove query stop words; and expand a small deterministic set of operational concept aliases.
Original normalized terms, true alias matches, normalized phrases, labeled fields, and exact named
entities remain separate explainable signals. Alias credit requires different phrases on each side,
which prevents a repeated broad word from counting twice.

The query-time strategy identifier is `normalized-weighted-v2`. The semantic channel keeps its
existing query embedding, while recent canonical bodies are never embedded synchronously.

## Consequences

Strong paraphrased recent memories can outrank weak indexed semantic matches without changing
chunks, embeddings, Vectorize metadata, canonical objects, or the public response shape. No index
rebuild or generation change is required. The bounded recent-revision and message limits remain
unchanged.

## Alternatives

Synchronous candidate embeddings and per-search LLM rewriting were rejected because they couple
read-after-write retrieval to remote inference. A large NLP subsystem and aggressive stemming were
rejected because they are less deterministic and harder to audit.
