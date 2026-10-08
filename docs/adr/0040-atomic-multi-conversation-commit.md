# ADR 0040: Atomic multi-conversation commits

- Status: Accepted
- Date: 2026-10-02

## Context

A client often has several independent conversation changes that must become visible as one
logical save: for example, appending an event to one conversation while replacing the complete
transcript of another. Sending one mutation per conversation leaves a partial result when a later
request is stale, invalid, or interrupted. It also makes retrying ambiguous: the client cannot know
which revisions or index jobs were created before the interruption.

The existing canonical write invariant remains mandatory: immutable canonical revision content is
prepared in R2 before a D1 head becomes current, and derived indexing happens only after the head
transition. A multi-conversation operation must extend that invariant without pretending that R2
and D1 are one distributed transaction. It needs all-head optimistic concurrency, deterministic
materialization, durable preparation state, one idempotency boundary, bounded receipts, and safe
recovery when a Worker or downstream service stops at any point.

## Decision

### 1. One bounded operation with explicit pins

`memory_commit_batch` accepts 1–20 operations. Every operation names a different owned
conversation, an operation (`append` or `replace`), and an explicit `base_revision_id`:

- `append` adds the supplied messages to the pinned transcript and may include additional tags,
  merged with the pinned conversation tags;
- `replace` supplies the complete replacement transcript and does not use append-only tag
  behavior;
- the request names one or more namespaces owned by the authenticated account, and operations
  may span those namespaces;
- a batch has one idempotency key and an optional request-level verification choice.

The server validates the complete request, aggregate limits, namespace ownership, conversation
membership, operation shape, and every base revision before canonical work starts. Duplicate
conversation targets are rejected. A missing, deleted, foreign, or unknown conversation is
reported as the same bounded `NOT_FOUND` category; the response does not disclose which case was
true.

A successful operation produces a `CommitBatchItem` with its request index, conversation identity,
previous revision identity, committed revision, messages, and operation. The public result contains
an opaque batch identity, replay state, ordered operation results, and—when available—a bounded
receipt. It never contains account identifiers, storage object names, database row identifiers, or
internal transition identifiers.

### 2. Deterministic canonical preparation

The server loads each pinned base revision from canonical storage and computes every append and
complete replacement before advancing any head. Node identities, graph links, revision manifests,
content hashes, and prepared bytes use the existing canonical materialization and write primitives;
the batch does not introduce a second transcript format.

For the same authenticated account, idempotency key, namespaces, ordered operations, explicit base
pins, and message material, preparation resolves to the same revision material and public result.
The operation's stable preparation metadata is persisted before it depends on a later retry, so a
Worker restart does not re-pin a moving head or create a different revision for the same request.
Existing immutable objects are reused rather than rewritten.

All validation and preparation is completed before the commit decision. If any operation cannot be
prepared, no conversation head advances and no indexing job is eligible for enqueueing.

### 3. Durable R2 prepare tracking

R2 objects are prepared before the catalog commit. The service durably records each prepared
object and its batch association before or while writing the object, including enough state to
recognize an already-written immutable object on restart. A retry can therefore resume preparation,
verify or reuse an immutable object, and continue to the same commit decision without allocating a
second revision.

Preparation records are coordination state, not canonical content. They do not make a revision
current. A prepared object that is never committed remains harmless until bounded cleanup removes
it according to the policy below.

### 4. One all-head D1 commit guard

After all operations are prepared, one atomic D1 batch transaction performs the catalog commit. The
transaction guards every target against the exact `base_revision_id` supplied by the caller and
records the idempotency outcome together with the head changes. It succeeds only if every expected
head still matches and every prepared revision is valid.

The transaction is all-or-nothing:

- every target head advances, or none advances;
- a stale middle operation aborts the whole batch just like a stale first or last operation;
- a validation, preparation, or D1 failure never leaves a subset of new heads current;
- historical revisions remain immutable and readable by their public revision identity.

R2 preparation cannot be rolled back by D1. If the guarded transaction does not commit, the
prepared objects remain tracked as uncommitted recovery candidates rather than being mistaken for
current data.

### 5. Batch-scoped idempotency and conflicts

Idempotency is scoped to the authenticated account and key. The stored material fingerprint covers
the namespaces, operation order, conversation targets, explicit base revisions, messages, and
operation-specific material. Execution-only choices such as whether to request verification do not
change the committed material fingerprint.

- Repeating the same key with the same material returns the stored durable receipt or the same
  deterministically prepared/committed result. It creates no duplicate revisions and no duplicate
  indexing jobs.
- Reusing a key with different material returns a bounded conflict. It never applies the new
  material under the old key.
- A retry after interruption resumes the recorded preparation or returns the already committed
  result; it does not re-pin heads or synthesize a second set of revisions.
- A stale base is a conflict for the whole batch, not a partial-success signal. The caller must
  reread current revisions and submit a new material/key when it intends a new save.

The operation ledger and receipt state are bounded. Receipt persistence after a canonical commit
is allowed to be best effort; failure to save that post-commit response state cannot turn a durable
commit into a reported mutation failure or authorize a duplicate retry.

### 6. Durable bounded receipts

The write surface reports durability independently from derived work. The public batch receipt has
the shape:

```text
{
  batch_id,
  status: "committed",
  durable: true,
  results: [
    {
      request_index,
      conversation_id,
      previous_revision_id,
      revision_id,
      durable: true,
      indexing,
      verification?
    }
  ],
  readback_requests?,
  omitted?,
  used_serialized_bytes,
  max_serialized_bytes
}
```

The receipt uses the shared `fitMutationReceipt` builder and its bounded UTF-8 serialization
ceiling. Required commit identity and durability fields are retained; optional readback, indexing
detail, verification detail, and error prose may be disclosed through `omitted` when the response
budget requires shedding. A committed operation is never hidden behind a generic response-size
error.

