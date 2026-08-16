import { domainId } from "./crypto";
import type { CanonicalConversation, CanonicalNode, ChunkSource, SearchChunk } from "./domain";
import { CHUNK_STRATEGY } from "./domain";

// Per-message safety limit. A canonical message is one semantic chunk unless
// it exceeds this bound; the bound is a ceiling, not a target size.
export const HARD_TOKENS = 1800;
// Micro-message grouping bounds: only tiny adjacent messages may share a
// chunk, so ordinary event-sized messages always stay isolated.
export const GROUP_UNIT_MAX_TOKENS = 64;
export const GROUP_MAX_TOKENS = 320;
export const GROUP_MAX_UNITS = 6;

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
    const boundary = preferredBoundary(text, start, end);
    if (boundary !== null) end = boundary;
    result.push({ text: text.slice(start, end), start, end });
    start = end;
  }
  return result;
}

// Choose the split point inside [start, end) without cutting a headed section.
// A paragraph break whose following line starts a markdown heading is the most
// preferred boundary, then any paragraph break, line break, word break, and
// finally the raw character boundary at `end`.
function preferredBoundary(text: string, start: number, end: number): number | null {
  const window = text.slice(start, end);
  const half = window.length / 2;
  let heading = window.lastIndexOf("\n\n");
  while (heading >= 0) {
    if (window[heading + 2] === "#") break;
    heading = window.lastIndexOf("\n\n", heading - 1);
  }
  if (heading > half) return start + heading + 2;
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph > half) return start + paragraph + 2;
  const line = window.lastIndexOf("\n");
  if (line > half) return start + line + 1;
  const space = window.lastIndexOf(" ");
  if (space > half) return start + space + 1;
  return null;
}

function unitsForNodes(nodes: CanonicalNode[], sequence: Map<string, number>): Unit[] {
  return nodes.flatMap((node) => {
    if (!node.text.trim()) return [];
    const prefix = `[${node.role ?? "unknown"}]\n`;
    const parts = hardSplit(node.text, HARD_TOKENS - estimateTokens(prefix));
    return parts.map((part) => ({
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

// One chunk per message by default. Consecutive micro-messages (each within
// GROUP_UNIT_MAX_TOKENS) may share a chunk while the whole group stays under
// GROUP_MAX_TOKENS and GROUP_MAX_UNITS, so short back-and-forth fragments
// remain searchable without merging real event-sized messages.
function groupUnits(units: Unit[]): Unit[][] {
  const groups: Unit[][] = [];
  let cursor = 0;
  while (cursor < units.length) {
    const first = units[cursor]!;
    if (estimateTokens(first.text) > GROUP_UNIT_MAX_TOKENS) {
      groups.push([first]);
      cursor += 1;
      continue;
    }
    const group: Unit[] = [first];
    let tokens = estimateTokens(first.text);
    let index = cursor + 1;
    while (index < units.length && group.length < GROUP_MAX_UNITS) {
      const next = units[index]!;
      const nextTokens = estimateTokens(next.text);
      if (nextTokens > GROUP_UNIT_MAX_TOKENS) break;
      if (tokens + nextTokens > GROUP_MAX_TOKENS) break;
      group.push(next);
      tokens += nextTokens;
      index += 1;
    }
    groups.push(group);
    cursor = index;
  }
  return groups;
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
    const groups = groupUnits(unitsForNodes(path.nodes, sequence));
    let ordinal = 0;
    for (const group of groups) {
      const body = group.map((unit) => unit.text).join("\n\n");
      const id = await domainId(
        "chunk",
        CHUNK_STRATEGY,
        generationId,
        revisionId,
        path.key,
        group
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
        sources: group.map((unit) => unit.source),
      });
      ordinal += 1;
    }
  }
  return chunks;
}
