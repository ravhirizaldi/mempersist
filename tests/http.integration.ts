import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/app";
import type { AppEnv } from "../src/domain";

describe("HTTP security boundary", () => {
  it("serves the landing page at the root without authentication", async () => {
    const appEnv = env as AppEnv;
    const response = await app.request("/", {}, appEnv);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("MemPersist");
    expect(html).toContain("https://mempersist.nextostaging.net/mcp");
    expect(html).toContain("Custom MCP app");
    expect(html).toContain("codex mcp login");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("serves the whitepaper, architecture, security, and ADR pages", async () => {
    const appEnv = env as AppEnv;
    const expectations: Array<[string, string]> = [
      ["/whitepaper", "Designing durable AI conversation memory"],
      ["/whitepaper", "How search works"],
      ["/architecture", "Cloudflare-native, clean-room"],
      ["/architecture", "Cloudflare services"],
      ["/security", "Threat model and controls"],
      ["/adrs", "Architecture decision records"],
      ["/about", "Ravhi Rizaldi"],
    ];
    for (const [path, marker] of expectations) {
      const response = await app.request(path, {}, appEnv);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toContain(marker);
      expect(html, path).toContain("Whitepaper"); // shared nav menu
    }
  });

  it("leaves health public and requires bearer authentication for API routes", async () => {
    const appEnv = env as AppEnv;
    const health = await app.request("/healthz", {}, appEnv);
    expect(health.status).toBe(200);

    const denied = await app.request("/api/conversations", {}, appEnv);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");

    const allowed = await app.request(
      "/api/conversations",
      { headers: { authorization: "Bearer integration-test-token" } },
      appEnv,
    );
    expect(allowed.status).toBe(200);
  });
});