`verify: true` verifies every committed revision in the batch using the existing canonical
verification path. Verification is post-commit: a failure is represented in that operation's
`verification` status while `durable` remains true. If inline readback does not fit, the receipt's
public readback selectors identify the committed revision for the existing bounded conversation
read tool; they do not expose storage details.

### 7. Post-commit indexing and verification failures

Only a successful all-head D1 commit may enqueue indexing. Jobs are created for committed
revisions after the transaction, never for prepared-but-aborted revisions. Queue failure is a
post-commit outcome (`indexing.status: "failed"` with bounded diagnostics); it does not roll back a
head or make the batch non-durable. Verification failure has the same separation.

Clients must not replay a committed batch because enqueueing, verification, receipt persistence, or
response shaping failed. They should use the returned revision identities and the existing retry,
reindex, or canonical-read paths for downstream recovery. Canonical data remains authoritative while
derived indexes converge independently.

### 8. Restart and orphan cleanup

Preparation and commit state are durable enough for a later Worker invocation to distinguish:

1. a prepared object whose all-head transaction is still pending;
2. a committed revision whose receipt or post-commit work is incomplete; and
3. an abandoned, uncommitted prepared object.

Recovery resumes only the deterministic batch associated with the first two states. Cleanup accepts
an age threshold and deletes only tracked prepared objects that are known to be uncommitted and
older than that threshold. It never deletes a committed or referenced canonical revision, and it
does not infer ownership from an untracked bucket listing. Cleanup is bounded and safe to repeat.

### 9. Tenancy and security

All targets and namespaces are resolved under the authenticated account. Same-account
cross-namespace batches are allowed when the caller owns every namespace; cross-account batches are
not. Every operation is authorized independently before preparation, and the all-head transaction
retains the same tenant boundary.

Public results and errors expose only the identifiers already part of the public conversation and
revision contract plus bounded operation status. They do not expose user IDs, R2 keys, D1 row IDs,
internal transition keys, namespace ownership details, or whether a foreign resource exists. The
idempotency key cannot be used to probe another account because its ledger lookup is tenant-bound.

## Failure outcomes

| Situation                                              | Canonical state                                   | Caller outcome                                                              |
| ------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Invalid request, duplicate target, or invalid material | No heads advance; no job is eligible              | Bounded validation error; submit a corrected request                        |
| Missing, deleted, foreign, or unknown conversation     | No heads advance                                  | Bounded `NOT_FOUND`; no ownership detail                                    |
| Any stale base revision                                | No heads advance                                  | Whole-batch conflict; reread heads and recompute                            |
| R2 or preparation failure                              | No heads advance; prepared objects remain tracked | Retry the same key to resume or let orphan cleanup remove uncommitted state |
| D1 guarded commit failure                              | No heads advance                                  | Retry the same material/key; no partial success                             |
| All-head commit succeeds                               | Every target head advances                        | Durable committed receipt                                                   |
| Queue enqueue failure after commit                     | Heads and revisions remain durable                | Receipt marks indexing failed; retry indexing, not the mutation             |
| Verification failure after commit                      | Heads and revisions remain durable                | Receipt marks verification failed; inspect or reread the pinned revision    |
| Receipt save or response fitting failure after commit  | Heads and revisions remain durable                | Durable result remains authoritative; replay by the same key is safe        |
| Same key and same material                             | No new revisions or jobs                          | Stored receipt/result is replayed                                           |
| Same key and different material                        | Existing commit is unchanged                      | Bounded idempotency conflict                                                |

## Alternatives considered

### Sequentially call existing mutation tools

Rejected. It cannot guarantee all-head atomicity, makes mid-batch failure ambiguous, and requires a
separate idempotency protocol at every client.

### Use a Durable Object or distributed lock

Rejected. A lock would not make R2 and D1 atomic and would add a stateful runtime dependency. The
existing D1 compare-and-swap model plus durable preparation state provides the required commit guard.

### Write D1 first and repair R2 later

Rejected. It violates the canonical R2-before-D1 invariant and can expose a current revision whose
canonical bytes are not durable.

### Enqueue jobs inside the D1 transaction

Rejected. Queue delivery is not part of the D1 transaction. Enqueueing after commit preserves the
canonical/derived boundary and reports downstream failure explicitly.

### Return one receipt per operation without a batch ledger

Rejected. Per-operation receipts cannot distinguish a complete replay from a partial retry and
cannot prevent changed material from reusing the same key.

## Consequences

- Up to 20 same-account conversation changes can become visible as one guarded catalog commit,
  including changes across owned namespaces.
- R2 preparation may leave bounded, tracked orphan candidates after an aborted request; cleanup and
  restart recovery are explicit parts of the storage lifecycle.
- Canonical durability, queueing, verification, and receipt persistence have separate statuses, so
  a downstream failure cannot erase or misreport a successful commit.
- Clients must provide explicit revision pins and must treat a stale base as a whole-batch conflict.
- Batch receipts remain useful under the shared response budget without exposing infrastructure
  identifiers.

## Non-goals

- Cross-account or cross-tenant atomic writes.
- Partial success, best-effort per-operation commits, or automatic rebasing of stale operations.
- A distributed transaction spanning R2, D1, Queues, Workers AI, or Vectorize.
- Changing canonical revision formats, node identity rules, existing append/replace semantics, or
  historical immutability.
- Making derived indexes transactional with canonical heads.
- Exposing storage keys, database row IDs, user identifiers, internal transition state, or a new
  public recovery endpoint.
- Increasing message, request, receipt, or response limits beyond the deployed capability contract.
