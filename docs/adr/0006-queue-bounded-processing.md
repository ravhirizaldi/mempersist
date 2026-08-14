# 0006: Queue-backed bounded processing

- Status: Accepted

## Context

Large exports and embedding batches cannot safely depend on one request or Worker lifetime.

## Decision

Use separate import and index Queues, job IDs as messages, D1 job leases/checkpoints, at-least-once idempotency, eight retries, and a shared DLQ. Process 25 conversations or 32 embeddings per bounded turn.

## Consequences

Work survives request termination and partial failures. Progress is observable in D1. A retry may re-scan bytes before the import checkpoint but does not redo committed conversations.

## Alternatives

Synchronous imports were rejected for memory/runtime limits. Workflows duplicate durable step state for a process already expressed by D1 checkpoints; add them only when multi-step waits or orchestration materially exceed Queues.
