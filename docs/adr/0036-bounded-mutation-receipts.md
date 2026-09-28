# ADR 0036: Bounded mutation receipts

- Status: Accepted
- Date: 2026-09-28

## Context

Canonical mutation tools (`memory_store`, `memory_append`, `memory_replace`,
`memory_restore_revision`, `memory_copy_conversations`) commit first and report afterwards. Their
receipts carry per-item durability, the committed revision IDs, post-commit verification, indexing
enqueue state, and a compact readback. Verification readback and copied conversation pages can be
large, and `verify: true` attaches that readback to every item.

Before this ADR, each tool assembled its receipt locally and the transport rejected the whole
response with a generic size error when the assembled JSON exceeded the 64 KiB `toolResult` guard
in `src/mcp.ts`. A generic size error on a committed mutation is the worst possible outcome: the
caller cannot tell whether the write happened, cannot see the committed revision, and is tempted to
replay. The receipt must therefore be bounded by construction, not by hope.

## Decision

### 1. Invariant

After any canonical mutation commits, response serialization can never replace that mutation's
receipt with a generic output-size error. The receipt is produced at a size the caller asked for or
at the documented safe maximum, with optional detail shed and disclosed instead of dropped
silently. The 64 KiB `toolResult` guard remains only as defense in depth against future
non-receipt responses; it is not the mechanism that keeps receipts bounded.

Shedding never removes required fields, never removes committed revision identity, and never
changes what was committed. Canonical R2 data, verification depth, and index generation behavior
are unchanged.

### 2. Shared builder

One builder, `fitMutationReceipt` in `src/writes.ts` (the existing post-commit receipt module),
serves every mutation receipt. Its constants are exported with it:

```ts
export const MUTATION_RECEIPT_MAX_SERIALIZED_BYTES = 48 * 1024; // 49,152
export const MUTATION_RECEIPT_ENVELOPE_HEADROOM = 512;
export const MUTATION_RECEIPT_ERROR_MESSAGE_LIMIT = 200;
export const MUTATION_RECEIPT_ERROR_MESSAGE_FLOOR = 80;
```

`fitMutationReceipt({ items, readbackRequests?, wrap, maxSerializedBytes? })` returns
`{ value, omitted, usedBytes, maxBytes }`. It is pure: items and selectors are deep-copied before
any edit, so a caller's objects are never mutated.

- **Budget**: `clamp(maxSerializedBytes ?? MUTATION_RECEIPT_MAX_SERIALIZED_BYTES, 1,
MUTATION_RECEIPT_MAX_SERIALIZED_BYTES)`. 49,152 bytes is the documented safe maximum; it equals
  the compact readback ceiling (`COMPACT_RESPONSE_BYTES`) and stays below the 64 KiB transport
  guard.
- **Measurement**: `jsonBytes(wrap({ items, readback_requests, omitted }))` using the UTF-8 byte
  length from `./retrieval`. Text is measured as bytes, never as characters, so non-ASCII content
  cannot pass a length check and then exceed the guard. The envelope fits iff
  `measured + MUTATION_RECEIPT_ENVELOPE_HEADROOM <= budget`; the 512-byte headroom covers the two
  budget fields appended after fitting (`used_serialized_bytes`, `max_serialized_bytes`) and leaves
  conservative slack. The final value is re-measured with those fields present and must satisfy
  `jsonBytes(value) <= budget` exactly, so the headroom is fitting slack, never a hidden overrun.
- **Required (never shed)**: `request_index`, `status`, `conversation_id`, `previous_revision_id`,
  `revision_id`, `durable`, `indexing.status`, `verification.status`,
  `verification.revision_id`, `verification.readback_available`, `error.code`.
- **Optional (shed in ladder order)**: inline `verification.readback` /
  `verification.readback_error`, `readback_requests`, `verification.checked_messages`,
  `indexing.error`, `indexing.job_id`, `source_revision_id`, `source_conversation_id`,
  `error.message` (truncated to the 80-character floor, then dropped with `error.code` retained).
  `verification.readback_available` is required and always present so a caller can always tell
  whether inline readback survived. Error messages are capped at
  `MUTATION_RECEIPT_ERROR_MESSAGE_LIMIT` (200 characters) when items are constructed, so the ladder
  truncation only ever shortens an already-bounded string.
- **Final value**: `{ ...wrap({ items, readback_requests, omitted }), used_serialized_bytes,
max_serialized_bytes: budget }`, with `used_serialized_bytes` computed by the same fixed-point
  loop used in `src/context.ts` (assign 0, measure, assign the candidate, re-measure, at most 10
  iterations, then assign the actual measurement). The reported byte count is therefore the exact
  serialized size of the returned envelope, including the digits it reports.

