import cytoscape from "cytoscape";
import type { EdgeDefinition, ElementAnimateOptionsBase, NodeDefinition } from "cytoscape";
import {
  buildCountDotEdge,
  buildCountDotNode,
  buildMindmapGraph,
  buildMoreEdge,
  buildMoreNode,
} from "./graph";
import { hideMindmapTooltip, showMindmapTooltip } from "./tooltip";
import type { MindmapClientConversation, MindmapClientCopy, MindmapClientPayload } from "./types";

declare global {
  interface Window {
    __mempersistMindmap?: MindmapClientCopy;
  }
}

interface GraphNodeTarget {
  data: (field: string) => string;
}

interface GraphEvent {
  target: GraphNodeTarget;
  originalEvent?: MouseEvent;
}

interface GraphPointerEvent extends GraphEvent {
  renderedPosition: { x: number; y: number };
}

type MindmapElementDefinition = NodeDefinition | EdgeDefinition;

/** Cytoscape accepts parameterized easings such as `spring(tension, friction)`; its typings list keywords only. */
const SPRING_ANIMATION = { duration: 460, easing: "spring(250, 20)" } as ElementAnimateOptionsBase;
const FADE_ANIMATION = { duration: 500, easing: "ease-out-cubic" } as const;
const EXIT_ANIMATION = { duration: 220, easing: "ease-out-cubic" } as const;
const EXIT_DURATION = 240;
/** Count dot text renders in JetBrains Mono at 9px: 0.6em advance, plus a 12px inset. */
const BADGE_ADVANCE = 9 * 0.6;
const BADGE_INSET = 12;

const REQUIRED_COPY_KEYS: ReadonlyArray<keyof MindmapClientCopy> = [
  "accountLabel",
  "conversationsLabel",
  "emptyLabel",
  "failedLabel",
  "loadingLabel",
  "messagesLabel",
  "moreLabel",
  "zoomInLabel",
  "zoomOutLabel",
];

const ACCOUNT_STYLE = {
  shape: "ellipse",
  width: 86,
  height: 86,
  "background-color": "#42634a",
  "border-color": "#c2d9b5",
  "border-width": 3,
  color: "#fffefa",
  "font-size": "12px",
  "text-valign": "center",
  "text-margin-y": 0,
} as const;

const NAMESPACE_STYLE = {
  shape: "ellipse",
  width: 58,
  height: 58,
  "background-color": "#b9d2aa",
  "border-color": "#7e9f70",
  "border-width": 2,
  color: "#dce8d5",
  "font-size": "10px",
  "text-valign": "bottom",
  "text-margin-y": 12,
} as const;

const CONVERSATION_STYLE = {
  shape: "ellipse",
  width: 24,
  height: 24,
  "background-color": "#eef3e8",
  "border-color": "#9eaf9a",
  "border-width": 1.5,
  color: "#dce8d5",
  "font-size": "10px",
  "text-valign": "bottom",
  "text-margin-y": 9,
} as const;

const MESSAGES_STYLE = {
  shape: "round-rectangle",
  width: "label",
  height: 18,
  "background-color": "#e9eee4",
  "border-color": "#42634a",
  "border-width": 1,
  color: "#42634a",
  "font-size": "9px",
  "text-valign": "center",
  "text-halign": "center",
  "text-margin-y": 0,
  "text-wrap": "none",
} as const;

const MORE_STYLE = {
  shape: "ellipse",
  width: 30,
  height: 30,
  "background-color": "#f4f3ec",
  "border-color": "#a9aba1",
  "border-width": 1,
  "border-style": "dashed",
  color: "#dce8d5",
  "font-size": "9px",
  "text-valign": "bottom",
  "text-margin-y": 10,
} as const;

function readCopy(): MindmapClientCopy | null {
  const copy = window.__mempersistMindmap;
  if (!copy) return null;
  for (const key of REQUIRED_COPY_KEYS) {
    if (typeof copy[key] !== "string") return null;
  }
  return copy;
}

