import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { landingRoutes } from "../src/landing";
import { SITE_SCRIPT } from "../src/site";

describe("Minimalist public pages", () => {
  it.each(
    Object.keys(landingRoutes).flatMap(
      (path) =>
        [
          [path, "en"],
          [path, "id"],
        ] as const,
    ),
  )("renders an accessible shared shell at %s in %s", async (path, locale) => {
    const response = landingRoutes[path]!(locale);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-language")).toBe(locale);
    expect(response.headers.get("vary")).toContain("Accept-Language");
    expect(html).toContain(`lang="${locale}"`);
    expect(html).toContain('href="#main-content">');
    expect(html).toContain('id="main-content"');
    expect(html).toContain(`href="${path}" aria-current="page"`);
    expect(html).toContain('aria-controls="nav-links"');
    expect(html).toContain(`/language/${locale === "en" ? "id" : "en"}?return_to=`);
    expect(html).toContain("--canvas:#f7f6f2");
    expect(html).toContain("prefers-reduced-motion:reduce");
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect((html.match(/<h1[ >]/g) ?? []).length).toBe(1);
    expect((html.match(/<footer>/g) ?? []).length).toBe(1);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) {
      expect(ids).toContain(id);
    }
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).not.toContain("cdn.jsdelivr.net");
  });

  it("keeps setup content and examples usable without JavaScript", async () => {
    const html = await landingRoutes["/"]!().text();
    expect(html).toContain("Custom MCP app");
    expect(html).toContain("codex mcp login mempersist");
    expect(html).toContain("claude mcp add --transport http mempersist");
    expect(html).toContain('data-copy="mcp-endpoint" aria-label="Copy MCP endpoint" hidden');
    expect(html).toContain('id="copy-feedback" role="status"');
    expect(html).toContain('id="example-save" data-example>');
    expect(html).toContain('id="example-find" data-example>');
    expect(html).toContain('id="example-continue" data-example>');
    expect(html).toContain('class="toc" aria-label="On this page"');
  });

  it("renders the complete decision log before progressive filtering", async () => {
    const html = await landingRoutes["/adrs"]!().text();
    expect(html.match(/<tr data-decision>/g)).toHaveLength(29);
    expect(html).toContain('id="decision-search" type="search"');
    expect(html).toContain('id="decision-count" role="status"');
    expect(html).toContain('id="decision-empty" hidden');
    expect(html).not.toContain('class="toc" aria-label="On this page"');
  });

  it("renders representative Indonesian content and runtime strings", async () => {
    const html = await landingRoutes["/"]!("id").text();
    expect(html).toContain("Simpan konteksnya");
    expect(html).toContain("Hubungkan ChatGPT");
    expect(html).toContain('data-copied="Disalin"');
    expect(html).toContain('aria-label="Navigasi utama"');
  });

  it("emits syntactically valid browser JavaScript", () => {
    expect(() => new Script(SITE_SCRIPT)).not.toThrow();
    expect(SITE_SCRIPT).not.toContain("fetch(");
    expect(SITE_SCRIPT).not.toContain("localStorage");
  });
});
