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
    expect(html).toContain(
      '<meta name="google-site-verification" content="mwzJlCt4rJwkhbnmNF0EDUELm14CZzPYQhI-YtcX_sA">',
    );
    expect(html).toContain(
      "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&display=optional",
    );
    expect(html).toContain('<link rel="stylesheet" href="/site.css">');
    expect(html).toContain('<script src="/site.js" defer></script>');
    expect(html).not.toContain("<style>");
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect((html.match(/<h1[ >]/g) ?? []).length).toBe(1);
    expect((html.match(/<footer>/g) ?? []).length).toBe(1);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) {
      expect(ids).toContain(id);
    }
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(html).not.toMatch(/class="(?:brand|copy-button)"[^>]*aria-label=/u);
    expect(csp).not.toContain("cdn.jsdelivr.net");
  });

  it("keeps setup content and examples usable without JavaScript", async () => {
    const html = await landingRoutes["/"]!().text();
    expect(html).toContain("Custom MCP app");
    expect(html).toContain("codex mcp login mempersist");
    expect(html).toContain("claude mcp add --transport http mempersist");
    expect(html).toContain('data-copy="mcp-endpoint" hidden>Copy endpoint</button>');
    expect(html).toContain('id="copy-feedback" role="status"');
    expect(html).toContain('id="example-save" data-example>');
    expect(html).toContain('id="example-find" data-example>');
    expect(html).toContain('id="example-continue" data-example>');
    expect(html).toContain('class="toc" aria-label="On this page"');
  });

  it("renders the complete decision log before progressive filtering", async () => {
    const html = await landingRoutes["/adrs"]!().text();
    expect(html.match(/<tr data-decision>/g)).toHaveLength(31);
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
