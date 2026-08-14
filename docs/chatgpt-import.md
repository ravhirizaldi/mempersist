# ChatGPT import

V1 accepts the native `conversations.json` file extracted from a ChatGPT data-export ZIP. The ZIP format and conversation fields can evolve, so input is untrusted and unknown fields are preserved in raw source nodes.

## Guarantees

- The uploaded file bytes are stored unchanged under `raw/imports/<import-id>/source/`.
- The completed object is SHA-256 hashed server-side.
- Exact duplicate checksums are marked `duplicate` and do not reprocess history.
- Source conversation/node IDs, parent-child edges, `current_node`, active path, alternate branches, timestamps, roles, content, model metadata, and raw unknown node fields remain recoverable.
- Newer exports reuse the same internal conversation ID and unchanged deterministic revisions; changed content/branch state creates a preserved revision.
- One queue turn processes 25 conversations. Ordinal checkpoints and deterministic writes make retry safe.

## Upload

The CLI uses a direct stream up to 16 MiB and R2 multipart upload above it. Multipart uses 16 MiB parts, below R2's maximum and above its non-final minimum. Network interruption can resume by re-uploading a known part; completed part ETags live in D1.

```bash
MEMPERSIST_URL=https://example.workers.dev \
MEMPERSIST_TOKEN='...' \
yarn import:chatgpt ./conversations.json
```

The streaming JSON scanner does not hold the full export in Worker memory. One unusually huge conversation is capped at 32 MiB and recorded as a parser failure rather than truncating content. Retry currently re-scans earlier file bytes to reach the checkpoint but skips committed ordinals; add persisted byte offsets only if scan cost becomes material.

Graph anomalies such as missing current nodes, cycles, and dangling parents are recorded on canonical revisions. A missing `current_node` selects a deterministic leaf for default retrieval without deleting any branch.
