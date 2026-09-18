import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleDashboardRequest } from "../src/dashboard";
import type { AppEnv } from "../src/domain";

describe("session survives landing page visit (repro)", () => {
  it("keeps the dashboard session after visiting the homepage", async () => {
    const sent: Array<{ html?: string }> = [];
    const testEnv = {
      ...env,
      EMAIL: {
        send: vi.fn((message: { html?: string }) => {
          sent.push(message);
          return Promise.resolve({ messageId: crypto.randomUUID() });
        }),
      },
    } as unknown as AppEnv;

    const login = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://mempersist.codifiedtech.id",
        },
        body: new URLSearchParams({ email: "persist@example.com", return_to: "/dashboard" }),
      }),
      testEnv,
    );
    expect(login.status).toBe(200);
    const link = sent
      .at(-1)
      ?.html?.match(/href="([^"]+)"/)?.[1]
      ?.replaceAll("&amp;", "&");
    expect(link).toBeTruthy();
    const callback = await handleDashboardRequest(new Request(link!), testEnv);
    const cookie = callback.headers.get("set-cookie")!.split(";", 1)[0]!;
    expect(cookie).toContain("__Host-mempersist_session=");

    const dashboardBefore = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard", { headers: { cookie } }),
      testEnv,
    );
    expect(dashboardBefore.status).toBe(200);

    const home = await SELF.fetch("https://mempersist.codifiedtech.id/", { headers: { cookie } });
    expect(home.status).toBe(200);
    const homeSetCookie = home.headers.get("set-cookie");
    console.log("homepage set-cookie:", JSON.stringify(homeSetCookie));
    const homeHtml = await home.text();
    console.log("homepage shows sign-in:", homeHtml.includes('class="nav-sign-in"'));

    // Full worker path (through the OAuth provider), exactly like the browser.
    const dashboardAfter = await SELF.fetch("https://mempersist.codifiedtech.id/dashboard", {
      headers: { cookie },
      redirect: "manual",
    });
    console.log("dashboard after homepage status:", dashboardAfter.status);
    const afterHtml = await dashboardAfter.text();
    console.log("dashboard still has csrf form:", afterHtml.includes('name="csrf"'));
    expect(dashboardAfter.status).toBe(200);

    // And the login page the homepage nav points at.
    const loginPage = await SELF.fetch("https://mempersist.codifiedtech.id/login", {
      headers: { cookie },
      redirect: "manual",
    });
    console.log("login page status while signed in:", loginPage.status);
    expect(loginPage.status).toBe(303);
    expect(loginPage.headers.get("location")).toBe("/dashboard");
  });
});
