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
    expect(html).toContain("https://mempersist.codifiedtech.id/mcp");
    expect(html).not.toContain("https://mempersist.nextostaging.net/mcp");
    expect(html).toContain("memory_get_conversations");
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

  it("negotiates Indonesian and allows a cookie preference to override it", async () => {
    const appEnv = env as AppEnv;
    const landing = await app.request("/", { headers: { "accept-language": "id-ID" } }, appEnv);
    expect(await landing.text()).toContain("ambil hingga 20 percakapan dikenal sekaligus");

    const indonesian = await app.request(
      "/whitepaper",
      { headers: { "accept-language": "id-ID, en;q=0.5" } },
      appEnv,
    );
    expect(indonesian.headers.get("content-language")).toBe("id");
    expect(await indonesian.text()).toContain("Merancang memori percakapan AI");

    const english = await app.request(
      "/whitepaper",
      {
        headers: {
          "accept-language": "id",
          cookie: "__Host-mempersist_lang=en",
        },
      },
      appEnv,
    );
    expect(english.headers.get("content-language")).toBe("en");
  });

  it("persists language switches and rejects external return targets", async () => {
    const appEnv = env as AppEnv;
    const switched = await app.request(
      "/language/id?return_to=%2Farchitecture%3Fview%3Dfull",
      {},
      appEnv,
    );
    expect(switched.status).toBe(303);
    expect(switched.headers.get("location")).toBe("/architecture?view=full");
    expect(switched.headers.get("set-cookie")).toContain("__Host-mempersist_lang=id");
    expect(switched.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");

    const unsafe = await app.request(
      "/language/id?return_to=https%3A%2F%2Fevil.example",
      {},
      appEnv,
    );
    expect(unsafe.headers.get("location")).toBe("/");
    expect((await app.request("/language/fr", {}, appEnv)).status).toBe(404);
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
