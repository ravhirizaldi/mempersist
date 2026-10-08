# Storage, indexing, and retrieval

## R2 layout

```text
raw/imports/<import-id>/source/<filename>
canonical/conversations/<conversation-id>/segments/<sha256>.jsonl
canonical/conversations/<conversation-id>/revisions/<revision-id>.json
```

Raw paths are immutable per import. Segment paths are content-addressed; manifests are immutable revision documents. Canonical JSONL is uncompressed in V1 for portability and straightforward inspection/range evolution. One revision segment per conversation avoids tiny-object request overhead. Compression can be added as a versioned format only after measured storage/operation benefit. Cross-namespace destination copies introduce no new key prefixes, reusing standard `canonical/conversations/<dest-conversation-id>/...` paths.

## IDs and revisions

IDs are lowercase SHA-256 hex over domain-separated inputs. ChatGPT conversation IDs derive from source type and source ID; MCP-created conversations use UUIDs; copied conversations derive deterministic IDs using domain `copy-conversation` over `(userId, idempotencyKey, requestIndex, sourceConversationId, pinnedRevisionId, targetNamespace)` with message-node IDs derived via domain `message-node` over `(destConversationId, sourceNodeId)`. Segment IDs derive from bytes. Revision IDs cover the segment hash, current branch state, and metadata. Chunk IDs cover strategy version, generation, revision, branch, and exact source ranges; vector IDs additionally cover generation.

First-class provenance `derivedFrom` (`{ operation: "copy", conversationId, revisionId, namespace, copiedAt }` or `null`) is attached to both the segment header and revision manifest. In migration 0011, the original unique constraint on `(source_type, source_id)` (`conversations_source_idx`) was replaced by non-unique lookup index `conversations_source_lookup_idx`, allowing lossless copies of imported ChatGPT conversations to preserve original `sourceType` and `sourceId` without collision. D1 table `conversation_copy_operations` serves as the idempotency ledger keyed by `(user_id, idempotency_key)`, recording wire request material hashes, pinned source revisions, timestamps, and per-request destination receipts.

## Chunking

`chat-turn-v2` preserves message order and roles. It estimates tokens as `ceil(UTF-8 bytes / 3)` and keeps one canonical message/node as its own semantic chunk by default, so container memories such as an events container (one event per message) get one vector per event instead of several events packed toward a token target. Only tiny adjacent messages (each at most 64 estimated tokens) may share a chunk, bounded to 320 tokens and 6 messages per group, so short back-and-forth fragments stay searchable without merging real event-sized messages. An individual oversized message splits at 1800 estimated tokens (a safety ceiling, not a target size), preferring paragraph breaks whose next line starts a markdown heading, then any paragraph, line, and word boundary; split parts of one message never overlap or mix other messages. Exact source character ranges are retained per part. Active history and each alternate leaf path are indexed; alternate paths include one ancestor before divergence.

No canonical text is truncated. If Workers AI rejects a chunk, future retries can bisect the derived chunk without changing canonical storage; a strategy/output change requires a new version.

## Embeddings and indexes

The initial generation uses `@cf/baai/bge-m3`, 1024 dimensions, cosine Vectorize, batches of 32, and `truncate_inputs: false`. Response rows and dimensions are validated before upsert. Generation, strategy, model, dimensions, revision, status, and mutation state live in D1.

Enqueue records revision state as `queued`; a worker attempt marks `processing`; complete FTS and Vectorize work marks `indexed`; and any failure marks `failed` with bounded error metadata. FTS rows and source mappings are written before embeddings, with `fts_indexed_at` recording partial readiness. Canonical R2 data is never rolled back by these transitions.

## Hybrid search

1. Build safe quoted FTS terms: a full-token phrase, each raw token, a stemmed-token prefix when
   the stem differs, and a last-token prefix; stop words are excluded. See ADR 0014.
2. Start D1 FTS, the semantic branch, and the recent-canonical fallback concurrently.
   2b. The semantic branch embeds at most two deterministic representations of the raw query in
   one batched call: the query itself and a concept-anchored variant appending canonical labels
   for concepts detected in the query (`wallpaper lock screen phone background`, `picture photo
image`, `couple started dating official relationship`, ...). Candidates from each Vectorize
   query are unioned and deduplicated by chunk ID, keeping the single best raw score per chunk,
   so repeated representation matches never inflate a candidate. See ADR 0018.
