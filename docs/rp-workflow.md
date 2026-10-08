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

## Recover one exact message

When a caller already knows the message identity, use `memory_get_messages` rather than
`memory_search` or a search result's text. The first call accepts 1–100 ordered `requests` and
each request names `conversation_id`, an optional `revision_id`, and exactly one of
`source_node_id` or `message_key`. `source_node_id` is the canonical node identity (at most 200
characters); `message_key` is the exact stable upsert key (1–128 lowercase ASCII characters from
`[a-z0-9._/-]`, starting and ending with an alphanumeric character). It resolves only when the
canonical node carries that key. Never infer an identity from similar text, ranking, title, offset,
or a search hit.

Omit `revision_id` only when the current head is intended. The server pins that head for every
request before loading any R2 body. An explicit revision must belong to the conversation. The
pin remains fixed for the whole call and for any continuation, so a concurrent save cannot replace
the message with text from a newer head. A deleted, foreign, missing, or stale conversation,
revision, node, or key has the same bounded `NOT_FOUND` outcome.

Resolution is canonical-only and supports both active and inactive branch nodes. A source node
does not become invalid merely because it is absent from `activeSourceNodeIds`; use a canonical
conversation read when the UI needs to inspect branch membership before selecting it. Duplicate
requests remain duplicate ordered result entries, while the implementation may load each unique
pinned revision once. A duplicate `message_key` in one canonical revision is a bounded canonical
storage error, never an arbitrary choice.

The response reports `results`, `next_cursor`, `used_serialized_bytes`, and
`max_serialized_bytes`. Each result retains its `request_index`, `conversation_id`, and
`revision_id`, with `status: "ok"`, `"error"`, or `"oversized"`. Successful messages contain
`sourceNodeId`, `messageKey` (or `null`), `role`, exact `text`, `createdAt`, and `updatedAt`.
Errors are bounded and isolated to their request; do not discard successful entries because one
selector failed. Whole messages are admitted only within the shared UTF-8 budget (default
32,768; minimum 4,096; maximum 49,152). An oversized result reports a bounded
`oversized_message` identity and bytes but never text; recover that text through an authorized
canonical HTTP read or export.

When `next_cursor` is non-null, call `memory_get_messages` again with only that opaque cursor and
the optional byte budget. Cursors and readbacks are tenant-bound: they are HMAC-signed with the
`MEMORY_API_TOKEN` secret and bind the authenticated user and effective namespaces. Treat a
malformed, expired, forged, cross-tenant, or scope-mismatched cursor as unrecoverable; restart
the first request instead of editing it. Do not persist request state in module globals or expose
R2 object keys in a UI, API response, error, cursor, or recovery instruction.

The dashboard/API may display the public conversation ID, pinned revision ID, and source-node
identity and may link an authorized canonical read for recovery. It must not reconstruct exact
text from search indexes, offsets, FTS/vector records, or internal R2 paths. A stale current head
is normal: an omitted revision reads the head pinned at request start, while an explicit revision
continues to address that immutable historical text until it is deleted or authorization changes.

## Maintain keyed state

Use `memory_upsert_messages` when RP state has a stable application field such as
`state.relationship` or `current_scene.summary` and the caller wants to update that field without
resubmitting an owner transcript. Send one owned conversation, the exact `base_revision_id` read
from that owner, and 1–100 unique keyed text messages with their required roles. Keys are
case-sensitive and must match the 1–128-character lowercase ASCII shape
`[a-z0-9._/-]`; do not derive keys from prose or titles.

The operation validates every item before writing. Existing keys keep their source-node identity,
role, creation time, graph links, branch membership, raw fields, and metadata; only text changes,
and `updatedAt` changes only when text changes. A role mismatch rejects the whole request. A
missing key is appended after the active current node in request order with a server ID/timestamp.
Keys are unique across the complete canonical graph, including inactive branches, so do not reuse a
key for an alternate branch or assume active-only uniqueness.

Expect one revision for any changed item, with canonical R2 write before head CAS and indexing
after the successful CAS. A stale base is a conflict; reread the owner and recompute intent rather
than rebasing. `status: "no_change"` means no revision or index job. Inspect `durable`, `indexing`,
and `verification` independently; a durable commit with a queue or verification failure remains
the saved state and must not be blindly replayed. Verification should confirm each key, role, and
exact text at the returned revision.

Choose the mutation by intent: use append for a new unkeyed transcript entry, edit for a known
`source_node_id` text correction or append/prepend, replace for a complete transcript, and upsert
for keyed field-level state. Upsert cannot change identity, role, graph, metadata, or a stale base.
Copy, restore, and export preserve keys as part of canonical graph data; canonical recovery and
integrity checks must revalidate key shape and complete-graph uniqueness rather than using search
indexes as a source of truth.

## Save 3–6 owners

1. Read each affected owner completely and retain its current revision ID. Reconcile the
   intended facts against prior facts and existing owner boundaries before writing.
2. When several owners must change as one coordinated save, call `memory_commit_batch` once
   with a stable `idempotency_key` and one operation per owner. Each operation must use the
   explicit revision ID just read as `base_revision_id`. Use `operation: "append"` for
   continuation (optionally supplying tags) and `operation: "replace"` with the **complete**
   intended transcript for corrections or supersession. The batch may span namespaces owned by
   the same account; it cannot span accounts.
