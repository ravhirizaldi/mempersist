import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpConversation } from "../src/chatgpt";
import { sha256 } from "../src/crypto";
import { handleDashboardRequest } from "../src/dashboard";
import { deleteConversations } from "../src/deletion";
import {
  cancelAccountDeletion,
  processDeletionJobMessage,
  scheduleAccountDeletion,
  scheduleNamespaceDeletion,
} from "../src/deletion-jobs";
import type { AppEnv } from "../src/domain";
import { writeCanonicalConversation } from "../src/storage";
import { getOrCreateUser, grantNamespace } from "../src/tenant";

interface SentEmail {
  to: string;
  html?: string;
  text?: string;
}

function dashboardEnv() {
  const sent: SentEmail[] = [];
  const queued: Array<{ body: { version: 1; job_id: string }; delaySeconds?: number }> = [];
  const value = {
    ...env,
    EMAIL: {
      send: vi.fn((message: SentEmail) => {
        sent.push(message);
        return Promise.resolve({ messageId: crypto.randomUUID() });
      }),
    },
    IMPORT_QUEUE: {
      send: vi.fn((body: { version: 1; job_id: string }, options?: { delaySeconds?: number }) => {
        queued.push({
          body,
          ...(options?.delaySeconds ? { delaySeconds: options.delaySeconds } : {}),
        });
        return Promise.resolve();
      }),
    },
  } as unknown as AppEnv;
  return { env: value, sent, queued };
}