3. Over-fetch `min(50, max(20, limit * 4))` candidates, or `min(200, max(20, limit * 8))` when the
   search filters by tags.
4. Drop semantic candidates below `0.35`, then normalize accepted similarity scores to `0.5..1.0`.
5. For recent current revisions not yet indexed, use D1 state to select at most 8 revisions from the last 24 hours, load their canonical R2 objects, and score at most 200 active messages with exact phrase, normalized meaningful-token, safe singular/stem, and compact operational-alias overlap.
6. Normalize lexical rank with `61/(60+rank)` and recent-canonical overlap to `0..1`. Use the strongest channel as source confidence, plus at most `0.10` for agreement across channels, so channel count cannot automatically outrank stronger content evidence.
7. Add explainable content boosts: `1.0` for a full query or exact named phrase, an additional `0.35` entity boost, up to `0.80` for another exact multi-token phrase, `0.40` for an exact identifier, up to `0.45` for normalized-token overlap, `0.15` for a true alias match, `0.15` for a matching labeled field, and at most `0.25` for matching conversation tags.
   7b. Add specificity signals: up to `0.9` for heading coverage (title or bracketed body
   heading; `0.6` when the heading contains the full normalized query), up to `0.6` for
   a query-named structured label such as `EVENT 16` (`0.3` in a heading, `0.1` in body
   text only), up to `0.5` for candidate-local IDF-weighted rare-term coverage, and up
   to `0.25` for covering several distinct rare concepts. See ADR 0015.
8. Add at most `0.10` as an exponentially decaying recency boost.
9. Require `0.25` unless an exact body match exists. Ranking strategy `normalized-weighted-v6` keeps component scores available internally for deterministic tests, but public responses expose only the final score.
   9b. Make semantic influence evidence-sensitive: generic token overlap and rare-term
   specificity are scaled by `lexicalEvidence` (exact/heading/structured signals, rare
   non-entity content-token IDF, capped entity credit), and the semantic score gains
   `(1 - lexicalEvidence) × conceptCoverage` extra weight. Weak entity-only overlap
   no longer outranks a strong semantic match; exact evidence keeps semantic purely
   complementary. See ADR 0019.
10. Return at most five chunks per conversation (container conversations hold one chunk per
    granular event under `chat-turn-v2`, so a query can legitimately surface several events
    from one log) and 20 results. The single strongest semantic candidate (raw Vectorize score
    at least `0.5`) is additionally guaranteed one page slot, so a paraphrase whose top match
    is diluted by lexical common-word matches still surfaces.

Tag filters on `memory_search` use AND semantics over `conversation_tags` and are applied after the
candidate merge, so they constrain every channel (FTS, semantic, recent-canonical) uniformly, and
the expanded pool keeps them from underfilling. Tags are intentionally absent from chunk bodies and
embeddings; the D1 catalog join is the query-time signal, and the bounded tag boost keeps strong
text matches dominant.
The semantic channel clamps its Vectorize `topK` to 50 (the platform hard cap), so large or
tag-filtered candidate pools never cause the semantic channel to fail outright.

Tag filters also support `tag_mode: "any"` on search and on conversation listing (SQL tag-set
membership), always combined with namespace isolation. Tag mutation goes through
`memory_update_tags` with optimistic revision checking; revisions are never rewritten for
tag-only changes, so the live tag set lives in `conversation_tags` while each manifest keeps its
revision-time snapshot. See ADR 0016.

Paraphrase recall is aided by two compact operational alias concepts (phone-background and
relationship, English plus Indonesian variants) using the existing alias credit rules, and by the
semantic channel, which never embeds canonical bodies synchronously. `searchMemory` accepts an
internal debug flag that attaches the per-result component breakdown for tests and diagnosis;
the MCP schema does not expose it. The semantic channel is retried once on transient failure and
accepts raw similarities from `0.30` (normalized floor `0.5`), so borderline cross-lingual
paraphrase matches are admitted without raising semantic weight.

Fallback candidate lookup always joins `conversations.current_revision_id`, filters namespace and deletion state, applies an indexed age predicate, and uses a SQL limit before any R2 read. Only active-branch chunks intersecting the newest message budget are scored. Deterministic chunk IDs deduplicate fallback and indexed matches during races.

Failures are explicit in `degraded` and `unavailable`, including `recent_canonical` when canonical fallback reads fail. Direct conversation/context retrieval bypasses all indexes.

