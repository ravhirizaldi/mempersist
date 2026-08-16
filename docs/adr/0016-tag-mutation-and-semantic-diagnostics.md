# 0016: Tag mutation, filter modes, and semantic diagnostics

- Status: Accepted

## Context

Tags were already first-class conversation-level metadata (ADR 0013), but the MCP surface only
exposed them on store/append and an AND-only search filter. There was no way to mutate tags after
creation, no `any` filtering, no tag filter on conversation listing, and no way to distinguish
"vector missing", "semantic candidate not returned", or "reranking suppressed it" when a
paraphrase search missed. Paraphrase queries with weak lexical overlap also had no deterministic
alias credit for common phone-background and relationship concepts.

## Decision

1. **`memory_update_tags` tool**: `conversation_id`, `base_revision_id`, optional `add` and
   `remove` tag lists. Uses the same optimistic revision check as append (stale
   `base_revision_id` → `IMPORT_CONFLICT` 409). Removals apply before additions, so a tag in both
   lists ends up present. Tags live in `conversation_tags` (the queryable source of truth);
   canonical revision manifests keep the revision-time tag snapshot and are not rewritten.
2. **Filter modes**: `memory_search` and `memory_list_conversations` accept `tag_mode:
"all" | "any"` (default `all`). Search applies it in the post-merge filter; listing applies it
   in SQL via tag-set membership (`GROUP BY ... HAVING COUNT(*) = n` for all, `IN (SELECT DISTINCT
...)` for any). Namespace filters combine independently and never widen isolation.
3. **`memory_get_conversation`** now returns the live tag list in conversation metadata.
4. **Search diagnostics**: `searchMemory` accepts an internal `debug` flag that attaches the full
   per-result component breakdown (`semanticScore`, `lexicalScore`, all boosts, sources). The MCP
   schema does not expose it, so normal consumers see no change; integration tests use it to
   distinguish vector status (semantic score > 0 means the vector channel returned the chunk).
5. **Concept aliases**: two compact operational concepts added to the existing alias mechanism:
   phone-background (wallpaper, lock screen, phone background, latar layar, layar kunci, ...) and
   relationship (started dating, became a couple, newly official, jadian, mulai pacaran, ...).
   Same alias-deduplication rules as before: credit only when query and memory use different
   phrases for the same concept.
6. **Semantic channel resilience**: the semantic channel is retried once when it rejects, so a
   transient Workers AI or Vectorize failure does not silently drop paraphrase recall for that
   query; a persistent failure still reports `unavailable: ["semantic"]` exactly once. The
   semantic entry threshold also drops from raw `0.35` to `0.30`, admitting borderline
   cross-lingual paraphrase matches while the normalized floor (`0.5`) keeps their contribution
   bounded and unchanged in scale.
7. **Vectorize topK clamp**: Cloudflare Vectorize rejects `query` calls with `topK` above its hard
   cap of 50. The semantic channel clamps to `min(50, candidateCount)` while the lexical and
   recent-canonical channels keep their larger candidate pools. Without the clamp, tag-filtered
   or high-limit searches (candidate pool up to 200) made the semantic channel fail outright,
   silently degrading paraphrase queries to lexical-only results.
8. **Per-conversation result slots**: the result cap rises from two to three chunks per
   conversation. Container conversations store one chunk per granular event, so two slots
   suppressed third-ranked granular events such as Event 16 inside the EVENTS log; three slots
   keep granular retrieval usable while still bounding page diversity.

Tags remain conversation-level; per-event granular tags inside a container conversation are
deliberately out of scope. Hashtags in body text are never parsed.

## Consequences

Tag mutation is revision-safe and lost updates are rejected; tag ordering is deterministic
(first-inserted first, via `ORDER BY rowid`). Paraphrase queries gain bounded alias credit (max
`0.15`) on top of semantic confidence, without changing any specificity component. No migration
was required: `conversation_tags` already existed and no schema changed.

## Alternatives

Replacing the whole tag list on every append was rejected because it risks silently destroying
tags on routine message appends. Rewriting the canonical revision for tag-only changes was
rejected because revisions are immutable and the tag table is the live source of truth. A full
thesaurus or LLM query rewrite was rejected for the alias work: semantic retrieval stays the main
paraphrase mechanism.
