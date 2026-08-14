import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/app";
import type { AppEnv } from "../src/domain";

describe("HTTP security boundary", () => {
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
