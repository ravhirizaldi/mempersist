import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMindmapGraph } from "../web/mindmap/graph";
import { mindmapBundleFingerprint } from "../src/mindmap-bundle";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const conversation = (
  id: string,
  namespace: string,
  title: string,
  tags: string[] = [],
): {
  id: string;
  namespace: string;
  title: string;
  tags: string[];
  updated_at: string | null;
} => ({ id, namespace, title, tags, updated_at: null });

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
        conversation("c", "personal", "Gamma"),
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
  });

  it("is deterministic regardless of input ordering", () => {
    const first = buildMindmapGraph(
      "My account",
      [
        { namespace: "work", conversations: 1 },
        { namespace: "alpha", conversations: 1 },
      ],
      [conversation("z", "work", "Zulu"), conversation("a", "alpha", "Alpha")],
    );
    const second = buildMindmapGraph(
      "My account",
      [
        { namespace: "alpha", conversations: 1 },
        { namespace: "work", conversations: 1 },
      ],
      [conversation("a", "alpha", "Alpha"), conversation("z", "work", "Zulu")],
    );
    expect(first).toEqual(second);
  });

  it("keeps namespace accounting labels and tag metadata on nodes", () => {
    const graph = buildMindmapGraph(
      "My account",
      [{ namespace: "work", conversations: 7 }],
      [conversation("a", "work", "Alpha", ["decision", "runbook"])],
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
    });
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
