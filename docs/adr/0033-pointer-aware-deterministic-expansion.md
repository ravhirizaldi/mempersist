# ADR 0033: Pointer-aware deterministic expansion

- Status: Accepted
- Date: 2026-09-20

## Context

ADR 0032 established deterministic context pack compilation and revision pinning for `memory_build_context`.
During surrounding message retrieval around search chunk hits, messages on the active timeline are expanded
linearly using their active sequence indices.

However, chunks originating from alternate conversation branches do not reside on the active sequence timeline.
The initial fallback implementation had significant deficiencies:

1. **Incomplete surrounding context**: It performed a static 1-hop parent/child node lookup, ignoring caller-specified `context_before` and `context_after` counts.
2. **Sibling branch fanout**: Slicing child pointers by graph depth fanned out across all children at fork junctions, violating the MCP contract specifying linear surrounding message counts and leaking unrelated sibling branches.
3. **Engine divergence**: Separate ad-hoc fallbacks existed in `src/retrieval.ts` (`getChunkContext`) and `src/context.ts` (`buildContext`), risking behavioral inconsistency.
4. **Dropped alternate nodes**: Chunks spanning both a branch junction node and an alternate node were misclassified as fully active, causing the alternate node to be omitted when slicing the active array.

A unified, pointer-aware expansion mechanism is required that reconstructs the exact linear branch timeline and slices deterministically by message count.

## Decision

### 1. Branch key selection from D1 catalog

D1 chunk queries in both `getChunkContext` (`src/retrieval.ts`) and `buildContext` (`src/context.ts`) explicitly select `c.branch_key`:

- For active timeline chunks, `branch_key` is `"active"`.
- For alternate branch chunks, `branch_key` is formatted as `"alternate:<leafSourceNodeId>"`, encoding the specific leaf node of that branch.

### 2. Linear branch path reconstruction and message-count slicing

We introduce `expandPointerNeighborhood` in `src/retrieval.ts` and share it across `getChunkContext` and `buildContext`:

```ts
export function expandPointerNeighborhood(
  conversation: CanonicalConversation,
  sourceNodeIds: string[],
  before: number,
  after: number,
  branchKey?: string,
): CanonicalNode[];
```

1. **Alternate branch reconstruction**: When `branchKey` starts with `"alternate:"`, the engine loads the leaf node and traverses `parentSourceNodeId` pointers upwards to the root, constructing an unambiguous, linear sequence of nodes for that exact branch.
2. **Active branch reconstruction**: When `branchKey` is `"active"`, the linear sequence is formed by `activeSourceNodeIds`.
3. **Exact message count slicing**: The engine identifies the positions of matched `sourceNodeIds` within the reconstructed linear branch and slices:
   - `start = Math.max(0, Math.min(...indices) - before)`
   - `end = Math.min(branchNodes.length, Math.max(...indices) + after + 1)`
4. **Sibling branch exclusion**: Because the reconstructed timeline traces strictly from root to the specified branch leaf, expanding `after` messages follows only descendants on that path. Sibling forks and alternate children are never included.
5. **Junction chunk safety**: Chunks containing alternate branch nodes are only routed to the active sequence slice if every source node resides on the active timeline (`activeSequences.length === rows.length && activeSequences.length > 0`). If any source node is off-active, the engine routes through `expandPointerNeighborhood`.

### 3. Builder version bump

Because deterministic context pack identity incorporates the builder version:

$$\text{pack\_id} = \text{domainId}(\text{"context-pack"}, \text{BUILDER\_VERSION}, \dots)$$

`BUILDER_VERSION` in `src/context.ts` is bumped from `"mempersist-context-pack-v1"` to `"mempersist-context-pack-v2"`. This ensures pack IDs for builds involving alternate branch expansion remain domain-separated from legacy v1 packs.

## Consequences

### Positive

- **Contract compliance**: `context_before` and `context_after` consistently mean message counts along the relevant timeline, whether active or alternate.
- **Strict fork isolation**: Sibling branches are excluded when expanding forward from a fork junction on an alternate branch.
- **Shared implementation**: `memory_get_context` and `memory_build_context` share identical deterministic branch reconstruction.
- **Deterministic pack identity**: Bumping `BUILDER_VERSION` to `v2` prevents hash collisions with legacy context packs.

### Negative / Trade-offs

- **Linear-only expansion**: Multi-branch graph tree structures are not emitted; callers wanting all branches simultaneously should request `branch: "all"` on required conversation selectors.
- **Path reconstruction cost**: Walking parent pointers from a leaf takes $O(\text{depth})$ per alternate chunk hit; path memoization is deferred until conversation depth warrants it.