### 3. Shedding ladder

Inline readback is shed first, then the ladder is applied cumulatively, in this exact order,
stopping as soon as the envelope fits. Each applied rung pushes its field path into `omitted`
exactly once, deduplicated, preserving ladder order.

```text
step 1  verification.readback + verification.readback_error   (greedy, per item, in array order)
rung 1  readback_requests                  -> []
rung 2  verification.readback_error        -> dropped from every item
rung 3  verification.checked_messages      -> dropped
rung 4  indexing.error                     -> dropped
rung 5  indexing.job_id                    -> dropped
rung 6  source_revision_id                 -> dropped
rung 7  source_conversation_id             -> dropped
rung 8  error.message                      -> truncated to 80 characters
rung 9  error.message                      -> dropped (error.code retained)
```

Step 1 walks items in array order and tentatively restores both inline readback fields on each item
that carried them; it keeps the restore only while the envelope still fits and leaves the fields
removed when it does not, so inline readback is retained whenever it fits and shed when it does
not. The shed fields are the
largest and least reconstructible-by-value data in the receipt, and they are exactly the data a
caller can fetch again through `readback_requests`, so they are shed before anything that names a
commit. Ladder order then follows cost: response-shaping detail (`readback_requests`) first, then
verification detail, indexing detail, provenance, and finally error prose — never a commit's
identity or status.

### 4. Budget arithmetic

The invariant holds because every supported batch is bounded and every required field is
schema-bounded, so the fully shed floor is far below 49,152 bytes.

`memory_copy_conversations` accepts 1–20 requests. Conversation, revision, and node identifiers are
lowercase SHA-256 hex (64 characters); MCP-created conversations use UUIDs (36 characters). The
fully shed floor is measured with compact JSON and `TextEncoder`, over the required-field set that
survives the complete ladder (both budget fields and `omitted` included):

