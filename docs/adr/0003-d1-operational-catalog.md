# 0003: D1 is the operational catalog

- Status: Accepted

## Context

Imports, pointers, jobs, graph metadata, source ranges, and exact lexical search need relational querying and migrations.

## Decision

Use one D1 database for operational metadata and disposable FTS5 text. Never make it the sole transcript archive. Manage all changes with numbered SQL migrations and `STRICT` tables.

## Consequences

D1 stays queryable and simple for personal V1. FTS virtual tables affect export procedures, so recovery documentation must account for them.

## Alternatives

KV lacks relational/FTS behavior. An external SQL service adds networking and operational complexity. An ORM adds little over the small explicit SQL surface.
