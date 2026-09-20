# ADR 0032: Deterministic context compilation and revision pinning

- Status: Accepted
- Date: 2026-09-18

## Context

AI agent runtimes (such as ChatGPT, Claude Code, Codex, and Cursor) frequently need to assemble a unified, bounded prompt context from multiple conversation sources:

1. **Required canonical owners**: Foundational transcripts containing current state, active plans, world facts, or event indexes (for example, `CURRENT`, `CURRENT_SCENE`, `EVENTS_INDEX`).
2. **Task-relevant search evidence**: Epistemic snippets retrieved through hybrid BM25 and vector search across historical dialogue and notes.
3. **Surrounding dialogue context**: Preceding and succeeding messages around retrieval hits to establish conversational context.

Prior to this ADR, assembling this context required multiple sequential MCP tool calls orchestrated entirely by the client:

- Resolving conversation titles via `memory_resolve_conversations`
- Batching canonical reads with `memory_get_conversations`
- Paging through message continuations
- Running independent searches with `memory_search`
- Loading surrounding messages with `memory_get_context`
- Performing client-side structural deduplication, message sorting, and token/byte budget fitting

This client-driven orchestration suffered from severe architectural deficiencies:

1. **Non-deterministic selection and skew**: When multiple clients assemble context, slight variations in sorting, deduplication, and truncation produce divergent context windows. Furthermore, concurrent writes between read calls can cause split-brain context where different sections reflect incompatible conversation revisions.
2. **Context window and transport overflows**: Clients lack visibility into exact serialized JSON overhead, risking exceeding downstream LLM token windows or triggering the 64 KiB MCP response transport guard.
3. **High network round-trip overhead**: Assembling a single prompt context required 4 to 10 sequential tool calls, adding substantial latency and multiplying token costs for orchestration loops.
4. **Lack of standardized provenance**: Extracted messages lacked structured cryptographic linkage back to their specific canonical R2 revisions and retrieval origins.

A dedicated read-only MCP tool, `memory_build_context`, backed by an internal context engine, is required to compile a deterministic, revision-pinned context pack within explicit token and serialized-byte limits in a single round trip.

## Decision

### 1. Architecture and internal engine boundary

We implement context compilation as a first-class internal engine exported from `src/context.ts`:

```ts
export async function buildContext(
  env: AppEnv,
  tenant: Tenant,
  input: BuildContextInput,
): Promise<ContextPack>;
```

The context engine operates exclusively through shared internal repository primitives:

- `resolveConversations` in `src/storage.ts` for exact-title resolution
- `loadCanonicalRevision` in `src/storage.ts` for direct R2 canonical revision retrieval
- `searchMemory` in `src/search.ts` for hybrid retrieval
- `getChunkContext` (or canonical segment loading) for surrounding message expansion

The context engine **never** invokes MCP tools via the MCP protocol or HTTP loopback. It is registered as an MCP tool (`memory_build_context`) in `src/mcp.ts` with explicit annotations:

- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: false`
- `idempotentHint: true`

### 2. Extractive-only scope (Zero LLM / Zero synthetic inference)

Version 1 of the context pack builder is strictly **extractive**:

- It extracts and projects verbatim canonical message nodes stored in R2.
- It never invokes generative language models or external AI services to summarize, rephrase, rewrite, compress, or merge text.
- It never performs contradiction resolution, subjective arbitration of truth, or automated canon selection.
- It performs zero database writes, creates no new canonical conversations or revisions, and enqueues no background indexing jobs.
- The compiled context pack is an ephemeral response artifact and is never stored as memory.

### 3. Wire protocol and input schema

The tool accepts an input object following the repository's established `snake_case` wire conventions:

```json
{
  "namespace": "astara_alt_v2",
  "task": "Continue the current scene after character reviews her resignation letter",
  "required": [
    {
      "selector": { "title": "CURRENT" },
      "mode": "full",
      "branch": "active",
      "priority": 100
    },
    {
      "selector": { "title": "CURRENT_SCENE" },
      "mode": "full",
      "branch": "active",
      "priority": 100
    },
    {
      "selector": { "title": "EVENTS_INDEX" },
      "mode": "tail",
      "tail_messages": 20,
      "branch": "active",
      "priority": 90
    }
  ],
  "retrieve": [
    {
      "query": "agency resignation letter professional responsibility",
      "tags": ["rp"],
      "tag_mode": "all",
      "limit": 8,
      "context_before": 2,
      "context_after": 3,
      "priority": 70
    }
  ],
  "budget": {
    "max_estimated_tokens": 8000,
    "max_serialized_bytes": 49152
  },
  "options": {
    "deduplicate": true,
    "include_provenance": true,
    "include_compiled_text": true
  }
}
```

#### Validation constraints

- **`namespace`** _(optional string)_: When provided, restricts selectors and searches to this namespace (which must be owned by `tenant.userId`). When omitted, scopes across all namespaces owned by the authenticated account (`tenant.ownedNamespaces`).
- **`task`** _(required string)_: High-level descriptive task metadata. The engine never silently coerces `task` into a search query.
- **`required`** _(array of 1 to 20 items)_:
  - Each item specifies exactly one selector: either `conversation_id` or `title`. Providing both or neither fails schema validation.
  - Title selectors use exact case-sensitive matching via `resolveConversations` (scoped by tenant and namespace). Missing or ambiguous titles fail the build immediately (`NOT_FOUND` or `VALIDATION`).
  - `mode`: `"full"` (include all selected branch messages) or `"tail"` (include the trailing `tail_messages`).
  - `tail_messages`: Positive integer bounded between 1 and 100 (defaults to 20).
  - `branch`: `"active"` (active branch nodes via `activeSourceNodeIds`) or `"all"` (all conversation nodes in canonical topological order).
  - `priority`: Integer priority used for inter-section ordering (higher values admitted first).
- **`retrieve`** _(optional array of 0 to 8 items)_:
  - `query`: Search text for hybrid BM25 and vector retrieval.
  - `limit`: Number of search hits (1 to 20, default 8).
  - `context_before` / `context_after`: Number of surrounding messages to load around each matched chunk (0 to 10).
  - `priority`: Integer priority for ranking retrieved evidence.
- **`budget`** _(required object)_:
  - `max_estimated_tokens`: Positive integer token budget.
  - `max_serialized_bytes`: Positive integer serialized byte budget, hard-capped at 49,152 bytes (48 KiB) to guarantee safe headroom under the 64 KiB MCP response threshold.
- **`options`** _(required object)_:
  - `deduplicate`: Boolean (default `true`).
  - `include_provenance`: Boolean (default `true`). When `false`, full provenance objects are omitted from individual message representations while keeping primary conversation and node identifiers.
  - `include_compiled_text`: Boolean (default `true`).

### 4. Compilation algorithm and revision pinning

The builder executes a strictly deterministic 9-stage pipeline:

```text
[Input]
   │
   ▼
1. Validate tenant & namespace authorization
   │
   ▼
2. Resolve required selectors & pin current revisions in D1 (Fail fast if missing/ambiguous)
   │
   ▼
3. Load required canonical revisions from R2 in bounded concurrent waves (concurrency = 4)
   │
   ▼
4. Concurrently execute hybrid retrieval, pin search revisions, & recheck stale heads
   │
   ▼
5. Perform structural deduplication (Conversation ID + Revision ID + Source Node ID)
   │
   ▼
6. Apply deterministic authority, priority, and tie-break ordering
   │
   ▼
7. Greedily fit whole messages within dual token and serialized-byte budgets
   │
   ▼
8. Generate deterministic compiled text projection (if requested)
   │
   ▼
9. Compute deterministic pack_id domain hash
   │
   ▼
