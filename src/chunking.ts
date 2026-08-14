import { domainId } from "./crypto";
import type { CanonicalConversation, CanonicalNode, ChunkSource, SearchChunk } from "./domain";
import { CHUNK_STRATEGY } from "./domain";

export const TARGET_TOKENS = 1200;
export const HARD_TOKENS = 1800;
export const OVERLAP_TOKENS = 150;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 3));
}

interface Unit {
  text: string;
  source: ChunkSource;
}

function hardSplit(
  text: string,
  maxTokens: number,
): Array<{ text: string; start: number; end: number }> {
  if (estimateTokens(text) <= maxTokens) return [{ text, start: 0, end: text.length }];
  const result: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    let low = start + 1;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (estimateTokens(text.slice(start, mid)) <= maxTokens) low = mid;
      else high = mid - 1;
    }
    let end = low;
    const previous = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end = end - 1 > start ? end - 1 : end + 1;
    }
    const window = text.slice(start, end);
    const boundary = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    if (boundary > window.length / 2) end = start + boundary + 1;
    result.push({ text: text.slice(start, end), start, end });
    start = end;
  }
  return result;
}

function unitsForNodes(nodes: CanonicalNode[], sequence: Map<string, number>): Unit[] {
  return nodes.flatMap((node) => {
    if (!node.text.trim()) return [];
    const prefix = `[${node.role ?? "unknown"}]\n`;
    return hardSplit(node.text, HARD_TOKENS - estimateTokens(prefix)).map((part) => ({
      text: `${prefix}${part.text}`,
      source: {
        sourceNodeId: node.sourceNodeId,
        sourceSequence: sequence.get(node.sourceNodeId) ?? null,
        charStart: part.start,
        charEnd: part.end,
      },
    }));
  });
}

function paths(
  conversation: CanonicalConversation,
): Array<{ key: string; nodes: CanonicalNode[] }> {
  const byId = new Map(conversation.nodes.map((node) => [node.sourceNodeId, node]));
  const active = conversation.activeSourceNodeIds.flatMap((id) =>
    byId.get(id) ? [byId.get(id)!] : [],
  );
  const activeSet = new Set(conversation.activeSourceNodeIds);
  const alternatives: Array<{ key: string; nodes: CanonicalNode[] }> = [];
  const leaves = conversation.nodes
    .filter((node) => node.childSourceNodeIds.length === 0 && !activeSet.has(node.sourceNodeId))
    .sort((a, b) => a.sourceNodeId.localeCompare(b.sourceNodeId));

  // ponytail: parent walks are O(nodes x branch depth); memoize paths if synthetic histories reach huge branching depth.
  for (const leaf of leaves) {
    const reversed: CanonicalNode[] = [];
    const seen = new Set<string>();
    let cursor: CanonicalNode | undefined = leaf;
    while (cursor && !seen.has(cursor.sourceNodeId)) {
      seen.add(cursor.sourceNodeId);
      reversed.push(cursor);
      cursor = cursor.parentSourceNodeId ? byId.get(cursor.parentSourceNodeId) : undefined;
    }
    const path = reversed.reverse();
    const firstDifferent = path.findIndex((node) => !activeSet.has(node.sourceNodeId));
    const start = Math.max(0, firstDifferent - 1);
    alternatives.push({ key: `alternate:${leaf.sourceNodeId}`, nodes: path.slice(start) });
  }
  return [{ key: "active", nodes: active }, ...alternatives];
}

export async function chunkConversation(
  conversation: CanonicalConversation,
  revisionId: string,
  generationId: string,
): Promise<SearchChunk[]> {
  const sequence = new Map(conversation.activeSourceNodeIds.map((id, index) => [id, index]));
  const chunks: SearchChunk[] = [];
  for (const path of paths(conversation)) {
    const units = unitsForNodes(path.nodes, sequence);
    let cursor = 0;
    let ordinal = 0;
    while (cursor < units.length) {
      const selected: Unit[] = [];
      let tokens = 0;
      let index = cursor;
      while (index < units.length) {
        const unit = units[index];
        if (!unit) break;
        const next = estimateTokens(unit.text);
        if (selected.length && tokens + next > TARGET_TOKENS) break;
        selected.push(unit);
        tokens += next;
        index += 1;
        if (tokens >= TARGET_TOKENS) break;
      }
      const body = selected.map((unit) => unit.text).join("\n\n");
      const id = await domainId(
        "chunk",
        CHUNK_STRATEGY,
        revisionId,
        path.key,
        selected
          .map(
            (unit) => `${unit.source.sourceNodeId}:${unit.source.charStart}:${unit.source.charEnd}`,
          )
          .join("|"),
      );
      chunks.push({
        id,
        vectorId: await domainId("vector", generationId, id),
        revisionId,
        conversationId: conversation.id,
        generationId,
        branchKey: path.key,
        ordinal,
        title: conversation.title,
        body,
        tokenEstimate: estimateTokens(body),
        conversationTimestamp: conversation.updatedAt,
        namespace: conversation.namespace,
        sources: selected.map((unit) => unit.source),
      });
      if (index >= units.length) break;
      let overlap = 0;
      let nextCursor = index;
      while (nextCursor > cursor + 1 && overlap < OVERLAP_TOKENS) {
        nextCursor -= 1;
        overlap += estimateTokens(units[nextCursor]?.text ?? "");
      }
      cursor = nextCursor;
      ordinal += 1;
    }
  }
  return chunks;
}