function formRequest(path: string, body: Record<string, string>, cookie?: string): Request {
  return new Request(`https://mempersist.codifiedtech.id${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://mempersist.codifiedtech.id",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body),
  });
}

async function signIn(appEnv: AppEnv, sent: SentEmail[], email: string, returnTo = "/dashboard") {
  const login = await handleDashboardRequest(
    formRequest("/login", { email, return_to: returnTo }),
    appEnv,
  );
  expect(login.status).toBe(200);
  const link = sent
    .at(-1)
    ?.html?.match(/href="([^"]+)"/)?.[1]
    ?.replaceAll("&amp;", "&");
  expect(link).toBeTruthy();
  const callback = await handleDashboardRequest(new Request(link!), appEnv);
  const setCookie = callback.headers.get("set-cookie");
  expect(callback.status).toBe(303);
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).toContain("Path=/");
  const cookie = setCookie!.split(";", 1)[0]!;
  const dashboard = await handleDashboardRequest(
    new Request("https://mempersist.codifiedtech.id/dashboard", { headers: { cookie } }),
    appEnv,
  );
  const html = await dashboard.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  expect(csrf).toBeTruthy();
  return { cookie, csrf: csrf!, link: link! };
}

beforeEach(async () => {
  await env.MEMORY_BUCKET.delete(
    (await env.MEMORY_BUCKET.list()).objects.map((object) => object.key),
  );
});

describe("dashboard authentication and isolation", () => {
  it("accepts browser same-origin metadata when Origin is omitted", async () => {
    const test = dashboardEnv();
    const response = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({ email: "metadata@example.com", return_to: "/dashboard" }),
      }),
      test.env,
    );
    expect(response.status).toBe(200);
    expect(test.sent).toHaveLength(1);
  });

  it("uses hashed one-use tokens, secure sessions, CSRF, and a safe return path", async () => {
    const test = dashboardEnv();
    const email = "Dashboard.User@example.com";
    const auth = await signIn(test.env, test.sent, email, "https://evil.example/steal");
    const rawToken = new URL(auth.link).searchParams.get("token")!;
    expect(
      await test.env.MEMORY_DB.prepare("SELECT 1 FROM dashboard_magic_links WHERE token_hash = ?")
        .bind(rawToken)
        .first(),
    ).toBeNull();
    expect(
      await test.env.MEMORY_DB.prepare("SELECT 1 FROM dashboard_magic_links WHERE token_hash = ?")
        .bind(await sha256(rawToken))
        .first(),
    ).not.toBeNull();

    const replay = await handleDashboardRequest(new Request(auth.link), test.env);
    expect(await replay.text()).toContain("invalid, expired, or already used");

    const missingOrigin = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard/profile", {
        method: "POST",
        headers: {
          accept: "application/json",
          cookie: auth.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf: auth.csrf, display_name: "Nope" }),
      }),
      test.env,
    );
    expect(missingOrigin.status).toBe(403);

    const opaqueOrigin = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/login", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          origin: "null",
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({ email: "opaque-origin@example.com", return_to: "/dashboard" }),
      }),
      test.env,
    );
    expect(opaqueOrigin.status).toBe(200);

    const spoofedOrigin = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/login", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({ email: "spoofed@example.com", return_to: "/dashboard" }),
      }),
      test.env,
    );
    expect(spoofedOrigin.status).toBe(403);

    const opaqueWithoutMetadata = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/login", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          origin: "null",
        },
        body: new URLSearchParams({ email: "opaque-alone@example.com", return_to: "/dashboard" }),
      }),
      test.env,
    );
    expect(opaqueWithoutMetadata.status).toBe(403);

    const profile = await handleDashboardRequest(
      formRequest(
        "/dashboard/profile",
        { csrf: auth.csrf, display_name: "  Ｍｅｍｏｒｙ User  " },
        auth.cookie,
      ),
      test.env,
    );
    expect(profile.status).toBe(303);
    const user = await test.env.MEMORY_DB.prepare("SELECT display_name FROM users WHERE email = ?")
      .bind(email.toLowerCase())
      .first<{ display_name: string }>();
    expect(user?.display_name).toBe("Memory User");

    const sessionToken = auth.cookie.split("=", 2)[1]!;
    await test.env.MEMORY_DB.prepare(
      "UPDATE dashboard_sessions SET expires_at = ? WHERE token_hash = ?",
    )
      .bind(new Date(0).toISOString(), await sha256(sessionToken))
      .run();
    const expired = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard", {
        headers: { cookie: auth.cookie },
      }),
      test.env,
    );
    expect(expired.status).toBe(303);
    expect(expired.headers.get("location")).toContain("/login?return_to=");
  });

  it("expires links and applies the existing five-per-window rate limit", async () => {
    const test = dashboardEnv();
    const email = "rate-limit@example.com";
    for (let count = 0; count < 6; count += 1) {
      const response = await handleDashboardRequest(
        formRequest("/login", { email, return_to: "/dashboard" }),
        test.env,
      );
      expect(response.status).toBe(200);
    }
    expect(test.sent).toHaveLength(5);
    const link = test.sent[0]?.html?.match(/href="([^"]+)"/)?.[1];
    const token = new URL(link!).searchParams.get("token")!;
    await test.env.MEMORY_DB.prepare(
      "UPDATE dashboard_magic_links SET expires_at = ? WHERE token_hash = ?",
    )
      .bind(new Date(0).toISOString(), await sha256(token))
      .run();
    const expired = await handleDashboardRequest(new Request(link!), test.env);
    expect(await expired.text()).toContain("invalid, expired, or already used");
  });

  it("requires the normalized email, makes the grace period read-only, and cancels", async () => {
    const test = dashboardEnv();
    const auth = await signIn(test.env, test.sent, "grace@example.com");
    const wrong = await handleDashboardRequest(
      formRequest(
        "/dashboard/account/delete",
        { csrf: auth.csrf, confirm_email: "wrong@example.com" },
        auth.cookie,
      ),
      test.env,
    );
    expect(wrong.status).toBe(400);
    const scheduled = await handleDashboardRequest(
      formRequest(
        "/dashboard/account/delete",
        { csrf: auth.csrf, confirm_email: " GRACE@example.com " },
        auth.cookie,
      ),
      test.env,
    );
    expect(scheduled.status).toBe(303);
    const job = await test.env.MEMORY_DB.prepare(
      "SELECT id, due_at FROM deletion_jobs WHERE user_id = (SELECT id FROM users WHERE email = ?)",
    )
      .bind("grace@example.com")
      .first<{ id: string; due_at: string }>();
    expect(Date.parse(job!.due_at) - Date.now()).toBeGreaterThan(6.99 * 86_400_000);

    const blocked = await handleDashboardRequest(
      formRequest("/dashboard/profile", { csrf: auth.csrf, display_name: "Blocked" }, auth.cookie),
      test.env,
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "DELETION_PENDING" } });
    const cancelled = await handleDashboardRequest(
      formRequest("/dashboard/account/cancel", { csrf: auth.csrf, job_id: job!.id }, auth.cookie),
      test.env,
    );
    expect(cancelled.status).toBe(303);
  });

  it("keeps readers, map data, and exports scoped to the signed-in user", async () => {
    const test = dashboardEnv();
    const first = await signIn(test.env, test.sent, "map-one@example.com");
    const second = await signIn(test.env, test.sent, "map-two@example.com");
    const firstUser = await getOrCreateUser(test.env, "map-one@example.com");
    const secondUser = await getOrCreateUser(test.env, "map-two@example.com");
    await grantNamespace(test.env, firstUser.id, "shared-map");
    await grantNamespace(test.env, secondUser.id, "shared-map");
    const own = await createMcpConversation({
      title: "<script>own title</script>",
      namespace: "shared-map",
      tags: ["own-tag"],
      messages: [{ role: "user", content: "<img src=x onerror=alert(1)>" }],
    });
    const foreign = await createMcpConversation({
      title: "foreign title",
      namespace: "shared-map",
      messages: [{ role: "user", content: "foreign secret" }],
    });
    await writeCanonicalConversation(test.env, own, null, null, firstUser.id);
    await writeCanonicalConversation(test.env, foreign, null, null, secondUser.id);

    const reader = await handleDashboardRequest(
      new Request(`https://mempersist.codifiedtech.id/dashboard/conversations/${own.id}`, {
        headers: { cookie: first.cookie },
      }),
      test.env,
    );
    const readerHtml = await reader.text();
    expect(readerHtml).toContain("&lt;script&gt;own title&lt;/script&gt;");
    expect(readerHtml).not.toContain("<img src=x");

    const denied = await handleDashboardRequest(
      new Request(`https://mempersist.codifiedtech.id/dashboard/conversations/${foreign.id}`, {
        headers: { cookie: first.cookie },
      }),
      test.env,
    );
    expect(denied.status).toBe(404);

    const map = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard/mindmap/data", {
        headers: { cookie: first.cookie },
      }),
      test.env,
    );
    const mapJson = await map.json<{ conversations: Array<{ id: string }> }>();
    expect(mapJson.conversations.map((item) => item.id)).toContain(own.id);
    expect(mapJson.conversations.map((item) => item.id)).not.toContain(foreign.id);

    const exported = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard/export", {
        headers: { cookie: first.cookie },
      }),
      test.env,
    );
    const exportJson = await exported.json<{
      format: string;
      conversations: Array<{ id: string; nodes: Array<{ raw: unknown }> }>;
    }>();
    expect(exportJson.format).toBe("mempersist.account-export.v1");
    expect(exportJson.conversations.map((item) => item.id)).toEqual([own.id]);
    expect(exportJson.conversations[0]?.nodes[0]).toHaveProperty("raw");
    expect(second.csrf).toBeTruthy();

    const manifest = await test.env.MEMORY_DB.prepare(
      "SELECT manifest_object_key FROM conversation_revisions WHERE conversation_id = ?",
    )
      .bind(own.id)
      .first<{ manifest_object_key: string }>();
    const manifestJson = await test.env.MEMORY_BUCKET.get(manifest!.manifest_object_key);
    const segmentKey = (await manifestJson!.json<{ segments: Array<{ key: string }> }>())
      .segments[0]!.key;
    await test.env.MEMORY_BUCKET.delete(segmentKey);
    const broken = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard/export", {
        headers: { cookie: first.cookie },
      }),
      test.env,
    );
    await expect(broken.text()).rejects.toThrow();
  });

  it("serves the bundled mindmap without external script hosts", async () => {
    const test = dashboardEnv();
    const auth = await signIn(test.env, test.sent, "mindmap@example.com");
    const user = await getOrCreateUser(test.env, "mindmap@example.com");
    await grantNamespace(test.env, user.id, "work");
    const memory = await createMcpConversation({
      title: "<script>map title</script>",
      namespace: "work",
      tags: ["decision"],
      messages: [{ role: "user", content: "mapped" }],
    });
    await writeCanonicalConversation(test.env, memory, null, null, user.id);

    const response = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard/mindmap", {
        headers: { cookie: auth.cookie },
      }),
      test.env,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).toContain('id="memory-map" class="mindmap-canvas"');
    expect(html).toContain('id="map-tooltip"');
    expect(html).toContain('id="map-collapse-all"');
    expect(html).toContain('id="map-expand-all"');
    expect(html).toContain('id="map-reset-view"');
    expect(html).toContain("window.__mempersistMindmap=");
    expect(html).toContain("&lt;script&gt;map title&lt;/script&gt;");
    expect(html).not.toContain("<script>map title</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('class="tree-list"');
  });
});

