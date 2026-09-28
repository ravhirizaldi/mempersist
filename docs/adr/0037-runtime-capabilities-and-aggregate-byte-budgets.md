# ADR 0037: Runtime capabilities and aggregate byte budgets

- Status: Accepted
- Date: 2026-09-28

## Context

Clients discover the service's request and response limits piecemeal. Some limits exist only as Zod
schema maxima (item counts, per-message character limits), some only as transport guards (64 KiB MCP
output guard, 1 MiB HTTP JSON body, 16 MiB direct import), and some only as documented targets
(48 KiB compact page, 32 KiB batch default). Item and character limits do not bound the aggregate:
1,000 messages of 1,000,000 characters each is schema-valid and hundreds of megabytes of JSON. A
client learns this only after a rejected request, and the rejection is a generic validation error
that carries no measurement and no actionable suggestion.

Two separate problems follow. Clients need one machine-readable contract describing what the
deployed service accepts, and aggregate request bytes must be measured in UTF-8 bytes and rejected
before any canonical R2 write, catalog write, queue enqueue, or embedding work begins.

## Decision

### 1. One capability contract

`src/limits.ts` is the single source of truth for runtime capability values. It is a leaf module:
it imports nothing from the application graph except `./errors`, so any module may import a limit
from it without pulling the storage, search, or retrieval graph — and no cycle can form when an
enforcing module needs a capability value.

Limits that other modules used to own are defined here, and the module that enforces a limit now
imports it from `./limits`:

- `MAX_TOOL_OUTPUT_BYTES` (64 KiB) is the guard in `src/mcp.ts`;
- `COMPACT_RESPONSE_BYTES` (48 KiB), `RECOMMENDED_TOOL_OUTPUT_BYTES`, and the batch bounds
  `BATCH_DEFAULT_SERIALIZED_BYTES`, `BATCH_MIN_SERIALIZED_BYTES`, `BATCH_MAX_SERIALIZED_BYTES`
  are enforced by `src/retrieval.ts` and `src/writes.ts`;
- `MUTATION_RECEIPT_MAX_SERIALIZED_BYTES` (48 KiB, ADR 0036) is enforced by `src/writes.ts`;
- `MAX_SERIALIZED_BYTES_LIMIT` and `MAX_FOLLOW_TARGETS_LIMIT` (ADR 0032) are enforced by
  `src/context.ts`;
- `MAX_DELETE_ITEMS` (100) is the Zod bound on `memory_delete_conversations` in `src/mcp.ts`;
- values with no other owner (1 MiB inline JSON write, 16 MiB direct import and multipart part,
  per-tool item and character maxima) are defined here once, and the enforcing Zod schemas and
  guards import them instead of repeating literals.

`memoryCapabilities()` assembles the payload the MCP tool returns. Because both the assembler and
the enforcement import the same constants, a capability cannot drift from its enforcement.

### 2. Versioning

The capability document carries two identifiers.

- `protocol_version` identifies the shape of the capability document itself and of the error
  objects described here. It changes only when a field is removed, renamed, or changes meaning.
- `capabilities_version` is a date (`YYYY-MM-DD`) identifying the set of enforced limits. It changes
  when any reported value or feature flag changes, including a change made in another module.

Both are scoped to the deployed Worker version. They never describe the caller's data volume,
account, or Cloudflare billing plan, and they are identical for every caller of a deployment.

Rule: any change to a value reported by `memory_get_capabilities` updates `capabilities_version` in
the same change, plus the documentation that quotes the value. Additive optional fields keep
`protocol_version`; a breaking shape change increments it.

### 3. `memory_get_capabilities`

A read-only MCP tool, annotated `readOnlyHint: true`, `destructiveHint: false`,
`openWorldHint: false`, `idempotentHint: true`, with an empty input object and a complete output
schema mirroring `memoryCapabilities()`:

