import { describe, expect, it } from "vitest";
import { semanticQueryVariants, SEMANTIC_QUERY_MAX_VARIANTS } from "../src/semantic-query";

describe("deterministic semantic query representations", () => {
  it("keeps the raw query as the first representation", () => {
    const query = "picture Adriana uses as her phone background after she and Ravhi started dating";
    const variants = semanticQueryVariants(query);
    expect(variants[0]).toBe(query);
  });

  it("anchors long English paraphrases on detected concepts", () => {
    const variants = semanticQueryVariants(
      "picture Adriana uses as her phone background after she and Ravhi started dating",
    );
    expect(variants.length).toBe(2);
    expect(variants[1]).toContain("picture photo image");
    expect(variants[1]).toContain("wallpaper lock screen phone background");
    expect(variants[1]).toContain("couple started dating official relationship");
  });

  it("anchors Indonesian paraphrases with the same canonical labels", () => {
    const variants = semanticQueryVariants(
      "gambar yang Adriana pakai sebagai latar layar HP setelah dia dan Ravhi mulai pacaran",
    );
    expect(variants.length).toBe(2);
    expect(variants[1]).toContain("wallpaper lock screen phone background");
    expect(variants[1]).toContain("picture photo image");
    expect(variants[1]).toContain("couple started dating official relationship");
  });

  it("adds no anchor when no concept is detected", () => {
    expect(semanticQueryVariants("database migration checklist")).toEqual([
      "database migration checklist",
    ]);
    expect(semanticQueryVariants("  ")).toEqual([]);
  });

  it("skips the anchor when the query already covers every label token", () => {
    expect(semanticQueryVariants("wallpaper lock screen phone background")).toEqual([
      "wallpaper lock screen phone background",
    ]);
  });

  it("is deterministic and bounded", () => {
    const query = "foto yang dipasang Adriana di layar HP sejak mereka jadian";
    const first = semanticQueryVariants(query);
    const second = semanticQueryVariants(query);
    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(SEMANTIC_QUERY_MAX_VARIANTS);
    expect(new Set(first).size).toBe(first.length);
  });

  it("anchors the lock-screen query on picture and phone-background concepts", () => {
    const variants = semanticQueryVariants("what photo is Adriana using on her phone lock screen");
    expect(variants.length).toBe(2);
    expect(variants[1]).toContain("picture photo image");
    expect(variants[1]).toContain("wallpaper lock screen phone background");
  });
});
