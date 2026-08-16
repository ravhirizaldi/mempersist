import { describe, expect, it } from "vitest";
import { normalizeTags } from "../src/domain";
import { rankCandidates } from "../src/search";

describe("tag normalization", () => {
  it("lowercases, trims, normalizes unicode, dedupes, and drops empties", () => {
    expect(
      normalizeTags([
        " Dragon-Arc ",
        "dragon-arc",
        "Ｂａｔｔｌｅ",
        "battle",
        "RELATIONSHIP",
        "relationship",
        "  ",
        "",
        "plot-line",
      ]),
    ).toEqual(["dragon-arc", "battle", "relationship", "plot-line"]);
    expect(normalizeTags([])).toEqual([]);
  });

  it("preserves hyphens and does not merge distinct tags", () => {
    expect(normalizeTags(["current-scene", "current_scene", "rules", "rule"])).toEqual([
      "current-scene",
      "current_scene",
      "rules",
      "rule",
    ]);
  });
});

describe("tag ranking boost", () => {
  const base = {
    revision_id: "r",
    conversation_id: "c",
    title: "Arc record",
    body: "The guild holds the eastern gate.",
    conversation_timestamp: "2026-08-01T00:00:00.000Z",
    namespace: "work",
  };
  const tagged = { ...base, id: "tagged" };
  const plain = { ...base, id: "plain", conversation_id: "c2" };
  const rows = new Map([
    [tagged.id, tagged],
    [plain.id, plain],
  ]);

  it("boosts a conversation whose tags overlap the query", () => {
    const [taggedResult, plainResult] = rankCandidates(
      [
        { chunkId: "tagged", lexicalRank: 2 },
        { chunkId: "plain", lexicalRank: 1 },
      ],
      "battle at the gate",
      rows,
      Date.parse("2026-08-01T00:00:00.000Z"),
      {
        conversationTags: new Map([
          ["c", ["battle"]],
          ["c2", []],
        ]),
      },
    );
    expect(taggedResult?.score).toBeGreaterThan(plainResult?.score ?? 0);
    expect(taggedResult?.debug.tagMatchBoost).toBe(0.1);
    expect(plainResult?.debug.tagMatchBoost).toBe(0);
  });

  it("caps the tag boost at 0.25", () => {
    const result = rankCandidates(
      [{ chunkId: "tagged", lexicalRank: 1 }],
      "battle war sword siege dragon",
      rows,
      Date.parse("2026-08-01T00:00:00.000Z"),
      {
        conversationTags: new Map([["c", ["battle", "war", "sword", "siege", "dragon"]]]),
      },
    );
    expect(result[0]?.debug.tagMatchBoost).toBe(0.25);
  });
});
