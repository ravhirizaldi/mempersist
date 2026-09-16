import type { EdgeDefinition, NodeDefinition } from "cytoscape";
import type { MindmapClientConversation } from "./types";

export interface MindmapGraphNamespace {
  namespace: string;
  conversations: number;
}

export interface MindmapGraph {
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
}

/** Deterministic account -> namespace -> conversation graph shared by the client and tests. */
export function buildMindmapGraph(
  accountLabel: string,
  namespaces: MindmapGraphNamespace[],
  conversations: MindmapClientConversation[],
): MindmapGraph {
  const grouped = new Map<string, MindmapClientConversation[]>();
  for (const row of conversations) {
    const list = grouped.get(row.namespace) ?? [];
    list.push(row);
    grouped.set(row.namespace, list);
  }
  const nodes: NodeDefinition[] = [
    { data: { id: "account", kind: "account", label: accountLabel } },
  ];
  const edges: EdgeDefinition[] = [];
  const ordered = [...namespaces].sort((left, right) =>
    left.namespace.localeCompare(right.namespace),
  );
  for (const entry of ordered) {
    const namespaceId = `namespace:${entry.namespace}`;
    nodes.push({
      data: {
        id: namespaceId,
        kind: "namespace",
        label: `${entry.namespace} - ${String(entry.conversations)}`,
        namespace: entry.namespace,
      },
    });
    edges.push({
      data: { id: `edge:account:${namespaceId}`, source: "account", target: namespaceId },
    });
    const items = [...(grouped.get(entry.namespace) ?? [])].sort(
      (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
    );
    for (const item of items) {
      const conversationId = `conversation:${item.id}`;
      nodes.push({
        data: {
          id: conversationId,
          kind: "conversation",
          label: item.title,
          namespace: item.namespace,
          conversationId: item.id,
          tags: item.tags.join(", "),
        },
      });
      edges.push({
        data: {
          id: `edge:${namespaceId}:${conversationId}`,
          source: namespaceId,
          target: conversationId,
        },
      });
    }
  }
  return { nodes, edges };
}