The operational alias table is intentionally small and concept-based. It covers responsibility,
packet loss, connectivity/outage, redundancy, maintenance scheduling, network-edge devices, and
links/connections. Alias credit is awarded only when query and memory use different phrases for the
same concept; repeating the same broad word does not create extra evidence. Search still performs
only the existing query embedding for the semantic channel and never embeds recent canonical
candidate bodies synchronously.

## Search snapshot pagination

The first paginated `memory_search` call runs the normal hybrid search once and materializes a
bounded D1 `search_snapshots` row. The row stores compact ranked result metadata, the exact pinned
revision IDs, the normalized namespace/filter binding, the `normalized-weighted-v6` ranking
version, bounded `degraded`/`unavailable` diagnostics, the current position, and
`created_at`/`expires_at`. It never stores canonical message bodies, R2 keys, D1 row IDs, or
foreign resource identifiers. Non-paginated internal `searchMemory` callers do not create this
state unless pagination is explicitly requested.

The snapshot retains at most **200 ranked candidates**, in their original order and with their
final scores. A continuation reads that stored order rather than rerunning retrieval or applying a
live offset. It validates each pinned candidate against the caller's ownership, namespace,
deletion, and current-revision scope; missing, superseded, deleted, or no-longer-owned candidates
are omitted, never replaced with a newer revision. The response reports only bounded aggregate
omission counts and safe reason categories. The original degradation diagnostics remain visible on
every page.

Search pages use the shared UTF-8 JSON budget: 32,768 bytes by default, 4,096 minimum, and 49,152
maximum. `used_serialized_bytes` and `max_serialized_bytes` make the selected budget explicit.
Whole result entries are kept intact, so a page can end before its item limit when the byte budget
is reached. The snapshot candidate cap and page byte budget are independent.

The returned cursor is an opaque, HMAC-authenticated value valid for **15 minutes**. Its body has
only a format version, opaque snapshot/session ID, and expiry; the HMAC binds the authenticated user
and normalized namespaces. The snapshot row binds the query hash, tags, and tag mode, and a
continuation accepts only the cursor plus page/byte limits, so the stored filter scope cannot be
changed. Malformed, forged, expired, version-incompatible, cross-user, or scope-mismatched cursors
receive a bounded validation error. `/api/search` does not allow `q` or filter changes when
`cursor` is present.

Expired rows are lazily deleted on snapshot reads, including continuation reads. This cleanup is
derived-state maintenance only: it does not touch canonical R2 revisions, catalog heads, FTS, or
Vectorize. See [ADR 0039](adr/0039-search-snapshot-cursors.md) for the rationale and migration
contract.

## Revision history

`memory_list_revisions` reads `conversation_revisions` only; it never loads a manifest or segment
from R2 and never reconstructs transcripts from D1. Paging is `(created_at DESC, id DESC)` keyset
with a snapshot anchor revision ID and pinned current revision ID in the opaque cursor:

- one first-page D1 statement pins the current head and the latest inserted revision to the same
  database snapshot;
- the ordering key makes pages exact when several revisions share a millisecond timestamp;
- the anchor resolves to its catalog `rowid` inside the requested conversation, and later pages
  filter `rowid <= anchor`, so a revision committed mid-walk is never injected into a page it does
  not belong to;
- continuation pages validate the anchor, pinned head, boundary revision, and boundary timestamp;
  forged or stale cursors fail instead of silently dropping the snapshot bound.

The cursor exposes only values already returned to the caller (revision IDs and a timestamp), never
catalog rowids, object keys, user IDs, or global counts. `current_revision_id` remains pinned across
the walk; only the page containing that revision has a `current: true` row.

Query-plan evidence (D1 `EXPLAIN QUERY PLAN`): the first-page scope uses primary-key lookups for the
conversation and current revision, `revisions_conversation_idx (conversation_id=?)` for the
max-rowid anchor, and a rowid lookup for that anchor. Cursor anchor and membership validation use
the revision primary-key index. The page query uses `revisions_conversation_idx` and a temp b-tree
only for the final `id DESC` tie-break. No additional index is required, so no migration was added
for this tool.

## Canonical message editing