[ContextPack]
```

#### Step 1: Tenant and namespace authorization

The engine verifies that `tenant.userId` is authenticated. If an explicit `namespace` is specified, the engine verifies that it exists in `tenant.ownedNamespaces`. Missing or unowned namespaces raise an authentication error (HTTP 403 / MCP error), preventing enumeration of foreign namespaces.

#### Step 2: Upfront revision pinning

Before reading any message bodies from R2, the engine pins every required conversation to an exact revision:

- **Conversation ID selectors**: Query D1 `conversations` where `user_id = ?`, `deleted_at IS NULL`, `current_revision_id IS NOT NULL`, and `namespace IN (...)`. If not found, abort immediately with `NOT_FOUND`.
- **Title selectors**: Batch query via `resolveConversations`. If a title has no matches, abort with `NOT_FOUND`. If a title has multiple active matches, abort with `VALIDATION` (`"Title selector is ambiguous"`).
- For every resolved required conversation, capture `(conversationId, revisionId, title, namespace)`.
- This upfront pinning guarantees that concurrent writes occurring during context compilation cannot cause split-brain reads across required documents.

#### Step 3: Bounded concurrent canonical R2 loads

Required revisions are loaded directly from R2 using `loadCanonicalRevision` in bounded concurrency waves of 4 to prevent I/O saturation on Cloudflare Workers.

- Message extraction follows the requested `branch`:
  - `"active"`: Traverses `activeSourceNodeIds` in order from root to leaf.
  - `"all"`: Traverses `nodes` in canonical order.
- Message slicing follows the requested `mode`:
  - `"full"`: Takes all selected messages.
  - `"tail"`: Slices the final `tail_messages` whole messages from the selected branch.

#### Step 4: Hybrid retrieval, search-revision pinning, and stale-head rechecks

Optional `retrieve` requests execute concurrently via `searchMemory`.

- Each search request is strictly scoped to `tenant.userId` and the allowed namespaces.
- **Search revision pinning and stale-head rechecks**: Each search chunk hit identifies a specific `revisionId`. The engine performs a stale-head recheck against the conversation's current state in D1. If the indexed chunk's revision differs from the conversation's current head revision, or if the pinned revision was deleted from R2 (`NOT_FOUND`), the hit is omitted with `reason: "stale_revision"` and a `STALE_REVISION` warning is appended, rather than returning outdated or mutated content. This guarantees that retrieved context never serves superseded revisions if concurrent writes or reindexing lags have occurred.
- **Degradation handling**: If Vectorize or Workers AI is unavailable, search operates in degraded mode (FTS-only or recent fallback). The builder captures `degraded: true` and appends unavailable subsystems to `unavailable: string[]`. Canonical required reads remain completely unaffected.

#### Step 5: Structural deduplication

Deduplication operates purely on structural node identity, never on semantic text similarity:

- Unique identity key: `(conversationId, revisionId, sourceNodeId)`.
- Two distinct canonical messages with identical text content are **never** deduplicated.
- **Required vs. Retrieved precedence**: When a retrieved message overlaps a message already present in a required section:
  - The required section retains the message in its canonical position.
  - The message is not duplicated in the retrieved section.
  - The retrieval evidence (matched chunk IDs, score, and query index) is merged into the required message's provenance and the section's matched ranges.
  - **Optional evidence precedence**: Evidence attached to required messages (chunk provenance and matched ranges) is strictly optional. If attaching evidence causes the serialized payload to exceed byte limits, optional evidence is dropped and restored before required content is ever impacted.
- **Between retrieved sections**: If multiple search queries hit the same message, the message is admitted under the highest-priority/highest-scoring retrieved section, merging matched chunk IDs.

#### Step 6: Authority and deterministic tie-break ordering

Sections and messages are ordered according to strict precedence rules:

- **Authority**: Required sections **always** outrank retrieved sections. Search relevance score never overrides required canonical owners.
- **Within required sections**:
  1. Priority descending (`priority DESC`)
  2. Request index ascending (`request_index ASC`)
  3. Canonical message sequence within the conversation branch
- **Within retrieved sections**:
  1. Priority descending (`priority DESC`)
  2. Normalized retrieval score descending (`score DESC`)
  3. Retrieve request index ascending (`request_index ASC`)
  4. Stable tie-break: `conversationId ASC`, `revisionId ASC`, `sourceNodeId ASC`

#### Step 7: Greedy dual-budget fitting

The engine fits content greedily against both `max_estimated_tokens` and `max_serialized_bytes`:

- Token counts are calculated using the repository standard estimator: `mempersist-token-estimate-v1` via `estimateTokens`.
- **Exact serialized byte measurement**: Serialized byte calculations test candidate full response envelopes via UTF-8 byte counting (`new TextEncoder().encode(JSON.stringify(envelope)).length`). The byte budget calculation accounts for the entire serialized JSON envelope overhead: top-level envelope keys, section headers, message payloads, provenance metadata, bounded omission records (`omitted`), warning diagnostics (`warnings`), and compiled text projection (`compiled_text`).
- **Whole-message inclusion**: The engine never truncates message text. Messages are included or omitted in their entirety.
- **Optional evidence dropped before required content**: When fitting content against budget limits, optional retrieval evidence (such as chunk provenance and matched ranges attached to canonical messages) is dropped and rolled back before any required message content is impacted or omitted.
- **Bounded omission and warning diagnostics**:
  - Optional retrieved messages that do not fit into the remaining token or byte budget are recorded in the `omitted` array with `reason: "budget"`.
  - Output byte fitting continuously accounts for the bounded byte growth of adding `omitted` entries and `warnings` to ensure the final payload remains strictly under `max_serialized_bytes`.
  - Optional warning diagnostics are capped at 20 during collection; excess warnings are replaced by one `DIAGNOSTICS_TRUNCATED` summary. Byte fitting evicts detail warnings before that summary and increments its count for each evicted detail. If the summary itself cannot fit after omissions and detail warnings are exhausted, it is dropped as the last-resort diagnostic to preserve the hard byte ceiling. If degraded retrieval metadata still exceeds the ceiling, unavailable channel names are removed while the `degraded` marker is retained.
- **Oversized message handling and zero text leakage**:
  - If required sections alone exceed either `max_estimated_tokens` or `max_serialized_bytes`, or if an individual **required** message exceeds the byte budget or MCP limit, the tool returns a bounded diagnostic envelope:
    ```json
    {
      "status": "required_budget_exceeded",
      "pack_id": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "required_estimated_tokens": 11420,
      "required_serialized_bytes": 52100,
      "suggested_minimum": {
        "max_estimated_tokens": 12000,
        "max_serialized_bytes": 54000
      },
      "warnings": [
        {
          "code": "REQUIRED_CONTENT_EXCEEDS_MCP_LIMIT",
          "bytes": 52100,
          "message": "Required content exceeds maximum MCP limit of 49152 bytes. Narrow required modes or use revision-pinned pagination."
        },
        {
          "code": "OVERSIZED_MESSAGE",
          "conversation_id": "conv_01j8",
          "revision_id": "rev_01j8",
          "source_node_id": "node_huge",
          "bytes": 50000,
          "message": "Message node_huge exceeds byte limit (50000 bytes)"
        }
      ],
      "degraded": false,
      "unavailable": []
    }
    ```
  - **Zero text leakage on overflow**: Diagnostic records for oversized messages and budget exceedance are strictly bounded and contain only structural metadata (`code`, `conversation_id`, `revision_id`, `source_node_id`, and `bytes`). Message text, substrings, or content previews are never emitted in warnings or error responses.
  - Individual messages in optional retrieved candidates that exceed the byte budget or MCP limit are omitted while the overall build remains `complete`; the builder records a bounded `OVERSIZED_MESSAGE` warning and an `omitted` entry with `reason: "budget"`.

#### Step 8: Deterministic plain-text projection (`compiled_text`)

When `options.include_compiled_text: true`, the engine formats the admitted messages into a clean, deterministic text projection suitable for direct injection into an LLM prompt:

```text
[REQUIRED MEMORY: CURRENT]
conversation_id: conv_01j8
revision_id: rev_01j8

