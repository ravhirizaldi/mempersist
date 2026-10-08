import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import app from "../src/app";
import type { AppEnv } from "../src/domain";
import {
  MAX_DIRECT_IMPORT_BYTES,
  MAX_INLINE_JSON_WRITE_BYTES,
  MAX_MESSAGE_CONTENT_CHARS,
} from "../src/limits";

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

  it("serves the whitepaper, architecture, security, privacy, terms, and ADR pages", async () => {
    const appEnv = env as AppEnv;
    const expectations: Array<[string, string]> = [
      ["/whitepaper", "Designing durable AI conversation memory"],
      ["/whitepaper", "How search works"],
      ["/architecture", "Cloudflare-native, clean-room"],
      ["/architecture", "Cloudflare services"],
      ["/security", "Threat model and controls"],
      ["/privacy", "Data categories"],
      ["/privacy", "Processors and recipients"],
      ["/privacy", "at most seven days"],
      ["/terms", "Service scope"],
      ["/terms", "Acceptable use"],
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
    const idPrivacy = await app.request(
      "/privacy",
      { headers: { "accept-language": "id" } },
      appEnv,
    );
    expect(idPrivacy.status).toBe(200);
    expect(await idPrivacy.text()).toContain("Kategori data");
    const idTerms = await app.request("/terms", { headers: { "accept-language": "id" } }, appEnv);
    expect(idTerms.status).toBe(200);
    expect(await idTerms.text()).toContain("Cakupan layanan");
  });

  it("serves OpenAI app challenge only when configured", async () => {
    const appEnv = env as AppEnv;
    const configured = await app.request("/.well-known/openai-apps-challenge", {}, appEnv);
    expect(configured.status).toBe(200);
    expect(configured.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(configured.headers.get("cache-control")).toBe("no-store");
    expect(await configured.text()).toBe("synthetic-openai-apps-challenge-token");

    const missing = await app.request("/.well-known/openai-apps-challenge", {}, {});
    expect(missing.status).toBe(404);
    const empty = await app.request(
      "/.well-known/openai-apps-challenge",
      {},
      {
        OPENAI_APPS_CHALLENGE_TOKEN: "",
      },
    );
    expect(empty.status).toBe(404);
  });

  it("publishes SEO, crawler, and security metadata", async () => {
    const appEnv = env as AppEnv;
    const robots = await app.request("/robots.txt", {}, appEnv);
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain(
      "Sitemap: https://mempersist.codifiedtech.id/sitemap.xml",
    );
    expect(robots.headers.get("cache-control")).toContain("public");

    const sitemap = await app.request("/sitemap.xml", {}, appEnv);
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toContain("application/xml");
    const sitemapBody = await sitemap.text();
    expect(sitemapBody).toContain("<loc>https://mempersist.codifiedtech.id/</loc>");
    expect(sitemapBody).toContain("<loc>https://mempersist.codifiedtech.id/privacy</loc>");
    expect(sitemapBody).toContain("<loc>https://mempersist.codifiedtech.id/terms</loc>");

    const security = await app.request("/.well-known/security.txt", {}, appEnv);
    expect(security.status).toBe(200);
    expect(await security.text()).toContain(
      "Contact: https://github.com/ravhirizaldi/mempersist/security/advisories/new",
    );

    const manifest = await app.request("/site.webmanifest", {}, appEnv);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");

    const llms = await app.request("/llms.txt", {}, appEnv);
    expect(llms.status).toBe(200);
    expect(llms.headers.get("content-type")).toContain("text/plain");
    const llmsBody = await llms.text();
    expect(llmsBody).toContain("# MemPersist");
    expect(llmsBody).toContain("- [Whitepaper](https://mempersist.codifiedtech.id/whitepaper)");

    const siteCss = await app.request("/site.css?v=2", {}, appEnv);
    expect(siteCss.status).toBe(200);
    expect(siteCss.headers.get("content-type")).toContain("text/css");
    expect(siteCss.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await siteCss.text()).toContain(".site-nav");
    const staleCss = await app.request("/site.css?v=1", {}, appEnv);
    expect(staleCss.headers.get("cache-control")).toContain("max-age=86400");

    const siteJs = await app.request("/site.js?v=2", {}, appEnv);
    expect(siteJs.status).toBe(200);
    expect(siteJs.headers.get("content-type")).toContain("application/javascript");
    expect(siteJs.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await siteJs.text()).toContain("navigator.clipboard");
    const staleJs = await app.request("/site.js", {}, appEnv);
    expect(staleJs.headers.get("cache-control")).toContain("max-age=86400");
    const landing = await app.request("/", {}, appEnv);
    const html = await landing.text();
    expect(html).toContain('<link rel="canonical" href="https://mempersist.codifiedtech.id/">');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('type="application/ld+json"');
  });

  it("negotiates Indonesian and allows a cookie preference to override it", async () => {
    const appEnv = env as AppEnv;
    const landing = await app.request("/", { headers: { "accept-language": "id-ID" } }, appEnv);
    expect(await landing.text()).toContain(
      "mulai dengan 1–20 permintaan; lanjutkan secara adil dengan satu kursor opak",
    );

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

describe("search cursor transport contract", () => {
  const authorization = "Bearer integration-test-token";
  const jsonHeaders = { authorization, "content-type": "application/json" };

  it("returns a paginated first page and rejects changed continuation inputs", async () => {
    const query = `cursor-contract-${crypto.randomUUID()}`;
    for (let index = 0; index < 2; index += 1) {
      const created = await app.request(
        "/api/memories",
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            title: `Cursor contract ${index}`,
            messages: [{ role: "user", content: `${query} memory ${index}` }],
          }),
        },
        env,
      );
      expect(created.status).toBe(201);
    }
    const headers = { authorization };
    const first = await app.request(
      `/api/search?q=${encodeURIComponent(query)}&limit=1&max_serialized_bytes=4096`,
      { headers },
      env,
    );
    expect(first.status).toBe(200);
    const parseJsonObject = async (response: Response): Promise<Record<string, unknown>> => {
      const value = JSON.parse(await response.text()) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a JSON object");
      }
      return value as Record<string, unknown>;
    };
    const page = await parseJsonObject(first);
    expect(page).toHaveProperty("results");
    expect(page).toHaveProperty("next_cursor");
    expect(page).toHaveProperty("snapshot");
    expect(page).toHaveProperty("used_serialized_bytes");
    expect(page.max_serialized_bytes).toBe(4096);
    const cursor = page.next_cursor;
    expect(typeof cursor).toBe("string");
    const continuation = await app.request(
      `/api/search?cursor=${encodeURIComponent(String(cursor))}&limit=1&max_serialized_bytes=4096`,
      { headers },
      env,
    );
    expect(continuation.status).toBe(200);
    const continuationPage = await parseJsonObject(continuation);
    expect(continuationPage).toHaveProperty("results");
    expect(continuationPage).toHaveProperty("next_cursor");
    expect(continuationPage).toHaveProperty("snapshot");
    expect(continuationPage).toHaveProperty("used_serialized_bytes");
    expect(continuationPage).toHaveProperty("max_serialized_bytes");
    expect(continuationPage.max_serialized_bytes).toBe(4096);

    for (const path of [
      `/api/search?cursor=forged&limit=1`,
      `/api/search?q=${encodeURIComponent(query)}&cursor=forged&limit=1`,
      `/api/search?cursor=forged&namespace=other&limit=1`,
      `/api/search?cursor=forged&tags=private&limit=1`,
      `/api/search?cursor=${encodeURIComponent(String(cursor))}&q=${encodeURIComponent(query)}&limit=1`,
      `/api/search?cursor=${encodeURIComponent(String(cursor))}&namespace=other&limit=1`,
      `/api/search?cursor=${encodeURIComponent(String(cursor))}&tags=private&limit=1`,
    ]) {
      const response = await app.request(path, { headers }, env);
      expect(response.status, path).toBe(400);
    }
  });

  it("enforces search response byte bounds at the HTTP boundary", async () => {
    const headers = { authorization };
    const query = `cursor-budget-${crypto.randomUUID()}`;
    for (const value of [4095, 49153]) {
      const response = await app.request(
        `/api/search?q=${encodeURIComponent(query)}&max_serialized_bytes=${value}`,
        { headers },
        env,
      );
      expect(response.status).toBe(400);
    }
  });
});

