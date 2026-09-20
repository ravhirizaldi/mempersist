# Dashboard

`/login` provides the same passwordless email-possession onboarding as MCP OAuth without sharing
OAuth grants or browser sessions. The one-use link creates an unknown account only when consumed.
Dashboard challenges and 30-day sessions are stored in D1 by SHA-256 hash; the raw session exists
only in the `Secure`, `HttpOnly`, `SameSite=Lax`, host-only cookie.

The server-rendered `/dashboard` shows profile and archive totals in a compact two-column
layout: profile and the collapsed danger zone on the side, namespaces and recent
conversations in the main column. Namespaces link to `/dashboard/namespaces/:namespace`
to browse all conversations within that namespace ordered by recency, with pagination and
namespace emptying controls. Conversation pages include back links to both the overview
and their parent namespace. Per-namespace emptying and account deletion stay behind
collapsed native disclosures so the overview fits roughly one viewport. Session pages include
a responsive CSS-only hamburger menu under 720px. `/dashboard/mindmap` is an
organizational account → namespace → conversation → tag view, not a semantic or AI-generated map.
Its interactive view is Cytoscape.js, bundled locally and inlined behind the existing script nonce,
with an accessible nested-list equivalent that carries the same content. Conversation pages pin
pagination to the revision loaded on the first page.

Conversation tags link to the memory map with that tag prefilled in the title-and-tag filter.
`/dashboard/export` streams `mempersist.account-export.v1`. It contains the profile, namespace
catalog, live tags, and every complete current canonical conversation, including canonical
metadata and raw node fields. It excludes historical revisions, derived indexes, and original
ChatGPT upload objects.

All dashboard mutations require a same-origin request and a token derived from the active browser
session. The literal `Origin: null` header sent by browsers for opaque-origin navigations (privacy
mode, DNT, extensions) carries no origin signal, so it falls through to `Referer` and
`Sec-Fetch-Site: same-origin` instead of failing outright. A present but mismatched origin still
fails closed. Form failures served to browsers return the dashboard error page rather than raw
JSON. Display names are NFKC-normalized, trimmed, and limited to 1–80 characters. Stored titles,
messages, tags, and names are escaped before server rendering; the memory map writes stored values
through `textContent` only and loads no external script or style host.

The memory map's browser code lives in its own strict TypeScript project (`web/mindmap/`) and is
bundled by `yarn build:mindmap` into the generated `src/mindmap-bundle.ts`. Run `yarn typecheck:web`
after editing it, and `yarn check:mindmap` (part of `yarn verify`) fails when the checked-in bundle
no longer matches the sources. Prettier and ESLint skip the generated file.

Namespace emptying is asynchronous and preserves the namespace record. Account deletion creates a
seven-day grace period: reads, export, logout, and cancellation remain available, while writes
return `409 DELETION_PENDING`. Cancellation succeeds only while the account deletion job is still
pending.