[user]
Review the current deployment status.

[assistant]
All systems operational in namespace astara_alt_v2.

[RETRIEVED EVIDENCE: RUNBOOK]
conversation_id: conv_01j9
revision_id: rev_01j9
matched_chunk_ids: chunk_01j9_0

[system]
Rollback procedures require approval from lead operator.
```

The projection contains zero inferred prose and strictly reflects admitted structured messages. Its length and bytes are accounted for within the dual budgets.

#### Step 9: Deterministic pack identity (`pack_id`)

Every context pack is assigned a deterministic content identifier derived via SHA-256 domain separation:

$$\text{pack\_id} = \text{domainId}(\text{"context-pack"}, \text{BUILDER\_VERSION}, \text{stableJson}(\text{normalizedInput}), \text{stableJson}(\text{revisionPins}), \text{searchGeneration}, \text{stableJson}(\text{admittedSections}))$$

Re-executing the same normalized request against identical pinned revisions, search index generation, and builder algorithm produces an identical `pack_id`.

## Failure Taxonomy & Operational Outcomes

| Failure Scenario                  | Engine State                                                                                                                | Result to Caller                                                                                                                                                   | Recovery Action                                                                                    |
| :-------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------- |
| **Missing required selector**     | Conversation ID or exact title not found in tenant's authorized namespaces.                                                 | Whole-call `NOT_FOUND` (HTTP 404 / MCP error).                                                                                                                     | Verify conversation ID or title via `memory_list_conversations` or `memory_resolve_conversations`. |
| **Ambiguous required title**      | Title matches multiple active conversations in authorized namespaces.                                                       | Whole-call `VALIDATION` (HTTP 400 / MCP error) listing matching candidate IDs.                                                                                     | Scope query to an explicit `namespace` or use an exact `conversation_id` selector.                 |
| **Unowned namespace requested**   | Requested `namespace` is not in `tenant.ownedNamespaces`.                                                                   | Whole-call `AUTHENTICATION` (HTTP 403 / MCP error).                                                                                                                | Verify authorized namespaces using `memory_list_namespaces`.                                       |
| **Required budget exceeded**      | Required canonical messages exceed `max_estimated_tokens` or `max_serialized_bytes`.                                        | `status: "required_budget_exceeded"` with `suggested_minimum` and warnings; zero text returned.                                                                    | Switch required mode from `"full"` to `"tail"`, reduce `tail_messages`, or increase budgets.       |
| **Required exceeds MCP limit**    | Required messages exceed the 48 KiB MCP response ceiling (49,152 bytes).                                                    | `status: "required_budget_exceeded"` with warning `REQUIRED_CONTENT_EXCEEDS_MCP_LIMIT`.                                                                            | Use `memory_get_conversations` with compact pagination instead of building a single mega-pack.     |
| **Search infrastructure down**    | Workers AI or Vectorize returns an error during hybrid retrieval.                                                           | `status: "complete"`, `degraded: true`, `unavailable: ["vectorize"]`; canonical pack returned.                                                                     | Required pack remains fully authoritative. Retry search when vector infrastructure recovers.       |
| **Stale retrieved revision**      | Search returned a revision that differs from the conversation's current head revision (stale head), or was deleted from R2. | Affected hit moved to `omitted` with `reason: "stale_revision"`; warning appended.                                                                                 | Background reindex reconciles search catalog. Required context unaffected.                         |
| **Concurrent write during build** | A required conversation is updated while context compilation is executing.                                                  | Built pack uses the revision pinned in Step 2; consistent snapshot returned.                                                                                       | Pack is internally consistent. Subsequent calls pin the newer revision.                            |
| **Individual oversized message**  | A single canonical message exceeds the serialized byte budget or MCP limit.                                                 | Emits bounded `OVERSIZED_MESSAGE` warning with `conversation_id`, `revision_id`, `source_node_id`, and `bytes` without text leakage; message excluded from output. | Read oversized message individually via compact or canonical readback tools.                       |

## Consequences

### Positive

- **Single-turn orchestration**: Replaces complex multi-call client loops with a single, highly optimized server-side context compilation call.
- **Strict revision consistency**: Upfront revision pinning guarantees that context packs never suffer from split-brain state caused by concurrent writes.
- **Deterministic and reproducible**: Explicit tie-breaking, structural deduplication, and cryptographic `pack_id` generation guarantee stable model inputs across retries.
- **Transport safety**: Hard 48 KiB byte limits and pre-flight budget checks prevent 64 KiB MCP response truncations and runtime errors.
- **Extractive purity**: Total absence of generative summarization preserves canonical R2 authority and eliminates hallucination risks in context assembly.
- **Resilient degradation**: Partial retrieval outages degrade gracefully to FTS without breaking or blocking canonical required context loading.

### Negative / Trade-offs

- **No generative compression**: Very large conversation histories cannot be summarized on the fly; callers must use `"tail"` mode or readback pagination to fit within budget.
- **Read amplification**: Deep surrounding context requests (`context_before`/`context_after`) across multiple search hits require loading R2 canonical segments. Bounded concurrency (wave limit 4) is required to manage I/O load.
- **Static token estimation**: `mempersist-token-estimate-v1` provides deterministic token approximations rather than exact model-specific tokenizer counts. Token limits should include modest safety margins.