describe("aggregate byte budgets", () => {
  const authorization = "Bearer integration-test-token";
  const jsonHeaders = { authorization, "content-type": "application/json" };
  const tooLargeResponse = z.object({
    error: z.object({
      code: z.literal("REQUEST_TOO_LARGE"),
      message: z.string(),
      request_bytes: z.number(),
      max_request_bytes: z.number(),
      suggested_max_items: z.number().optional(),
    }),
  });

  async function tooLarge(response: Response) {
    expect(response.status).toBe(413);
    return tooLargeResponse.parse(await response.json());
  }

  it("rejects an oversized inline memory write with a measured 413", async () => {
    const chunk = "a".repeat(600_000);
    const body = JSON.stringify({
      title: "Oversized inline write",
      messages: [
        { role: "user", content: chunk },
        { role: "assistant", content: chunk },
      ],
    });
    const response = await app.request(
      "/api/memories",
      { method: "POST", headers: jsonHeaders, body },
      env,
    );
    const { error } = await tooLarge(response);
    expect(error.code).toBe("REQUEST_TOO_LARGE");
    expect(error.request_bytes).toBeGreaterThan(error.max_request_bytes);
    expect(error.max_request_bytes).toBe(MAX_INLINE_JSON_WRITE_BYTES);
    expect(error.max_request_bytes).toBe(1048576);
    expect(Number.isInteger(error.suggested_max_items)).toBe(true);
    expect(error.suggested_max_items ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("accepts an inline write exactly at the byte ceiling", async () => {
    const scaffold = JSON.stringify({
      title: "Exactly at the ceiling",
      namespace: "personal",
      messages: [
        { role: "user", content: "" },
        { role: "user", content: "" },
      ],
      verify: false,
    });
    const padding = MAX_INLINE_JSON_WRITE_BYTES - new TextEncoder().encode(scaffold).byteLength;
    const half = Math.floor(padding / 2);
    const body = JSON.stringify({
      title: "Exactly at the ceiling",
      namespace: "personal",
      messages: [
        { role: "user", content: "a".repeat(half) },
        { role: "user", content: "a".repeat(padding - half) },
      ],
      verify: false,
    });
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_INLINE_JSON_WRITE_BYTES);
    const response = await app.request(
      "/api/memories",
      { method: "POST", headers: jsonHeaders, body },
      env,
    );
    expect(response.status).toBe(201);
  });

  it("rejects a multibyte body under the character limit but over 1 MiB of bytes", async () => {
    const content = "é".repeat(600_000);
    const body = JSON.stringify({ title: "Multibyte", messages: [{ role: "user", content }] });
    expect(content.length).toBeLessThan(MAX_MESSAGE_CONTENT_CHARS);
    expect(body.length).toBeLessThan(MAX_INLINE_JSON_WRITE_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(MAX_INLINE_JSON_WRITE_BYTES);
    const response = await app.request(
      "/api/memories",
      { method: "POST", headers: jsonHeaders, body },
      env,
    );
    const { error } = await tooLarge(response);
    expect(error.code).toBe("REQUEST_TOO_LARGE");
    expect(error.request_bytes).toBeGreaterThan(MAX_INLINE_JSON_WRITE_BYTES);
    expect(error.max_request_bytes).toBe(MAX_INLINE_JSON_WRITE_BYTES);
    expect(Number.isInteger(error.suggested_max_items)).toBe(true);
    expect(error.suggested_max_items ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("rejects an oversized inline append before writing a new revision", async () => {
    const created = await app.request(
      "/api/memories",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          title: "Append target",
          messages: [{ role: "user", content: "seed" }],
        }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const receiptSchema = z.object({ conversation_id: z.string(), revision_id: z.string() });
    const receipt = receiptSchema.parse(await created.json());
    const chunk = "b".repeat(600_000);
    const response = await app.request(
      `/api/conversations/${receipt.conversation_id}/append`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          base_revision_id: receipt.revision_id,
          messages: [
            { role: "user", content: chunk },
            { role: "assistant", content: chunk },
          ],
        }),
      },
      env,
    );
    const { error } = await tooLarge(response);
    expect(error.code).toBe("REQUEST_TOO_LARGE");
    expect(error.request_bytes).toBeGreaterThan(error.max_request_bytes);
    expect(error.max_request_bytes).toBe(MAX_INLINE_JSON_WRITE_BYTES);
    expect(Number.isInteger(error.suggested_max_items)).toBe(true);
    expect(error.suggested_max_items ?? 0).toBeGreaterThanOrEqual(1);

    const pageResponse = await app.request(
      `/api/conversations/${receipt.conversation_id}`,
      { headers: jsonHeaders },
      env,
    );
    expect(pageResponse.status).toBe(200);
    const page = z.object({ messages: z.array(z.unknown()) }).parse(await pageResponse.json());
    expect(page.messages).toHaveLength(1);
  });

  it("rejects a direct import whose Content-Length exceeds the streamed ceiling", async () => {
    const oversized = MAX_DIRECT_IMPORT_BYTES + 1;
    const response = await app.request(
      "/api/imports/direct",
      {
        method: "POST",
        headers: {
          authorization: "Bearer integration-test-token",
          "content-length": String(oversized),
        },
        body: "x".repeat(oversized),
      },
      env,
    );
    const { error } = await tooLarge(response);
    expect(error.code).toBe("REQUEST_TOO_LARGE");
    expect(error.request_bytes).toBe(oversized);
    expect(error.max_request_bytes).toBe(MAX_DIRECT_IMPORT_BYTES);
    expect(error.max_request_bytes).toBe(16777216);
    expect(error.suggested_max_items).toBeUndefined();
  });
});
