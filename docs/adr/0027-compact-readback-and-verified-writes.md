# ADR 0027: Compact readback and verified writes

- Status: Accepted
- Date: 2026-09-11

## Context

Known-owner RP continuation needs original prose from several conversations. Canonical
responses repeat text in normalized and raw content fields. Separate post-save reads add
tool round trips and can observe a newer revision than the one just committed.

## Decision

Add optional compact projections to conversation/context reads, retaining canonical output
by default. Add `memory_get_conversations` for up to 20 ordered, ownership-checked compact
reads with per-request errors, whole-message pagination, and deferred requests. Limit the
serialized result JSON to 48 KiB, below the existing 64 KiB tool-result ceiling. Read in
waves of four serial canonical-load chains, leaving headroom under the
[Workers connection limit](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections).

Conversation reads may select a specific `revision_id`, after checking both conversation
ownership and revision membership. Continuations pin that revision so concurrent updates
cannot change the transcript between pages. This does not implement revision-aware
"unchanged" caching.

An optional `verify: true` write reloads the committed R2 revision, validates the segment
hash against the committed content hash, and compares persisted roles, text, supplied
timestamps, and message counts against the intended write. Store/replace readback starts
at zero; append starts at its captured original active-message count. Verification covers
all intended messages, even when its compact readback needs pagination. It uses
[R2 read-after-write consistency](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#bucket-method-definitions)
and does not depend on indexes.

Post-commit indexing or verification failure returns the durable receipt with a separate
failure status. Existing successful unverified responses keep their shape. Canonical write
failures and optimistic conflicts still fail the write; no verification receipt is issued.

## Consequences

- No canonical format, migration, binding, chunk strategy, index generation, or rebuild changes.
- Compact output is an optional projection; full raw data and branch relationships remain in R2.
- Whole oversized messages are explicitly identified, never cut or silently skipped.
- Readback metadata uses revision-time tags; ordinary reads retain the live tag list.
- Persistence verification does not establish semantic completeness or multi-owner atomicity.
- Deployment and stored runtime-rule maintenance require separate authorization.