function requireElement<T extends Element>(selector: string, type: new () => T): T {
  const element = document.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`mindmap element missing: ${selector}`);
  return element;
}

function requireCopy(): MindmapClientCopy {
  const copy = readCopy();
  if (!copy) throw new Error("mindmap copy missing");
  return copy;
}

function init(): void {
  const copy = requireCopy();
  const container = requireElement("#memory-map", HTMLElement);
  const viewport = requireElement("#map-viewport", HTMLElement);
  const tooltip = requireElement("#map-tooltip", HTMLElement);
  const status = requireElement("#map-status", HTMLParagraphElement);
  const form = requireElement("#map-search", HTMLFormElement);
  const queryInput = requireElement("#map-query", HTMLInputElement);
  const listToggle = requireElement("#map-list-toggle", HTMLButtonElement);
  const list = requireElement("#map-list", HTMLElement);
  const collapseAll = requireElement("#map-collapse-all", HTMLButtonElement);
  const expandAll = requireElement("#map-expand-all", HTMLButtonElement);
  const resetView = requireElement("#map-reset-view", HTMLButtonElement);
  const zoomIn = requireElement("#map-zoom-in", HTMLButtonElement);
  const zoomOut = requireElement("#map-zoom-out", HTMLButtonElement);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  zoomIn.setAttribute("aria-label", copy.zoomInLabel);
  zoomOut.setAttribute("aria-label", copy.zoomOutLabel);

  const cy = cytoscape({
    container,
    wheelSensitivity: 0.24,
    minZoom: 0.35,
    maxZoom: 2.5,
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "font-family": "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          "font-size": "11px",
          color: "#dce8d5",
          "text-wrap": "ellipsis",
          "text-max-width": "170px",
          "text-valign": "bottom",
          "text-halign": "center",
          "text-margin-y": 12,
          "min-zoomed-font-size": 8,
          "border-width": 1.5,
          "overlay-opacity": 0,
        },
      },
      { selector: "node[kind = 'account']", style: ACCOUNT_STYLE },
      { selector: "node[kind = 'namespace']", style: NAMESPACE_STYLE },
      { selector: "node[kind = 'conversation']", style: CONVERSATION_STYLE },
      { selector: "node[kind = 'messages']", style: MESSAGES_STYLE },
      { selector: "node[kind = 'more']", style: MORE_STYLE },
      {
        selector: "node:selected",
        style: { "background-color": "#94b985", "border-color": "#e0f0d8", "border-width": 3 },
      },
      {
        selector: "edge",
        style: {
          width: 1.1,
          "line-color": "#728371",
          "curve-style": "bezier",
          opacity: 0.62,
        },
      },
    ],
  });

  /** Namespace list from the last payload; conversations of expanded namespaces live in `cache`. */
  let namespaces: MindmapClientPayload["namespaces"] = [];
  const cache = new Map<string, MindmapClientConversation[]>();
  const cursors = new Map<string, string | null>();
  const loaded = new Set<string>();
  const expanded = new Set<string>();
  const revealed = new Set<string>();
  const byId = new Map<string, MindmapClientConversation>();
  const initialQuery = new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
  let query = initialQuery;
  let pending = 0;
  let failed = false;
  queryInput.value = initialQuery;

  function updateStatus(): void {
    if (pending > 0) {
      status.textContent = copy.loadingLabel;
      return;
    }
    if (failed) {
      status.textContent = copy.failedLabel;
      return;
    }
    const total = namespaces.reduce((sum, entry) => sum + entry.conversations, 0);
    status.textContent =
      total > 0 ? `${String(total)} ${copy.conversationsLabel.toLowerCase()}` : copy.emptyLabel;
  }

  async function run(task: () => Promise<void>): Promise<boolean> {
    pending += 1;
    updateStatus();
    try {
      await task();
      failed = false;
      return true;
    } catch {
      failed = true;
      return false;
    } finally {
      pending -= 1;
      updateStatus();
    }
  }

  function pageParams(namespace: string, cursor: string | null): Record<string, string> {
    const params: Record<string, string> = { namespace, limit: "50" };
    if (cursor) params.cursor = cursor;
    if (query) params.q = query;
    return params;
  }

  async function fetchPage(params: Record<string, string>): Promise<MindmapClientPayload> {
    const search = new URLSearchParams(params);
    const response = await fetch(`/dashboard/mindmap/data?${search.toString()}`);
    if (!response.ok) throw new Error(`map request failed: ${String(response.status)}`);
    return (await response.json()) as MindmapClientPayload;
  }

  function adoptNamespaces(payload: MindmapClientPayload): void {
    namespaces = payload.namespaces;
    const known = new Set(namespaces.map((entry) => entry.namespace));
    for (const namespace of [...expanded]) {
      if (!known.has(namespace)) expanded.delete(namespace);
    }
  }

  function indexRows(): void {
    byId.clear();
    for (const rows of cache.values()) {
      for (const row of rows) byId.set(row.id, row);
    }
  }

  function conversationNodeId(conversationId: string): string {
    return `conversation:${conversationId}`;
  }

  /** Account, every namespace, the conversations of expanded namespaces, plus their satellites. */
  function desiredElements(): MindmapElementDefinition[] {
    const known = new Set(namespaces.map((entry) => entry.namespace));
    const rows: MindmapClientConversation[] = [];
    for (const namespace of expanded) {
      if (!known.has(namespace)) continue;
      for (const row of cache.get(namespace) ?? []) rows.push(row);
    }
    const graph = buildMindmapGraph(copy.accountLabel, namespaces, rows);
    const nodes: NodeDefinition[] = [...graph.nodes];
    const edges: EdgeDefinition[] = [...graph.edges];
    for (const row of rows) {
      if (!revealed.has(row.id)) continue;
      const label = `${String(row.messages)} ${copy.messagesLabel}`;
      nodes.push(buildCountDotNode(row.id, row.messages, label));
      edges.push(buildCountDotEdge(row.id));
    }
    for (const namespace of expanded) {
      if (!known.has(namespace)) continue;
      // A search loads a single page for every match, and `namespaces[].conversations` counts
      // the whole namespace, so a paging node there would promise page 2 of a filtered list.
      if (query) continue;
      const cursor = cursors.get(namespace) ?? null;
      const total = namespaces.find((entry) => entry.namespace === namespace)?.conversations ?? 0;
      const remaining = total - (cache.get(namespace)?.length ?? 0);
      if (cursor === null || remaining <= 0) continue;
      nodes.push(buildMoreNode(namespace, remaining, copy.moreLabel));
      edges.push(buildMoreEdge(namespace));
    }
    return [...nodes, ...edges];
  }

  function runLayout(): void {
    cy.layout({
      name: "cose",
      animate: !reducedMotion,
      animationDuration: 520,
      animationEasing: "ease-out-cubic",
      // Satellites are laid out too, so `fit` always keeps them reachable; they hug their source.
      idealEdgeLength: (edge) => {
        const kind = (edge.target() as GraphNodeTarget).data("kind");
        if (kind === "messages") return 44;
        if (kind === "more") return 74;
        return 120;
      },
      nodeRepulsion: (node) => {
        const kind = (node as GraphNodeTarget).data("kind");
        return kind === "messages" || kind === "more" ? 1800 : 7200;
      },
      edgeElasticity: 110,
      gravity: 0.55,
      numIter: 600,
      componentSpacing: 100,
      padding: 64,
      fit: true,
    }).run();
  }

  function animateEntering(ids: readonly string[]): void {
    for (const id of ids) {
      const node = cy.getElementById(id);
      if (node.empty() || !node.isNode()) continue;
      if (!id.startsWith("messages:")) {
        if (reducedMotion) continue;
        node.style({ opacity: 0 });
        node.animate({ style: { opacity: 1 } }, FADE_ANIMATION);
        continue;
      }
      const row = byId.get(id.slice("messages:".length));
      const source = cy.getElementById(conversationNodeId(id.slice("messages:".length)));
      if (!row || source.empty()) continue;
      const anchor = source.position();
      node.position({ x: anchor.x + 30, y: anchor.y - 18 });
      const label = `${String(row.messages)} ${copy.messagesLabel}`;
      const width = Math.max(24, Math.round(label.length * BADGE_ADVANCE) + BADGE_INSET);
      node.style({ opacity: reducedMotion ? 1 : 0, width: reducedMotion ? width : 6 });
      if (!reducedMotion) node.animate({ style: { opacity: 1, width } }, SPRING_ANIMATION);
    }
  }

  function syncGraph(layout: boolean, entering: readonly string[] = []): void {
    indexRows();
    const desired = desiredElements();
    const wanted = new Set(desired.map((definition) => String(definition.data.id ?? "")));
    cy.batch(() => {
      cy.elements().forEach((element) => {
        if (!wanted.has(element.id())) element.remove();
      });
      for (const definition of desired) {
        const id = String(definition.data.id ?? "");
        if (id && cy.getElementById(id).empty()) cy.add(definition);
      }
    });
    animateEntering(entering);
    if (layout) runLayout();
    updateStatus();
  }

  async function refresh(): Promise<void> {
    cache.clear();
    cursors.clear();
    loaded.clear();
    expanded.clear();
    revealed.clear();
    byId.clear();
    await run(async () => {
      if (!query) {
        const payload = await fetchPage({ limit: "1" });
        adoptNamespaces(payload);
        return;
      }
      // Search: one page seeds and auto-expands every namespace it belongs to. The global cursor
      // still works per namespace because conversations are ordered by id.
      const payload = await fetchPage({ limit: "50", q: query });
      adoptNamespaces(payload);
      for (const row of payload.conversations) {
        const rows = cache.get(row.namespace) ?? [];
        rows.push(row);
        cache.set(row.namespace, rows);
        expanded.add(row.namespace);
        loaded.add(row.namespace);
      }
      for (const namespace of expanded) cursors.set(namespace, payload.nextCursor);
    });
    syncGraph(true);
  }

  async function expandNamespace(namespace: string): Promise<void> {
    expanded.add(namespace);
    if (loaded.has(namespace)) {
      const nodeIds = (cache.get(namespace) ?? []).map((row) => conversationNodeId(row.id));
      syncGraph(true, nodeIds);
      return;
    }
    let entering: string[] = [];
    const ok = await run(async () => {
      const payload = await fetchPage(pageParams(namespace, null));
      cache.set(namespace, payload.conversations);
      loaded.add(namespace);
      cursors.set(namespace, payload.nextCursor);
      adoptNamespaces(payload);
      entering = payload.conversations.map((row) => conversationNodeId(row.id));
    });
    if (!ok) expanded.delete(namespace);
    syncGraph(true, entering);
  }

  function toggleNamespace(namespace: string): void {
    if (expanded.delete(namespace)) {
      syncGraph(true);
      return;
    }
    void expandNamespace(namespace);
  }

  async function loadMore(namespace: string): Promise<void> {
    const cursor = cursors.get(namespace) ?? null;
    if (cursor === null) return;
    let entering: string[] = [];
    await run(async () => {
      const payload = await fetchPage(pageParams(namespace, cursor));
      const rows = cache.get(namespace) ?? [];
      const known = new Set(rows.map((row) => row.id));
      const added = payload.conversations.filter((row) => !known.has(row.id));
      rows.push(...added);
      cache.set(namespace, rows);
      cursors.set(namespace, payload.nextCursor);
      adoptNamespaces(payload);
      entering = added.map((row) => conversationNodeId(row.id));
    });
    syncGraph(true, entering);
  }

  async function expandEveryNamespace(): Promise<void> {
    const targets = namespaces.filter((entry) => !expanded.has(entry.namespace));
    if (targets.length === 0) return;
    for (const entry of targets) expanded.add(entry.namespace);
    const entering: string[] = [];
    const ok = await run(async () => {
      await Promise.all(
        targets.map(async (entry) => {
          if (loaded.has(entry.namespace)) {
            const cached = cache.get(entry.namespace) ?? [];
            entering.push(...cached.map((row) => conversationNodeId(row.id)));
            return;
          }
          const payload = await fetchPage(pageParams(entry.namespace, null));
          cache.set(entry.namespace, payload.conversations);
          loaded.add(entry.namespace);
          cursors.set(entry.namespace, payload.nextCursor);
          adoptNamespaces(payload);
          entering.push(...payload.conversations.map((row) => conversationNodeId(row.id)));
        }),
      );
    });
    if (!ok) {
      for (const entry of targets) {
        if (!loaded.has(entry.namespace)) expanded.delete(entry.namespace);
      }
    }
    syncGraph(true, entering);
  }

  function hideCountDot(conversationId: string): void {
    const node = cy.getElementById(`messages:${conversationId}`);
    if (node.empty() || reducedMotion) {
      syncGraph(false);
      return;
    }
    node.animate({ style: { opacity: 0, width: 6 } }, EXIT_ANIMATION);
    node.connectedEdges().animate({ style: { opacity: 0 } }, EXIT_ANIMATION);
    window.setTimeout(() => {
      syncGraph(false);
    }, EXIT_DURATION);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    query = queryInput.value.trim();
    void refresh();
  });
  listToggle.addEventListener("click", () => {
    list.hidden = !list.hidden;
    listToggle.setAttribute("aria-expanded", String(!list.hidden));
  });
  collapseAll.addEventListener("click", () => {
    if (expanded.size === 0) return;
    expanded.clear();
    syncGraph(true);
  });
  expandAll.addEventListener("click", () => {
    void expandEveryNamespace();
  });
  resetView.addEventListener("click", () => {
    cy.zoom(1);
    cy.center();
  });
  zoomIn.addEventListener("click", () => {
    cy.zoom({
      level: cy.zoom() * 1.15,
      renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 },
    });
  });
  zoomOut.addEventListener("click", () => {
    cy.zoom({
      level: cy.zoom() * 0.87,
      renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 },
    });
  });
  window.addEventListener("resize", () => {
    cy.resize();
  });
  cy.on("tap", "node[kind = 'account']", () => {
    if (expanded.size === 0) return;
    expanded.clear();
    syncGraph(true);
  });
  cy.on("tap", "node[kind = 'namespace']", (event: GraphEvent) => {
    const namespace = event.target.data("namespace");
    if (namespace) toggleNamespace(namespace);
  });
  cy.on("tap", "node[kind = 'more']", (event: GraphEvent) => {
    const namespace = event.target.data("namespace");
    if (namespace) void loadMore(namespace);
  });
  cy.on("tap", "node[kind = 'conversation']", (event: GraphEvent) => {
    if (event.originalEvent && event.originalEvent.detail > 1) return;
    const conversationId = event.target.data("conversationId");
    if (!conversationId) return;
    if (revealed.delete(conversationId)) {
      hideCountDot(conversationId);
      return;
    }
    revealed.add(conversationId);
    syncGraph(false, [`messages:${conversationId}`]);
  });
  cy.on("dbltap", "node[kind = 'conversation']", (event: GraphEvent) => {
    const conversationId = event.target.data("conversationId");
    if (conversationId) {
      window.location.assign(`/dashboard/conversations/${encodeURIComponent(conversationId)}`);
    }
  });
  cy.on("mousemove", "node[kind = 'conversation']", (event: GraphPointerEvent) => {
    const item = byId.get(event.target.data("conversationId"));
    if (item) {
      showMindmapTooltip(
        tooltip,
        viewport,
        item,
        event.renderedPosition.x,
        event.renderedPosition.y,
        copy.messagesLabel,
      );
    }
  });
  cy.on("mouseout", "node[kind = 'conversation']", () => {
    hideMindmapTooltip(tooltip);
  });

  void refresh();
}

init();