```json
{
  "protocol_version": "1",
  "capabilities_version": "2026-09-28",
  "limits": {
    "max_tool_output_bytes": 65536,
    "recommended_tool_output_bytes": 49152,
    "max_inline_json_write_bytes": 1048576,
    "max_direct_import_bytes": 16777216,
    "max_multipart_part_bytes": 16777216,
    "max_message_content_chars": 1000000,
    "max_receipt_bytes": 49152
  },
  "tools": {
    "memory_get_conversations": {
      "max_items": 20,
      "default_response_bytes": 32768,
      "max_response_bytes": 49152,
      "supports_cursor": true
    },
    "memory_append": {
      "max_items": 100,
      "max_request_bytes": 1048576,
      "supports_verify": true
    }
  },
  "features": {
    "revision_pinning": true,
    "verified_writes": true,
    "cursor_reads": true,
    "message_keys": false,
    "atomic_multi_conversation_commit": false
  }
}
```

The `tools` map lists every tool with a bounded item count, response budget, or verification flag,
using only these field names: `max_items`, `default_items`, `max_request_bytes`,
`max_response_bytes`, `default_response_bytes`, `max_tail_messages`, `supports_cursor`,
`supports_verify`. The `features` flags state protocol availability, never authorization: a true
flag does not grant access to another account's namespaces, and no flag implies administrative
capability.

The tool exposes no secret binding names, account identifiers, bucket or database identifiers, queue
names, or plan and pricing metadata.

### 4. Byte accounting

Aggregate budgets are measured in UTF-8 bytes, never `String.prototype.length`:

- MCP: the bytes of the complete serialized tool input as the transport receives it, produced by
  `JSON.stringify` of the parsed input and measured with `TextEncoder`, so roles, timestamps, tags,
  keys, and the envelope are counted;
- HTTP inline JSON writes: the same measurement of the parsed body, plus the existing
  `content-length` guard as a pre-parse defense for oversized bodies;
- HTTP import routes: the `content-length` of the streamed body or part, unchanged in mechanism.

The measured ceiling for inline JSON writes is `max_inline_json_write_bytes` (1 MiB) on both
transports, so an MCP `memory_store` that HTTP would reject is rejected identically. Import ceilings
stay transport-specific (16 MiB direct, 16 MiB per multipart part) because those routes stream to R2
rather than holding a parsed object.

### 5. Stable rejection shape

Every aggregate rejection is an `AppError` with code `REQUEST_TOO_LARGE`, status `413`,
`retryable: false`, and details:

```json
{
  "code": "REQUEST_TOO_LARGE",
  "request_bytes": 1824100,
  "max_request_bytes": 1048576,
  "suggested_max_items": 42
}
```

`suggested_max_items` is `floor(item_count * max_request_bytes / request_bytes)`, clamped to at
least 1, and is omitted when the item count is unknown (pre-parse `content-length` rejects and
streamed import bodies). It is a conservative proportional estimate, never a guarantee: it assumes
every item is the size of the average item in the rejected request, so a retry with differently
sized messages can still be rejected.

Transport envelopes differ and are documented as such:

- HTTP: `{ "error": { "code", "message", "request_bytes", "max_request_bytes", "suggested_max_items" } }`
  with status 413, produced by the existing `app.onError` handler merging `AppError.details`;
- MCP: `isError: true` with a single text content block containing the same JSON object plus a
  human-readable `message`, because an error result must not claim the tool's declared
  `outputSchema`.

Validation happens before canonical work: before `writeCanonicalConversation`, `appendConversation`,
`replaceConversation`, queue enqueue, or any embedding call. Canonical-data invariants are unchanged;
a rejected request writes nothing.

### 6. Tests

- A unit test parses the capability document with the MCP output schema and asserts each value
  equals the exported constant it claims to report, so a hand-edit of a literal fails.
- A drift test asserts the limits quoted in `README.md`, `docs/mcp.md`, and the landing-page copy
  equal the same constants.
- Boundary tests cover ASCII, multibyte Unicode, metadata-heavy messages, exactly-at-limit, and
  over-limit requests on both transports, asserting the rejection shape and that the suggestion is
  conservative (never exceeds the true affordable item count).

## Consequences

Clients can read one authoritative contract instead of discovering limits by failure, and oversized
inline writes fail fast with a measurement and a conservative suggestion. The cost is a new shared
module that both transports and their schemas import, and a version bump obligation whenever a
reported limit changes.

## Non-goals

- Raising Cloudflare account, Worker, or provider limits.
- Exposing secrets, account or infrastructure identifiers, or plan metadata.
- Replacing Zod input validation; schemas still reject malformed input.
- Accepting payloads larger than the reported inline limit.
- Guaranteeing completion within downstream provider quotas.
