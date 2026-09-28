import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCountDotEdge,
  buildCountDotNode,
  buildMindmapGraph,
  buildMoreEdge,
  buildMoreNode,
} from "../web/mindmap/graph";
import type { MindmapClientConversation } from "../web/mindmap/types";
import { mindmapBundleFingerprint } from "../src/mindmap-bundle";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const conversation = (
  id: string,
  namespace: string,
  title: string,
  tags: string[] = [],
  messages = 0,
): MindmapClientConversation => ({ id, namespace, title, tags, updated_at: null, messages });

describe("mindmap graph construction", () => {
  it("links the account to namespaces and namespaces to conversations", () => {
    const graph = buildMindmapGraph(
      "My account",
      [
        { namespace: "work", conversations: 2 },
        { namespace: "personal", conversations: 1 },
      ],
      [
        conversation("b", "work", "Beta"),
        conversation("a", "work", "Alpha", ["decision"]),
        conversation("c", "personal", "Gamma", [], 3),
      ],
    );

    expect(graph.nodes.map((node) => node.data?.id)).toEqual([
      "account",
      "namespace:personal",
      "conversation:c",
      "namespace:work",
      "conversation:a",
      "conversation:b",
    ]);
    expect(graph.edges.map((edge) => edge.data?.id)).toEqual([
      "edge:account:namespace:personal",
      "edge:namespace:personal:conversation:c",
      "edge:account:namespace:work",
      "edge:namespace:work:conversation:a",
      "edge:namespace:work:conversation:b",
    ]);
    expect(graph.nodes[2]?.data).toMatchObject({
      id: "conversation:c",
      kind: "conversation",
      conversationId: "c",
      messages: 3,
    });
  });

  it("is deterministic regardless of input ordering", () => {
    const first = buildMindmapGraph(
      "My account",
      [
        { namespace: "work", conversations: 1 },
        { namespace: "alpha", conversations: 1 },
      ],
      [conversation("z", "work", "Zulu", [], 2), conversation("a", "alpha", "Alpha", [], 5)],
    );
    const second = buildMindmapGraph(
      "My account",
      [
        { namespace: "alpha", conversations: 1 },
        { namespace: "work", conversations: 1 },
      ],
      [conversation("a", "alpha", "Alpha", [], 5), conversation("z", "work", "Zulu", [], 2)],
    );
    expect(first).toEqual(second);
  });

  it("keeps namespace accounting labels and tag metadata on nodes", () => {
    const graph = buildMindmapGraph(
      "My account",
      [{ namespace: "work", conversations: 7 }],
      [conversation("a", "work", "Alpha", ["decision", "runbook"], 4)],
    );
    expect(graph.nodes[1]?.data).toMatchObject({
      kind: "namespace",
      label: "work - 7",
      namespace: "work",
    });
    expect(graph.nodes[2]?.data).toMatchObject({
      kind: "conversation",
      conversationId: "a",
      label: "Alpha",
      tags: "decision, runbook",
      messages: 4,
    });
  });

  it("carries the active message count on every conversation node", () => {
    const graph = buildMindmapGraph(
      "My account",
      [{ namespace: "work", conversations: 2 }],
      [conversation("a", "work", "Alpha", [], 0), conversation("b", "work", "Beta", [], 12)],
    );
    expect(graph.nodes).toMatchObject([
      { data: { id: "account", kind: "account" } },
      { data: { id: "namespace:work", kind: "namespace" } },
      { data: { id: "conversation:a", kind: "conversation", messages: 0 } },
      { data: { id: "conversation:b", kind: "conversation", messages: 12 } },
    ]);
  });

  it("still renders an account node when no memories exist", () => {
    const graph = buildMindmapGraph("My account", [], []);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  it("never injects stored titles into generated markup attributes", () => {
    const graph = buildMindmapGraph(
      "My account",
      [{ namespace: "work", conversations: 1 }],
      [conversation("a", "work", "<img src=x onerror=alert(1)>")],
    );
    const node = graph.nodes.find((item) => item.data?.id === "conversation:a");
    const label = (node?.data as Record<string, unknown> | undefined)?.["label"];
    expect(label).toBe("<img src=x onerror=alert(1)>");
    expect(JSON.stringify(graph)).not.toContain("innerHTML");
  });
});

describe("mindmap drill-down builders", () => {
  it("builds a conversation count dot and its edge with deterministic ids", () => {
    const node = buildCountDotNode("abc", 7, "messages");
    expect(node.data).toEqual({
      id: "messages:abc",
      kind: "messages",
      label: "messages",
      messages: 7,
      source: "conversation:abc",
      conversationId: "abc",
    });

    const edge = buildCountDotEdge("abc");
    expect(edge.data).toEqual({
      id: "edge:conversation:abc:messages:abc",
      source: "conversation:abc",
      target: "messages:abc",
    });
  });

  it("builds a namespace more node and its edge with the remaining count", () => {
    const node = buildMoreNode("work", 12, "more");
    expect(node.data).toEqual({
      id: "more:work",
      kind: "more",
      label: "more",
      namespace: "work",
      remaining: 12,
    });

    const edge = buildMoreEdge("work");
    expect(edge.data).toEqual({
      id: "edge:namespace:work:more:work",
      source: "namespace:work",
      target: "more:work",
    });
  });

  it("keeps stored namespaces and ids as plain values, never markup", () => {
    const namespace = `<img src=x onerror=alert(1)>`;
    const more = buildMoreNode(namespace, 1, "more");
    expect(more.data).toMatchObject({ namespace, label: "more", remaining: 1 });
    expect(JSON.stringify(more)).not.toContain("innerHTML");

    const conversationId = `" onmouseover="alert(1)`;
    const dot = buildCountDotNode(conversationId, 2, "messages");
    expect(dot.data).toMatchObject({ id: `messages:${conversationId}`, conversationId });
    expect(JSON.stringify(dot)).not.toContain("innerHTML");
  });

  it("labels the count dot and more node from the supplied copy, not stored data", () => {
    expect(buildCountDotNode("abc", 3, "pesan").data).toMatchObject({ label: "pesan" });
    expect(buildMoreNode("work", 0, "lainnya").data).toMatchObject({ label: "lainnya" });
  });
});

describe("bundled mindmap client", () => {
  it("is rebuilt from the current web/mindmap sources", () => {
    const watched = ["client.ts", "graph.ts", "tooltip.ts", "types.ts"].map((name) =>
      readFileSync(join(root, "web/mindmap", name), "utf8"),
    );
    const digest = createHash("sha256")
      .update(watched.join("\n/* mempersist-mindmap-source */\n"))
      .digest("hex");
    expect(mindmapBundleFingerprint()).toBe(digest);
  });

  it("bundles locally instead of loading an external script", () => {
    const bundle = readFileSync(join(root, "src/mindmap-bundle.ts"), "utf8");
    expect(bundle).not.toContain("cdn.jsdelivr.net");
    expect(bundle).not.toContain("unpkg.com");
    expect(bundle).not.toContain("<script");
    expect(bundle).not.toContain('src="http');
    expect(bundle).not.toContain('createElement("script")');
  });
});
