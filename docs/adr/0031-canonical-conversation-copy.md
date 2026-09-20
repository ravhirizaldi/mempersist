# ADR 0031: Canonical conversation copy

- Status: Accepted
- Date: 2026-09-18

## Context

Users and AI agents frequently need to duplicate, fork, template, or promote conversations across namespaces owned by the same account (for example, graduating a staging scenario into production, branching an exploratory dialogue, or duplicating a shared prompt template).

Prior to this ADR, copying a conversation required reading back transcript messages via MCP and writing them to a new conversation using `memory_store`. This workaround had critical limitations:

1. **Loss of structural fidelity**: Compact MCP readbacks flatten or discard inactive branches, raw payloads, model slugs, fine-grained timestamps, and anomaly annotations present in the underlying canonical R2 revision.
2. **Missing provenance**: The newly stored conversation lacked any cryptographic or structured linkage to its source revision and original conversation identity.
3. **Non-atomic multi-item orchestration**: Re-importing multiple conversations required repeated client round-trips without unified idempotency, conflict detection, or consistent tag transformation rules.

A dedicated `memory_copy_conversations` MCP tool must provide lossless, revision-pinned, same-account conversation copies that preserve full graph structures, maintain strict source immutability, record first-class provenance, and guarantee deterministic idempotency.

## Decision

### 1. Canonical R2 source load and source immutability

Copying a conversation reads the source revision directly from R2 using `loadCanonicalRevision`. It does not rely on lossy compact MCP readbacks.

The copy preserves the complete canonical conversation graph:

- All message nodes (both active and inactive branches)
- Raw message payloads and vendor-specific metadata
- Model slugs, anomaly annotations, and message-level timestamps
- Original conversation `createdAt`, `updatedAt`, `sourceType`, and `sourceId`

Source D1 rows (`conversations`, `conversation_revisions`, `conversation_tags`), head pointers (`current_revision_id`, `current_node_id`), and R2 objects remain completely immutable. Copy operations never modify, update, or delete source conversation records.

### 2. First-class `derivedFrom` provenance

Provenance is stored as a first-class, structured field on `CanonicalConversation` and `CanonicalRevisionManifest`:

```ts
export interface CopyProvenance {
  operation: "copy";
  conversationId: string;
  revisionId: string;
  namespace: string;
  copiedAt: string;
}
```

- **Field definition**: `derivedFrom: CopyProvenance | null`. Existing non-copied conversations set or treat this field as `null`.
- **Header placement**: The field resides at the top-level of canonical headers and manifests, not inside `conversation.metadata` or node `raw` properties. Content hashing (`stableJson(conversation.metadata)` and segment body) naturally incorporates the header while keeping metadata unpolluted.
- **Export and recovery**: `derivedFrom` is preserved during full dashboard account exports and recovery (`src/dashboard.ts` `exportAccount`).
- **Compact readback omission**: `derivedFrom` is intentionally omitted from `conversationPage` and compact MCP readback schemas, preserving existing compact tool output contracts.

### 3. Deterministic destination and message-node IDs

Destination conversation and message-node IDs are derived deterministically using SHA-256 domain separation:

$$\text{destConversationId} = \text{domainId}(\text{"copy-conversation"}, \text{userId}, \text{idempotencyKey}, \text{String}(\text{requestIndex}), \text{sourceConversationId}, \text{pinnedRevisionId}, \text{targetNamespace})$$

$$\text{destNodeId} = \text{domainId}(\text{"message-node"}, \text{destConversationId}, \text{sourceNodeId})$$

Every node's internal graph pointers (`sourceNodeId`, `parentSourceNodeId`, `childSourceNodeIds`, `currentSourceNodeId`, `activeSourceNodeIds`) are preserved verbatim, matching the node derivation model in `normalizeChatGptConversation`.

### 4. Idempotency ledger and material conflict detection

To guarantee safe retries across distributed networks, the copy operation uses a D1 idempotency ledger:

- **Migration**: `0011_conversation_copy.sql` creates the `conversation_copy_operations` table:
  ```sql
  CREATE TABLE conversation_copy_operations (
    user_id TEXT NOT NULL REFERENCES users(id),
    idempotency_key TEXT NOT NULL,
    material_hash TEXT NOT NULL,
    target_namespace TEXT NOT NULL,
    copied_at TEXT NOT NULL,
    requests_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, idempotency_key)
  ) STRICT;
  ```
- **Stable timestamp**: `copiedAt` is established and persisted in D1 **before** any destination R2 write. Retries reuse this timestamp so destination canonical JSONL bytes and `revisionId` content hashes remain identical.
- **Material hash**: $\text{materialHash} = \text{sha256}(\text{stableJson}(\{\text{target\_namespace}, \text{requests}: \text{wireRequests}\}))$, where each request specifies `conversation_id`, `revision_id`, `title`, and `tags`. Ephemeral execution flags (`create_target_namespace`, `verify`) are excluded from the hash.
- **Conflict vs replay**:
  - Replaying with the same `(userId, idempotencyKey)` and matching `materialHash` returns the stored destination receipts without repeating writes or re-pinning heads.
  - Reusing an existing `idempotencyKey` with different material raises an `AppError("IMPORT_CONFLICT", "idempotency_key was reused with different copy material", 409)`.

### 5. Upfront revision pinning

For each request in a new copy operation:

- If `revision_id` is omitted: the operation queries D1 `conversations.current_revision_id` and pins that head revision.
- If `revision_id` is specified: the operation verifies that the revision exists and belongs to the source conversation in `conversation_revisions`. Missing or foreign revisions fail that item with `NOT_FOUND`.
- Pinned revisions are recorded in `conversation_copy_operations.requests_json` before destination writes begin. Subsequent retries never re-pin a moved source head.

### 6. Migration 0011 and non-unique source lookup index

In `migrations/0001_core.sql`, a unique index `conversations_source_idx` existed on `(source_type, source_id)`. Because lossless copy preserves the original `sourceType` and `sourceId` (e.g. from imported ChatGPT conversations) while generating new conversation IDs, a unique index causes constraint violations.

Migration `0011_conversation_copy.sql`:

1. Drops `conversations_source_idx`.
2. Creates non-unique lookup index `conversations_source_lookup_idx` on `conversations(source_type, source_id)`.

ChatGPT re-import deduplication remains enforced by primary key `id = domainId("conversation", "chatgpt", sourceId)` via `ON CONFLICT(id)` in `writeCanonicalConversation`.

### 7. Tag inheritance, replacement, and validation

Tags on copied conversations are transformed via a local tag helper:

- **`inherit` mode (default)**: Starts from the **pinned source revision's** canonical tags (not live mutable `conversation_tags`).
- **`replace` mode**: Starts from an empty tag set `[]`.
- **Transformation order**: Removes tags in `remove`, then adds tags in `add`, followed by `normalizeTags`.
- **Validation**: If the resulting tag set exceeds 20 tags, that item fails with `VALIDATION` (HTTP 400). No silent truncation occurs.

### 8. Namespace tenancy and `create_target_namespace`

- **Same-account restriction**: Copies are permitted only between namespaces owned by the same authenticated account (`userId`), including copying into the source namespace. Cross-account copies are strictly prohibited.
- **`create_target_namespace: false` (default)**: The caller must already own `target_namespace`. If unowned, the tool raises `AUTHENTICATION` (HTTP 403: `"Namespace is not accessible to this account"`).
- **`create_target_namespace: true`**: The handler invokes `grantNamespace(env, userId, target_namespace)` before executing copies.

### 9. Error taxonomy and mixed batch semantics

The `memory_copy_conversations` tool accepts 1 to 20 conversation requests in a single batch:

- **Whole-call errors**: Schema validation failures (Zod), unowned target namespace (without `create_target_namespace`), idempotency material conflicts (`IMPORT_CONFLICT`), and `DELETION_PENDING` fail the entire tool call immediately.
- **Per-item errors**: Missing source conversations, unauthorized source namespaces, invalid revision IDs, tag validation overflow (`VALIDATION`), or R2 canonical corruption (`CANONICAL_STORAGE`) fail only the affected item. The tool returns a `results[]` array containing both `status: "copied"` receipts and `status: "failed"` items. One item's failure never aborts or hides sibling results.

