# RP readback and saves

Ordinary roleplay is read-only. Persist only after explicit `simpan state` or a separately
authorized maintenance action. Keep the existing CORE/WORLD/HISTORY/STATE/ARC owners and
optimistic revision checks; these tools do not introduce a story schema or a transaction
across owners.

## Continue a scene

1. Prefer `memory_build_context` when task context needs to combine required owners (e.g. `CURRENT`,
   `CURRENT_SCENE`, `EVENTS_INDEX`) and optional retrieval evidence into a single revision-pinned pack.
   Specify required owners with exact `title` selectors (mode `"full"` or `"tail"`, branch `"active"`).
   To eliminate client-side round trips and avoid stale semantic search pollution, specify `follow` on `CURRENT`
   to deterministically expand pointers (e.g. `follow: [{ field: "current_scene" }, { field: "active_arc.owner" }]`).
   Add optional `retrieve` queries for thematic or world facts, and explicit token/byte budgets.
   Use `options.include_compiled_text: true` for direct prompt injection.
2. Fall back to `memory_resolve_conversations` and batch readback (`memory_get_conversations`) when:
   - Required owners alone exceed the 48 KiB MCP response ceiling or return `status: "required_budget_exceeded"`.
   - Complete transcripts require deep pagination or continuation cursors.
   - Branch exploration, raw payload metadata, or non-active graph traversals (`format: "canonical"`) are needed.
3. In the fallback workflow:
   - When conversation IDs are not yet known, resolve canonical owners (CURRENT, CURRENT_SCENE,
     EVENTS_INDEX) by exact title using `memory_resolve_conversations` (scoped to your project or
     active namespace) without semantic search. Then batch the resolved conversation IDs with
     `memory_get_conversations`. Use actual IDs discovered in your archive.
   - On the first call, send 1–20 requests with optional `max_serialized_bytes`. Process ordered
     results and errors, including later correction messages. Then repeatedly call
     `memory_get_conversations({ cursor: nextCursor })` with only that cursor until `nextCursor` is
     `null`; do not resubmit `requests`.
   - Legacy per-item `continuation` objects may be followed only by compatibility clients. A deferred
     entry has not delivered its prose; keep `revision_id` when following a legacy continuation.
   - Oversized diagnostics require authorized canonical HTTP/export recovery; do not retry an identical
     batch page as recovery.
   - Resolve the active arc and relevant character/world owners from the complete first batch,
     then batch those owners. Fetch archived arcs only when source context is needed.
4. Treat individual read failures, oversized messages, incomplete pages, or `required_budget_exceeded`
   diagnostics as missing context. Never infer missing facts from a title, an index, or an earlier partial page.

Use `format: "compact"` for individual conversation/context reads in fallback mode. Compact responses preserve
original text and corrections; they are not generated summaries. Use canonical output when
branch relationships, raw source fields, or multimodal references are needed.

## Save 3–6 owners

1. Read each affected owner completely and retain its revision ID. Reconcile the intended
   facts against prior facts and the existing owner boundaries before writing.
2. After `simpan state`, use `memory_append` for continuation or `memory_replace` with the
   **complete** intended transcript for corrections/supersession. Supply `base_revision_id`
   and `verify: true`. Use `memory_store` with verification only for a genuinely new owner.
3. Inspect `durable`, `revision_id`, `indexing`, and `verification` independently. A passed
   verification means the server reloaded that exact committed R2 revision, checked its
   integrity, and compared all intended messages. The compact readback is persisted data.
4. Check the readback semantically. Append readback starts at the first new message's active
   offset. Follow `readback.nextOffset` through `memory_get_conversation` with the receipt's
   conversation ID, `revision_id`, `format: "compact"`, and that offset until complete.
   A successful persistence check does not mean the AI included every fact it should have.
5. A conflict requires rereading the current owner and reconciling before another write.
   A post-commit verification/indexing failure requires inspecting the returned revision,
   not blindly repeating the write. Report which owners committed if a later owner fails;
   earlier saves remain committed.

For readbacks that fit in one response, 3–6 owners require 3–6 write/verification calls rather
than 6–12 separate write/readback calls, excluding preparatory reads. Large readbacks require
continuation calls. An `oversizedMessage` is an explicit blocker at that offset; a smaller
message-count limit cannot split it. Retrieve the original through an authorized canonical
HTTP read/export and do not silently skip it.

## Runtime-rule amendment for review

This passage is a proposed maintenance edit, **not applied to any stored runtime rules**.
Review it against the full current rules and their later corrections before replacing or
appending anything. Preserve unrelated rules and owner references verbatim.

> Ordinary RP remains read-only. Save only on explicit `simpan state`. Prefer `memory_build_context`
> to compile required runtime owners and task evidence into a single pinned context pack. Fall back to
> `memory_resolve_conversations` and compact batch reads (`memory_get_conversations`) when individual owners
> require deep pagination or exceed pack budgets. Start each batch with 1–20 requests and optional
> `max_serialized_bytes`; process ordered results and errors, then repeatedly call
> `memory_get_conversations({ cursor: nextCursor })` with only that cursor until `nextCursor` is `null`.
> Legacy per-item `continuation` objects may be followed only by compatibility clients. Oversized diagnostics
> require authorized canonical HTTP/export recovery. Later corrective messages supersede earlier facts.
> Resolve the active arc and relevant owners after runtime loading; archived arcs remain source-on-demand.
>
> For authorized saves, retain owner boundaries and optimistic base revisions. Request
> `verify: true` for each store/append/replace. Server readback counts as persistence
> verification only when it reports `verification.status: "passed"` for the returned
> committed revision. Check the persisted readback semantically and finish any pagination
> before declaring the save reviewed. Persistence verification cannot detect facts omitted
> from the write request. Report durability, verification, and indexing separately. Never
> repeat a committed write merely because verification or indexing failed. No multi-owner
> atomicity is assumed.

Repair broken owner references and disagreeing arc pointers in a separately authorized
maintenance pass. Do not guess replacement IDs. Revision-aware unchanged responses,
reference auditing, and namespace-specific indexing health remain future work.

## Reproduce the synthetic benchmark

```bash
yarn test:integration tests/readback.integration.ts -t benchmarks --reporter=verbose --disableConsoleIntercept
```

The test logs `RP_BENCHMARK` samples for five-owner continuation and 3/6-owner saves. It uses
synthetic text, real MCP handlers through an in-memory transport, and local Miniflare R2/D1.
It measures tool-result JSON bytes, call counts, and wall time; setup calls are excluded.
These timings exclude Internet and model/tool scheduling latency and cannot establish
production latency improvements. No private RP content or live archive access is required.

Local result on 2026-09-11 (median of three samples; setup excluded):

| Workflow                  | Calls before → after | JSON bytes before → after | Elapsed ms before → after |
| ------------------------- | -------------------- | ------------------------- | ------------------------- |
| Five-owner continuation   | 5 → 1                | 82,780 → 41,598           | 132 → 118                 |
| Three-owner save/readback | 6 → 3                | 3,444 → 2,673             | 299 → 234                 |
| Six-owner save/readback   | 12 → 6               | 6,885 → 5,349             | 721 → 541                 |

Continuation reads use the same pinned revisions for every sample. Save comparisons append
one synthetic correction per owner; separate reads start at the newly appended offset.
The continuation payload reduction was 49.7%. Local elapsed times are noisy and should be
remeasured on the deployed workflow before choosing further latency work.
