import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { verifySecret } from "./crypto";
import type { AppEnv } from "./domain";

export const MCP_ORIGIN = "https://mempersist.nextostaging.net";
export const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;
export const MCP_SCOPE = "memory";

export type OAuthEnv = AppEnv & { OAUTH_PROVIDER: OAuthHelpers };

const CSRF_COOKIE = "__Host-mempersist_csrf";
const SECURITY_HEADERS = {
  "Cache-Control": "no-store, no-transform",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function csrfCookie(request: Request): string | null {
  const item = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  return item?.slice(CSRF_COOKIE.length + 1) ?? null;
}

function newCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Set-Cookie": `${CSRF_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

function oauthErrorRedirect(request: AuthRequest, code: string, description: string): Response {
  const target = new URL(request.redirectUri);
  target.searchParams.set("error", code);
  target.searchParams.set("error_description", description);
  if (request.state) target.searchParams.set("state", request.state);
  if (request.issuer) target.searchParams.set("iss", request.issuer);
  return redirect(target.toString());
}

function authorizationError(error: AuthorizationError): Response {
  if (error.redirectUri) {
    const target = new URL(error.redirectUri);
    target.searchParams.set("error", error.code);
    target.searchParams.set("error_description", error.description);
    if (error.state) target.searchParams.set("state", error.state);
    if (error.issuer) target.searchParams.set("iss", error.issuer);
    return redirect(target.toString());
  }
  return statusPage("Connection request rejected", error.description, 400);
}

function statusPage(title: string, message: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · MemPersist</title><style>${PAGE_CSS}</style></head><body><main class="status"><div class="brand"><span class="mark">M</span><span>MemPersist</span></div><section class="status-card"><p class="eyebrow">CONNECTION STATUS</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></section></main></body></html>`,
    {
      status,
      headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=UTF-8" },
    },
  );
}

function consentPage(request: Request, client: ClientInfo, error?: string): Response {
  const csrf = newCsrfToken();
  const url = new URL(request.url);
  const action = escapeHtml(`${url.pathname}${url.search}`);
  const rawClientName = client.clientName?.trim() || "ChatGPT";
  const clientName = escapeHtml(rawClientName);
  const errorMarkup = error
    ? `<p id="token-error" class="form-error" role="alert">${escapeHtml(error)}</p>`
    : "";

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connect ${clientName} · MemPersist</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <main class="shell">
    <section class="panel" aria-labelledby="page-title">
      <div class="brand"><span class="mark">M</span><span>MemPersist · Ravhi Rizaldi</span></div>
      <div class="panel-heading">
        <p class="eyebrow">AUTHORIZATION</p>
        <h1 id="page-title">Approve this connection</h1>
        <p class="summary">Allow ${clientName} to use your private conversation archive when you ask.</p>
      </div>

      <div class="permission">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
        <div><strong>Conversation memory</strong><span>Search, retrieve, store, and append memories when you ask.</span></div>
      </div>

      <form method="post" action="${action}">
        <input type="hidden" name="csrf" value="${csrf}">
        <label for="owner-token">Owner access key</label>
        <input id="owner-token" name="owner_token" type="password" maxlength="1024" required autocomplete="current-password" autofocus aria-describedby="token-help${error ? " token-error" : ""}">
        <p id="token-help" class="help">Used for this approval only. It is never logged or stored by this page.</p>
        ${errorMarkup}
        <div class="actions">
          <button class="secondary" type="submit" name="decision" value="deny">Cancel</button>
          <button class="primary" type="submit" name="decision" value="allow">Connect ${clientName}</button>
        </div>
      </form>

      <p class="privacy">Only approve clients you recognize. You can disconnect the app from ChatGPT at any time.</p>
    </section>
  </main>
</body>
</html>`,
    {
      status: error ? 401 : 200,
      headers: {
        ...SECURITY_HEADERS,
        "Content-Security-Policy": SECURITY_HEADERS["Content-Security-Policy"].replace(
          "form-action 'self'",
          "form-action *",
        ),
        "Content-Type": "text/html; charset=UTF-8",
        "Set-Cookie": `${CSRF_COOKIE}=${csrf}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      },
    },
  );
}

export async function handleAuthorization(request: Request, env: OAuthEnv): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationError(error);
    throw error;
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client)
    return statusPage("Unknown client", "The requesting application is not registered.", 400);
  if (request.method === "GET") return consentPage(request, client);
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...SECURITY_HEADERS, Allow: "GET, POST" },
    });
  }

  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length > 16_384) {
    return statusPage("Request too large", "The authorization form exceeded 16 KiB.", 413);
  }
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return statusPage("Unsupported request", "The authorization form format was invalid.", 415);
  }

  const form = await request.formData();
  const submittedCsrf = form.get("csrf");
  const cookieCsrf = csrfCookie(request);
  if (
    typeof submittedCsrf !== "string" ||
    !cookieCsrf ||
    !(await verifySecret(submittedCsrf, cookieCsrf))
  ) {
    return statusPage("Authorization expired", "Reload the connection request and try again.", 403);
  }

  if (form.get("decision") === "deny") {
    return oauthErrorRedirect(oauthRequest, "access_denied", "The owner declined access.");
  }

  const ownerToken = form.get("owner_token");
  if (
    typeof ownerToken !== "string" ||
    ownerToken.length > 1024 ||
    !(await verifySecret(ownerToken, env.MEMORY_API_TOKEN))
  ) {
    return consentPage(request, client, "That access key is not valid. Try again.");
  }

  const requestedScopes = oauthRequest.scope.filter((scope) => scope === MCP_SCOPE);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: "owner",
    metadata: { clientName: client.clientName ?? "Unknown client" },
    scope: requestedScopes.length > 0 ? requestedScopes : [MCP_SCOPE],
    props: { userId: "owner", authType: "oauth" },
  });
  return redirect(redirectTo);
}

const PAGE_CSS = `
:root{color-scheme:dark;font-family:Geist,"Segoe UI",system-ui,sans-serif;background:#061225;color:#eef4ff;font-synthesis:none}
*{box-sizing:border-box}
body{margin:0;height:100dvh;overflow:hidden;background:#061225}
button,input{font:inherit}
.shell{height:100%;display:grid;place-items:center;padding:16px}
.panel{width:min(100%,460px);padding:28px;border:1px solid #29415f;background:#0d1d34;box-shadow:0 24px 64px rgba(1,8,20,.28);animation:enter .35s ease-out both}
.brand{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:700;letter-spacing:.02em}
.mark{display:grid;place-items:center;width:30px;height:30px;border:1px solid #6987ae;background:#102746;color:#dceaff;font-size:13px}
.panel-heading{margin-top:24px}
.eyebrow{margin:0 0 7px;color:#91add2;font-size:10px;font-weight:800;letter-spacing:.16em}
h1{margin:0;font-size:32px;font-weight:650;letter-spacing:-.04em;line-height:1.05}
.summary{margin:10px 0 0;color:#aebed4;font-size:14px;line-height:1.5}
.permission div{display:flex;flex-direction:column;gap:3px}
.permission strong{font-size:13px}
.permission span{color:#91a4bd;font-size:12px;line-height:1.45}
.permission{display:flex;gap:12px;margin-top:20px;padding:14px;border:1px solid #29415f;background:#0a192e}
.permission svg{flex:0 0 22px;width:22px;margin-top:1px;stroke:#b6d2f5;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
form{margin-top:20px}
label{display:block;margin-bottom:9px;color:#dce8f8;font-size:13px;font-weight:700}
input[type=password]{width:100%;height:44px;padding:0 12px;border:1px solid #415c7d;border-radius:0;outline:none;background:#07162a;color:#fff;transition:border-color .15s,box-shadow .15s}
input[type=password]:focus{border-color:#8bb8ed;box-shadow:0 0 0 3px rgba(139,184,237,.16)}
.help,.form-error{margin:7px 0 0;font-size:11px;line-height:1.45}
.help{color:#7f93ad}.form-error{color:#ffb4b8}
.actions{display:grid;grid-template-columns:auto 1fr;gap:8px;margin-top:18px}
button{min-height:44px;padding:0 18px;border:1px solid transparent;cursor:pointer;font-size:13px;font-weight:800;transition:transform .15s,background .15s,border-color .15s}
button:hover{transform:translateY(-1px)}button:active{transform:translateY(0)}button:focus-visible{outline:3px solid rgba(139,184,237,.42);outline-offset:2px}
.secondary{border-color:#405a78;background:transparent;color:#d9e6f7}.secondary:hover{background:#142943}
.primary{background:#dceaff;color:#07162a}.primary:hover{background:#c9ddf7}
.privacy{margin:18px 0 0;padding-top:16px;border-top:1px solid #233a57;color:#8294ad;font-size:11px;line-height:1.45}
.status{min-height:100dvh;display:grid;place-content:center;gap:28px;padding:24px;background:#0a1930}
.status-card{width:min(100%,560px);padding:38px;border:1px solid #29415f;background:#0d1d34}.status-card h1{font-size:42px}.status-card>p:last-child{color:#aebed4;line-height:1.6}
@keyframes enter{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media(max-width:480px){.shell{padding:12px}.panel{padding:22px 18px}.actions{grid-template-columns:1fr}.secondary{order:2}}
@media(max-height:620px){.panel{padding:18px}.panel-heading{margin-top:14px}.permission{margin-top:14px}form{margin-top:14px}.privacy{margin-top:12px;padding-top:10px}}
@media(max-height:520px){body{height:auto;min-height:100dvh;overflow:auto}.shell{height:auto;min-height:100dvh}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
