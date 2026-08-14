# 0009: Bounded recent-canonical retrieval fallback

- Status: Accepted

## Context

Canonical writes are durable before asynchronous FTS and Vectorize indexing completes. Immediate search could therefore miss a newly stored revision even though R2 and D1 already contained the authoritative memory.

## Decision

Track revision indexing as `queued`, `processing`, `indexed`, or `failed`. Search the existing FTS and Vectorize channels alongside a bounded D1-selected set of recent current revisions that are not indexed. Read only those canonical R2 revisions, score recent active messages with phrase and term overlap, and merge by the same deterministic chunk IDs used by indexing.

The fallback defaults to 8 revisions, 24 hours, and 200 active messages. Namespace, deletion state, active generation, and `current_revision_id` are enforced before R2 reads and revalidated before ranking.

## Consequences

Clients gain practical read-after-write search consistency without synchronous embeddings. Index failures do not make recent canonical memory disappear, channel failures remain explicit, and races cannot duplicate a logical chunk. Persisted chunk, embedding, and indexed-only ranking output is unchanged, so no index-generation bump is required.

One canonical revision is currently one R2 segment, so a selected revision is loaded as a whole even though only its recent active messages are scored. Add byte-range metadata only if measured large-revision costs justify a canonical format evolution.

## Alternatives

Synchronous indexing was rejected because it couples durable writes to Workers AI and Vectorize latency. Scanning R2 or all revisions was rejected as unbounded. A second semantic index and an indexing-status API were deferred because the existing queue/job operations and lightweight bridge cover the consistency gap.
