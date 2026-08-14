import { describe, expect, it } from "vitest";
import { queryTerms, rankCandidates, recentLexicalScore } from "../src/search";

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
    const ranked = rankCandidates(
      [
        { chunkId: "old", lexicalRank: 1, semanticScore: 0.9 },
        { chunkId: "recent", lexicalRank: 8, semanticScore: 0.4 },
      ],
      "database architecture",
      rows,
      Date.parse("2026-08-14T00:00:00.000Z"),
    );
    expect(ranked[0]?.chunkId).toBe("old");
  });

  it("boosts exact hostnames and emits safe FTS terms", () => {
    const rows = new Map([[oldDecision.id, oldDecision]]);
    const [ranked] = rankCandidates(
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
    expect(recentLexicalScore("Marmot", "The gateway is called Marmot.")).toBe(1);
    expect(recentLexicalScore("late-token", `${"filler ".repeat(20)}late-token`)).not.toBeNull();
    expect(recentLexicalScore("unrelated query", "The gateway is called Marmot.")).toBeNull();
  });

  it("normalizes operational paraphrases without embeddings", () => {
    expect(
      recentLexicalScore("WAN outage", "The internet failure drill is Thursday."),
    ).not.toBeNull();
    expect(recentLexicalScore("responsible person", "PIC: Satria Mahendra")).not.toBeNull();
    expect(
      recentLexicalScore("maintenance schedule", "Maintenance window: Tuesday 02:15 WIB"),
    ).not.toBeNull();
    expect(
      recentLexicalScore(
        "test packet loss on the secondary satellite connection",
        "Packet-loss simulation runs on the backup satellite link.",
      ),
    ).not.toBeNull();
  });

  it("adds recent canonical provenance without changing the indexed rank scale", () => {
    const rows = new Map([[oldDecision.id, oldDecision]]);
    const [indexed] = rankCandidates(
      [{ chunkId: "old", lexicalRank: 1 }],
      "database architecture",
      rows,
    );
    const [recent] = rankCandidates(
      [{ chunkId: "old", recentScore: 1 }],
      "database architecture",
      rows,
    );
    expect(recent?.score).toBeCloseTo(indexed?.score ?? 0, 12);
    expect(recent?.sources).toEqual(["recent_canonical"]);
  });

  it("ranks an exact entity phrase above an unrelated semantic result", () => {
    const rows = new Map([
      [
        "tarsier",
        {
          ...oldDecision,
          id: "tarsier",
          revision_id: "r3",
          title: "Tarsier Delta",
          body: "Tarsier Delta maintenance is handled by Livia Maheswari.",
        },
      ],
      [
        "glass",
        {
          ...recentWeak,
          id: "glass",
          revision_id: "r4",
          title: "Project Glass Comet",
          body: "A separate project discussion.",
        },
      ],
    ]);
    const ranked = rankCandidates(
      [
        { chunkId: "tarsier", recentScore: 0.8 },
        { chunkId: "glass", semanticScore: 0.99 },
      ],
      "who is responsible for Tarsier Delta?",
      rows,
    );

    expect(ranked[0]?.chunkId).toBe("tarsier");
    expect(ranked[0]?.debug.exactMatchBoost).toBe(1);
    expect(ranked[0]?.debug.recentCanonicalScore).toBe(0.8);
  });

  it("ranks a strong lexical entity match above weak semantic similarity", () => {
    const rows = new Map([
      [
        "entity",
        {
          ...oldDecision,
          id: "entity",
          revision_id: "r5",
          title: "Tarsier Delta operations",
          body: "Maintenance ownership notes for Tarsier Delta.",
        },
      ],
      [
        "semantic",
        {
          ...recentWeak,
          id: "semantic",
          revision_id: "r6",
          title: "Weak semantic result",
          body: "Unrelated scheduling notes.",
        },
      ],
    ]);
    const ranked = rankCandidates(
      [
        { chunkId: "entity", lexicalRank: 3 },
        { chunkId: "semantic", semanticScore: 0.4 },
      ],
      "Tarsier Delta",
      rows,
    );

    expect(ranked[0]?.chunkId).toBe("entity");
    expect(ranked[0]?.debug.lexicalScore).toBeGreaterThan(ranked[1]?.debug.semanticScore ?? 1);
  });
});
