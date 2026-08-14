import { describe, expect, it } from "vitest";
import { queryTerms, recentLexicalScore, reciprocalRankFusion } from "../src/search";

describe("hybrid retrieval ranking", () => {
  const oldDecision = {
    id: "old",
    revision_id: "r1",
    conversation_id: "c1",
    title: "Atlas DB architecture decision",
    body: "The exact hostname is api.internal.example and migration 0007 stays additive.",
    conversation_timestamp: "2020-01-01T00:00:00.000Z",
    namespace: "work",
  };
  const recentWeak = {
    ...oldDecision,
    id: "recent",
    revision_id: "r2",
    conversation_id: "c2",
    title: "Recent chat",
    body: "A generic database conversation.",
    conversation_timestamp: "2026-08-14T00:00:00.000Z",
  };

  it("keeps an old strong match above a recent weak match", () => {
    const rows = new Map([
      [oldDecision.id, oldDecision],
      [recentWeak.id, recentWeak],
    ]);
    const ranked = reciprocalRankFusion(
      [
        { chunkId: "old", lexicalRank: 1, semanticRank: 1, semanticScore: 0.9 },
        { chunkId: "recent", lexicalRank: 8, semanticRank: 8, semanticScore: 0.4 },
      ],
      "database architecture",
      rows,
      Date.parse("2026-08-14T00:00:00.000Z"),
    );
    expect(ranked[0]?.chunkId).toBe("old");
  });

  it("boosts exact hostnames and emits safe FTS terms", () => {
    const rows = new Map([[oldDecision.id, oldDecision]]);
    const [ranked] = reciprocalRankFusion(
      [{ chunkId: "old", lexicalRank: 1 }],
      "api.internal.example",
      rows,
    );
    expect(ranked?.score).toBeGreaterThan(0.5);
    expect(queryTerms('api.internal.example "quoted"')).toBe('"api.internal.example" OR "quoted"');
  });

  it("matches recent canonical text with phrases or lightweight term overlap", () => {
    expect(
      recentLexicalScore(
        "which gateway is used to test internet failure?",
        "The WAN outage test gateway is called Marmot.",
      ),
    ).not.toBeNull();
    expect(recentLexicalScore("Marmot", "The gateway is called Marmot.")).toBeGreaterThan(2);
    expect(recentLexicalScore("late-token", `${"filler ".repeat(20)}late-token`)).not.toBeNull();
    expect(recentLexicalScore("unrelated query", "The gateway is called Marmot.")).toBeNull();
  });

  it("adds recent canonical provenance without changing the indexed rank scale", () => {
    const rows = new Map([[oldDecision.id, oldDecision]]);
    const [indexed] = reciprocalRankFusion(
      [{ chunkId: "old", lexicalRank: 1 }],
      "database architecture",
      rows,
    );
    const [recent] = reciprocalRankFusion(
      [{ chunkId: "old", recentRank: 1 }],
      "database architecture",
      rows,
    );
    expect(recent?.score).toBe(indexed?.score);
    expect(recent?.sources).toEqual(["recent_canonical"]);
  });
});