`memory_edit_messages` edits the text of known messages server-side instead of resubmitting a
transcript. It loads and integrity-checks the pinned `base_revision_id` from R2, locates each target
by the exact `source_node_id` exposed by compact/canonical reads, computes every `replace`, `append`,
or `prepend` result before writing anything, and rebuilds a complete new revision from the base
graph. Only the supported text representation of targeted nodes changes: source-node identity, role,
`createdAt`, parents and children, branch membership, active-path position, model/source metadata,
and unrelated raw fields are copied through, including inactive branches. `updatedAt` moves to the
server edit time only when final text changed. An older revision and its segments stay immutable and
revision-pinned-readable; no manifest or segment is edited or deleted.

Ordering matches every other canonical write: the new revision object is persisted to R2 first, then
the D1 head advances with a compare-and-swap from `base_revision_id`. A stale base aborts with the
existing conflict error, and the prepared revision is neither made current nor enqueued. An indexing
job is queued only after the head transition, so derived FTS and Vectorize state converge on the new
current revision and never promote text from a superseded one. Canonical durability and the head
transition stay authoritative when queueing, indexing, or optional verification fails afterwards.

An all-unchanged request short-circuits to `status: "no_change"` against the current revision with no
new revision and no indexing job. A mixed request commits one revision and reports `edited` versus
`unchanged` per target. Any missing, duplicated, foreign, oversized, or unsupported target — for
example a tool call, attachment, or multimodal part that cannot be represented as text — fails the
whole request with `UNSUPPORTED_MESSAGE_CONTENT` or the corresponding categorized error before any
write, so canonical storage never gains a partial edit. Separator semantics are explicit: `replace`
rejects `separator`, while `append`/`prepend` default to a blank line and omit it when either side is
empty. Text is never trimmed, normalized, or re-parsed.

## Exact revision-pinned message lookup

`memory_get_messages` is the exact message lookup path. It resolves selectors only against canonical
R2 content: it does not query FTS, Vectorize, chunks, recent-canonical search, or any other derived
index. A selector contains a `conversation_id`, optional `revision_id`, and exactly one of
`source_node_id` or `message_key`. `source_node_id` is the stable canonical node identity (maximum
200 characters). `message_key` is an optional stable key on a canonical node; it uses the exact
upsert shape (1–128 lowercase ASCII characters from `[a-z0-9._/-]`, starting and ending with an
alphanumeric character). `memory_get_messages` resolves either selector only against the pinned
complete graph.
Keys are unique across every node in that graph, including inactive branches. A duplicate key is a
canonical-storage error, never an arbitrary match. The key is immutable: keyed updates change text
only and preserve the source-node ID, role, timestamps (except `updatedAt` on a text change),
graph links, and metadata. See [ADR 0042](adr/0042-stable-keyed-message-upserts.md).

The server resolves every omitted revision to the conversation's current head before the first
canonical body load. Explicit revisions must belong to that conversation. It then loads each
unique pinned revision at most once per call and resolves all selectors against that revision.
The ordered request list is preserved, including duplicate selectors and duplicate result entries.
Missing, foreign, deleted, or stale conversation/revision/node/key cases deliberately collapse to
the same bounded `NOT_FOUND` behavior. If a canonical revision contains duplicate `messageKey`
values, lookup returns a bounded canonical-storage error instead of choosing one node.

Canonical nodes are not restricted to the active branch: a known source node on an inactive
branch is resolvable when its pinned revision is authorized. Active-branch projections use
`activeSourceNodeIds`; canonical reads and exact lookup retain the complete node graph, including
inactive branches. This is why callers must carry the source-node identity (or exact key) from a
canonical read rather than trying to derive it from an index result, title, text, or offset.

The MCP result envelope is snake_case:

```json
{
  "results": [
    {
      "request_index": 0,
      "status": "ok",
      "conversation_id": "<conversation>",
      "revision_id": "<pinned revision>",
      "message": {
        "sourceNodeId": "<source node>",
        "messageKey": null,
        "role": "assistant",
        "text": "Exact canonical text",
        "createdAt": "<created-at>",
        "updatedAt": "<updated-at>"
      }
    }
  ],
  "next_cursor": null,
  "used_serialized_bytes": 512,
  "max_serialized_bytes": 32768
}
```

The first call has 1–100 ordered `requests`; a continuation has only an opaque `cursor`.
`max_serialized_bytes` uses the shared UTF-8 limits: 32,768 by default, 4,096 minimum, and
49,152 maximum. Admission is whole-message: text is never truncated. A result with
`status: "oversized"` carries a bounded `oversized_message` object with identity and serialized
bytes; it contains no text. `status: "error"` is bounded and isolated, so one bad selector does
not hide other results. The cursor advances past an oversized or failed item and cannot be used to
loop over it.

