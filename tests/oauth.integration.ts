import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  handleAuthorization,
  MCP_ORIGIN,
  MCP_RESOURCE,
  MCP_SCOPE,
  type OAuthEnv,
} from "../src/oauth";
import { userIdForEmail } from "../src/tenant";

const oauthRequest: AuthRequest = {
  responseType: "code",
  clientId: "chatgpt-client",
  redirectUri: "https://chatgpt.com/connector/oauth/callback",
  scope: [MCP_SCOPE],
  state: "state-123",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
};
const client: ClientInfo = {
  clientId: "chatgpt-client",
  redirectUris: [oauthRequest.redirectUri],
  clientName: "ChatGPT",
  tokenEndpointAuthMethod: "none",
};

function testEnv(redirectTo = "https://chatgpt.com/connector/oauth/callback?code=approved") {
  const completeAuthorization = vi.fn().mockResolvedValue({ redirectTo });
  const helpers = {
    parseAuthRequest: vi.fn().mockResolvedValue(oauthRequest),
    lookupClient: vi.fn().mockResolvedValue(client),
    completeAuthorization,
  } as unknown as OAuthHelpers;
  return {
    env: {
      MEMORY_API_TOKEN: "owner-secret",
      MEMORY_DB: env.MEMORY_DB,
      OAUTH_PROVIDER: helpers,
    } as OAuthEnv,
    completeAuthorization,
  };
}

async function consent(env: OAuthEnv) {
  return handleAuthorization(
    new Request("https://mempersist.example/authorize?client_id=chatgpt-client", {
      method: "GET",
    }),
    env,
  );
}

function csrfFrom(response: Response, html: string): { cookie: string; token: string } {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const token = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!cookie || !token) throw new Error("Consent response did not contain CSRF state");
  return { cookie, token };
}

describe("OAuth authorization consent", () => {
  it("renders a secure navy consent page", async () => {
    const { env } = testEnv();
    const response = await consent(env);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("form-action *");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(html).toContain("Approve this connection");
    expect(html).toContain("#061225");
    expect(html).toContain('name="email" type="email"');
    expect(html).not.toContain("owner-secret");
  });

  it("rejects an invalid email without completing authorization", async () => {
    const { env, completeAuthorization } = testEnv();
    const getResponse = await consent(env);
    const { cookie, token } = csrfFrom(getResponse, await getResponse.text());
    const body = new URLSearchParams({ csrf: token, decision: "allow", email: "not-an-email" });

    const response = await handleAuthorization(
      new Request("https://mempersist.example/authorize?client_id=chatgpt-client", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(body.size),
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Enter a valid email address");
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("completes authorization after a valid email and CSRF state", async () => {
    const redirectTo = "https://chatgpt.com/connector/oauth/callback?code=approved";
    const { env, completeAuthorization } = testEnv(redirectTo);
    const getResponse = await consent(env);
    const { cookie, token } = csrfFrom(getResponse, await getResponse.text());
    const email = "vhie1046@gmail.com";
    const expectedUserId = await userIdForEmail(email);
    const body = new URLSearchParams({
      csrf: token,
      decision: "allow",
      email,
    });

    const response = await handleAuthorization(
      new Request("https://mempersist.example/authorize?client_id=chatgpt-client", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(body.size),
        },
        body,
        redirect: "manual",
      }),
      env,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(redirectTo);
    expect(completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: expectedUserId,
        scope: [MCP_SCOPE],
        props: { userId: expectedUserId, authType: "oauth" },
      }),
    );
    const user = await env.MEMORY_DB.prepare("SELECT id, namespace FROM users WHERE id = ?")
      .bind(expectedUserId)
      .first<{ id: string; namespace: string }>();
    expect(user?.namespace).toBe("personal");
  });
});

describe("OAuth provider", () => {
  it("publishes discovery and completes a PKCE flow into an authenticated MCP request", async () => {
    const protectedMetadata = await SELF.fetch(
      `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(protectedMetadata.status).toBe(200);
    await expect(protectedMetadata.json()).resolves.toMatchObject({
      resource: MCP_RESOURCE,
      authorization_servers: [MCP_ORIGIN],
      scopes_supported: [MCP_SCOPE],
    });

    const serverMetadata = await SELF.fetch(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`);
    expect(serverMetadata.status).toBe(200);
    await expect(serverMetadata.json()).resolves.toMatchObject({
      authorization_endpoint: `${MCP_ORIGIN}/authorize`,
      token_endpoint: `${MCP_ORIGIN}/oauth/token`,
      registration_endpoint: `${MCP_ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });

    const redirectUri = "https://chatgpt.com/connector/oauth/callback";
    const registration = await SELF.fetch(`${MCP_ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT integration test",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    const registrationJson: { client_id: string } = await registration.json();
    const clientId = registrationJson.client_id;

    const verifier = "mempersist-pkce-verifier-for-integration-test-0123456789";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const authorizeUrl = new URL(`${MCP_ORIGIN}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: MCP_SCOPE,
      state: "integration-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_RESOURCE,
    }).toString();

    const consentResponse = await SELF.fetch(authorizeUrl);
    expect(consentResponse.status).toBe(200);
    const consentHtml = await consentResponse.text();
    const { cookie, token: csrf } = csrfFrom(consentResponse, consentHtml);
    const consentBody = new URLSearchParams({
      csrf,
      decision: "allow",
      email: "second-user@example.com",
    });
    const approval = await SELF.fetch(authorizeUrl, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: consentBody,
      redirect: "manual",
    });
    expect(approval.status).toBe(302);
    const callback = new URL(approval.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("integration-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();
    if (!code) throw new Error("OAuth callback did not include an authorization code");

    const tokenResponse = await SELF.fetch(`${MCP_ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: MCP_RESOURCE,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokenJson: { access_token: string } = await tokenResponse.json();
    const accessToken = tokenJson.access_token;

    const initialized = await SELF.fetch(MCP_RESOURCE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: new URL(MCP_ORIGIN).host,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "oauth-integration", version: "1.0.0" },
        },
      }),
    });
    const initializedBody = await initialized.text();
    expect(initialized.status, initializedBody).toBe(200);

    async function mcpCall(id: number, method: string, params: unknown) {
      const response = await SELF.fetch(MCP_RESOURCE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          host: new URL(MCP_ORIGIN).host,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      const text = await response.text();
      const data = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5))
        .join("");
      return JSON.parse(data) as {
        result?: { content?: Array<{ text: string }>; isError?: boolean };
        error?: { message: string };
      };
    }

    const emptyList = await mcpCall(2, "tools/call", {
      name: "memory_list_conversations",
      arguments: {},
    });
    const emptyText = emptyList.result?.content?.[0]?.text;
    expect(JSON.parse(emptyText ?? "{}")).toEqual({ conversations: [], nextCursor: null });

    const ownStore = await mcpCall(3, "tools/call", {
      name: "memory_store",
      arguments: {
        title: "second-user personal",
        namespace: "personal",
        messages: [{ role: "user", content: "second-user content" }],
      },
    });
    expect(ownStore.result?.isError ?? false).toBe(false);

    const ownList = await mcpCall(4, "tools/call", {
      name: "memory_list_conversations",
      arguments: { namespace: "personal" },
    });
    const ownText = ownList.result?.content?.[0]?.text;
    expect(JSON.parse(ownText ?? "{}")).toMatchObject({
      conversations: [{ title: "second-user personal" }],
    });
  });
});
