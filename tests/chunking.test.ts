import { describe, expect, it } from "vitest";
import { chunkConversation, HARD_TOKENS } from "../src/chunking";
import { normalizeChatGptConversation } from "../src/chatgpt";
import { branchedChatGptConversation } from "./fixtures/chatgpt";

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
});