Continuations preserve selector order and pinned conversation/revision IDs. Their HMAC is signed
with `MEMORY_API_TOKEN` and bound to the authenticated user and effective namespaces. Cursor
validation happens before canonical R2 access; malformed, expired, forged, foreign, or
scope-mismatched cursors have indistinguishable bounded validation errors. No module-global
request state is used, and neither cursors nor public diagnostics contain R2 object keys, D1 row
IDs, or other internal storage identifiers.

Exact text recovery is therefore stable across a stale head and index outage. An omitted revision
reads the head captured before the body load; a later write does not change that result. An
explicit historical revision remains the requested source until deletion or loss of authorization.
For an oversized response or a failed canonical read, an authorized canonical HTTP read/export
must reload the pinned conversation/revision. Operators must restore missing canonical objects from
an independent canonical backup, never reconstruct prose from FTS/vector chunks, and never expose
internal R2 keys as a recovery shortcut.

## Stable keyed message upserts

`memory_upsert_messages` updates or appends keyed text nodes without resubmitting a transcript. One request targets one owned, live conversation and contains 1–100 unique `message_key` values, a required `base_revision_id`, and the required role for each message. Keys are exact, case-sensitive, 1–128 ASCII characters matching `[a-z0-9._/-]`, and must start and end with `[a-z0-9]`; text and role limits use the deployed capability contract. Missing, deleted, foreign, and unowned conversations are deliberately indistinguishable from one another.

The server validates the entire request, including ownership, base membership, batch size, key syntax, duplicate request keys, text limits, and roles, before writing anything. It loads the pinned complete canonical graph and rejects a role mismatch for an existing key. Existing keys preserve source-node identity, role, `createdAt`, parent/child links, active/inactive branch membership, raw graph data, and metadata; only text is replaced, and `updatedAt` changes only when the text changes. A missing key appends a server-ID/server-timestamp node after the active current node, in request order, with the supplied role, text, and key. Keys remain unique across the complete graph, not merely its active projection.

Any changed item produces exactly one immutable revision. Canonical R2 manifest and segment writes complete before the D1 head compare-and-swap against `base_revision_id`; only a successful CAS can make the revision current or enqueue indexing. A stale base never overwrites a concurrent head, and a failed validation or CAS creates no current revision. An all-unchanged request returns `status: "no_change"` against the current revision and writes neither canonical data nor an index job. Post-commit queue and verification failures do not roll back the durable canonical revision; retry indexing or read the pinned revision instead of resubmitting the mutation. Optional verification reloads the committed canonical revision and checks every requested key, exact text, role, and revision integrity.

This is distinct from the other mutation surfaces: `memory_append` adds unkeyed messages, `memory_edit_messages` targets immutable `source_node_id` values and can append/prepend text, and `memory_replace` supplies a complete transcript. Upsert never changes key identity, graph structure, role, or metadata and never silently rebases a stale request.

Copying a pinned conversation preserves each `messageKey` in the complete graph while assigning destination node IDs and a new conversation/revision identity; source data is unchanged, and destination validation still rejects duplicate or malformed keys. Restore reactivates the exact key set in the selected historical revision and does not rewrite keys. Full exports include keys; imports and recovery must revalidate the shape and complete-graph uniqueness before accepting canonical data. Integrity checks report malformed or duplicate keys and compare restored/copy manifests against their recorded hashes; operators must repair canonical R2 from an independent export rather than reconstructing keyed messages from FTS, Vectorize, or chunks.

## Exact-title conversation resolution

`memory_resolve_conversations` executes deterministic catalog-only lookups against `conversations`
and `conversation_tags` without touching R2, FTS, Vectorize, or Workers AI. Matching is
exact and case-sensitive (`title = ?`), excludes tombstones (`deleted_at IS NULL`), and requires
a valid current revision head (`current_revision_id IS NOT NULL`).

Query-plan evidence (D1 `EXPLAIN QUERY PLAN`): title resolution queries use the existing index
`conversations_user_idx (user_id=?)` to scan only the requesting tenant's live conversations,
filtering by namespace and title. In single-user and bounded-tenant workloads, this index scan is
bounded to the caller's active conversations. No additional migration or index was added.

## Atomic multi-conversation commits

