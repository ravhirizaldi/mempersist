# ADR 0028: Passwordless dashboard, export, and leased deletion jobs

- Status: Accepted
- Date: 2026-09-16

## Context

Users need a browser view of their own archive, a portable current-state export, and recoverable
destructive controls. The service already has passwordless email, D1 identity/catalog data,
canonical R2 revisions, OAuth grants in KV, bounded erasure, and Queues. Adding a frontend runtime,
new identity system, Workflow, or another Cloudflare resource would duplicate those capabilities.

## Decision

The dashboard is bilingual, server-rendered HTML from the existing Worker. It reuses the shared
visual foundation and has no frontend dependency. Browser magic links and sessions have separate
D1 tables from OAuth challenges. Only hashes are stored; sessions last 30 days in a secure
host-only cookie. Same-origin checks plus a session-derived token protect every authenticated form.

The memory map is deterministic account → namespace → conversation → tag organization. Its inline
SVG is progressively enhanced with DOM-created nodes; an ordinary nested list carries the same
content. Conversation pagination pins a revision. The streamed `mempersist.account-export.v1`
format contains only current canonical conversations plus profile, namespace, and live tag data.
Historical revisions, disposable indexes, and original imports are excluded from export.

Destructive work uses a new, separately leased `deletion_jobs` table and sends only its job ID to
the existing import queue. Namespace jobs lock writes, invoke the existing bounded canonical and
derived cleanup repeatedly, preserve the namespace row, then unlock it. Account jobs immediately
make the account read-only, wait exactly seven days, revoke paginated OAuth grants, delete bounded
conversation and raw-import batches, then remove challenges, sessions, namespaces, and the user.
Jobs are idempotent under duplicate delivery. Failed jobs retain their lock/read-only state.

Cloudflare Queue send/retry delay is capped at 24 hours, so future account jobs re-enqueue in hops
of at most 86,400 seconds until due:
<https://developers.cloudflare.com/queues/platform/limits/>.

## Consequences

- Existing OAuth PKCE, owner aliases, MCP tools, bearer-token access, D1/R2 bindings, and queue
  resources remain compatible.
- A code rollback does not remove migration 0009 or its pending deletion jobs. Operators must
  re-enqueue pending job IDs after deploying compatible code.
- Account export is portable and lossless for current canonical memory, but is intentionally not a
  full legal/forensic dump of history or source uploads.
- No dashboard write, semantic mind-map generation, bulk restore UI, or new scheduler is added.
