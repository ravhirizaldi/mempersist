import { describe, expect, it } from "vitest";
import {
  chunkConversation,
  estimateTokens,
  GROUP_MAX_TOKENS,
  GROUP_MAX_UNITS,
  GROUP_UNIT_MAX_TOKENS,
  HARD_TOKENS,
} from "../src/chunking";
import { normalizeChatGptConversation } from "../src/chatgpt";
import { branchedChatGptConversation } from "./fixtures/chatgpt";

function eventsConversation(messages: string[]): Record<string, unknown> {
  const ids = messages.map((_, index) => `event-${index}`);
  const mapping: Record<string, unknown> = {
    root: { id: "root", parent: null, children: [ids[0]], message: null },
  };
  ids.forEach((id, index) => {
    mapping[id] = {
      id,
      parent: index === 0 ? "root" : ids[index - 1],
      children: index === ids.length - 1 ? [] : [ids[index + 1]],
      message: {
        author: { role: index % 2 === 0 ? "user" : "assistant" },
        create_time: 1_700_000_000 + index,
        content: { content_type: "text", parts: [messages[index] ?? ""] },
        metadata: {},
      },
    };
  });
  return {
    id: "events-conversation",
    title: "Event log",
    create_time: 1_700_000_000,
    update_time: 1_700_000_000 + messages.length,
    current_node: ids.at(-1),
    mapping,
  };
}

function eventText(label: string): string {
  return `[${label}]\n\n${"Canonical event record with operator context, outcome, and follow-up notes. ".repeat(6)}`;
}

describe("deterministic hybrid chunking", () => {
  it("creates active and alternate chunks with stable ids", async () => {
    const conversation = await normalizeChatGptConversation(branchedChatGptConversation());
    const first = await chunkConversation(conversation, "revision", "generation");
    const second = await chunkConversation(conversation, "revision", "generation");
    expect(first.map((chunk) => chunk.id)).toEqual(second.map((chunk) => chunk.id));
    expect(first.some((chunk) => chunk.branchKey === "active")).toBe(true);
    expect(first.some((chunk) => chunk.branchKey.startsWith("alternate:"))).toBe(true);
  });

  it("splits very long mixed-language and code content without truncation", async () => {
    const fixture = branchedChatGptConversation();
    const longText = `${"Keputusan arsitektur multilingual. ".repeat(600)}\n\n\`\`\`ts\n${"const packageName = '@scope/pkg';\n".repeat(300)}\`\`\``;
    fixture.mapping["assistant-active"].message.content.parts = [longText];
    const conversation = await normalizeChatGptConversation(fixture);
    const chunks = await chunkConversation(conversation, "revision-long", "generation");
    expect(chunks.every((chunk) => chunk.tokenEstimate <= HARD_TOKENS + 10)).toBe(true);
    const ranges = chunks
      .flatMap((chunk) => chunk.sources)
      .filter((source) => source.sourceNodeId === "assistant-active")
      .sort((a, b) => a.charStart - b.charStart);
    expect(ranges[0]?.charStart).toBe(0);
    expect(Math.max(...ranges.map((range) => range.charEnd))).toBe(longText.length);
  });

  it("keeps one canonical message as its own semantic chunk", async () => {
    const texts = Array.from({ length: 35 }, (_, index) =>
      eventText(`EVENT ${index + 1} / SAMPLE RECORD ${index + 1}`),
    );
    const conversation = await normalizeChatGptConversation(eventsConversation(texts));
    const first = await chunkConversation(conversation, "revision-events", "generation");
    const second = await chunkConversation(conversation, "revision-events", "generation");
    const active = first.filter((chunk) => chunk.branchKey === "active");

    expect(active.length).toBe(35);
    expect(first.map((chunk) => chunk.id)).toEqual(second.map((chunk) => chunk.id));
    for (const [ordinal, chunk] of active.entries()) {
      expect(chunk.ordinal).toBe(ordinal);
      expect(chunk.sources.length).toBe(1);
      const source = chunk.sources[0];
      expect(source?.sourceNodeId).toBe(`event-${ordinal}`);
      expect(source?.charStart).toBe(0);
      expect(source?.charEnd).toBe(texts[ordinal]?.length);
      expect(chunk.body).toContain(texts[ordinal] ?? "");
    }
    expect(active.some((chunk) => chunk.sources.length > 1)).toBe(false);
  });

  it("groups tiny adjacent messages conservatively without polluting event chunks", async () => {
    const texts = [
      eventText("EVENT 1 / BIG RECORD"),
      ...Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? "ok" : "noted")),
    ];
    const conversation = await normalizeChatGptConversation(eventsConversation(texts));
    const chunks = (await chunkConversation(conversation, "revision-micro", "generation")).filter(
      (chunk) => chunk.branchKey === "active",
    );

    const big = chunks.find((chunk) => chunk.body.includes("BIG RECORD"));
    expect(big?.sources.length).toBe(1);
    expect(chunks.some((chunk) => chunk.sources.length > 1)).toBe(true);
    for (const chunk of chunks) {
      if (chunk.sources.length <= 1) continue;
      expect(chunk.sources.length).toBeLessThanOrEqual(GROUP_MAX_UNITS);
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(GROUP_MAX_TOKENS + GROUP_MAX_UNITS);
      for (const source of chunk.sources) {
        const unit = texts[Number(source.sourceNodeId.slice(6))] ?? "";
        expect(unit).toBeTruthy();
        expect(estimateTokens(unit)).toBeLessThanOrEqual(GROUP_UNIT_MAX_TOKENS);
      }
    }
  });

  it("splits an oversized message at headed section boundaries", async () => {
    const sections = Array.from(
      { length: 24 },
      (_, index) =>
        `## EVENT ${index + 1}\n${"Detailed section body with operator context and decisions. ".repeat(5)}`,
    );
    const longText = sections.join("\n\n");
    const conversation = await normalizeChatGptConversation(
      eventsConversation(["assistant-long", longText, "ok"]),
    );
    const chunks = (
      await chunkConversation(conversation, "revision-headings", "generation")
    ).filter((chunk) => chunk.branchKey === "active");
    const parts = chunks.filter((chunk) => chunk.sources[0]?.sourceNodeId === "event-1");

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((chunk) => chunk.tokenEstimate <= HARD_TOKENS + 10)).toBe(true);
    const starts = parts.map((chunk) => chunk.sources[0]?.charStart ?? 0).sort((a, b) => a - b);
    expect(starts[0]).toBe(0);
    for (const start of starts) expect(longText.slice(start, start + 2)).toBe("##");
    expect(Math.max(...parts.map((chunk) => chunk.sources[0]?.charEnd ?? 0))).toBe(longText.length);
  });
});