`memory_commit_batch` is the write path for coordinating 1–20 append or replace operations
across distinct conversations. The caller supplies an explicit `base_revision_id` for every
operation, and all target conversations must belong to the same authenticated account. The
operations may span namespaces owned by that account; a namespace boundary never widens
ownership or permits a cross-account write.

An `append` materializes new message nodes after the pinned base and may add tags (tag
updates are a union). A `replace` materializes the complete intended transcript and does not
accept tags. Both operations produce immutable revision manifests and segments using the
same canonical formats and write primitives as single-conversation mutations. The aggregate
serialized input is measured in UTF-8 bytes, including every operation, message, tag, and
envelope, before any R2, D1, queue, or embedding work. The batch is bounded to 1–20 unique
conversations and rejects an over-budget or invalid operation without changing any head.

Preparation preserves the canonical ordering invariant: immutable R2 objects are prepared
first, while durable preparation records make each expected object discoverable if a Worker
terminates between R2 and D1. One D1 `batch()` commit then inserts the prepared catalog rows
and compare-and-swaps every expected conversation head against its supplied base revision.
The transaction succeeds only when every base matches; a stale, deleted, foreign, unknown, or
otherwise invalid operation advances no head. R2 is immutable and cannot participate in a
rollback, so a failed D1 commit can leave trackable, uncommitted prepared objects.

The idempotency key is scoped to the authenticated account and records a hash of the complete
material and bases. Replaying the same key with the same material returns the stored durable
receipt (or the same deterministic prepared/committed result) without duplicate revisions or
index jobs. Reusing the key with changed material or bases is a conflict. Receipt persistence
is post-commit and best-effort; failure to save a receipt never turns a durable commit into a
failed mutation.

Index jobs are enqueued only after the all-or-none D1 commit. Optional verification reloads
each committed revision from R2 and checks its integrity and intended messages. Queue and
verification failures are reported in the bounded receipt as post-commit states; they do not
roll back canonical data or heads. A restart resumes deterministic preparation by retrying the
same account/key/material. A reviewed maintenance path may call
`cleanupPreparedCommitBatches(olderThan)` to delete only aged preparations that never
committed; it must not sweep arbitrary R2 keys or delete an object belonging to a committed
revision.

This facility does not provide cross-account commits, an external distributed transaction
across R2/D1/queues, or rollback of immutable R2 data. Derived indexes remain rebuildable
state and are repaired after the canonical commit.

## Mutation receipts

The batch receipt is `{ batch_id, status: "committed", durable: true, results, readback_requests?,
omitted?, used_serialized_bytes, max_serialized_bytes }`. Each result retains only
`request_index`, public conversation/revision IDs, `durable`, `indexing`, and optional
`verification`; optional fields are shed through `fitMutationReceipt` before serialization.
Verification depth is independent of receipt fitting: every committed revision is checked when
requested even if inline readback is omitted.

Post-commit receipt serialization is a response contract only (ADR 0036). The shared bounded
builder in `src/writes.ts` sizes a receipt to at most 49,152 serialized UTF-8 bytes and may shed
optional readback or error detail into `omitted` and `readback_requests`; it does not rewrite
canonical R2 objects, reduce verification depth, change revision identity, or alter index
generation state. `memory_edit_messages` routes its per-target results, verification readback, and
revision-pinned `readback_requests` selectors through the same builder, so a durable edit always
returns a bounded receipt even when indexing or verification fails after commit. Everything below
is unchanged by receipt size.

## Deletion consistency

Conversation deletion first sets the existing D1 `deleted_at` tombstone, immediately excluding the
memory from FTS, Vectorize result hydration, and recent-canonical selection. It then processes 25
revisions at a time: delete canonical manifest and segment keys from R2, request Vectorize deletion
in batches of 100 IDs, and atomically remove FTS rows, revision/index state, jobs, chunks, sources,
and catalog rows. A conversation row is removed only after every revision page succeeds. Partial
failure leaves the tombstone and remaining catalog pointers in place so the same request resumes
idempotently.

Namespace and all-memory tools page D1 by 50 conversation IDs and process at most 500 per call.
They never load an entire namespace or bucket listing into memory. Raw import objects and import
records remain unchanged; only their conversation/revision pointers are cleared. Index workers
verify that a revision still exists, is current, and is not tombstoned before FTS writes, before and
after each Vectorize upsert, and before completion. A stale queue message whose job was deleted is
acknowledged as a no-op, while a genuinely leased job still retries.
