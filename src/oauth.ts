import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { consumeMagicLink, discardMagicLink, issueMagicLink } from "./auth";
import { verifySecret } from "./crypto";
import type { AppEnv } from "./domain";
import {
  interpolate,
  localeHeaders,
  messages,
  resolveLocale,
  safeReturnPath,
  type Locale,
} from "./i18n";
import { getOrCreateUser, isValidEmail } from "./tenant";
import { BASE_CSS, brand, FAVICON } from "./ui";

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

function authorizationError(error: AuthorizationError, locale: Locale): Response {
  if (error.redirectUri) {
    const target = new URL(error.redirectUri);
    target.searchParams.set("error", error.code);
    target.searchParams.set("error_description", error.description);
    if (error.state) target.searchParams.set("state", error.state);
    if (error.issuer) target.searchParams.set("iss", error.issuer);
    return redirect(target.toString());
  }
  const t = messages(locale).oauth;
  return statusPage(t.rejectedTitle, t.rejectedMessage, 400, locale);
}

function statusPage(title: string, message: string, status: number, locale: Locale): Response {
  const t = messages(locale);
  return new Response(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · MemPersist</title>${FAVICON}<style>${BASE_CSS}${PAGE_CSS}</style></head><body><main class="status">${brand(t.shared.homeLabel)}<section class="status-card" aria-labelledby="status-title"><div class="status-symbol" aria-hidden="true">${status < 400 ? "↗" : "!"}</div><p class="eyebrow">${status < 400 ? t.oauth.statusPending : t.oauth.statusError}</p><h1 id="status-title">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p class="status-help">${status < 400 ? t.oauth.pendingHelp : t.oauth.errorHelp}</p><a class="button secondary" href="/">${t.oauth.back} <span aria-hidden="true">↗</span></a></section><p class="auth-footer">${t.oauth.archiveYours}</p></main></body></html>`,
    {
      status,
      headers: {
        ...SECURITY_HEADERS,
        ...localeHeaders(locale),
        "Content-Type": "text/html; charset=UTF-8",
      },
    },
  );
}

function consentPage(
  request: Request,
  client: ClientInfo,
  locale: Locale,
  error?: string,
): Response {
  const t = messages(locale);
  const csrf = newCsrfToken();
  const url = new URL(request.url);
  const action = escapeHtml(`${url.pathname}${url.search}`);
  const rawClientName = client.clientName?.trim() || "ChatGPT";
  const errorMarkup = error
    ? `<p id="email-error" class="form-error" role="alert">${escapeHtml(error)}</p>`
    : "";
  const errorId = error ? " email-error" : "";
  const returnTo = safeReturnPath(`${url.pathname}${url.search}`, "/authorize");
  const language = `<nav class="language-switch" aria-label="${t.shared.language}"><a href="/language/en?return_to=${encodeURIComponent(returnTo)}" lang="en"${locale === "en" ? ' aria-current="true"' : ""}>EN</a><span aria-hidden="true">/</span><a href="/language/id?return_to=${encodeURIComponent(returnTo)}" lang="id"${locale === "id" ? ' aria-current="true"' : ""}>ID</a></nav>`;

  return new Response(
    `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(interpolate(t.oauth.connectTitle, { client: rawClientName }))} · MemPersist</title>
  ${FAVICON}
  <style>${BASE_CSS}${PAGE_CSS}</style>
</head>
<body>
  <main class="shell">
    <section class="panel" aria-labelledby="page-title">
      <div class="auth-brand">${brand(t.shared.homeLabel)}<div>${language}<span class="badge">${t.oauth.privateConnection}</span></div></div>
      <div class="panel-heading">
        <p class="eyebrow">${t.oauth.contextConnected}</p>
        <h1 id="page-title">${t.oauth.approve}</h1>
        <p class="summary">${escapeHtml(interpolate(t.oauth.summary, { client: rawClientName }))}</p>
      </div>

      <ol class="connection-steps" aria-label="${t.oauth.connectionSteps}"><li aria-current="step"><span>01</span> ${t.oauth.yourEmail}</li><li><span>02</span> ${t.oauth.openLink}</li><li><span>03</span> ${t.oauth.connected}</li></ol>

      <ul class="permission">
        <li>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
          <div><strong>${t.oauth.conversationMemory}</strong><span>${t.oauth.permission}</span></div>
        </li>
      </ul>

      <form method="post" action="${action}">
        <input type="hidden" name="csrf" value="${csrf}">
        <label for="account-email">${t.oauth.yourEmail}</label>
        <input id="account-email" name="email" type="email" maxlength="320" required autocomplete="email" placeholder="you@example.com" aria-invalid="${error ? "true" : "false"}" aria-describedby="email-help${errorId}">
        <p id="email-help" class="help">${t.oauth.emailHelp}</p>
        ${errorMarkup}
        <div class="actions">
          <button class="button secondary" type="submit" name="decision" value="deny" formnovalidate>${t.oauth.cancel}</button>
          <button class="button primary" type="submit">${t.oauth.continueEmail} <span aria-hidden="true">↗</span></button>
        </div>
      </form>

      <details class="privacy"><summary>${t.oauth.emailDetails}</summary><p>${t.oauth.emailDetailsBody}</p></details>
    </section>
    <p class="auth-footer">${t.oauth.footer} <a href="/security">${t.shared.privacy}</a></p>
  </main>
</body>
</html>`,
    {
      status: error ? 401 : 200,
      headers: {
        ...SECURITY_HEADERS,
        ...localeHeaders(locale),
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
  const locale = resolveLocale(request);
  const t = messages(locale).oauth;
  const previewClientId = new URL(request.url).searchParams.get("client_id");
  if (previewClientId === "DEVMODE" && request.method === "GET") {
    return consentPage(
      request,
      {
        clientId: "DEVMODE",
        clientName: "ChatGPT",
        redirectUris: [],
        tokenEndpointAuthMethod: "none",
      },
      locale,
    );
  }
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationError(error, locale);
    throw error;
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return statusPage(t.unknownClientTitle, t.unknownClientMessage, 400, locale);
  if (request.method === "GET") return consentPage(request, client, locale);
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...SECURITY_HEADERS, Allow: "GET, POST" },
    });
  }

  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length > 16_384) {
    return statusPage(t.requestLargeTitle, t.requestLargeMessage, 413, locale);
  }
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return statusPage(t.unsupportedTitle, t.unsupportedMessage, 415, locale);
  }

  const form = await request.formData();
  const submittedCsrf = form.get("csrf");
  const cookieCsrf = csrfCookie(request);
  if (
    typeof submittedCsrf !== "string" ||
    !cookieCsrf ||
    !(await verifySecret(submittedCsrf, cookieCsrf))
  ) {
    return statusPage(t.expiredAuthTitle, t.expiredAuthMessage, 403, locale);
  }

  if (form.get("decision") === "deny") {
    return oauthErrorRedirect(oauthRequest, "access_denied", "The owner declined access.");
  }

  const email = form.get("email");
  if (typeof email !== "string" || email.length > 320 || !isValidEmail(email)) {
    return consentPage(request, client, locale, t.invalidEmail);
  }

  const issue = await issueMagicLink(env, "continue", email, oauthRequest);
  if (!issue) {
    return statusPage(t.checkEmailTitle, t.checkEmailGeneric, 200, locale);
  }

  const magicUrl = `${MCP_ORIGIN}/auth/magic-link?token=${encodeURIComponent(issue.token)}&lang=${locale}`;
  const action = issue.mode === "register" ? t.emailActionRegister : t.emailActionLogin;
  try {
    await env.EMAIL.send({
      to: issue.email,
      from: env.AUTH_EMAIL_FROM,
      subject: t.emailSubject,
      html: `<h1>${t.emailHeading}</h1><p>${interpolate(t.emailInstruction, { action })}</p><p><a href="${escapeHtml(magicUrl)}">${t.emailContinue}</a></p><p>${t.emailExpiry}</p>`,
      text: `${t.emailHeading}\n\n${interpolate(t.emailInstruction, { action })} ${magicUrl}\n\n${t.emailExpiry}`,
    });
  } catch {
    await discardMagicLink(env, issue.tokenHash);
    return statusPage(t.emailUnavailableTitle, t.emailUnavailableMessage, 503, locale);
  }

  return statusPage(t.checkEmailTitle, t.checkEmailSent, 200, locale);
}

export async function handleMagicLink(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const locale = resolveLocale(request, url.searchParams.get("lang"));
  const t = messages(locale).oauth;
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...SECURITY_HEADERS, Allow: "GET" },
    });
  }

  const token = url.searchParams.get("token");
  if (!token || token.length > 128) {
    return statusPage(t.invalidLinkTitle, t.invalidLinkMessage, 400, locale);
  }

  const challenge = await consumeMagicLink(env, token);
  if (!challenge) {
    return statusPage(t.expiredLinkTitle, t.expiredLinkMessage, 400, locale);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(challenge.oauthRequest.clientId);
  if (!client) return statusPage(t.unknownClientTitle, t.unknownClientMessage, 400, locale);

  let user: { id: string; email: string; namespace: string };
  if (challenge.mode === "register") {
    const existing = await env.MEMORY_DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind(challenge.email)
      .first<{ id: string }>();
    if (existing) {
      return statusPage(t.registeredTitle, t.registeredMessage, 409, locale);
    }
    user = await getOrCreateUser(env, challenge.email);
  } else {
    const existingUser = await env.MEMORY_DB.prepare(
      "SELECT id, email, namespace FROM users WHERE email = ?",
    )
      .bind(challenge.email)
      .first<{ id: string; email: string; namespace: string }>();
    if (!existingUser) {
      return statusPage(t.accountMissingTitle, t.accountMissingMessage, 404, locale);
    }
    user = existingUser;
  }

  try {
    const requestedScopes = challenge.oauthRequest.scope.filter((scope) => scope === MCP_SCOPE);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: challenge.oauthRequest,
      userId: user.id,
      metadata: { clientName: client.clientName ?? "Unknown client" },
      scope: requestedScopes.length > 0 ? requestedScopes : [MCP_SCOPE],
      props: { userId: user.id, authType: "oauth" },
    });
    return redirect(redirectTo);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return statusPage(t.expiredAuthTitle, t.expiredAuthMessage, 400, locale);
    }
    throw error;
  }
}

const PAGE_CSS = `
.shell{min-height:100dvh;display:grid;align-content:center;justify-items:center;padding:48px 24px;gap:22px}
.panel{width:min(100%,520px);padding:36px;background:var(--surface);border:1px solid var(--line);border-radius:8px;animation:enter .6s var(--ease)}
.auth-brand{display:flex;align-items:center;justify-content:space-between;gap:18px}
.auth-brand>div{display:flex;align-items:center;gap:14px}
.language-switch{display:flex;align-items:center;gap:5px;font:10px var(--mono);color:var(--muted)}
.language-switch a{text-decoration:none;padding:4px 2px}
.language-switch a[aria-current]{color:var(--accent);font-weight:600}
.badge{font:8px/1.5 var(--mono);letter-spacing:.05em;color:var(--accent);text-align:right}
.panel-heading{margin-top:38px}
.panel-heading .eyebrow{margin-bottom:14px}
h1{margin:0;font-size:clamp(27px,5.6vw,34px);line-height:1.12}
.summary{margin:16px 0 0;font-size:14px;line-height:1.8}
.connection-steps{display:flex;justify-content:space-between;gap:12px;list-style:none;padding:0;margin:28px 0;font-size:10px;color:var(--muted)}
.connection-steps li{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.connection-steps span{font:9px var(--mono)}
.connection-steps [aria-current]{color:var(--accent)}
.permission{list-style:none;margin:0;padding:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.permission li{display:flex;gap:14px;padding:20px 0}
.permission div{display:flex;flex-direction:column;gap:5px}
.permission strong{font-size:13px;font-weight:500}
.permission span{color:var(--muted);font-size:12px;line-height:1.6}
.permission svg{flex:0 0 20px;width:20px;height:24px;stroke:var(--accent);stroke-width:1.7;stroke-linecap:round}
form{margin-top:24px}
label{display:block;margin-bottom:9px;font-size:13px;font-weight:500}
input[type=email]{width:100%;min-height:48px;padding:12px 14px;border:1px solid #a8ada0;border-radius:5px;background:var(--surface);color:var(--ink);font-size:15px;transition:border-color .2s}
input[type=email]:focus{border-color:var(--accent)}
input[type=email][aria-invalid=true]{border-color:#9f2f2d}
input[type=email]::placeholder{color:var(--muted)}
.help,.form-error{margin:10px 0 0;font-size:12px;line-height:1.7}
.form-error{color:#9f2f2d;padding:8px 12px;background:#fdebec;border-radius:4px}
.actions{display:grid;grid-template-columns:auto 1fr;gap:10px;margin-top:24px}
.privacy{margin-top:26px;padding-top:20px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.privacy summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:12px;color:var(--ink)}
.privacy summary::-webkit-details-marker{display:none}
.privacy summary::after{content:"+";font-family:var(--mono);color:var(--accent)}
.privacy[open] summary::after{content:"−"}
.privacy p{margin:12px 0 0;line-height:1.8}
.auth-footer{font-size:11px;max-width:440px;text-align:center;margin:0;line-height:1.8}
.auth-footer a{display:block;margin-top:6px}
.status{min-height:100dvh;width:min(100%,536px);margin:auto;padding:48px 24px;display:grid;align-content:center;gap:28px}
.status-card{padding:32px;background:var(--surface);border:1px solid var(--line);border-radius:8px;animation:enter .6s var(--ease)}
.status-symbol{display:grid;place-items:center;width:44px;height:44px;background:var(--tint);color:var(--accent);border-radius:6px;font-size:24px;margin-bottom:28px}
.status-card .eyebrow{margin-bottom:12px}
.status-card>p{font-size:14px;line-height:1.8}
.status-card .status-help{font-size:12px;border-top:1px solid var(--line);padding-top:20px;margin-top:24px}
.status-card .button{margin-top:16px}
@keyframes enter{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media(max-width:440px){.shell{padding:24px 14px}.panel{padding:24px 20px}.auth-brand{gap:12px}.badge{max-width:80px}.actions{grid-template-columns:1fr}.actions .primary{grid-row:1}.panel-heading{margin-top:28px}.status{padding:32px 16px}.status-card{padding:26px}}
`;
