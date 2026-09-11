import { describe, expect, it } from "vitest";
import {
  localeFromAcceptLanguage,
  localeFromCookie,
  resolveLocale,
  safeReturnPath,
} from "../src/i18n";

describe("locale negotiation", () => {
  it("parses supported cookies", () => {
    expect(localeFromCookie("session=x; __Host-mempersist_lang=id")).toBe("id");
    expect(localeFromCookie("__Host-mempersist_lang=fr")).toBeNull();
    expect(localeFromCookie("x".repeat(4097))).toBeNull();
  });

  it("honors quality, regional tags, and deterministic order", () => {
    expect(localeFromAcceptLanguage("en-US;q=0.4, id-ID;q=0.9")).toBe("id");
    expect(localeFromAcceptLanguage("fr, en;q=0.8, id;q=0.8")).toBe("en");
    expect(localeFromAcceptLanguage("*, id;q=0")).toBeNull();
    expect(localeFromAcceptLanguage("id;q=broken, en;q=0.5")).toBe("en");
  });

  it("uses explicit locale, cookie, header, then English", () => {
    const request = new Request("https://mempersist.example/", {
      headers: { cookie: "__Host-mempersist_lang=en", "accept-language": "id-ID" },
    });
    expect(resolveLocale(request, "id")).toBe("id");
    expect(resolveLocale(request)).toBe("en");
    expect(resolveLocale(new Request("https://mempersist.example/"))).toBe("en");
  });

  it("accepts only same-origin relative return paths", () => {
    expect(safeReturnPath("/authorize?client_id=test")).toBe("/authorize?client_id=test");
    expect(safeReturnPath("https://evil.example/")).toBe("/");
    expect(safeReturnPath("//evil.example/")).toBe("/");
    expect(safeReturnPath(null, "/about")).toBe("/about");
  });
});
