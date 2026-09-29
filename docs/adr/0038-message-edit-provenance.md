# ADR 0038: Message-edit provenance

- Status: Accepted
- Date: 2026-09-29

## Context

`memory_edit_messages` (issue #6) changes the text of known messages server-side and commits the
result as a new canonical revision. The revision-identity pipeline hashes the complete segment JSONL
body, including its header, so any additional header field necessarily participates in the resulting
revision ID.

The existing canonical v1 segment header (`mempersist.conversation-segment.v1`) already carries
per-conversation metadata — identity, title, namespace, tags, active-branch pointers, `metadata`,
`anomalies`, and copy provenance in `derivedFrom`. Message editing introduces a new kind of fact:
which base revision an edit was computed from and which nodes and operations it targeted. Without a
durable record, an operator cannot distinguish a revision produced by a message edit from one
produced by store, append, replace, restore, or copy, and a revision-pinned reader cannot explain
why a message's text differs from its predecessor.

Three constraints shape the decision:

1. Existing canonical objects are immutable; no manifest or segment may be rewritten or deleted.
2. Non-edit revisions must serialize byte-identically, or unrelated revision IDs would change.
3. No internal storage key, user ID, namespace ID, or internal node ID may cross the MCP boundary.

## Decision

### 1. Optional provenance on the existing v1 segment header

The edit operation sets `conversation.mutation` (`MessageEditProvenance`) in the segment header. No
new segment format version, R2 object, or manifest field is introduced: the manifest remains
`mempersist.conversation-revision.v1` and does not repeat the field. Provenance is segment-header
metadata, alongside the existing `derivedFrom` copy provenance, and is parsed back into
`CanonicalConversation.mutation` when present.

### 2. Exact fields

```ts
interface MessageEditProvenance {
  operation: "edit_messages";
  previousRevisionId: string;
  edits: Array<{ sourceNodeId: string; operation: "replace" | "append" | "prepend" }>;
  editedAt: string;
}
```

| Field                | Meaning                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation`          | Discriminator, the literal `edit_messages`, so a future mutation kind can add a sibling variant without ambiguity.                          |
| `previousRevisionId` | The base revision the edit was computed from and compare-and-swapped away; ties the new revision to its predecessor for audit and rollback. |
| `edits`              | One entry per requested target in request order: the exact `sourceNodeId` and the applied `replace` / `append` / `prepend` operation.       |
| `editedAt`           | Server clock time of the edit (ISO-8601).                                                                                                   |

The record deliberately contains no user ID, namespace ID, R2 object key, manifest key, segment key,
internal node ID, role, timestamp, message text, separator, or error text. The conversation ID and
revision IDs are already derivable from the storage paths and manifest; carrying them would only
duplicate storage addressing into client-adjacent data.

### 3. Immutability and hash implications

The header is serialized inside the segment JSONL body and is covered by every hash in the identity
chain:

$$\text{segmentHash} = \text{sha256}(\text{segmentBody})$$
$$\text{contentHash} = \text{domainId}(\text{"revision-content"}, \text{segmentHash}, \text{currentSourceNodeId}, \text{stableJson(metadata)})$$
$$\text{revisionId} = \text{domainId}(\text{"revision"}, \text{conversationId}, \text{contentHash})$$

Provenance is therefore part of revision identity. Rewriting or tampering with the field changes the
segment hash and the revision ID, and `putImmutable` refuses to overwrite an existing segment or
manifest key, so a fabricated provenance record cannot masquerade as an existing revision. Edit
timestamps — each targeted node's `updatedAt`, the conversation `updatedAt`, and `mutation.editedAt`
— are all hashed, so every edit yields a fresh revision ID. The original revision object is never
modified or deleted and remains readable through revision-pinned reads.

### 4. Compatibility with non-edit revisions

`mutation` is optional and is omitted rather than serialized as `null` when absent; the parser
materializes it only when the header carries it. Segments written by store, append, replace, restore,
copy, or import therefore serialize byte-identically to pre-0038 output and keep their existing
segment hashes and revision IDs. v1 readers that ignore unknown fields continue to parse the header
unchanged, and `derivedFrom` copy provenance is independent and unaffected.

### 5. Scope and propagation

`mutation` is present exactly on revisions produced by `memory_edit_messages`: it describes the single
operation that authored that revision. Non-edit operations that build a new revision from a base
conversation — append and replace — explicitly drop any inherited value (`clearMutation` deletes the
key on a shallow copy rather than writing `null`), so a later revision can never carry a stale
`previousRevisionId`. Copy records its lineage in `derivedFrom` instead, and import and store paths
build fresh conversations, so none of them can inherit edit provenance. Restore authors no new
revision at all (head-only move, ADR 0030). A revision without provenance omits the key entirely —
absent, never `null`. Head movement remains logged separately by `conversation_head_transitions`
(ADR 0030), and the MCP-facing edit outcome — per-target `edited` / `unchanged` status, bounded
readback, and `readback_requests` selectors — remains the contract defined in ADR 0036.

## Consequences

- **Auditable lineage**: A revision-pinned reader or operator can identify that a revision resulted
  from a message edit, from which base revision, and which nodes and operations were targeted,
  without inspecting MCP receipts or D1 state.
- **No storage growth**: No new object, key prefix, or migration is added; the record rides inside the
  already-written segment header.
- **Hash-stable compatibility**: Non-edit revisions are byte-identical and keep their revision IDs;
  only edit revisions gain the field, and their new revision ID covers it.
- **No leakage**: The record contains no storage keys or tenant identifiers, so it cannot widen the
  MCP surface; provenance is canonical-internal and is not part of the bounded mutation receipt.
- **Bounded by construction**: The field is proportional to the 1–100 edit targets in a request and
  repeats no message text, so it cannot inflate a canonical segment beyond existing size limits.
