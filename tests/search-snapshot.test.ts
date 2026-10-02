import { describe, expect, it } from "vitest";
import {
  SEARCH_CURSOR_MAX_CHARS,
  SEARCH_RANKING_VERSION,
  SEARCH_SNAPSHOT_CANDIDATE_CAP,
} from "../src/limits";
import { hashSearchQuery, normalizeSearchNamespaces } from "../src/search-snapshot";

describe("search snapshot cursor support", () => {
  it("keeps namespace bindings exact while sorting and deduplicating", () => {
    expect(normalizeSearchNamespaces([" team ", "ＴＥＡＭ", "personal", "team"])).toEqual([
      " team ",
      "personal",
      "team",
      "ＴＥＡＭ",
    ]);
    expect(normalizeSearchNamespaces(["", " ", ""])).toEqual([" "]);
    expect(normalizeSearchNamespaces(undefined)).toEqual([]);
  });

  it("hashes the exact query deterministically", async () => {
    const queryHash = await hashSearchQuery("東京 snapshot ✨");
    expect(queryHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await hashSearchQuery("東京 snapshot ✨")).toBe(queryHash);
    expect(await hashSearchQuery("東京 snapshot")).not.toBe(queryHash);
  });

  it("keeps cursor and candidate bounds explicit", () => {
    expect(SEARCH_RANKING_VERSION).toBe("normalized-weighted-v6");
    expect(SEARCH_CURSOR_MAX_CHARS).toBe(16 * 1024);
    expect(SEARCH_SNAPSHOT_CANDIDATE_CAP).toBe(200);
  });
});
