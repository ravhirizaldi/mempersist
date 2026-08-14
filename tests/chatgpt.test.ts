import { describe, expect, it } from "vitest";
import { activeBranch, normalizeChatGptConversation } from "../src/chatgpt";
import { branchedChatGptConversation } from "./fixtures/chatgpt";

describe("ChatGPT graph normalization", () => {
  it("preserves the graph and extracts only the current branch as the default timeline", async () => {
    const normalized = await normalizeChatGptConversation(branchedChatGptConversation());
    expect(normalized.activeSourceNodeIds).toEqual(["root", "user-1", "assistant-active"]);
    expect(normalized.nodes.map((node) => node.sourceNodeId)).toContain("assistant-alt");
    expect(
      normalized.nodes.find((node) => node.sourceNodeId === "assistant-alt")?.raw,
    ).toMatchObject({
      message: { metadata: { unusual: { preserved: true } } },
    });
    expect(
      normalized.nodes.find((node) => node.sourceNodeId === "assistant-active")?.modelSlug,
    ).toBe("gpt-example");
  });

  it("keeps a stable conversation id when a newer export extends an old conversation", async () => {
    const oldConversation = branchedChatGptConversation();
    const newerConversation = structuredClone(oldConversation);
    Object.assign(newerConversation.mapping, {
      "assistant-new": {
        id: "assistant-new",
        parent: "assistant-active",
        children: [],
        message: null,
      },
    });
    newerConversation.mapping["assistant-active"].children = ["assistant-new"];
    newerConversation.current_node = "assistant-new";
    const [oldNormalized, newerNormalized] = await Promise.all([
      normalizeChatGptConversation(oldConversation),
      normalizeChatGptConversation(newerConversation),
    ]);
    expect(newerNormalized.id).toBe(oldNormalized.id);
    expect(newerNormalized.nodes).toHaveLength(oldNormalized.nodes.length + 1);
  });

  it("reports cycles instead of looping", () => {
    const result = activeBranch(
      {
        a: { parent: "b" },
        b: { parent: "a" },
      },
      "a",
    );
    expect(result.anomalies).toEqual(["cycle:a"]);
  });
});