### 10. Independent post-commit indexing and verification

- **Canonical write**: Destination conversations are written sequentially using `writeCanonicalConversation(env, dest, null, null, userId)` with `putImmutable`.
- **Derived indexing**: Enqueueing search indexing (`enqueueIndex`) occurs post-commit. An indexing queue failure returns `indexing.status: "failed"` with `retryable: true`, without invalidating the durable copy.
- **Verification (`verify: true`)**: Post-commit verification validates destination segment hashes against manifests, verifies D1 `conversations.current_revision_id`, confirms `derivedFrom.operation === "copy"`, and performs a compact readback bounded to 48 KiB JSON. Verification failures return `verification.status: "failed"` with `error.code: "CANONICAL_STORAGE"`, preserving the durable receipt.

### 11. Explicit non-goals

- No HTTP copy endpoint (`/api/*` routes).
- No dashboard copy UI.
- No cross-account copy operations.
- No whole-namespace batch copy tools.
- No search-result deduplication (searches spanning multiple namespaces return both source and copied conversations as independent hits).
- No changes to compact MCP readback output schemas.

## Failure Taxonomy & Operational Outcomes

| Failure Scenario                | Database / Storage State                                                                 | Result to Caller                                            | Recovery Action                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Material conflict**           | Existing `conversation_copy_operations` row has different `material_hash`.               | Whole-call `IMPORT_CONFLICT` (HTTP 409).                    | Submit request with a fresh `idempotency_key` or match original request parameters. |
| **Unowned target namespace**    | Target namespace not in user's authorized set; `create_target_namespace: false`.         | Whole-call `AUTHENTICATION` (HTTP 403).                     | Pass `create_target_namespace: true` or grant namespace before copying.             |
| **Missing source conversation** | Source ID not found, deleted, or belongs to another user/namespace.                      | Item `status: "failed"`, `error.code: "NOT_FOUND"`.         | Verify source conversation ID and authorized namespaces.                            |
| **Invalid source revision**     | Pinned `revision_id` does not belong to source conversation.                             | Item `status: "failed"`, `error.code: "NOT_FOUND"`.         | Inspect available revisions via `memory_list_revisions`.                            |
| **Tag limit exceeded (>20)**    | Inherit/replace transformation yields > 20 tags.                                         | Item `status: "failed"`, `error.code: "VALIDATION"`.        | Reduce tags in `add` or specify `remove` tags to stay within the 20-tag limit.      |
| **Index queue failure**         | Destination conversation durably written in R2 and D1; indexing enqueue failed.          | Item `status: "copied"`, `indexing.status: "failed"`.       | Copy is durable. Retry indexing via background reindex worker (`yarn reindex`).     |
| **Verification failure**        | Destination conversation committed; R2 readback or manifest integrity validation failed. | Item `status: "copied"`, `verification.status: "failed"`.   | Copy is durable. Inspect R2 canonical objects and run `yarn verify:integrity`.      |
| **Idempotent retry**            | Operation already completed; `requests_json` contains copied items.                      | Item `status: "copied"` with original destination receipts. | Operation completed cleanly with zero duplicate R2 objects or D1 rows.              |

## Consequences

- **Full graph fidelity**: Copied conversations retain complete branch hierarchies, raw data payloads, and vendor metadata without data degradation.
- **Auditable lineage**: `derivedFrom` establishes an immutable, queryable provenance chain across canonical manifests and exports.
- **Deterministic and safe retries**: Pre-persisted `copiedAt` and D1 idempotency records prevent duplicate R2 allocations, split-brain revisions, or re-pinning drift.
- **Tenant isolation**: All copy operations are strictly bounded to namespaces owned by the same authenticated user account.
- **Index synchronization**: Search indexing remains decoupled from durability, ensuring consistent hybrid retrieval across source and destination namespaces.