3. Set `verify: true` when the save needs canonical readback. The batch is all-or-none for
   head advancement: a stale or invalid middle operation commits none of the owners. Inspect
   `status`, `durable`, every ordered result's `revision_id`, `indexing`, and `verification`
   independently. A committed batch returns a bounded receipt with `batch_id`, per-owner
   `request_index`, prior revision, new revision, and post-commit states.
4. Check each persisted readback semantically. When inline readback is present, follow its
   continuation to completion. When receipt fitting sheds readback, use `readback_requests` as
   the `requests` array of a first-call `memory_get_conversations`, then repeat with only
   `cursor` until `nextCursor` is `null`. Shedding is disclosure, not a verification failure.
5. Keep the exact request material for safe retry. Replaying the same account/key/material
   returns the durable receipt without duplicate revisions or jobs. A changed material or
   base under the same key conflicts. If a batch did not commit because a base was stale,
   reread **all** affected owners and reconcile before submitting a new batch.
6. A post-commit indexing or verification failure is not a failed save. Inspect the returned
   revision IDs, retry indexing or recover readback as documented, and do not blindly repeat
   the write. If atomic coordination is unnecessary, ordinary `memory_append`,
   `memory_replace`, or `memory_store` calls remain valid.

For a coordinated 3–6-owner save, this is one write/verification call rather than one call per
owner. Large readbacks still require continuation calls. An `oversizedMessage` is an explicit
blocker at that offset; retrieve the original through an authorized canonical HTTP read/export
and do not silently skip it.

## Amend an existing message

Use `memory_edit_messages` to change the text of one or more known messages without resubmitting the
transcript. Send `conversation_id`, the exact `base_revision_id` you read, and 1–100 `edits`; each
edit names a `source_node_id` that is unique within the request with `operation` `replace`, `append`,
or `prepend`. `separator` is accepted only for `append`/`prepend` and defaults to a blank line; it is
omitted at a boundary where either side is empty.

1. Read first (`memory_get_conversation`, compact or canonical), retain the revision ID, and copy the
   exact `sourceNodeId` values you intend to edit. The server applies the change against the pinned
   base revision, so you do not need the complete transcript in context and cannot drop pages,
   branches, metadata, or anomalies by reconstructing it.
2. Submit one atomic request. Every target must exist in that revision; duplicate, missing, foreign,
   malformed, oversized, or unsupported targets fail the whole request with no new revision and no
   head change. Roles, timestamps, graph structure, titles, tags, namespaces, and message-node
   identities are not editable here.
3. Read the result by status. `status: "no_change"` means every computed text already matched, so no
   revision or indexing job was created. Otherwise the returned `revision_id` supersedes
   `previous_revision_id`, and each `edits[].status` reports `edited` or `unchanged`; a mixed request
   still commits one revision and rewrites only the changed targets.
4. Inspect `durable`, `indexing`, and `verification` independently, as for other writes. The head
   advance is a compare-and-swap against `base_revision_id`, so a stale base fails with the existing
   conflict error instead of overwriting concurrent work; the prepared revision is not made current
   and is not queued. Queuing happens only after the head transition, and every older revision stays
   immutable and readable for branch exploration or `memory_restore_revision`.
5. On conflict, re-read the current revision, re-resolve the target nodes, recompute intent, and send
   a new request. Never replay an edit against a different head. A post-commit indexing or
   verification failure is not a failed edit: the write is durable, so inspect the returned revision
   rather than repeating it.

Verification rechecks every requested target against the committed R2 revision even when inline
readback is omitted; `verification.readback_available` stays independent of what fit. When readback
text is shed, the receipt lists the `omitted` paths and returns revision-pinned `readback_requests`
selectors. Send those as the `requests` array of a first-call `memory_get_conversations`, then repeat
`memory_get_conversations({ cursor: nextCursor })` with only that cursor until `nextCursor` is
`null`; each selector pins the committed `revision_id`. Shedding is disclosure, not a verification
failure, and no canonical text is lost.

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
> For authorized saves, retain owner boundaries and optimistic base revisions. For a coordinated
> 3–6-owner save, send one `memory_commit_batch` with a stable `idempotency_key`, one
> operation per owner, explicit `base_revision_id` values, and `verify: true`; use append for
> continuation and complete replace for corrections. Same-account namespaces are allowed, but
> cross-account writes are not. The batch advances every head or none, so a stale middle owner
> must cause a reread of all affected owners before a new batch.
>
> Server readback counts as persistence verification only when it reports
> `verification.status: "passed"` for each returned committed revision. Check persisted readback
> semantically and finish pagination before declaring the save reviewed. Persistence verification
> cannot detect facts omitted from the write request. Report durability, verification, and
> indexing separately. Never repeat a committed batch merely because verification or indexing
> failed; replay the same key/material only to recover an ambiguous result. Amend a known message
> only with `memory_edit_messages`, sending the pinned base revision and exact `source_node_id`
> for each `replace`/`append`/`prepend` edit.

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

The historical save rows above measure separate per-owner writes and readbacks; they do not
measure the coordinated `memory_commit_batch` path. Use the batch workflow for new 3–6-owner
saves when all-head atomicity is required, and do not infer batch latency from these samples.
