# ADR 0029: Bundled graph library for the dashboard memory map

- Status: Accepted
- Date: 2026-09-16

## Context

`/dashboard/mindmap` renders an organizational account → namespace → conversation → tag view. Its
hand-written inline SVG had manual layout, manual pan/zoom, and flat monochrome nodes. The owner
asked for a more beautiful map built on a package library, scoped to `/dashboard/mindmap`. Home
pages, OAuth pages, and any future billing work are out of scope.

Repository constraints that shape the choice:

- Yarn only; strict TypeScript; Cloudflare Workers runtime; no `any`.
- Dashboard CSP is nonce-only for scripts and styles, with `connect-src 'self'` and `img-src data:`.
  Existing tests assert that no CDN host appears in HTML or CSP.
- The main `tsconfig.json` compiles against the Workers runtime (`WebWorker` lib, no DOM), so
  browser-only DOM code cannot live in `src/**` without polluting Worker types.
- `GET /dashboard/mindmap/data` remains the only data contract, and the accessible nested list must
  stay for screen readers, keyboard users, and no-JS clients.

## Decision

Use Cytoscape.js (installed with Yarn, pinned) as the rendering and layout engine for the map.

Browser code lives in its own strict TypeScript project at `web/mindmap/` with a dedicated
`web/mindmap/tsconfig.json` (`lib: ES2023, DOM, DOM.Iterable`, same strictness switches) and a
`yarn typecheck:web` gate. `src/**` stays DOM-free.

`yarn build:mindmap` bundles `web/mindmap/client.ts` with esbuild (minified IIFE, browser platform)
and writes the base64 bundle plus a SHA-256 source fingerprint into the generated
`src/mindmap-bundle.ts`. `src/dashboard.ts` inlines that bundle inside the existing
`<script nonce="…">` tag, so the CSP keeps `default-src 'none'` and never needs an external script
host. `yarn check:mindmap` and `tests/mindmap.test.ts` fail when the checked-in bundle is stale.

The map renders the same account → namespace → conversation hierarchy with a curated warm-monochrome
Cytoscape stylesheet that matches `src/ui.ts` tokens, plus pan/zoom, collapse/expand, search,
pagination, a hover/tap detail panel, and reduced-motion-aware transitions. Storage titles, tags, and
namespaces are only ever written through `textContent`, and the server-rendered accessible
`tree-list` is unchanged.

## Rejected alternatives

- CDN-hosted graph libraries: widen CSP to third-party hosts, contradict existing no-CDN assertions,
  and leak page loads. Rejected.
- `@xyflow/react` with React: React + ReactDOM + a hydration runtime for one page, and it does not
  fit the current nonce-inline-string presentation without a larger frontend migration. Rejected for
  this scope; a full React frontend remains a separate, undecided decision.
- Apache ECharts bundled locally: viable, but heavier for a collapse/pan hierarchy and less direct
  for node-tap navigation. Revisit only with an explicit radial-chart requirement and its own budget.
- Restyling the existing dependency-free SVG: cannot reach the requested packaged-library layout and
  interaction quality without reimplementing that library.
- Moving the map into the `src/**` tsconfig: would force DOM types into Worker compilation. Rejected.

## Consequences

- New runtime dependency `cytoscape` and generated artifact `src/mindmap-bundle.ts` (excluded from
  Prettier and ESLint because it is machine-generated). `/dashboard/mindmap` HTML grows by roughly
  the minified bundle size; no other route changes.
- New commands: `yarn typecheck:web`, `yarn build:mindmap`, `yarn check:mindmap`; `yarn verify` runs
  the first and third.
- Client behaviour is unit-tested through the pure `buildMindmapGraph` function, and the page is
  covered by Workers integration assertions for CSP, no external hosts, escaping, and the accessible
  tree.
- No migration, binding change, canonical storage change, indexing change, or remote provisioning.
- This decision does not approve React, Pages/Worker separation, containers, billing tables, or
  webhook handlers. Those need their own ADR.
