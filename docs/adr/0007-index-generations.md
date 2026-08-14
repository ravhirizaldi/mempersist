# 0007: Versioned disposable index generations

- Status: Accepted

## Context

Embedding models, dimensions, chunking, ranking, and Vectorize indexes will change while canonical IDs must remain stable.

## Decision

Record generation, chunk strategy, model, dimensions, revision hash, vector ID, status, and timestamps from V1. Deterministic rebuilds read canonical R2. Use one active binding now and temporary dual bindings for future blue/green migration.

## Consequences

Reindex and model migration do not require re-upload. Derived D1 rows can coexist by generation. Operators must create a new Vectorize index when dimensions/metric change.

## Alternatives

An unversioned mutable index was rejected because it cannot be audited or migrated safely. Permanent multiple active indexes were deferred as needless personal-V1 cost and configuration.