| Receipt shape (fully shed floor)                        | Item bytes | 20 items | 100 items | Share of 49,152 at 100 items |
| ------------------------------------------------------- | ---------- | -------- | --------- | ---------------------------- |
| copy item: ids, `status`, `error.code`                  | 241        | 4,949    | 24,309    | 49%                          |
| edit item (#6): `source_node_id`, `operation`, `status` | 144        | 3,009    | 14,609    | 30%                          |
| upsert item (#7): 128-char `message_key`, id, `role`    | 288        | 5,889    | 29,009    | 59%                          |

The copy receipt therefore uses 4,949 of 49,152 bytes at its maximum batch — 9.9× headroom —
before any of the optimistic paths (fewer items, no failure, UUID identifiers) are considered.
Readback selectors are at most five small fields each and are shed at rung 1 anyway, so they never
threaten the ceiling. 49,152 bytes is an enforced ceiling with measured margin, not a target.

The arithmetic is per-item, not per-receipt: an item that additionally retains non-floor fields
(per-item `previous_revision_id`/`source_*` ids plus `indexing` and `verification` blocks) measures
699 bytes, and 100 such items would reach 70,109 bytes. Those fields are shed before any commit
identity, so that configuration is not a floor — it is the shape the ladder exists to bring back
under the ceiling.

The rule generalizes: a batch is supported only while
`item_count × required_field_floor + envelope <= 49,152`. Issue #6 (`memory_edit_messages`) and
issue #7 (`memory_upsert_messages`) adopt this contract for their 1–100 item batches. With the
measured floors above, 100-item batches fit for both shapes (14,609 and 29,009 bytes), so their
schemas need no additional item bound or identifier narrowing beyond their own validation limits;
they must still route every receipt through the builder so error prose, readback, selectors, and
provenance fields shed deterministically. If a future shape's required-field floor cannot fit the
ceiling, the item count an envelope may carry is the thing to bound — required fields are never
dropped to make room.

### 5. Readback exposure

Verification readback and cursor-pinned selectors are exposed as data, not as hidden server state:

- **Inline**: `verification.readback` (a `CompactPage`) and `verification.readback_error` when they
  fit.
- **Selectors**: `readback_requests` is a list of `MutationReceiptReadbackSelector`:
  `{ conversation_id, revision_id, offset, limit, branch }`. It contains one selector per item that
  is durably committed, verified (`verify: true`), and reports
  `verification.readback_available === true`; `offset` mirrors the verification page offset
  (`stored.writeOffset ?? 0` for writes, `0` for copies), `limit` is 20, and `branch` is
  `"active"`.

A selector is exactly a valid first-call `requests` payload for `memory_get_conversations`, so
readback is consumed through the canonical batch read and its cursor continuations
(`nextCursor`, ADR 0035) rather than through a second, receipt-specific channel. Revision pinning
is preserved end to end: the selector names the exact committed revision, and
`memory_get_conversations` resolves and pins explicit revision IDs in cursor state.

No durable receipt-cursor store is introduced. A durable store would be redundant: selectors are
reconstructible from the required `conversation_id` and `revision_id` that always remain in the
receipt, offsets default to 0 for any read the caller can re-issue, and identifier widths plus the
batch cap bound the envelope anyway. Adding one would create a new D1 table, a migration, an expiry
and authorization surface, and a second source of truth for readback offsets — all to serve data
the caller already holds. There is no new D1 table, migration, R2 prefix, or storage surface in
this design.

`readback_requests` and `omitted` appear in the response only when non-empty. The bulk envelope is
`{ results, readback_requests?, omitted?, used_serialized_bytes, max_serialized_bytes }`; single
mutations return the flat `{ ...item, readback_requests?, omitted?, used_serialized_bytes,
max_serialized_bytes }` shape.

### 6. Failure and retry semantics

- **Receipt always wins**: a post-commit indexing or verification failure is reported inside the
  receipt (`indexing.status: "failed"`, `verification.status: "failed"`) with `durable: true` and
  the committed `revision_id`. A size-conditioned transport error can no longer mask it.
- **Shedding is disclosed, not silent**: every applied step and rung appears in `omitted`, so a
  caller sees that inline readback was removed rather than inferring it from absence. A caller that
  needs the readback follows `readback_requests`; recovery never depends on resubmitting the
  mutation.
- **Never replay a committed mutation**: receipt loss, a shed readback, or a failed post-commit
  step is never a reason to resend the write. The receipt's `revision_id` is the recovery handle;
  retry applies to the index job, not to the mutation.
- **Retry safety**: the builder is pure and deterministic, so a retried call that legitimately
  commits again (idempotent replay, restore, copy) produces the same bounded shape from the same
  inputs. `readback_requests` offsets are pinned to the committed revision, so a later read cannot
  drift to a newer head.

### 7. Security

- Selectors expose only identifiers the caller already received in a receipt for a commit the
  caller was authorized to perform: `conversation_id`, `revision_id`, `offset`, `limit`, `branch`.
  They contain no R2 object keys, D1 row IDs, internal user IDs, namespace internals, storage
  layout, or byte counts.
- Readback is not a new authorization path. `memory_get_conversations` applies its existing
  tenant, ownership, and namespace checks to every selector, so a selector grants nothing that the
  caller did not already have.
- `omitted` contains only field paths — public receipt field names — never content.
- Bounded error messages carry operation-level diagnostics. The 200-character construction cap and
  the 80-character ladder floor bound size, and receipt messages never contain prior canonical
  text, transcripts, or query text.
- The builder makes no storage decision and performs no I/O; it cannot widen a mutation's blast
  radius.

### 8. Relationship to ADR 0031 and issues #6/#7

ADR 0031 defines what `memory_copy_conversations` commits and how it verifies; this ADR defines how
its receipt is serialized. ADR 0031's bounded-readback and verification behavior stays in force —
verification is neither weakened nor made optional, and no readback text is lost, because every
shed field is either reconstructible from the required identifiers or fetchable through
`readback_requests`.

Issues #6 (`memory_edit_messages`) and #7 (`memory_upsert_messages`) must adopt the same
`fitMutationReceipt` contract for their 1–100 item batches: same required/optional partition, same
headroom-accounted UTF-8 measurement, same 49,152-byte ceiling, same ladder order, same
`readback_requests` consumption through `memory_get_conversations`. Their batch sizes are the
variable to verify against the shed floor in §4 before they ship.

### 9. Explicit non-goals

- No durable receipt-cursor store, table, or migration.
- No new MCP tool or readback endpoint.
- No change to canonical formats, revision identity, verification depth, compact readback schemas,
  or index generations.
- No client-side byte accounting requirement: the server fits the envelope before it returns.

## Consequences

- **Committed mutations are always legible**: durability, revision identity, and status survive
  every size condition, so callers stop confusing a transport error with a failed write.
- **One receipt contract**: writes, restores, and copies share one builder, one ceiling, and one
  shedding order, so receipt behavior is reviewable in one place instead of per tool.
- **Recoverable shedding**: `omitted` plus `readback_requests` turn a size condition into a
  documented follow-up read through an existing canonical tool, at the cost of one extra batch-read
  call.
- **No new storage surface**: the guarantee is bought with arithmetic and a pure function, not with
  a cursor table, migration, or index.
- **Known ceiling**: batch item counts are the binding constraint on the shed floor; enlarging a
  batch beyond what its required fields support is a schema decision, not a builder tweak.
