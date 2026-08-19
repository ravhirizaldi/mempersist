import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { verifySecret } from "./crypto";
import type { AppEnv } from "./domain";
import { getOrCreateUser, isValidEmail } from "./tenant";

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
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · MemPersist</title><style>${PAGE_CSS}</style></head><body><main class="status"><div class="brand"><span class="mark">M</span><span class="wordmark">MemPersist</span></div><section class="status-card"><p class="eyebrow">CONNECTION STATUS</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></section></main></body></html>`,
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
    ? `<p id="email-error" class="form-error" role="alert">${escapeHtml(error)}</p>`
    : "";
  const errorId = error ? " email-error" : "";

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
      <div class="brand"><span class="mark">M</span><span class="wordmark">MemPersist</span><span class="badge" role="status"><i class="dot" aria-hidden="true"></i>OAUTH</span></div>
      <div class="panel-heading">
        <p class="eyebrow">AUTHORIZATION</p>
        <h1 id="page-title">Approve this connection</h1>
        <p class="summary">Allow ${clientName} to use your private conversation archive when you ask.</p>
      </div>

      <ul class="permission">
        <li>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
          <div><strong>Conversation memory</strong><span>Search, retrieve, store, and append memories when you ask.</span></div>
        </li>
      </ul>

      <form method="post" action="${action}">
        <input type="hidden" name="csrf" value="${csrf}">
        <label for="account-email">Your email</label>
        <input id="account-email" name="email" type="email" maxlength="320" required autocomplete="email" autofocus aria-describedby="email-help${errorId}">
        <p id="email-help" class="help">The email tied to your MemPersist archive. It is only used to identify your data and is never shared with the client.</p>
        ${errorMarkup}
        <div class="actions">
          <button class="secondary" type="submit" name="decision" value="deny">Cancel</button>
          <button class="primary" type="submit" name="decision" value="allow">Connect ${clientName}</button>
        </div>
      </form>

      <p class="privacy">This email is used only to identify your archive. You can disconnect the app from ChatGPT at any time.</p>
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
  const previewClientId = new URL(request.url).searchParams.get("client_id");
  if (previewClientId === "DEVMODE" && request.method === "GET") {
    return consentPage(request, {
      clientId: "DEVMODE",
      clientName: "ChatGPT",
      redirectUris: [],
      tokenEndpointAuthMethod: "none",
    });
  }
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

  const email = form.get("email");
  if (typeof email !== "string" || email.length > 320 || !isValidEmail(email)) {
    return consentPage(request, client, "Enter a valid email address to continue.");
  }
  const user = await getOrCreateUser(env, email);

  const requestedScopes = oauthRequest.scope.filter((scope) => scope === MCP_SCOPE);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: user.id,
    metadata: { clientName: client.clientName ?? "Unknown client" },
    scope: requestedScopes.length > 0 ? requestedScopes : [MCP_SCOPE],
    props: { userId: user.id, authType: "oauth" },
  });
  return redirect(redirectTo);
}

const PAGE_CSS = `
:root{color-scheme:dark;font-family:Geist,"Segoe UI",system-ui,sans-serif;background:#061225;color:#eef4ff;font-synthesis:none;font-size:14px}
*{box-sizing:border-box}
html{height:100%}
body{margin:0;height:100dvh;overflow:hidden;background:#061225}
button,input{font:inherit}
.shell{height:100%;display:grid;place-items:center;padding:16px}
.panel{width:min(100%,400px);padding:26px 26px 20px;border:1px solid #243c5c;background:linear-gradient(180deg,#0e1f38 0%,#0a1930 100%);box-shadow:0 28px 70px rgba(1,8,20,.5),inset 0 1px 0 rgba(255,255,255,.04);animation:enter .45s cubic-bezier(.16,1,.3,1) both}
.brand{display:flex;align-items:center;gap:10px}
.mark{display:grid;place-items:center;width:26px;height:26px;border:1px solid #48688f;background:#102746;color:#dceaff;font-size:12px;font-weight:800}
.wordmark{font-size:13px;font-weight:700;letter-spacing:.02em}
.badge{display:inline-flex;align-items:center;gap:6px;margin-left:auto;color:#7d92af;font-family:Geist Mono,ui-monospace,"SF Mono",monospace;font-size:9px;font-weight:600;letter-spacing:.16em}
.badge .dot{width:5px;height:5px;border-radius:50%;background:#7fc9a8;animation:breathe 2.4s ease-in-out infinite}
@keyframes breathe{0%,100%{opacity:.45;transform:scale(1)}50%{opacity:1;transform:scale(1.12)}}
.panel-heading{margin-top:20px;animation:rise .4s cubic-bezier(.16,1,.3,1) .06s both}
.eyebrow{margin:0 0 6px;color:#91add2;font-family:Geist Mono,ui-monospace,"SF Mono",monospace;font-size:10px;font-weight:700;letter-spacing:.18em}
h1{margin:0;font-size:clamp(20px,5.6vw,25px);font-weight:680;letter-spacing:-.03em;line-height:1.08}
.summary{margin:8px 0 0;color:#aebed4;font-size:13px;line-height:1.45}
.permission{list-style:none;margin:18px 0 0;padding:0;border-top:1px solid #22395a;border-bottom:1px solid #22395a;animation:rise .4s cubic-bezier(.16,1,.3,1) .12s both}
.permission li{display:flex;gap:11px;padding:12px 0}
.permission div{display:flex;flex-direction:column;gap:3px}
.permission strong{font-size:12.5px;font-weight:700}
.permission span{color:#91a4bd;font-size:11.5px;line-height:1.4}
.permission svg{flex:0 0 18px;width:18px;margin-top:1px;stroke:#b6d2f5;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
form{margin-top:16px;animation:rise .4s cubic-bezier(.16,1,.3,1) .18s both}
label{display:block;margin-bottom:7px;color:#dce8f8;font-size:12px;font-weight:700}
input[type=email]{width:100%;height:40px;padding:0 12px;border:1px solid #3a5577;border-radius:0;outline:none;background:#07162a;color:#fff;transition:border-color .15s,box-shadow .15s}
input[type=email]:focus{border-color:#8bb8ed;box-shadow:0 0 0 3px rgba(139,184,237,.18)}
input[type=email]::placeholder{color:#5f7490}
.help,.form-error{margin:6px 0 0;font-size:11px;line-height:1.45}
.help{color:#7d92af}.form-error{color:#ffb4b8}
.actions{display:grid;grid-template-columns:auto 1fr;gap:8px;margin-top:16px}
button{min-height:40px;padding:0 16px;border:1px solid transparent;cursor:pointer;font-size:12.5px;font-weight:800;transition:transform .15s cubic-bezier(.16,1,.3,1),background .15s,border-color .15s}
button:hover{transform:translateY(-1px)}button:active{transform:translateY(1px)}button:focus-visible{outline:3px solid rgba(139,184,237,.42);outline-offset:2px}
.secondary{border-color:#3a5577;background:transparent;color:#d9e6f7}.secondary:hover{background:#142943}
.primary{background:#dceaff;color:#07162a}.primary:hover{background:#c9ddf7}
.privacy{margin:16px 0 0;padding-top:12px;border-top:1px solid #1d324e;color:#7d92af;font-size:10.5px;line-height:1.5;animation:rise .4s cubic-bezier(.16,1,.3,1) .24s both}
.status{min-height:100dvh;display:grid;place-content:center;gap:22px;padding:20px;background:#0a1930}
.status-card{width:min(100%,440px);padding:30px;border:1px solid #243c5c;background:linear-gradient(180deg,#0e1f38 0%,#0a1930 100%);box-shadow:0 28px 70px rgba(1,8,20,.5),inset 0 1px 0 rgba(255,255,255,.04);animation:enter .45s cubic-bezier(.16,1,.3,1) both}
.status-card .eyebrow{margin-bottom:10px}
.status-card h1{font-size:clamp(22px,6vw,28px)}
.status-card>p:last-child{margin:10px 0 0;color:#aebed4;font-size:13.5px;line-height:1.6}
@keyframes enter{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media(max-width:420px){.shell{padding:10px}.panel{padding:20px 18px 16px}}
@media(max-height:700px){.panel{padding:20px 22px 16px}.panel-heading{margin-top:14px}.permission{margin-top:12px}.permission li{padding:9px 0}form{margin-top:12px}.privacy{margin-top:12px;padding-top:9px}}
@media(max-height:580px){.panel{padding:16px 20px 14px}.mark{width:22px;height:22px;font-size:11px}.panel-heading{margin-top:10px}.summary{margin-top:6px}.permission{margin-top:10px}.permission li{padding:7px 0}.permission span{font-size:11px}form{margin-top:10px}input[type=email]{height:36px}.actions{margin-top:12px}button{min-height:36px}.privacy{margin-top:10px;padding-top:7px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
