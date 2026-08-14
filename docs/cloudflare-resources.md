# Cloudflare resources

The checked-in configuration names resources but does not provision them. Do not reuse unrelated account resources.

| Resource   | Binding/name                             | Purpose                        | Recovery                                                            |
| ---------- | ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| Worker     | `mempersist`                             | HTTP, MCP, queue consumers     | Redeploy code/config                                                |
| D1         | `MEMORY_DB` / `mempersist-catalog`       | catalog, jobs, FTS             | restore/export catalog where possible; rebuild derived rows from R2 |
| R2         | `MEMORY_BUCKET` / `mempersist-memory`    | raw and canonical truth        | external/versioned backup; never treat indexes as backup            |
| KV         | `OAUTH_KV` / `mempersist-oauth`          | OAuth clients, grants, tokens  | reconnect clients; canonical memory is unaffected                   |
| Vectorize  | `MEMORY_VECTOR` / `mempersist-bge-m3-v1` | disposable 1024-d cosine index | rebuild from canonical R2                                           |
| Workers AI | `AI`                                     | BGE-M3 embeddings              | FTS-only degradation and retry                                      |
| Queue      | `IMPORT_QUEUE` / `mempersist-import`     | bounded import turns           | jobs/checkpoints in D1, retry                                       |
| Queue      | `INDEX_QUEUE` / `mempersist-index`       | chunk/embed/index work         | re-enqueue from revisions                                           |
| Queue      | `mempersist-dead-letter`                 | exhausted messages             | inspect job ID, correct cause, retry                                |

Provision only after explicit authorization:

```bash
yarn wrangler d1 create mempersist-catalog
yarn wrangler r2 bucket create mempersist-memory
yarn wrangler kv namespace create mempersist-oauth --binding OAUTH_KV
yarn wrangler vectorize create mempersist-bge-m3-v1 --dimensions=1024 --metric=cosine
yarn wrangler vectorize create-metadata-index mempersist-bge-m3-v1 --property-name=generation --type=string
yarn wrangler vectorize create-metadata-index mempersist-bge-m3-v1 --property-name=namespace --type=string
yarn wrangler vectorize create-metadata-index mempersist-bge-m3-v1 --property-name=source_type --type=string
yarn wrangler queues create mempersist-dead-letter
yarn wrangler queues create mempersist-import
yarn wrangler queues create mempersist-index
```

Add the real D1 and KV IDs printed by Wrangler to their matching bindings. Vectorize dimensions and metric are immutable; a model dimension change requires a new index. Metadata indexes must exist before relevant vectors are inserted.

Local D1/R2/KV/Queues are simulated. AI and Vectorize are remote in normal `yarn dev`; the test configuration omits them. R2 canonical data should eventually have an independent portable backup because accidental bucket deletion is not repaired by D1 or Vectorize. Losing OAuth KV disconnects clients but does not lose conversation memory.
