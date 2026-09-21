# ADR 0034: Deterministic pointer follow expansion in memory_build_context

- Status: Accepted
- Date: 2026-09-20

## Context

ADR 0032 established server-side deterministic context compilation and revision pinning via `memory_build_context`, and ADR 0033 unified branch timeline reconstruction for alternate conversation branches.

However, structured runtime memory frequently employs hierarchical or relational references between separate conversations. A primary canonical owner (such as `CURRENT`) references related conversations via structured text pointers, for example:

```text
[CURRENT / SYNTHETIC ACTIVE STATE]
active_arc: SYNTHETIC ACTIVE ARC; owner 0191f6e0-3333-7000-8000-000000000003; status OPEN
current_scene: 0191f6e0-2222-7000-8000-000000000002; status OPEN; Headquarters Monday morning; POV Operator; Operational review
```

Previously, callers had to either:

1. Know all referenced conversation IDs/titles up front and include them manually in `required`, or
2. Rely on optional hybrid semantic search to retrieve the referenced conversations.

Relying on semantic search suffered from severe deficiencies:

1. **Stale context pollution**: Semantic search can match older, superseded scenes or archived arcs instead of the exact active pointer targets.
2. **Budget displacement**: Semantic retrieval candidates competed with or were displaced by irrelevant hits.
3. **Lack of determinism**: Pointers are exact references and should never be subject to probabilistic or semantic threshold variations.

## Decision

We introduce deterministic pointer-aware expansion directly into `memory_build_context` through an explicit `follow` property on `required` selectors:

```ts
export interface BuildContextFollowItem {
  field: string;
  required?: boolean;
  priority?: number;
  mode?: "full" | "tail";
  branch?: "active" | "all";
  tail_messages?: number;
  follow?: BuildContextFollowItem[];
}
```

### 1. Deterministic pointer extraction

Pointer fields are extracted from canonical message text (or structured JSON) without uncontrolled prose scanning.

- Direct field lookup: e.g. `current_scene` extracts `<uuid>` from `current_scene: <uuid>; status OPEN`.
- Nested field lookup: e.g. `active_arc.owner` matches root line `active_arc:` and extracts the value of `owner <uuid>`.
- Reverse-chronological evaluation: Later corrective messages supersede earlier facts on the active branch timeline.
- Validation: Extracted strings are validated against exact conversation ID patterns (UUID or 64-char hex). Malformed values fail validation.

### 2. Tenant and namespace isolation

Pointer targets are resolved from D1 with strict tenant isolation (`user_id = tenant.userId`) and namespace scoping. Callers cannot traverse into or discover conversations belonging to other accounts or inaccessible namespaces.

### 3. Cycle and duplicate protection

A visited set and a maximum recursion depth of 5 prevent infinite loops and duplicate sections for cyclic or repeated pointer references (e.g. A -> B -> A).

### 4. Revision pinning and provenance

Every expanded conversation is pinned in `revision_pins`. Sections and message provenance record `kind: "expanded_required"` along with `source_conversation_id`, `source_revision_id`, and `pointer`.

### 5. Priority and budget preservation

Explicit required sections are sorted first, followed by expanded required sections. Both precede retrieved evidence. Optional hybrid retrieval runs strictly after deterministic required expansion and can never evict required or expanded content. If required plus expanded content exceeds response limits, the request fails explicitly with `required_budget_exceeded`.

## Consequences

### Positive

- **Deterministic runtime assembly**: Structured state like `CURRENT` -> `current_scene` -> `active_arc` expands without client-side round trips or semantic inaccuracy.
- **Zero stale pollution**: Exact conversation IDs are resolved directly without semantic search interference.
- **Full reproducibility**: Revision pins and provenance ensure all expanded dependencies remain reproducible.
