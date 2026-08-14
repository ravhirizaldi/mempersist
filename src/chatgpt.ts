import { z } from "zod";
import { domainId } from "./crypto";
import type { CanonicalConversation, CanonicalNode, JsonValue } from "./domain";
import { SOURCE_CHATGPT } from "./domain";
import { AppError } from "./errors";

const recordSchema = z.record(z.string(), z.unknown());
const chatGptConversationSchema = z
  .object({
    id: z.string().optional(),
    conversation_id: z.string().optional(),
    title: z.string().optional(),
    create_time: z.number().nullish(),
    update_time: z.number().nullish(),
    current_node: z.string().nullish(),
    mapping: z.record(z.string(), recordSchema),
  })
  .passthrough();

function asJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(asJson);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, asJson(item)]));
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "symbol";
  return typeof value === "undefined" ? "undefined" : "unsupported";
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function extractMessageText(message: Record<string, unknown> | null): string {
  const content = object(message?.content);
  const parts = content?.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((part) => (typeof part === "string" ? part : JSON.stringify(asJson(part))))
      .join("\n");
  }
  if (typeof content?.text === "string") return content.text;
  if (typeof message?.text === "string") return message.text;
  return "";
}

export function activeBranch(
  mapping: Record<string, Record<string, unknown>>,
  currentNode: string | null,
): { ids: string[]; anomalies: string[] } {
  const anomalies: string[] = [];
  let cursor = currentNode;
  if (!cursor || !mapping[cursor]) {
    const leaves = Object.entries(mapping)
      .filter(([, node]) => !Array.isArray(node.children) || node.children.length === 0)
      .sort(([a], [b]) => a.localeCompare(b));
    cursor = leaves.at(-1)?.[0] ?? Object.keys(mapping).sort().at(-1) ?? null;
    if (currentNode) anomalies.push(`current_node_missing:${currentNode}`);
  }

  const reversed: string[] = [];
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) {
      anomalies.push(`cycle:${cursor}`);
      break;
    }
    const node = mapping[cursor];
    if (!node) {
      anomalies.push(`dangling_parent:${cursor}`);
      break;
    }
    seen.add(cursor);
    reversed.push(cursor);
    cursor = string(node.parent);
  }
  return { ids: reversed.reverse(), anomalies };
}

export async function normalizeChatGptConversation(input: unknown): Promise<CanonicalConversation> {
  const parsed = chatGptConversationSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("PERMANENT_PARSER", parsed.error.message, 422, false);
  }

  const sourceId = parsed.data.id ?? parsed.data.conversation_id ?? null;
  const conversationId = sourceId
    ? await domainId("conversation", SOURCE_CHATGPT, sourceId)
    : await domainId("conversation", SOURCE_CHATGPT, JSON.stringify(asJson(parsed.data)));
  const branch = activeBranch(parsed.data.mapping, parsed.data.current_node ?? null);
  const active = new Set(branch.ids);
  const nodes: CanonicalNode[] = [];

  for (const [sourceNodeId, rawNode] of Object.entries(parsed.data.mapping).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const message = object(rawNode.message);
    const author = object(message?.author);
    const metadata = object(message?.metadata) ?? {};
    const children = Array.isArray(rawNode.children)
      ? rawNode.children.filter((child): child is string => typeof child === "string")
      : [];
    nodes.push({
      id: await domainId("message-node", conversationId, sourceNodeId),
      sourceNodeId,
      parentSourceNodeId: string(rawNode.parent),
      childSourceNodeIds: [...children].sort(),
      role: string(author?.role),
      text: extractMessageText(message),
      content: asJson(message?.content ?? null),
      createdAt: timestamp(message?.create_time ?? rawNode.create_time),
      updatedAt: timestamp(message?.update_time ?? rawNode.update_time),
      modelSlug: string(metadata.model_slug ?? message?.model_slug),
      metadata: asJson(metadata),
      raw: asJson(rawNode),
    });
  }

  const rawMetadata = Object.fromEntries(
    Object.entries(parsed.data).filter(([key]) => !["mapping", "title"].includes(key)),
  );
  return {
    id: conversationId,
    sourceType: SOURCE_CHATGPT,
    sourceId,
    title: parsed.data.title?.trim() || "Untitled conversation",
    namespace: "personal",
    createdAt: timestamp(parsed.data.create_time),
    updatedAt: timestamp(parsed.data.update_time),
    currentSourceNodeId: parsed.data.current_node ?? branch.ids.at(-1) ?? null,
    activeSourceNodeIds: branch.ids.filter((id) => active.has(id)),
    nodes,
    metadata: asJson(rawMetadata),
    anomalies: branch.anomalies,
  };
}

export async function createMcpConversation(input: {
  id?: string;
  title: string;
  namespace: string;
  messages: Array<{ role: string; content: string; timestamp?: string | undefined }>;
}): Promise<CanonicalConversation> {
  const conversationId = input.id ?? crypto.randomUUID();
  const nodes: CanonicalNode[] = [];
  let parent: string | null = null;
  for (const [index, message] of input.messages.entries()) {
    const sourceNodeId = `mcp-${index}-${await domainId("mcp-message", message.role, message.content)}`;
    nodes.push({
      id: await domainId("message-node", conversationId, sourceNodeId),
      sourceNodeId,
      parentSourceNodeId: parent,
      childSourceNodeIds: [],
      role: message.role,
      text: message.content,
      content: { content_type: "text", parts: [message.content] },
      createdAt: message.timestamp ?? null,
      updatedAt: null,
      modelSlug: null,
      metadata: {},
      raw: {},
    });
    if (parent) nodes.at(-2)?.childSourceNodeIds.push(sourceNodeId);
    parent = sourceNodeId;
  }
  const now = new Date().toISOString();
  return {
    id: conversationId,
    sourceType: "mcp",
    sourceId: null,
    title: input.title,
    namespace: input.namespace,
    createdAt: nodes[0]?.createdAt ?? now,
    updatedAt: nodes.at(-1)?.createdAt ?? now,
    currentSourceNodeId: parent,
    activeSourceNodeIds: nodes.map((node) => node.sourceNodeId),
    nodes,
    metadata: {},
    anomalies: [],
  };
}
