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
    expect(queryTerms('api.internal.example "quoted"')).toBe(
      '"api.internal.example quoted" OR "api.internal.example" OR "quoted" OR "quot"* OR "quoted"*',
    );
  });

  it("builds phrase, stem-prefix, and last-token prefix FTS terms without stop words", () => {
    expect(queryTerms("dragons")).toBe('"dragons" OR "dragon"* OR "dragons"*');
    expect(queryTerms("people")).toBe('"people" OR "person"* OR "people"*');
    const stopWordQuery = queryTerms("how is the gateway working");
    expect(stopWordQuery).toBe(
      '"gateway working" OR "gateway" OR "working" OR "work"* OR "working"*',
    );
    expect(queryTerms("the the the")).toBe("");
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

  it("ranks an exact labeled event heading decisively above a generic semantic couple", () => {
    const rows = new Map([
      [
        "event16",
        {
          id: "event16",
          revision_id: "r16",
          conversation_id: "c16",
          title: "[EVENT 16 / NEW-COUPLE PHOTOBOX + CANONICAL WALLPAPER]",
          body: "Ravhi and Adriana became a newly official couple at the photobox. The photobox image became Adriana's wallpaper, lock screen, and canonical wallpaper.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
      [
        "event12",
        {
          id: "event12",
          revision_id: "r12",
          conversation_id: "c12",
          title: "[EVENT 12 / VIEN + PRASETYO BECOME ESTABLISHED COUPLE]",
          body: "Couple. They became a couple. Their couple status is official. The couple relationship.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
    ]);
    const ranked = rankCandidates(
      [
        { chunkId: "event12", lexicalRank: 1, semanticScore: 0.99 },
        { chunkId: "event16", lexicalRank: 2, semanticScore: 0.4 },
      ],
      "EVENT 16 NEW-COUPLE PHOTOBOX CANONICAL WALLPAPER",
      rows,
      Date.parse("2026-08-15T00:00:00.000Z"),
    );

    expect(ranked[0]?.chunkId).toBe("event16");
    expect((ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0)).toBeGreaterThan(1);
    expect(ranked[0]?.debug).toMatchObject({
      exactMatchBoost: 1,
      headingMatchBoost: 0.6,
      structuredLabelBoost: 0.3,
      specificityBoost: 0.5,
    });
    expect(ranked[0]?.debug.coOccurrenceBoost).toBeCloseTo(0.15, 10);
  });

  it("lets rare terms beat a repeatedly matched generic term", () => {
    const rows = new Map([
      [
        "rare",
        {
          id: "rare",
          revision_id: "r1",
          conversation_id: "c1",
          title: "Photobox wallpaper setup",
          body: "photobox and wallpaper for the couple photo.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
      [
        "generic",
        {
          id: "generic",
          revision_id: "r2",
          conversation_id: "c2",
          title: "Couple notes",
          body: "couple couple couple relationship couple status couple",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
    ]);
    const ranked = rankCandidates(
      [
        { chunkId: "rare", lexicalRank: 1 },
        { chunkId: "generic", lexicalRank: 1 },
      ],
      "photobox wallpaper couple",
      rows,
      Date.parse("2026-08-15T00:00:00.000Z"),
    );

    expect(ranked[0]?.chunkId).toBe("rare");
    expect((ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0)).toBeGreaterThan(1);
    expect(ranked[0]?.debug.specificityBoost).toBe(0.5);
    expect(ranked[1]?.debug.specificityBoost).toBe(0);
  });

  it("keeps semantic paraphrase retrieval working without exact lexical overlap", () => {
    const rows = new Map([
      [
        "paraphrase",
        {
          id: "paraphrase",
          revision_id: "r1",
          conversation_id: "c1",
          title: "Adriana's phone background",
          body: "The photobox image became Adriana's chosen wallpaper / lock screen.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
      [
        "device",
        {
          id: "device",
          revision_id: "r2",
          conversation_id: "c2",
          title: "Device memory",
          body: "The phone was replaced after a hardware failure.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
    ]);
    const ranked = rankCandidates(
      [
        { chunkId: "paraphrase", semanticScore: 0.9 },
        { chunkId: "device", semanticScore: 0.45 },
      ],
      "picture Adriana uses as her phone background",
      rows,
      Date.parse("2026-08-15T00:00:00.000Z"),
    );

    expect(ranked[0]?.chunkId).toBe("paraphrase");
    expect(ranked[0]?.sources).toContain("semantic");
    expect((ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0)).toBeGreaterThan(0.3);
  });

  it("credits structured event labels only for the matching heading label", () => {
    const rows = new Map([
      [
        "a16",
        {
          id: "a16",
          revision_id: "r1",
          conversation_id: "c1",
          title: "EVENT 16 / Photo setup",
          body: "photobox wallpaper.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
      [
        "b12",
        {
          id: "b12",
          revision_id: "r2",
          conversation_id: "c2",
          title: "EVENT 12 / Couple record",
          body: "couple.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
      [
        "cBody",
        {
          id: "cBody",
          revision_id: "r3",
          conversation_id: "c3",
          title: "Device notes",
          body: "The device serial is 16-2290. Unrelated.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
    ]);
    const ranked = rankCandidates(
      [
        { chunkId: "a16", lexicalRank: 1 },
        { chunkId: "b12", lexicalRank: 1 },
        { chunkId: "cBody", lexicalRank: 1 },
      ],
      "event 16 wallpaper",
      rows,
      Date.parse("2026-08-15T00:00:00.000Z"),
    );

    const a = ranked.find((item) => item.chunkId === "a16");
    const b = ranked.find((item) => item.chunkId === "b12");
    const c = ranked.find((item) => item.chunkId === "cBody");
    expect(ranked[0]?.chunkId).toBe("a16");
    expect(a?.debug.structuredLabelBoost).toBe(0.3);
    expect(b?.debug.structuredLabelBoost).toBe(0);
    expect(c?.debug.structuredLabelBoost).toBe(0);
    expect((a?.score ?? 0) - (c?.score ?? 0)).toBeGreaterThan(1);
  });

  it("does not boost a generic heading on its own", () => {
    const rows = new Map([
      [
        "generic",
        {
          id: "generic",
          revision_id: "r1",
          conversation_id: "c1",
          title: "[CURRENT]",
          body: "Adriana is in a relationship. The relationship status is official.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
      [
        "specific",
        {
          id: "specific",
          revision_id: "r2",
          conversation_id: "c2",
          title: "RELATIONSHIP STATUS ADRIANA / OFFICIAL COUPLE",
          body: "Adriana's relationship status with Ravhi is official.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
    ]);
    const ranked = rankCandidates(
      [
        { chunkId: "generic", lexicalRank: 1 },
        { chunkId: "specific", lexicalRank: 1 },
      ],
      "relationship status Adriana",
      rows,
      Date.parse("2026-08-15T00:00:00.000Z"),
    );

    const generic = ranked.find((item) => item.chunkId === "generic");
    expect(ranked[0]?.chunkId).toBe("specific");
    expect(generic?.debug.headingMatchBoost).toBe(0);
    expect(generic?.debug.structuredLabelBoost).toBe(0);
  });

  it("does not triple-count alias variants of one rare concept", () => {
    const rows = new Map([
      [
        "a",
        {
          id: "a",
          revision_id: "r1",
          conversation_id: "c1",
          title: "Photobox memories",
          body: "The photobox image became her wallpaper.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
      [
        "b",
        {
          id: "b",
          revision_id: "r2",
          conversation_id: "c2",
          title: "Couple record",
          body: "They are a couple.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
    ]);
    const single = rankCandidates(
      [
        { chunkId: "a", lexicalRank: 1 },
        { chunkId: "b", lexicalRank: 1 },
      ],
      "photobox",
      rows,
      Date.parse("2026-08-15T00:00:00.000Z"),
    );
    const variants = rankCandidates(
      [
        { chunkId: "a", lexicalRank: 1 },
        { chunkId: "b", lexicalRank: 1 },
      ],
      "photobox photo-box photo booth",
      rows,
      Date.parse("2026-08-15T00:00:00.000Z"),
    );

    expect(single[0]?.chunkId).toBe("a");
    expect(variants[0]?.chunkId).toBe("a");
    expect(single[0]?.debug.coOccurrenceBoost).toBe(0);
    expect(variants[0]?.debug.coOccurrenceBoost).toBe(0);
  });

  it("treats heading punctuation variants equivalently", () => {
    const rows = new Map([
      [
        "a",
        {
          id: "a",
          revision_id: "r1",
          conversation_id: "c1",
          title: "[EVENT 16 / NEW-COUPLE PHOTOBOX + CANONICAL WALLPAPER]",
          body: "photobox wallpaper canonical.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
      [
        "b",
        {
          id: "b",
          revision_id: "r2",
          conversation_id: "c2",
          title: "Couple notes",
          body: "couple.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
    ]);
    const queries = [
      "[EVENT 16 / NEW-COUPLE PHOTOBOX + CANONICAL WALLPAPER]",
      "EVENT 16 NEW COUPLE PHOTOBOX CANONICAL WALLPAPER",
      "event-16 new-couple photobox canonical wallpaper",
    ];
    const ranked = queries.map((query) =>
      rankCandidates(
        [
          { chunkId: "a", lexicalRank: 1 },
          { chunkId: "b", lexicalRank: 1 },
        ],
        query,
        rows,
        Date.parse("2026-08-15T00:00:00.000Z"),
      ),
    );

    for (const result of ranked) {
      expect(result[0]?.chunkId).toBe("a");
      expect((result[0]?.score ?? 0) - (result[1]?.score ?? 0)).toBeGreaterThan(1);
    }
    expect(ranked[0]?.[0]?.score).toBe(ranked[1]?.[0]?.score);
    // A lowercase query loses the case-sensitive named-entity credit (0.35)
    // and full-query substring credit (0.2) but keeps every other signal.
    expect(ranked[2]?.[0]?.score).toBeGreaterThanOrEqual((ranked[0]?.[0]?.score ?? 0) - 0.8);
  });

  it("keeps a broad semantic query competitive without the exact rare word", () => {
    const rows = new Map([
      [
        "photobox",
        {
          id: "photobox",
          revision_id: "r1",
          conversation_id: "c1",
          title: "Photobox event",
          body: "Ravhi and Adriana became a newly official couple at the photobox.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
      [
        "other",
        {
          id: "other",
          revision_id: "r2",
          conversation_id: "c2",
          title: "Vien Prasetyo record",
          body: "Vien and Prasetyo became an established couple.",
          conversation_timestamp: "2026-08-15T00:00:00.000Z",
          namespace: "work",
        },
      ],
    ]);
    const ranked = rankCandidates(
      [
        { chunkId: "photobox", lexicalRank: 1, semanticScore: 0.75 },
        { chunkId: "other", lexicalRank: 1 },
      ],
      "Adriana and Ravhi took pictures together after they started dating",
      rows,
      Date.parse("2026-08-15T00:00:00.000Z"),
    );

    expect(ranked[0]?.chunkId).toBe("photobox");
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });
});