describe("asynchronous destructive jobs", () => {
  it("locks, empties, and retains a namespace", async () => {
    const test = dashboardEnv();
    const user = await getOrCreateUser(test.env, "empty@example.com");
    await grantNamespace(test.env, user.id, "work");
    const memory = await createMcpConversation({
      title: "delete me",
      namespace: "work",
      messages: [{ role: "user", content: "gone" }],
    });
    await writeCanonicalConversation(test.env, memory, null, null, user.id);
    const jobId = await scheduleNamespaceDeletion(test.env, user.id, "work");
    await expect(
      deleteConversations(test.env, [memory.id], ["work"], user.id),
    ).rejects.toMatchObject({ code: "DELETION_PENDING", status: 409 });
    await expect(
      writeCanonicalConversation(
        test.env,
        await createMcpConversation({
          title: "blocked",
          namespace: "work",
          messages: [{ role: "user", content: "blocked" }],
        }),
        null,
        null,
        user.id,
      ),
    ).rejects.toMatchObject({ code: "DELETION_PENDING", status: 409 });

    await processDeletionJobMessage(
      test.env,
      { version: 1, job_id: jobId },
      { listUserGrants: vi.fn(), revokeGrant: vi.fn() },
    );
    expect(
      await test.env.MEMORY_DB.prepare(
        "SELECT deletion_job_id FROM user_namespaces WHERE user_id = ? AND namespace = ?",
      )
        .bind(user.id, "work")
        .first<{ deletion_job_id: string | null }>(),
    ).toEqual({ deletion_job_id: null });
    expect(
      await test.env.MEMORY_DB.prepare(
        "SELECT COUNT(*) AS count FROM conversations WHERE user_id = ? AND namespace = ?",
      )
        .bind(user.id, "work")
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("supports grace-period cancellation and fully erases a due account", async () => {
    const test = dashboardEnv();
    const cancelUser = await getOrCreateUser(test.env, "cancel-delete@example.com");
    const scheduled = await scheduleAccountDeletion(test.env, cancelUser.id);
    expect(Date.parse(scheduled.dueAt) - Date.now()).toBeGreaterThan(6.99 * 86_400_000);
    const cancelled = await cancelAccountDeletion(test.env, cancelUser.id, scheduled.jobId);
    expect(cancelled).toBe(true);

    const user = await getOrCreateUser(test.env, "erase@example.com");
    const memory = await createMcpConversation({
      title: "account memory",
      namespace: user.namespace,
      messages: [{ role: "user", content: "erase all" }],
    });
    await writeCanonicalConversation(test.env, memory, null, null, user.id);
    const importId = crypto.randomUUID();
    const rawKey = `raw/imports/${importId}/source/export.json`;
    await test.env.MEMORY_BUCKET.put(rawKey, "[]");
    const timestamp = new Date().toISOString();
    await test.env.MEMORY_DB.prepare(
      `INSERT INTO imports
       (id, source_type, filename, raw_object_key, status, created_at, updated_at, user_id)
       VALUES (?, 'chatgpt', 'export.json', ?, 'complete', ?, ?, ?)`,
    )
      .bind(importId, rawKey, timestamp, timestamp, user.id)
      .run();
    const due = await scheduleAccountDeletion(
      test.env,
      user.id,
      new Date(Date.now() - 8 * 86_400_000),
    );
    await expect(
      writeCanonicalConversation(test.env, memory, null, null, user.id),
    ).rejects.toMatchObject({ code: "DELETION_PENDING" });
    const grants = [
      { id: "grant-1", clientId: "client", userId: user.id, scope: [], metadata: {} },
    ];
    const listUserGrants = vi
      .fn()
      .mockResolvedValueOnce({ items: grants })
      .mockResolvedValue({ items: [] });
    const revokeGrant = vi.fn().mockResolvedValue(undefined);
    for (let step = 0; step < 5; step += 1) {
      await processDeletionJobMessage(
        test.env,
        { version: 1, job_id: due.jobId },
        { listUserGrants, revokeGrant },
      );
    }
    expect(revokeGrant).toHaveBeenCalledWith("grant-1", user.id);
    expect(
      await test.env.MEMORY_DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(user.id).first(),
    ).toBeNull();
    expect(await test.env.MEMORY_BUCKET.head(rawKey)).toBeNull();
  });
});

describe("dashboard namespace browse and mobile nav", () => {
  it("renders hamburger chrome for signed-in session and omits it on login", async () => {
    const test = dashboardEnv();
    const { cookie } = await signIn(test.env, test.sent, "nav-user@example.com");

    const signedIn = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard", {
        headers: { cookie },
      }),
      test.env,
    );
    expect(signedIn.status).toBe(200);
    const signedInHtml = await signedIn.text();
    expect(signedInHtml).toContain('class="dashboard-menu"');
    expect(signedInHtml).toContain('class="nav-toggle"');
    expect(signedInHtml).toContain('class="hamburger"');
    expect(signedInHtml).toContain(">Menu<");

    const login = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/login"),
      test.env,
    );
    expect(login.status).toBe(200);
    const loginHtml = await login.text();
    expect(loginHtml).not.toContain('class="dashboard-menu"');
    expect(loginHtml).not.toContain('class="nav-toggle"');
  });

  it("links namespaces on overview without putting hrefs on empty form", async () => {
    const test = dashboardEnv();
    const user = await getOrCreateUser(test.env, "overview-links@example.com");
    const { cookie } = await signIn(test.env, test.sent, user.email);
    await grantNamespace(test.env, user.id, "personal");
    await grantNamespace(test.env, user.id, "work");

    const c1 = await createMcpConversation({
      title: "personal 1",
      namespace: "personal",
      messages: [{ role: "user", content: "hello 1" }],
    });
    const c2 = await createMcpConversation({
      title: "personal 2",
      namespace: "personal",
      messages: [{ role: "user", content: "hello 2" }],
    });
    const c3 = await createMcpConversation({
      title: "work 1",
      namespace: "work",
      messages: [{ role: "user", content: "work task" }],
    });
    await writeCanonicalConversation(test.env, c1, null, null, user.id);
    await writeCanonicalConversation(test.env, c2, null, null, user.id);
    await writeCanonicalConversation(test.env, c3, null, null, user.id);

    const overview = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard", {
        headers: { cookie },
      }),
      test.env,
    );
    expect(overview.status).toBe(200);
    const html = await overview.text();
    expect(html).toContain('href="/dashboard/namespaces/personal"');
    expect(html).toContain('href="/dashboard/namespaces/work"');
    expect(html).toContain('action="/dashboard/namespaces/empty"');
    expect(html).not.toMatch(/<form[^>]+href="/);
  });

  it("lists only owned conversations in a namespace", async () => {
    const test = dashboardEnv();
    const userA = await getOrCreateUser(test.env, "user-a@example.com");
    const userB = await getOrCreateUser(test.env, "user-b@example.com");
    const { cookie: cookieA } = await signIn(test.env, test.sent, userA.email);
    await grantNamespace(test.env, userA.id, "shared-ns");
    await grantNamespace(test.env, userB.id, "shared-ns");

    const own = await createMcpConversation({
      title: "own memory title",
      namespace: "shared-ns",
      messages: [{ role: "user", content: "secret A" }],
    });
    const foreign = await createMcpConversation({
      title: "foreign memory title",
      namespace: "shared-ns",
      messages: [{ role: "user", content: "secret B" }],
    });
    await writeCanonicalConversation(test.env, own, null, null, userA.id);
    await writeCanonicalConversation(test.env, foreign, null, null, userB.id);

    const res = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard/namespaces/shared-ns", {
        headers: { cookie: cookieA },
      }),
      test.env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("own memory title");
    expect(html).not.toContain("foreign memory title");
    expect(html).not.toContain(foreign.id);
  });

  it("returns 404 for missing or foreign namespace", async () => {
    const test = dashboardEnv();
    const userA = await getOrCreateUser(test.env, "user-a404@example.com");
    const userB = await getOrCreateUser(test.env, "user-b404@example.com");
    const { cookie: cookieA } = await signIn(test.env, test.sent, userA.email);

    await grantNamespace(test.env, userB.id, "b-private-ns");

    const missing = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard/namespaces/not-a-namespace", {
        headers: { cookie: cookieA },
      }),
      test.env,
    );
    expect(missing.status).toBe(404);

    const foreign = await handleDashboardRequest(
      new Request(
        `https://mempersist.codifiedtech.id/dashboard/namespaces/${encodeURIComponent("b-private-ns")}`,
        {
          headers: { cookie: cookieA },
        },
      ),
      test.env,
    );
    expect(foreign.status).toBe(404);
  });

  it("supports namespaces with slashes and encodes overview hrefs", async () => {
    const test = dashboardEnv();
    const user = await getOrCreateUser(test.env, "slash-ns@example.com");
    const { cookie } = await signIn(test.env, test.sent, user.email);

    await grantNamespace(test.env, user.id, "project/mempersist");
    const conv = await createMcpConversation({
      title: "project memory",
      namespace: "project/mempersist",
      messages: [{ role: "user", content: "nested slash content" }],
    });
    await writeCanonicalConversation(test.env, conv, null, null, user.id);

    const overview = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard", {
        headers: { cookie },
      }),
      test.env,
    );
    const overviewHtml = await overview.text();
    expect(overviewHtml).toContain('href="/dashboard/namespaces/project%2Fmempersist"');

    const nsPage = await handleDashboardRequest(
      new Request(
        `https://mempersist.codifiedtech.id/dashboard/namespaces/${encodeURIComponent("project/mempersist")}`,
        {
          headers: { cookie },
        },
      ),
      test.env,
    );
    expect(nsPage.status).toBe(200);
    const nsHtml = await nsPage.text();
    expect(nsHtml).toContain("project memory");
  });

  it("renders empty owned namespace with empty state and empty-namespace form", async () => {
    const test = dashboardEnv();
    const user = await getOrCreateUser(test.env, "empty-ns@example.com");
    const { cookie } = await signIn(test.env, test.sent, user.email);

    await grantNamespace(test.env, user.id, "empty-target");

    const res = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard/namespaces/empty-target", {
        headers: { cookie },
      }),
      test.env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No memories found.");
    expect(html).toContain('action="/dashboard/namespaces/empty"');
    expect(html).toContain('name="confirm_namespace"');
  });

  it("paginates namespace conversations correctly", async () => {
    const test = dashboardEnv();
    const user = await getOrCreateUser(test.env, "paginate-ns@example.com");
    const { cookie } = await signIn(test.env, test.sent, user.email);

    await grantNamespace(test.env, user.id, "bulk-ns");
    for (let i = 1; i <= 21; i += 1) {
      const conv = await createMcpConversation({
        title: `item ${String(i).padStart(2, "0")}`,
        namespace: "bulk-ns",
        messages: [{ role: "user", content: `content ${i}` }],
      });
      await writeCanonicalConversation(test.env, conv, null, null, user.id);
    }

    const page1 = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard/namespaces/bulk-ns?offset=0", {
        headers: { cookie },
      }),
      test.env,
    );
    expect(page1.status).toBe(200);
    const html1 = await page1.text();
    expect(html1).toContain("Next");
    expect(html1).not.toContain("Previous");

    const page2 = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard/namespaces/bulk-ns?offset=20", {
        headers: { cookie },
      }),
      test.env,
    );
    expect(page2.status).toBe(200);
    const html2 = await page2.text();
    expect(html2).toContain("Previous");
  });

  it("includes back links to dashboard and namespace on conversation page", async () => {
    const test = dashboardEnv();
    const user = await getOrCreateUser(test.env, "back-links@example.com");
    const { cookie } = await signIn(test.env, test.sent, user.email);

    const conv = await createMcpConversation({
      title: "my conversation",
      namespace: "docs-ns",
      messages: [{ role: "user", content: "check back link" }],
    });
    await writeCanonicalConversation(test.env, conv, null, null, user.id);

    const res = await handleDashboardRequest(
      new Request(`https://mempersist.codifiedtech.id/dashboard/conversations/${conv.id}`, {
        headers: { cookie },
      }),
      test.env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('href="/dashboard/namespaces/docs-ns"');
  });

  it("escapes malicious script tags in titles on namespace page", async () => {
    const test = dashboardEnv();
    const user = await getOrCreateUser(test.env, "xss-ns@example.com");
    const { cookie } = await signIn(test.env, test.sent, user.email);
    await grantNamespace(test.env, user.id, "safe-ns");

    const conv = await createMcpConversation({
      title: "<script>alert('pwned')</script>",
      namespace: "safe-ns",
      messages: [{ role: "user", content: "safe content" }],
    });
    await writeCanonicalConversation(test.env, conv, null, null, user.id);

    const res = await handleDashboardRequest(
      new Request("https://mempersist.codifiedtech.id/dashboard/namespaces/safe-ns", {
        headers: { cookie },
      }),
      test.env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;alert(&#39;pwned&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('pwned')</script>");
  });
});
