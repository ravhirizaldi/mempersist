import cytoscape from "cytoscape";
import { buildMindmapGraph } from "./graph";
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
}

interface GraphPointerEvent extends GraphEvent {
  renderedPosition: { x: number; y: number };
}

const ACCOUNT_STYLE = {
  shape: "round-rectangle",
  width: 176,
  height: 50,
  "background-color": "#282a25",
  "border-color": "#282a25",
  color: "#fffefa",
} as const;

const NAMESPACE_STYLE = {
  shape: "round-rectangle",
  width: 190,
  height: 52,
  "background-color": "#e9eee4",
  "border-color": "#42634a",
  "border-width": 2,
} as const;

const CONVERSATION_STYLE = {
  shape: "round-rectangle",
  width: 186,
  height: 46,
  "background-color": "#fffefa",
  "border-color": "#bdc4b8",
} as const;

function readCopy(): MindmapClientCopy | null {
  const copy = window.__mempersistMindmap;
  if (!copy) return null;
  if (
    typeof copy.accountLabel !== "string" ||
    typeof copy.conversationsLabel !== "string" ||
    typeof copy.emptyLabel !== "string" ||
    typeof copy.failedLabel !== "string" ||
    typeof copy.loadingLabel !== "string"
  ) {
    return null;
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
  const container = requireElement("#memory-map", HTMLDivElement);
  const status = requireElement("#map-status", HTMLParagraphElement);
  const more = requireElement("#load-more", HTMLButtonElement);
  const form = requireElement("#map-search", HTMLFormElement);
  const queryInput = requireElement("#map-query", HTMLInputElement);
  const viewport = requireElement("#map-viewport", HTMLDivElement);
  const tooltip = requireElement("#map-tooltip", HTMLDivElement);
  const collapseAll = requireElement("#map-collapse-all", HTMLButtonElement);
  const expandAll = requireElement("#map-expand-all", HTMLButtonElement);
  const resetView = requireElement("#map-reset-view", HTMLButtonElement);
  const zoomIn = requireElement("#map-zoom-in", HTMLButtonElement);
  const zoomOut = requireElement("#map-zoom-out", HTMLButtonElement);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
          color: "#282a25",
          "text-wrap": "ellipsis",
          "text-max-width": "156px",
          "text-valign": "center",
          "text-halign": "center",
          "border-width": 1.5,
          "overlay-opacity": 0,
        },
      },
      { selector: "node[kind = 'account']", style: ACCOUNT_STYLE },
      { selector: "node[kind = 'namespace']", style: NAMESPACE_STYLE },
      { selector: "node[kind = 'conversation']", style: CONVERSATION_STYLE },
      { selector: "node:selected", style: { "border-color": "#42634a", "border-width": 3 } },
      {
        selector: "edge",
        style: {
          width: 1.6,
          "line-color": "#bdc4b8",
          "curve-style": "bezier",
          opacity: 0.95,
        },
      },
    ],
  });
  let rows: MindmapClientConversation[] = [];
  let namespaces: MindmapClientPayload["namespaces"] = [];
  let cursor: string | null = null;
  let query = "";
  const collapsed = new Set<string>();
  const byId = new Map<string, MindmapClientConversation>();

  function render(): void {
    const visibleNamespaces = namespaces.filter((entry) => !collapsed.has(entry.namespace));
    const visibleRows = rows.filter((row) => !collapsed.has(row.namespace));
    const graph = buildMindmapGraph(copy.accountLabel, visibleNamespaces, visibleRows);
    cy.batch(() => {
      cy.elements().remove();
      cy.add([...graph.nodes, ...graph.edges]);
    });
    cy.layout({
      name: "concentric",
      minNodeSpacing: 34,
      spacingFactor: 1.1,
      animate: !reducedMotion,
      animationDuration: 420,
    }).run();
    status.textContent =
      rows.length > 0
        ? `${String(rows.length)} ${copy.conversationsLabel.toLowerCase()}`
        : copy.emptyLabel;
    more.hidden = cursor === null;
  }

  async function load(reset: boolean): Promise<void> {
    status.textContent = copy.loadingLabel;
    if (reset) {
      rows = [];
      cursor = null;
    }
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    if (query) params.set("q", query);
    try {
      const response = await fetch(`/dashboard/mindmap/data?${params.toString()}`);
      if (!response.ok) throw new Error(`map request failed: ${String(response.status)}`);
      const data = (await response.json()) as MindmapClientPayload;
      namespaces = data.namespaces;
      rows.push(...data.conversations);
      byId.clear();
      for (const row of rows) byId.set(row.id, row);
      cursor = data.nextCursor;
      render();
    } catch {
      status.textContent = copy.failedLabel;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    query = queryInput.value.trim();
    void load(true);
  });
  more.addEventListener("click", () => {
    void load(false);
  });
  collapseAll.addEventListener("click", () => {
    for (const entry of namespaces) collapsed.add(entry.namespace);
    render();
  });
  expandAll.addEventListener("click", () => {
    collapsed.clear();
    render();
  });
  resetView.addEventListener("click", () => {
    collapsed.clear();
    cy.zoom(1);
    cy.center();
    render();
  });
  zoomIn.addEventListener("click", () => {
    cy.zoom({ level: cy.zoom() * 1.15, renderedPosition: { x: 320, y: 240 } });
  });
  zoomOut.addEventListener("click", () => {
    cy.zoom({ level: cy.zoom() * 0.87, renderedPosition: { x: 320, y: 240 } });
  });
  cy.on("tap", "node[kind = 'namespace']", (event: GraphEvent) => {
    const namespace = event.target.data("namespace");
    if (!namespace) return;
    if (collapsed.has(namespace)) collapsed.delete(namespace);
    else collapsed.add(namespace);
    render();
  });
  cy.on("tap", "node[kind = 'conversation']", (event: GraphEvent) => {
    const id = event.target.data("conversationId");
    if (id) window.location.assign(`/dashboard/conversations/${encodeURIComponent(id)}`);
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
      );
    }
  });
  cy.on("mouseout", "node[kind = 'conversation']", () => {
    hideMindmapTooltip(tooltip);
  });
  void load(true);
}

init();
