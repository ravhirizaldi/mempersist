import { z } from "zod";
import { sha256, verifySecret } from "./crypto";
import {
  cancelAccountDeletion,
  scheduleAccountDeletion,
  scheduleNamespaceDeletion,
} from "./deletion-jobs";
import type { AppEnv } from "./domain";
import { AppError } from "./errors";
import { messages, resolveLocale, safeReturnPath, type Locale } from "./i18n";
import { buildMindmapClientScript } from "./mindmap-bundle";
import { LEGACY_MCP_ORIGIN } from "./oauth";
import { getConversationPage } from "./retrieval";
import { listConversations, loadConversationTags, loadCurrentConversation } from "./storage";
import { assertAccountWritable, getOrCreateUser, isValidEmail, normalizeEmail } from "./tenant";
import { BASE_CSS, brand, FAVICON } from "./ui";

const MAGIC_LINK_TTL_SECONDS = 900;
const MAGIC_LINK_MAX_PER_EMAIL = 5;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_COOKIE = "__Host-mempersist_session";
const TOKEN_BYTES = 32;

interface DashboardSession {
  token: string;
  tokenHash: string;
  csrf: string;
  user: {
    id: string;
    email: string;
    namespace: string;
    display_name: string | null;
    deletion_job_id: string | null;
  };
}

interface MindmapConversation {
  id: string;
  title: string;
  namespace: string;
  updated_at: string | null;
  tags: string[];
}

const copy = {
  en: {
    signIn: "Sign in",
    loginTitle: "Continue with email",
    loginBody: "We’ll email a one-use link. Opening it signs you in or creates your archive.",
    email: "Email address",
    sendLink: "Send secure link",
    checkEmail: "Check your email",
    linkSent: "If this address is eligible, a secure link is on its way.",
    invalidLink: "This sign-in link is invalid, expired, or already used.",
    dashboard: "Dashboard",
    memoryMap: "Memory map",
    export: "Export JSON",
    logout: "Log out",
    overview: "Your memory at a glance",
    profile: "Profile",
    displayName: "Display name",
    save: "Save",
    namespaces: "Namespaces",
    conversations: "Conversations",
    messages: "Messages",
    tags: "Tags",
    recent: "Recent conversations",
    empty: "Empty namespace",
    emptyHelp: "Type the exact namespace. It stays available after its memories are erased.",
    deleteNamespace: "Delete namespace",
    deleteHelp: "Type the exact namespace. This removes the namespace and all of its memories.",
    accountDeletion: "Delete account",
    accountHelp: "Type your normalized email. Erasure starts after a seven-day grace period.",
    schedule: "Schedule deletion",
    pending:
      "Account deletion is pending. Your archive is read-only until erasure or cancellation.",
    cancelDeletion: "Cancel deletion",
    search: "Search titles and tags",
    searchButton: "Search",
    loadMore: "Load more",
    loading: "Loading memory map…",
    noMemories: "No memories found.",
    mapError: "The memory map could not be loaded.",
    mapHint:
      "Drag to pan, scroll or use the controls to zoom, select a namespace to collapse it, and hover any memory for details.",
    collapseAll: "Collapse all",
    expandAll: "Expand all",
    resetView: "Reset view",
    accessibleTree: "Accessible memory hierarchy",
    back: "Back to dashboard",
    conversation: "Conversation",
    previous: "Previous",
    next: "Next",
    metadata: "Metadata",
    deleteDue: "Scheduled erasure",
  },
  id: {
    signIn: "Masuk",
    loginTitle: "Lanjutkan dengan email",
    loginBody:
      "Kami akan mengirim tautan sekali pakai. Membukanya akan masuk atau membuat arsip Anda.",
    email: "Alamat email",
    sendLink: "Kirim tautan aman",
    checkEmail: "Periksa email Anda",
    linkSent: "Jika alamat ini memenuhi syarat, tautan aman sedang dikirim.",
    invalidLink: "Tautan masuk ini tidak valid, kedaluwarsa, atau sudah digunakan.",
    dashboard: "Dasbor",
    memoryMap: "Peta memori",
    export: "Ekspor JSON",
    logout: "Keluar",
    overview: "Ringkasan memori Anda",
    profile: "Profil",
    displayName: "Nama tampilan",
    save: "Simpan",
    namespaces: "Namespace",
    conversations: "Percakapan",
    messages: "Pesan",
    tags: "Tag",
    recent: "Percakapan terbaru",
    empty: "Kosongkan namespace",
    emptyHelp: "Ketik namespace persis. Namespace tetap tersedia setelah memorinya dihapus.",
    deleteNamespace: "Hapus namespace",
    deleteHelp: "Ketik namespace persis. Namespace dan semua memorinya akan dihapus.",
    accountDeletion: "Hapus akun",
    accountHelp:
      "Ketik email yang dinormalisasi. Penghapusan dimulai setelah masa tenggang tujuh hari.",
    schedule: "Jadwalkan penghapusan",
    pending: "Penghapusan akun tertunda. Arsip hanya-baca sampai dihapus atau dibatalkan.",
    cancelDeletion: "Batalkan penghapusan",
    search: "Cari judul dan tag",
    searchButton: "Cari",
    loadMore: "Muat lagi",
    loading: "Memuat peta memori…",
    noMemories: "Tidak ada memori ditemukan.",
    mapError: "Peta memori tidak dapat dimuat.",
    mapHint:
      "Seret untuk menggeser, gulir atau gunakan kontrol untuk memperbesar, pilih namespace untuk melipatnya, dan arahkan kursor ke memori mana pun untuk detail.",
    collapseAll: "Lipat semua",
    expandAll: "Buka semua",
    resetView: "Atur ulang tampilan",
    accessibleTree: "Hierarki memori yang aksesibel",
    back: "Kembali ke dasbor",
    conversation: "Percakapan",
    previous: "Sebelumnya",
    next: "Berikutnya",
    metadata: "Metadata",
    deleteDue: "Penghapusan terjadwal",
  },
} as const;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
function renderTagLinks(tags: string[]): string {
  return tags
    .map(
      (tag) =>
        `<a href="/dashboard/mindmap?q=${encodeURIComponent(tag)}"><span class="truncate">${escapeHtml(tag)}</span></a>`,
    )
    .join("");
}

function namespaceMutationForm(
  csrf: string,
  namespace: string,
  action: "empty" | "delete",
  label: string,
  help: string,
): string {
  const endpoint = `/dashboard/namespaces/${action}`;
  return `<details class="ns-empty${action === "delete" ? " ns-delete" : ""}"><summary>${escapeHtml(label)}</summary><form method="post" action="${endpoint}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="namespace" value="${escapeHtml(namespace)}"><label><span>${escapeHtml(help)}</span><input name="confirm_namespace" required autocomplete="off" placeholder="${escapeHtml(namespace)}"></label><button class="button danger" type="submit">${escapeHtml(label)}</button></form></details>`;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function cookieValue(request: Request, name: string): string | null {
  const prefix = `${name}=`;
  const part = request.headers
    .get("cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  return part?.slice(prefix.length) ?? null;
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function sameOrigin(request: Request): boolean {
  const expected = new URL(request.url).origin;
  const rawOrigin = request.headers.get("origin")?.trim();
  // Browsers send the literal string "null" for opaque-origin navigations
  // (privacy mode, DNT, extensions). It carries no origin signal, so fall
  // through to Referer / Fetch Metadata instead of comparing "null".
  if (rawOrigin && rawOrigin.toLowerCase() !== "null") {
    return rawOrigin === expected;
  }

  const referer = request.headers.get("referer");
  if (referer !== null) {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }

  return request.headers.get("sec-fetch-site") === "same-origin";
}

function nonce(): string {
  return randomToken();
}

function htmlHeaders(locale: Locale, value: string): HeadersInit {
  return {
    "Cache-Control": "no-store, no-transform",
    "Content-Language": locale,
    "Content-Security-Policy": `default-src 'none'; script-src 'self' 'nonce-${value}' https://static.cloudflareinsights.com; style-src 'self' 'nonce-${value}' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://cloudflareinsights.com https://static.cloudflareinsights.com; manifest-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    "Content-Type": "text/html; charset=UTF-8",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    Vary: "Accept-Language, Cookie",
  };
}
const DASHBOARD_MENU_SCRIPT = `(()=>{const n=document.querySelector('.dashboard-nav');if(!n)return;const m=n.querySelector('.dashboard-menu'),t=m?.querySelector('.nav-toggle'),p=m?.querySelector('.nav-panel');if(!m||!t||!p)return;const s=document.createElement('div');s.className='nav-scrim';s.hidden=true;s.setAttribute('aria-hidden','true');n.appendChild(s);const f='a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])';t.setAttribute('aria-expanded','false');function sync(){if(m.open){s.hidden=false;t.setAttribute('aria-expanded','true');document.body.style.overflow='hidden';window.requestAnimationFrame(()=>{s.classList.add('open');const first=p.querySelector(f);if(first)first.focus();});}else{s.classList.remove('open');t.setAttribute('aria-expanded','false');document.body.style.overflow='';window.setTimeout(()=>{if(!m.open)s.hidden=true;},400);}}m.addEventListener('toggle',sync);function closeMenu(restore=true){if(!m.open)return;m.open=false;sync();if(restore)t.focus();}s.addEventListener('click',()=>closeMenu(true));p.addEventListener('click',e=>{if(e.target.closest('a,button'))closeMenu(true);});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&m.open)closeMenu(true);});m.addEventListener('keydown',e=>{if(e.key!=='Tab'||!m.open)return;const items=[...p.querySelectorAll(f)];if(!items.length)return;const a=document.activeElement;if(e.shiftKey){if(a===items[0]){t.focus();e.preventDefault();}else if(a===t){items[items.length-1].focus();e.preventDefault();}else if(!p.contains(a)){items[items.length-1].focus();e.preventDefault();}}else{if(a===items[items.length-1]){t.focus();e.preventDefault();}else if(a===t){items[0].focus();e.preventDefault();}else if(!p.contains(a)){items[0].focus();e.preventDefault();}}});window.matchMedia('(min-width: 769px)').addEventListener('change',e=>{if(e.matches)closeMenu(false);});})();`;

function page(
  title: string,
  body: string,
  locale: Locale,
  requestPath: string,
  options: { session?: DashboardSession; script?: string; status?: number } = {},
): Response {
  const n = nonce();
  const t = copy[locale];
  const language = `<nav class="language" aria-label="${messages(locale).shared.language}"><a href="/language/en?return_to=${encodeURIComponent(requestPath)}" lang="en"${locale === "en" ? ' aria-current="true"' : ""}>EN</a><span>/</span><a href="/language/id?return_to=${encodeURIComponent(requestPath)}" lang="id"${locale === "id" ? ' aria-current="true"' : ""}>ID</a></nav>`;
  const pathname = requestPath.split("?")[0] ?? requestPath;
  const dashboardCurrent =
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/namespaces/") ||
    pathname.startsWith("/dashboard/conversations/");
  const mapCurrent = pathname === "/dashboard/mindmap";
  const nav = options.session
    ? `<nav class="dashboard-nav" aria-label="${messages(locale).shared.mainNav}">${brand(messages(locale).shared.homeLabel)}<details class="dashboard-menu"><summary class="nav-toggle" aria-haspopup="true"><span class="hamburger" aria-hidden="true"></span><span class="sr-only">${messages(locale).shared.menu}</span></summary><div class="nav-panel"><a href="/dashboard"${dashboardCurrent ? ' aria-current="page"' : ""}>${t.dashboard}</a><a href="/dashboard/mindmap"${mapCurrent ? ' aria-current="page"' : ""}>${t.memoryMap}</a><a href="/dashboard/export">${t.export}</a>${language}<form method="post" action="/logout"><input type="hidden" name="csrf" value="${options.session.csrf}"><button class="link-button" type="submit">${t.logout}</button></form></div></details></nav>`
    : `<nav class="dashboard-nav">${brand(messages(locale).shared.homeLabel)}<div>${language}</div></nav>`;
  return new Response(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · MemPersist</title>${FAVICON}<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"><style nonce="${n}">${BASE_CSS}${DASHBOARD_CSS}</style></head><body><a class="skip-link" href="#main">${messages(locale).shared.skip}</a>${nav}<main id="main" class="dashboard-shell" tabindex="-1">${body}</main>${options.session ? `<script nonce="${n}">${DASHBOARD_MENU_SCRIPT}</script>` : ""}${options.script ? `<script nonce="${n}">${options.script}</script>` : ""}</body></html>`,
    {
      headers: htmlHeaders(locale, n),
      ...(options.status === undefined ? {} : { status: options.status }),
    },
  );
}

async function formData(request: Request): Promise<FormData> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length > 16_384) {
    throw new AppError("VALIDATION", "Form exceeds 16 KiB", 413);
  }
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    throw new AppError("VALIDATION", "Expected a form submission", 415);
  }
  return request.formData();
}

async function issueMagicLink(
  env: AppEnv,
  email: string,
  returnTo: string,
  now = new Date(),
): Promise<{ token: string; tokenHash: string; email: string } | null> {
  const normalized = normalizeEmail(email);
  const createdAt = now.toISOString();
  const cutoff = new Date(now.valueOf() - MAGIC_LINK_TTL_SECONDS * 1000).toISOString();
  const recent = await env.MEMORY_DB.prepare(
    "SELECT COUNT(*) AS count FROM dashboard_magic_links WHERE email = ? AND created_at > ?",
  )
    .bind(normalized, cutoff)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= MAGIC_LINK_MAX_PER_EMAIL) return null;
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(now.valueOf() + MAGIC_LINK_TTL_SECONDS * 1000).toISOString();
  await env.MEMORY_DB.batch([
    env.MEMORY_DB.prepare(
      "DELETE FROM dashboard_magic_links WHERE consumed_at IS NOT NULL OR expires_at <= ?",
    ).bind(createdAt),
    env.MEMORY_DB.prepare(
      `INSERT INTO dashboard_magic_links
       (token_hash, email, return_to, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(tokenHash, normalized, safeReturnPath(returnTo, "/dashboard"), createdAt, expiresAt),
  ]);
  return { token, tokenHash, email: normalized };
}

async function consumeMagicLink(
  env: AppEnv,
  token: string,
  now = new Date(),
): Promise<{ email: string; return_to: string } | null> {
  const tokenHash = await sha256(token);
  const timestamp = now.toISOString();
  const consumed = await env.MEMORY_DB.prepare(
    `UPDATE dashboard_magic_links SET consumed_at = ?
     WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  )
    .bind(timestamp, tokenHash, timestamp)
    .run();
  if (consumed.meta.changes !== 1) return null;
  return env.MEMORY_DB.prepare(
    "SELECT email, return_to FROM dashboard_magic_links WHERE token_hash = ?",
  )
    .bind(tokenHash)
    .first<{ email: string; return_to: string }>();
}

async function createSession(env: AppEnv, userId: string, now = new Date()): Promise<string> {
  const token = randomToken();
  const hash = await sha256(token);
  const createdAt = now.toISOString();
  await env.MEMORY_DB.batch([
    env.MEMORY_DB.prepare("DELETE FROM dashboard_sessions WHERE expires_at <= ?").bind(createdAt),
    env.MEMORY_DB.prepare(
      "INSERT INTO dashboard_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(
      hash,
      userId,
      createdAt,
      new Date(now.valueOf() + SESSION_TTL_SECONDS * 1000).toISOString(),
    ),
  ]);
  return token;
}

async function readSession(request: Request, env: AppEnv): Promise<DashboardSession | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const tokenHash = await sha256(token);
  const user = await env.MEMORY_DB.prepare(
    `SELECT users.id, users.email, users.namespace, users.display_name, users.deletion_job_id
     FROM dashboard_sessions sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  )
    .bind(tokenHash, new Date().toISOString())
    .first<DashboardSession["user"]>();
  if (!user) return null;
  return { token, tokenHash, csrf: await sha256(`dashboard-csrf:${token}`), user };
}

async function requireMutation(request: Request, session: DashboardSession): Promise<FormData> {
  if (!sameOrigin(request)) throw new AppError("AUTHENTICATION", "Same-origin form required", 403);
  const form = await formData(request);
  const submitted = form.get("csrf");
  if (typeof submitted !== "string" || !(await verifySecret(submitted, session.csrf))) {
    throw new AppError("AUTHENTICATION", "Invalid CSRF token", 403);
  }
  return form;
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function errorResponse(request: Request, error: unknown, locale: Locale): Response {
  const appError = error instanceof AppError ? error : null;
  const status = appError?.status ?? 500;
  const code = appError?.code ?? "RETRYABLE_INFRASTRUCTURE";
  const message = appError?.message ?? "Internal server error";
  const accept = request.headers.get("accept") ?? "";
  const path = new URL(request.url).pathname;
  if (accept.includes("text/html") && path !== "/dashboard/mindmap/data") {
    const t = copy[locale];
    return page(
      t.signIn,
      `<section class="auth-card"><p class="eyebrow">${escapeHtml(code)}</p><h1>${escapeHtml(message)}</h1><p>${escapeHtml(t.linkSent)}</p><a class="button secondary" href="/login">${escapeHtml(t.signIn)}</a></section>`,
      locale,
      path,
      { status },
    );
  }
  return Response.json(
    {
      error: {
        code,
        message,
      },
    },
    {
      status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    },
  );
}

async function login(request: Request, env: AppEnv, locale: Locale): Promise<Response> {
  const t = copy[locale];
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get("return_to"), "/dashboard");
  if (request.method === "GET") {
    if (await readSession(request, env)) return redirect(returnTo);
    return page(
      t.loginTitle,
      `<section class="auth-card"><div class="auth-header"><span class="dash-badge">PASSWORDLESS</span><h1>${t.loginTitle}</h1><p>${t.loginBody}</p></div><form method="post" action="/login"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><label for="email"><span>${t.email}</span><input id="email" name="email" type="email" required maxlength="320" autocomplete="email" placeholder="name@domain.com"></label><button class="button" type="submit">${t.sendLink} <span aria-hidden="true">↗</span></button></form></section>`,
      locale,
      `/login?return_to=${encodeURIComponent(returnTo)}`,
    );
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!sameOrigin(request)) throw new AppError("AUTHENTICATION", "Same-origin form required", 403);
  const form = await formData(request);
  const email = form.get("email");
  const requestedReturn = form.get("return_to");
  if (typeof email !== "string" || email.length > 320 || !isValidEmail(email)) {
    throw new AppError("VALIDATION", "Enter a valid email address", 400);
  }
  const issue = await issueMagicLink(
    env,
    email,
    typeof requestedReturn === "string" ? requestedReturn : "/dashboard",
  );
  if (issue) {
    const origin = new URL(request.url).origin;
    const url = `${origin}/auth/dashboard?token=${encodeURIComponent(issue.token)}&lang=${locale}`;
    try {
      await env.EMAIL.send({
        to: issue.email,
        from: origin === LEGACY_MCP_ORIGIN ? env.LEGACY_AUTH_EMAIL_FROM : env.AUTH_EMAIL_FROM,
        subject: locale === "id" ? "Tautan masuk MemPersist Anda" : "Your MemPersist sign-in link",
        html: `<h1>${t.loginTitle}</h1><p><a href="${escapeHtml(url)}">${t.signIn}</a></p><p>${messages(locale).oauth.emailExpiry}</p>`,
        text: `${t.loginTitle}\n\n${url}\n\n${messages(locale).oauth.emailExpiry}`,
      });
    } catch {
      await env.MEMORY_DB.prepare("DELETE FROM dashboard_magic_links WHERE token_hash = ?")
        .bind(issue.tokenHash)
        .run();
      throw new AppError("RETRYABLE_INFRASTRUCTURE", "Email is temporarily unavailable", 503);
    }
  }
  return page(
    t.checkEmail,
    `<section class="auth-card"><div class="auth-header"><span class="dash-badge">${t.checkEmail}</span><h1>${t.checkEmail}</h1><p>${t.linkSent}</p></div><div class="auth-actions"><a class="button secondary" href="/">${messages(locale).oauth.back}</a></div></section>`,
    locale,
    "/login",
  );
}

async function callback(request: Request, env: AppEnv, locale: Locale): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  const consumed = token && token.length <= 128 ? await consumeMagicLink(env, token) : null;
  if (!consumed) {
    return page(
      copy[locale].invalidLink,
      `<section class="auth-card"><h1>${copy[locale].invalidLink}</h1><a class="button" href="/login">${copy[locale].signIn}</a></section>`,
      locale,
      "/auth/dashboard",
    );
  }
  const user = await getOrCreateUser(env, consumed.email);
  const session = await createSession(env, user.id);
  return redirect(safeReturnPath(consumed.return_to, "/dashboard"), sessionCookie(session));
}

async function dashboardData(env: AppEnv, userId: string) {
  const namespaces = await env.MEMORY_DB.prepare(
    `SELECT un.namespace, un.deletion_job_id,
            COUNT(DISTINCT c.id) AS conversations, COUNT(n.id) AS messages
     FROM user_namespaces un
     LEFT JOIN conversations c
       ON c.user_id = un.user_id AND c.namespace = un.namespace AND c.deleted_at IS NULL
     LEFT JOIN conversation_revisions r ON r.id = c.current_revision_id
     LEFT JOIN message_nodes n ON n.revision_id = r.id
     WHERE un.user_id = ? GROUP BY un.namespace ORDER BY un.namespace`,
  )
    .bind(userId)
    .all<{
      namespace: string;
      deletion_job_id: string | null;
      conversations: number;
      messages: number;
    }>();
  const recent = await env.MEMORY_DB.prepare(
    `SELECT id, title, namespace, updated_at FROM conversations
     WHERE user_id = ? AND deleted_at IS NULL ORDER BY COALESCE(updated_at, created_at) DESC, id LIMIT 10`,
  )
    .bind(userId)
    .all<{ id: string; title: string; namespace: string; updated_at: string | null }>();
  const deletion = await env.MEMORY_DB.prepare(
    `SELECT jobs.id, jobs.due_at FROM deletion_jobs jobs
     JOIN users ON users.deletion_job_id = jobs.id
     WHERE users.id = ? AND jobs.kind = 'account'`,
  )
    .bind(userId)
    .first<{ id: string; due_at: string }>();
  return { namespaces: namespaces.results, recent: recent.results, deletion };
}
async function listNamespaceConversations(
  env: AppEnv,
  userId: string,
  namespace: string,
  offset: number,
): Promise<{
  conversations: Array<{ id: string; title: string; updated_at: string | null }>;
  total: number;
}> {
  const countRow = await env.MEMORY_DB.prepare(
    `SELECT COUNT(*) AS total FROM conversations
     WHERE user_id = ? AND namespace = ? AND deleted_at IS NULL`,
  )
    .bind(userId, namespace)
    .first<{ total: number }>();
  const rows = await env.MEMORY_DB.prepare(
    `SELECT id, title, updated_at FROM conversations
     WHERE user_id = ? AND namespace = ? AND deleted_at IS NULL
     ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
     LIMIT 20 OFFSET ?`,
  )
    .bind(userId, namespace, offset)
    .all<{ id: string; title: string; updated_at: string | null }>();
  return {
    conversations: rows.results,
    total: countRow?.total ?? 0,
  };
}

async function namespacePage(
  request: Request,
  env: AppEnv,
  locale: Locale,
  session: DashboardSession,
  namespace: string,
): Promise<Response> {
  const t = copy[locale];
  const url = new URL(request.url);
  const offset = z.coerce.number().int().min(0).catch(0).parse(url.searchParams.get("offset"));
  const nsRow = await env.MEMORY_DB.prepare(
    "SELECT namespace, deletion_job_id FROM user_namespaces WHERE user_id = ? AND namespace = ?",
  )
    .bind(session.user.id, namespace)
    .first<{ namespace: string; deletion_job_id: string | null }>();
  if (!nsRow) {
    throw new AppError("NOT_FOUND", "Namespace not found", 404);
  }
  const data = await listNamespaceConversations(env, session.user.id, namespace, offset);
  const rows = data.conversations.length
    ? data.conversations
        .map(
          (item) =>
            `<li><a href="/dashboard/conversations/${encodeURIComponent(item.id)}"><div class="recent-main"><strong class="truncate">${escapeHtml(item.title)}</strong></div><span class="recent-date truncate">${item.updated_at ? escapeHtml(item.updated_at) : ""}</span><span class="recent-arrow" aria-hidden="true">→</span></a></li>`,
        )
        .join("")
    : `<li><div class="empty-state"><strong>${t.noMemories}</strong></div></li>`;
  const previous = offset > 0 ? Math.max(0, offset - 20) : null;
  const next = offset + 20 < data.total ? offset + 20 : null;
  const namespaceActions = nsRow.deletion_job_id
    ? `<p class="ns-meta"><span>${t.pending}</span></p>`
    : `<div class="namespace-actions">${namespaceMutationForm(session.csrf, namespace, "empty", t.empty, t.emptyHelp)}${namespaceMutationForm(session.csrf, namespace, "delete", t.deleteNamespace, t.deleteHelp)}</div>`;

  return page(
    namespace,
    `<p class="dash-back"><a href="/dashboard">← ${t.back}</a></p><header class="dash-head"><div><span class="dash-badge">${t.namespaces}</span><h1 class="truncate">${escapeHtml(namespace)}</h1><p>${data.total} ${t.conversations.toLowerCase()}</p></div></header><section class="card"><ul class="recent-list">${rows}</ul></section>${namespaceActions}<nav class="pagination" aria-label="Pagination">${previous === null ? "" : `<a class="button secondary" href="?offset=${previous}">${t.previous}</a>`}${next === null ? "" : `<a class="button secondary" href="?offset=${next}">${t.next}</a>`}</nav>`,
    locale,
    url.pathname + url.search,
    { session },
  );
}

async function overview(
  request: Request,
  env: AppEnv,
  locale: Locale,
  session: DashboardSession,
): Promise<Response> {
  const t = copy[locale];
  const data = await dashboardData(env, session.user.id);
  const totals = data.namespaces.reduce(
    (value, row) => ({
      conversations: value.conversations + row.conversations,
      messages: value.messages + row.messages,
    }),
    { conversations: 0, messages: 0 },
  );
  const namespaceRows = data.namespaces
    .map((row) => {
      const actions = row.deletion_job_id
        ? `<p class="ns-meta ns-pending"><span>${t.pending}</span></p>`
        : `<div class="namespace-actions">${namespaceMutationForm(session.csrf, row.namespace, "empty", t.empty, t.emptyHelp)}${namespaceMutationForm(session.csrf, row.namespace, "delete", t.deleteNamespace, t.deleteHelp)}</div>`;
      return `<li><a class="ns-link" href="/dashboard/namespaces/${encodeURIComponent(row.namespace)}"><span class="ns-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></span><div class="ns-meta"><strong class="truncate">${escapeHtml(row.namespace)}</strong><span>${row.conversations} ${t.conversations.toLowerCase()} · ${row.messages} ${t.messages.toLowerCase()}</span></div></a>${actions}</li>`;
    })
    .join("");
  const recent = data.recent.length
    ? data.recent
        .map(
          (item) =>
            `<li><a href="/dashboard/conversations/${encodeURIComponent(item.id)}"><div class="recent-main"><strong class="truncate">${escapeHtml(item.title)}</strong><span class="recent-ns-tag truncate">${escapeHtml(item.namespace)}</span></div><span class="recent-date truncate">${item.updated_at ? escapeHtml(item.updated_at) : ""}</span><span class="recent-arrow" aria-hidden="true">→</span></a></li>`,
        )
        .join("")
    : `<li><div class="empty-state"><strong>${t.noMemories}</strong></div></li>`;
  const account = data.deletion
    ? `<div class="notice" role="status"><strong>${t.pending}</strong><span class="truncate">${t.deleteDue}: ${escapeHtml(data.deletion.due_at)}</span><form method="post" action="/dashboard/account/cancel"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="job_id" value="${data.deletion.id}"><button class="button secondary" type="submit">${t.cancelDeletion}</button></form></div>`
    : `<section class="card danger-zone"><details><summary><strong>${t.accountDeletion}</strong></summary><p>${t.accountHelp}</p><form method="post" action="/dashboard/account/delete"><input type="hidden" name="csrf" value="${session.csrf}"><label>${t.email}<input name="confirm_email" type="email" required autocomplete="off" placeholder="${escapeHtml(session.user.email)}"></label><button class="button danger" type="submit">${t.schedule}</button></form></details></section>`;
  return page(
    t.dashboard,
    `<header class="dash-head dash-hero"><div class="dash-intro"><span class="dash-badge">${t.dashboard}</span><h1 class="truncate">${escapeHtml(session.user.display_name ?? session.user.email)}</h1><p>${t.overview}</p></div><div class="dash-hero-rail"><div class="dash-actions"><a class="button secondary" href="/dashboard/mindmap">${t.memoryMap} <span aria-hidden="true">↗</span></a><a class="button secondary" href="/dashboard/export">${t.export} <span aria-hidden="true">↓</span></a></div><div class="dash-metrics" aria-label="${escapeHtml(t.dashboard)}"><div class="dash-metric"><strong>${data.namespaces.length}</strong><span>${t.namespaces}</span></div><div class="dash-metric"><strong>${totals.conversations}</strong><span>${t.conversations}</span></div><div class="dash-metric"><strong>${totals.messages}</strong><span>${t.messages}</span></div></div></div></header>${data.deletion ? account : ""}<div class="dash-main"><div class="dash-side"><section class="card"><h2>${t.profile}</h2><form method="post" action="/dashboard/profile"><input type="hidden" name="csrf" value="${session.csrf}"><label>${t.displayName}<input name="display_name" maxlength="80" required value="${escapeHtml(session.user.display_name ?? "")}" placeholder="${escapeHtml(session.user.email)}"></label><button class="button" type="submit"${data.deletion ? " disabled" : ""}>${t.save}</button></form></section>${data.deletion ? "" : account}</div><div class="dash-content"><section class="card"><div class="section-heading"><h2>${t.namespaces}</h2><a class="action-link" href="/dashboard/mindmap">${t.memoryMap} <span aria-hidden="true">→</span></a></div><ul class="namespace-list">${namespaceRows}</ul></section><section class="card"><div class="section-heading"><h2>${t.recent}</h2></div><ul class="recent-list">${recent}</ul></section></div></div>`,
    locale,
    new URL(request.url).pathname,
    { session },
  );
}

function likePattern(value: string): string {
  return `%${value.toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

async function mindmapData(
  env: AppEnv,
  userId: string,
  input: { namespace?: string; cursor?: string; q?: string; limit: number },
): Promise<{
  namespaces: Array<{ namespace: string; conversations: number }>;
  conversations: MindmapConversation[];
  nextCursor: string | null;
}> {
  const namespaceRows = await env.MEMORY_DB.prepare(
    `SELECT un.namespace, COUNT(c.id) AS conversations
     FROM user_namespaces un LEFT JOIN conversations c
       ON c.user_id = un.user_id AND c.namespace = un.namespace AND c.deleted_at IS NULL
     WHERE un.user_id = ? GROUP BY un.namespace ORDER BY un.namespace`,
  )
    .bind(userId)
    .all<{ namespace: string; conversations: number }>();
  const where = ["user_id = ?", "deleted_at IS NULL"];
  const params: Array<string | number> = [userId];
  if (input.namespace) {
    where.push("namespace = ?");
    params.push(input.namespace);
  }
  if (input.cursor) {
    where.push("id > ?");
    params.push(input.cursor);
  }
  if (input.q) {
    where.push(
      `(LOWER(title) LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM conversation_tags tags
        WHERE tags.conversation_id = conversations.id AND LOWER(tags.tag) LIKE ? ESCAPE '\\'
      ))`,
    );
    const pattern = likePattern(input.q);
    params.push(pattern, pattern);
  }
  params.push(input.limit + 1);
  const rows = await env.MEMORY_DB.prepare(
    `SELECT id, title, namespace, updated_at FROM conversations
     WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`,
  )
    .bind(...params)
    .all<Omit<MindmapConversation, "tags">>();
  const hasMore = rows.results.length > input.limit;
  if (hasMore) rows.results.pop();
  const tags = await loadConversationTags(
    env,
    rows.results.map((row) => row.id),
  );
  return {
    namespaces: namespaceRows.results,
    conversations: rows.results.map((row) => ({ ...row, tags: tags.get(row.id) ?? [] })),
    nextCursor: hasMore ? (rows.results.at(-1)?.id ?? null) : null,
  };
}

function accessibleTree(data: Awaited<ReturnType<typeof mindmapData>>, locale: Locale): string {
  const t = copy[locale];
  if (!data.namespaces.length) return `<p>${t.noMemories}</p>`;
  return `<ul class="tree-list">${data.namespaces
    .map((namespace) => {
      const children = data.conversations
        .filter((conversation) => conversation.namespace === namespace.namespace)
        .map(
          (conversation) =>
            `<li><a class="truncate" href="/dashboard/conversations/${encodeURIComponent(conversation.id)}">${escapeHtml(conversation.title)}</a>${conversation.tags.length ? `<span>${renderTagLinks(conversation.tags)}</span>` : ""}</li>`,
        )
        .join("");
      return `<li><details open><summary><span class="truncate">${escapeHtml(namespace.namespace)} (${namespace.conversations})</span></summary><ul>${children || `<li>${t.noMemories}</li>`}</ul></details></li>`;
    })
    .join("")}</ul>`;
}

async function mindmap(
  request: Request,
  env: AppEnv,
  locale: Locale,
  session: DashboardSession,
): Promise<Response> {
  const t = copy[locale];
  const initialQuery = z
    .string()
    .max(100)
    .catch("")
    .parse(new URL(request.url).searchParams.get("q") ?? "")
    .trim();
  const initial = await mindmapData(env, session.user.id, {
    limit: 50,
    ...(initialQuery ? { q: initialQuery } : {}),
  });
  const accountLabel = locale === "id" ? "Akun saya" : "My account";
  const script = buildMindmapClientScript({
    accountLabel,
    conversationsLabel: t.conversations,
    emptyLabel: t.noMemories,
    failedLabel: t.mapError,
    loadingLabel: t.loading,
  });
  return page(
    t.memoryMap,
    `<header class="hero"><p class="eyebrow">${t.memoryMap}</p><h1>${t.memoryMap}</h1><p>${t.mapHint}</p></header><form id="map-search" class="search-form"><label for="map-query">${t.search}</label><div><input id="map-query" name="q" maxlength="100"><button class="button" type="submit">${t.searchButton}</button></div></form><section class="map-panel" aria-labelledby="map-status"><div class="map-toolbar" role="toolbar" aria-label="${escapeHtml(t.memoryMap)}"><div class="map-actions"><button id="map-collapse-all" class="chip-button" type="button">${t.collapseAll}</button><button id="map-expand-all" class="chip-button" type="button">${t.expandAll}</button><button id="map-reset-view" class="chip-button" type="button">${t.resetView}</button></div><div class="map-actions"><button id="map-zoom-out" class="chip-button" type="button" aria-label="Zoom out">−</button><button id="map-zoom-in" class="chip-button" type="button" aria-label="Zoom in">+</button></div></div><div class="map-legend" aria-label="${escapeHtml(t.memoryMap)}"><span><i class="map-dot account" aria-hidden="true"></i>${escapeHtml(accountLabel)}</span><span><i class="map-dot namespace" aria-hidden="true"></i>${escapeHtml(t.namespaces)}</span><span><i class="map-dot conversation" aria-hidden="true"></i>${escapeHtml(t.conversations)}</span></div><div id="map-viewport" class="map-viewport"><p id="map-status" role="status">${t.loading}</p><div id="memory-map" class="mindmap-canvas" aria-hidden="true" tabindex="0"></div><div id="map-tooltip" class="map-tooltip" hidden></div></div><button id="load-more" class="button secondary" type="button" hidden>${t.loadMore}</button></section><section class="card"><h2>${t.accessibleTree}</h2>${accessibleTree(initial, locale)}</section>`,
    locale,
    "/dashboard/mindmap",
    { session, script },
  );
}

async function conversation(
  request: Request,
  env: AppEnv,
  locale: Locale,
  session: DashboardSession,
  id: string,
): Promise<Response> {
  const t = copy[locale];
  const url = new URL(request.url);
  const offset = z.coerce.number().int().min(0).catch(0).parse(url.searchParams.get("offset"));
  const revision = z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional()
    .catch(undefined)
    .parse(url.searchParams.get("revision_id") ?? undefined);
  const result = await getConversationPage(
    env,
    id,
    offset,
    20,
    "active",
    undefined,
    session.user.id,
    revision,
  );
  const pinned = result.conversation.revisionId;
  const items = result.messages
    .map(
      (message) =>
        `<article class="message"><header><span class="message-role ${escapeHtml(message.role ?? "unknown")} truncate">${escapeHtml(message.role ?? "unknown")}</span><span class="message-time truncate">${escapeHtml(message.createdAt ?? "")}</span></header><p>${escapeHtml(message.text)}</p><details class="message-details"><summary>${t.metadata}</summary><pre>${escapeHtml(JSON.stringify({ sourceNodeId: message.sourceNodeId, modelSlug: message.modelSlug, metadata: message.metadata }, null, 2))}</pre></details></article>`,
    )
    .join("");
  const previous = offset > 0 ? Math.max(0, offset - 20) : null;
  return page(
    result.conversation.title,
    `<p class="dash-back"><a href="/dashboard">← ${t.back}</a><span class="dash-back-sep" aria-hidden="true">/</span><a class="truncate" href="/dashboard/namespaces/${encodeURIComponent(result.conversation.namespace)}">${escapeHtml(result.conversation.namespace)}</a></p><header class="hero compact"><p class="eyebrow">${t.conversation}</p><h1 class="truncate">${escapeHtml(result.conversation.title)}</h1><p class="truncate">${escapeHtml(result.conversation.namespace)} · ${result.total} ${t.messages.toLowerCase()}</p><div class="tags">${renderTagLinks(result.conversation.tags)}</div></header><section class="messages-stream">${items || `<p>${t.noMemories}</p>`}</section><nav class="pagination" aria-label="Pagination">${previous === null ? "" : `<a class="button secondary" href="?offset=${previous}&revision_id=${pinned}">${t.previous}</a>`}${result.nextOffset === null ? "" : `<a class="button secondary" href="?offset=${result.nextOffset}&revision_id=${pinned}">${t.next}</a>`}</nav>`,
    locale,
    url.pathname + url.search,
    { session },
  );
}

async function exportAccount(env: AppEnv, session: DashboardSession): Promise<Response> {
  const namespaces = await env.MEMORY_DB.prepare(
    "SELECT namespace, created_at FROM user_namespaces WHERE user_id = ? ORDER BY namespace",
  )
    .bind(session.user.id)
    .all<{ namespace: string; created_at: string }>();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(
            `{"format":"mempersist.account-export.v1","exportedAt":${JSON.stringify(new Date().toISOString())},"profile":${JSON.stringify({ email: session.user.email, displayName: session.user.display_name })},"namespaces":${JSON.stringify(namespaces.results)},"conversations":[`,
          ),
        );
        let cursor: string | undefined;
        let first = true;
        do {
          const listed = await listConversations(env, {
            userId: session.user.id,
            limit: 50,
            ...(cursor ? { cursor } : {}),
          });
          for (const item of listed.conversations) {
            const loaded = await loadCurrentConversation(env, item.id, undefined, session.user.id);
            controller.enqueue(
              encoder.encode(`${first ? "" : ","}${JSON.stringify(loaded.conversation)}`),
            );
            first = false;
          }
          cursor = listed.nextCursor ?? undefined;
        } while (cursor);
        controller.enqueue(encoder.encode("]}"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="mempersist-export.json"',
      "Content-Type": "application/json; charset=UTF-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleDashboardRequest(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const locale = resolveLocale(request, url.searchParams.get("lang"));
  try {
    if (url.pathname === "/login") return await login(request, env, locale);
    if (url.pathname === "/auth/dashboard") return await callback(request, env, locale);

    const session = await readSession(request, env);
    if (!session)
      return redirect(
        `/login?return_to=${encodeURIComponent(url.pathname + url.search)}`,
        clearSessionCookie(),
      );

    if (url.pathname === "/logout" && request.method === "POST") {
      await requireMutation(request, session);
      await env.MEMORY_DB.prepare("DELETE FROM dashboard_sessions WHERE token_hash = ?")
        .bind(session.tokenHash)
        .run();
      return redirect("/", clearSessionCookie());
    }
    if (url.pathname === "/dashboard/export" && request.method === "GET") {
      return await exportAccount(env, session);
    }
    if (url.pathname === "/dashboard/mindmap/data" && request.method === "GET") {
      const input = z
        .object({
          namespace: z.string().min(1).max(100).optional(),
          cursor: z.string().max(200).optional(),
          q: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(50),
        })
        .parse(Object.fromEntries(url.searchParams));
      if (input.namespace) {
        const owned = await env.MEMORY_DB.prepare(
          "SELECT 1 FROM user_namespaces WHERE user_id = ? AND namespace = ?",
        )
          .bind(session.user.id, input.namespace)
          .first();
        if (!owned) throw new AppError("NOT_FOUND", "Namespace not found", 404);
      }
      return Response.json(
        await mindmapData(env, session.user.id, {
          limit: input.limit,
          ...(input.namespace ? { namespace: input.namespace } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.q ? { q: input.q } : {}),
        }),
        {
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        },
      );
    }
    if (url.pathname === "/dashboard/mindmap" && request.method === "GET") {
      return await mindmap(request, env, locale, session);
    }
    if (url.pathname.startsWith("/dashboard/conversations/") && request.method === "GET") {
      const encoded = url.pathname.slice("/dashboard/conversations/".length);
      let id: string;
      try {
        id = decodeURIComponent(encoded);
      } catch {
        throw new AppError("VALIDATION", "Invalid conversation ID", 400);
      }
      return await conversation(request, env, locale, session, id);
    }
    if (url.pathname.startsWith("/dashboard/namespaces/") && request.method === "GET") {
      const encoded = url.pathname.slice("/dashboard/namespaces/".length);
      if (!encoded) throw new AppError("NOT_FOUND", "Route not found", 404);
      let namespace: string;
      try {
        namespace = decodeURIComponent(encoded);
      } catch {
        throw new AppError("NOT_FOUND", "Route not found", 404);
      }
      if (namespace.length < 1 || namespace.length > 100) {
        throw new AppError("NOT_FOUND", "Route not found", 404);
      }
      return await namespacePage(request, env, locale, session, namespace);
    }
    if (url.pathname === "/dashboard" && request.method === "GET") {
      return await overview(request, env, locale, session);
    }

    if (request.method !== "POST") throw new AppError("NOT_FOUND", "Route not found", 404);
    const form = await requireMutation(request, session);
    if (url.pathname === "/dashboard/account/cancel") {
      const jobId = form.get("job_id");
      if (
        typeof jobId !== "string" ||
        !(await cancelAccountDeletion(env, session.user.id, jobId))
      ) {
        throw new AppError("DELETION_PENDING", "Deletion can no longer be cancelled", 409);
      }
      return redirect("/dashboard");
    }
    await assertAccountWritable(env, session.user.id);
    if (url.pathname === "/dashboard/profile") {
      const raw = form.get("display_name");
      if (typeof raw !== "string")
        throw new AppError("VALIDATION", "Display name is required", 400);
      const displayName = raw.normalize("NFKC").trim();
      if (!displayName || displayName.length > 80) {
        throw new AppError("VALIDATION", "Display name must be 1–80 characters", 400);
      }
      await env.MEMORY_DB.prepare("UPDATE users SET display_name = ? WHERE id = ?")
        .bind(displayName, session.user.id)
        .run();
      return redirect("/dashboard");
    }
    if (
      url.pathname === "/dashboard/namespaces/empty" ||
      url.pathname === "/dashboard/namespaces/delete"
    ) {
      const namespace = form.get("namespace");
      const confirmation = form.get("confirm_namespace");
      if (typeof namespace !== "string" || confirmation !== namespace) {
        throw new AppError("VALIDATION", "Namespace confirmation must match exactly", 400);
      }
      await assertAccountWritable(env, session.user.id, namespace);
      await scheduleNamespaceDeletion(
        env,
        session.user.id,
        namespace,
        url.pathname.endsWith("/delete") ? "delete" : "empty",
      );
      return redirect("/dashboard");
    }
    if (url.pathname === "/dashboard/account/delete") {
      const confirmation = form.get("confirm_email");
      if (typeof confirmation !== "string" || normalizeEmail(confirmation) !== session.user.email) {
        throw new AppError("VALIDATION", "Email confirmation must match exactly", 400);
      }
      await scheduleAccountDeletion(env, session.user.id);
      return redirect("/dashboard");
    }
    throw new AppError("NOT_FOUND", "Route not found", 404);
  } catch (error) {
    return errorResponse(request, error, locale);
  }
}
const DASHBOARD_CSS = `
.truncate{display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-scrim{position:fixed;inset:0;z-index:10;background:rgba(40,42,37,.4);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .35s var(--ease);pointer-events:none}
.nav-scrim.open{opacity:1;pointer-events:all}
.dashboard-nav{position:sticky;top:0;z-index:20;background:rgba(247,246,242,.9);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);min-height:72px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px max(24px,calc((100vw - 1200px)/2));transition:border-color .2s}
.dashboard-nav>div,.nav-panel{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dashboard-nav a,.link-button{font-size:13px;font-weight:500;text-decoration:none;color:var(--muted);padding:7px 13px;border-radius:6px;transition:color .18s var(--ease),background .18s var(--ease)}
.dashboard-nav a:hover,.link-button:hover{color:var(--ink);background:rgba(40,42,37,.05)}
.dashboard-nav a[aria-current="page"]{color:var(--accent);background:var(--tint);font-weight:600}
.dashboard-nav form,.dashboard-menu form{margin:0}
.dashboard-menu{display:contents;margin:0}
summary.nav-toggle{display:none}
summary.nav-toggle::-webkit-details-marker{display:none}
.link-button{border:0;background:none;color:var(--muted);cursor:pointer;font-family:inherit;font-size:13px;padding:7px 13px;border-radius:6px;transition:all .18s}
.link-button:hover{color:var(--ink);background:rgba(40,42,37,.05)}
.hamburger{display:block;width:18px;height:12px;position:relative;background:linear-gradient(var(--ink),var(--ink)) 0 5px/18px 2px no-repeat;transition:background .2s}
.hamburger::before,.hamburger::after{content:"";position:absolute;left:0;width:18px;height:2px;background:var(--ink);transition:transform .25s var(--ease),top .25s var(--ease)}
.hamburger::before{top:0}
.hamburger::after{top:10px}
.language{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border:1px solid var(--line);border-radius:6px;font:10px/1.8 var(--mono);color:var(--muted);background:var(--surface)}
.language a{padding:2px 4px;border-radius:3px;text-decoration:none;color:inherit;transition:color .15s}
.language a:hover{color:var(--ink)}
.language a[aria-current]{color:var(--accent);font-weight:600}
.language-sep{color:var(--line);margin:0 1px}
.dashboard-shell{width:min(1200px,calc(100% - 48px));margin:0 auto;padding:32px 0 64px}
.dash-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:28px;padding-bottom:22px;border-bottom:1px solid var(--line);min-width:0;max-width:100%}
.dash-head>div{min-width:0;max-width:100%;flex:1}
.dash-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,460px);align-items:end;gap:40px;min-height:190px;padding:20px 0 26px;position:relative}
.dash-intro{align-self:center}
.dash-head h1{font-size:clamp(40px,6vw,72px);font-weight:500;letter-spacing:-.065em;line-height:.98;margin:0;color:var(--ink);text-wrap:balance;min-width:0;max-width:100%}
.dash-head h1.truncate{text-wrap:nowrap}
.dash-head p{margin:10px 0 0;font-size:16px;color:var(--muted);min-width:0;max-width:100%}
.dash-badge{display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 12px;border-radius:999px;background:var(--tint);border:1px solid rgba(66,99,74,.2);font:500 10px/1 var(--mono);color:var(--accent);letter-spacing:.08em;text-transform:uppercase;margin:0 0 12px;box-sizing:border-box;vertical-align:middle}
.dash-hero-rail{display:grid;gap:20px;align-self:stretch;align-content:end;min-width:0;padding-left:28px;border-left:1px solid var(--line)}
.dash-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;flex-shrink:0}
.dash-actions .button{min-height:38px;padding:8px 16px;font-size:13px}
.dash-metrics{display:grid;grid-template-columns:repeat(3,minmax(72px,1fr));border-top:1px solid var(--line);border-bottom:1px solid var(--line);min-width:0}
.dash-metric{display:grid;gap:5px;padding:13px 14px;min-width:0}
.dash-metric+.dash-metric{border-left:1px solid var(--line)}
.dash-metric strong{font:500 clamp(24px,3vw,34px)/1 var(--mono);color:var(--ink);letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.dash-metric span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 10px var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.dash-main{display:grid;grid-template-columns:320px minmax(0,1fr);gap:24px;align-items:start;margin-bottom:28px}
.dash-side,.dash-content{display:flex;flex-direction:column;gap:20px;min-width:0;max-width:100%}
.card,.map-panel{padding:24px 28px;border:1px solid var(--line);background:var(--surface);border-radius:8px;box-shadow:0 1px 3px rgba(40,42,37,.03);min-width:0;max-width:100%}
.card h2{margin:0;font-size:16px;font-weight:500;letter-spacing:-.02em;color:var(--ink)}
.section-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--line);min-width:0;max-width:100%}
.section-heading h2{margin:0;min-width:0;max-width:100%}
.action-link{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--accent);text-decoration:none;transition:transform .2s var(--ease),color .2s;flex-shrink:0}
.action-link:hover{color:var(--ink);transform:translateX(2px)}
.card form,.auth-card form{display:grid;gap:14px;margin-top:16px;min-width:0;max-width:100%}
label{display:grid;gap:6px;font:500 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);min-width:0;max-width:100%}
input{min-width:0;max-width:100%;width:100%;min-height:42px;padding:10px 14px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink);font-size:14px;font-family:inherit;transition:border-color .2s,box-shadow .2s,background .2s;box-sizing:border-box}
input:hover{border-color:#b9beb1}
input:focus-visible{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(66,99,74,.18);background:#fff}
.namespace-list,.recent-list,.tree-list{list-style:none;padding:0;margin:0;min-width:0;max-width:100%;display:flex;flex-direction:column}
.namespace-list>li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 14px;margin:0 -14px;border-radius:6px;border-bottom:1px solid rgba(222,223,214,.6);transition:background .18s var(--ease);min-width:0;max-width:calc(100% + 28px)}
.namespace-list>li:last-child{border-bottom:0}
.namespace-list>li:hover{background:rgba(40,42,37,.025)}
.ns-link{display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;min-width:0;max-width:100%;flex:1}
.ns-icon{display:grid;place-items:center;width:28px;height:28px;border-radius:6px;background:var(--tint);color:var(--accent);flex-shrink:0}
.ns-meta{display:grid;gap:2px;min-width:0;max-width:100%;flex:1}
.ns-meta strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;color:var(--ink);font-family:var(--mono);min-width:0;max-width:100%}
.ns-meta span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--muted);font-family:var(--mono);min-width:0;max-width:100%}
.ns-empty{flex-shrink:0}
.namespace-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;flex-shrink:0}
.ns-pending{flex-shrink:0}
.ns-empty summary{cursor:pointer;font-size:12px;color:var(--muted);padding:4px 10px;border-radius:5px;border:1px solid var(--line);background:var(--canvas);transition:all .18s}
.ns-delete summary{color:#8d322f;border-color:#eccdcc;background:#fbf1f0}
.ns-empty:hover summary,.ns-empty[open] summary{color:#8d322f;border-color:#eccdcc;background:#fbf1f0}
.ns-empty form{display:grid;gap:10px;margin-top:10px;padding:14px;border:1px solid #eccdcc;border-radius:6px;background:#fbf1f0;min-width:min(280px,70vw);max-width:100%;box-sizing:border-box}
.ns-empty label span{font-size:11px;color:#8d322f;text-transform:none;font-family:inherit;letter-spacing:normal}
.recent-list li{border-bottom:1px solid rgba(222,223,214,.6);min-width:0;max-width:100%}
.recent-list li:last-child{border-bottom:0}
.recent-list a{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 14px;margin:0 -14px;border-radius:6px;text-decoration:none;color:inherit;transition:background .18s var(--ease);min-width:0;max-width:calc(100% + 28px)}
.recent-list a:hover{background:var(--tint)}
.recent-main{display:flex;align-items:center;gap:10px;min-width:0;max-width:100%;flex:1}
.recent-main strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.recent-list a strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:100%;font-size:14px;font-weight:500;color:var(--ink)}
.recent-ns-tag{font:10px var(--mono);padding:2px 7px;border-radius:4px;background:rgba(40,42,37,.06);color:var(--muted);flex-shrink:0;min-width:0;max-width:min(160px,40%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.recent-date{font:11px var(--mono);color:var(--muted);white-space:nowrap;flex-shrink:0;min-width:0;max-width:min(180px,30%);overflow:hidden;text-overflow:ellipsis}
.recent-arrow{font-size:13px;color:var(--muted);transition:transform .18s,color .18s;flex-shrink:0}
.recent-list a:hover .recent-arrow{transform:translateX(3px);color:var(--accent)}
.empty-state{padding:24px;text-align:center;color:var(--muted);font-size:13px;border:1px dashed var(--line);border-radius:6px;background:var(--canvas)}
.empty-state strong{font-weight:500;color:var(--muted)}
.button.danger{background:#8d322f;border-color:#8d322f;color:#fff}
.button.danger:hover{background:#752825;border-color:#752825}
.danger-zone{border-color:#eccdcc;background:#fdf9f8}
.danger-zone details summary{cursor:pointer;font-size:13px;color:#8d322f;font-weight:500}
.danger-zone details[open] summary{margin-bottom:10px}
.danger-zone p{font-size:13px;line-height:1.6;color:#6a403e;margin:0 0 10px}
.danger-zone form{display:grid;gap:10px;margin-top:12px}
.notice{display:grid;gap:8px;padding:16px 20px;margin-bottom:24px;border:1px solid #e8d7a7;background:#fffbf0;border-radius:8px;color:#705314}
.notice strong{font-size:14px;font-weight:600}
.notice span{font:12px var(--mono)}
.notice form{margin:4px 0 0}
.dash-back{display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:13px;min-width:0;max-width:100%}
.dash-back a{display:inline-flex;align-items:center;gap:4px;text-decoration:none;color:var(--muted);font-weight:500;transition:color .2s,transform .2s;min-width:0;max-width:100%}
.dash-back a:first-child{flex-shrink:0}
.dash-back a:hover{color:var(--accent);transform:translateX(-2px)}
.dash-back a.truncate{display:block;min-width:0;max-width:100%;flex:1}
.dash-back-sep{color:var(--line);flex-shrink:0}
.hero{max-width:800px;margin-bottom:36px;min-width:0;max-width:100%}
.hero.compact{margin-top:24px}
.hero h1{font-size:clamp(34px,5vw,56px);letter-spacing:-.045em;line-height:1.1;margin:0 0 10px;min-width:0;max-width:100%}
.hero p{font-size:16px;line-height:1.6;min-width:0;max-width:100%}
.messages-stream{display:flex;flex-direction:column;gap:18px;min-width:0;max-width:100%}
.message{padding:22px 26px;border:1px solid var(--line);background:var(--surface);border-radius:8px;box-shadow:0 1px 3px rgba(40,42,37,.03);transition:border-color .2s;min-width:0;max-width:100%}
.message:hover{border-color:#c8cebf}
.message header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(222,223,214,.6);min-width:0;max-width:100%}
.message-role{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:4px;font:500 10px var(--mono);text-transform:uppercase;letter-spacing:.08em;min-width:0;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.message-role.truncate{display:inline-flex}
.message-role.user{background:var(--ink);color:var(--surface)}
.message-role.assistant{background:var(--tint);color:var(--accent);border:1px solid rgba(66,99,74,.2)}
.message-role.system{background:rgba(40,42,37,.08);color:var(--muted)}
.message-time{font:11px var(--mono);color:var(--muted);min-width:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.message p{font-size:15px;line-height:1.75;color:var(--ink);white-space:pre-wrap;word-break:break-word;margin:0 0 12px}
.message details summary{font:11px var(--mono);color:var(--muted);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.pre,pre{margin-top:10px;padding:14px;border-radius:6px;background:var(--canvas);border:1px solid var(--line);font:11px/1.6 var(--mono);color:var(--ink);overflow-x:auto}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;min-width:0;max-width:100%}
.tags a{display:inline-flex;min-width:0;max-width:100%;text-decoration:none}
.tags span,.tags a span{padding:3px 8px;border-radius:4px;background:var(--tint);color:var(--accent);font:10px var(--mono);border:1px solid rgba(66,99,74,.15);min-width:0;max-width:min(200px,100%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pagination{display:flex;justify-content:space-between;gap:16px;margin-top:28px}
.search-form{display:grid;gap:10px;margin-bottom:24px}
.search-form>div{display:flex;gap:10px}
.map-panel{overflow:hidden;margin-bottom:28px;background:#1b211c;border-color:#3a493c;box-shadow:0 16px 40px -22px rgba(22,35,25,.5)}
.map-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 12px}
.map-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.chip-button{min-height:34px;padding:6px 14px;border:1px solid #536351;border-radius:6px;background:#253027;color:#dce8d5;font:500 11px var(--mono);transition:all .18s var(--ease);cursor:pointer}
.chip-button:hover{background:#324334;border-color:#9ebd8e;color:#f0f6eb;transform:translateY(-1px)}
.map-legend{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:0 0 12px;font:10px var(--mono);color:#9ead9b}
.map-legend span{display:inline-flex;align-items:center;gap:7px}
.map-dot{display:inline-block;width:9px;height:9px;border-radius:50%;border:1px solid #a9c49a}
.map-dot.account{width:11px;height:11px;background:#42634a}
.map-dot.namespace{background:#b9d2aa;border-color:#7e9f70}
.map-dot.conversation{background:#eef3e8;border-color:#9eaf9a}
.map-viewport>p{font:11px var(--mono);color:#9ead9b;margin:0 0 10px}
.mindmap-canvas{display:block;width:100%;height:620px;background-color:#171d18;background-image:radial-gradient(circle at 50% 50%,rgba(128,165,113,.12),transparent 42%),radial-gradient(circle,#526452 1px,transparent 1px);background-size:100% 100%,24px 24px;border:1px solid #3a493c;border-radius:6px;outline-offset:2px;touch-action:none}
.mindmap-canvas canvas{cursor:grab}
.map-tooltip{position:absolute;z-index:2;display:grid;gap:2px;max-width:260px;padding:10px 14px;border:1px solid #536351;border-radius:6px;background:#eef3e8;box-shadow:0 12px 28px -18px rgba(0,0,0,.75);pointer-events:none;font:11px/1.5 var(--mono);color:#4f5f50}
.map-tooltip>*{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.map-tooltip strong{font:500 13px/1.4 Outfit,sans-serif;color:#1f2b21;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.map-tooltip span,.map-tooltip p{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tree-list ul{margin:8px 0 16px}
.tree-list li{min-width:0;max-width:100%}
.tree-list details{min-width:0;max-width:100%}
.tree-list summary{cursor:pointer;font-weight:500;min-width:0;max-width:100%}
.tree-list a{display:inline-block;margin-right:12px;min-width:0;max-width:100%}
.tree-list a.truncate{display:inline-block;vertical-align:middle;max-width:calc(100% - 24px)}
.auth-card{width:min(100%,480px);margin:9vh auto 0;padding:40px;border:1px solid var(--line);background:var(--surface);border-radius:12px;box-shadow:0 4px 20px -8px rgba(40,42,37,.08)}
.auth-card h1{font-size:clamp(30px,5vw,42px);letter-spacing:-.04em;line-height:1.15;margin:0 0 8px}
.auth-card p{font-size:15px;line-height:1.65;margin:0 0 18px;color:var(--muted)}
.auth-actions{margin-top:20px}
@media(max-width:768px){
  .dashboard-nav{padding:10px 16px;min-height:64px;backdrop-filter:none;-webkit-backdrop-filter:none}
  .dashboard-menu{display:block}
  summary.nav-toggle{display:grid;place-items:center;margin-left:auto;width:44px;height:44px;min-width:44px;min-height:44px;padding:0;border:1px solid var(--line);border-radius:4px;background:var(--surface);list-style:none;cursor:pointer;position:relative;z-index:13;transition:border-color .2s}
  summary.nav-toggle::-webkit-details-marker{display:none}
  .dashboard-menu[open] summary.nav-toggle,summary.nav-toggle[aria-expanded="true"]{position:fixed;top:10px;right:16px;z-index:13}
  .dashboard-menu[open] summary.nav-toggle .hamburger,summary.nav-toggle[aria-expanded="true"] .hamburger{background:none}
  .dashboard-menu[open] summary.nav-toggle .hamburger::before,summary.nav-toggle[aria-expanded="true"] .hamburger::before{top:5px;transform:rotate(45deg)}
  .dashboard-menu[open] summary.nav-toggle .hamburger::after,summary.nav-toggle[aria-expanded="true"] .hamburger::after{top:5px;transform:rotate(-45deg)}
  .nav-panel{display:flex;position:fixed;top:0;right:0;bottom:0;width:min(320px,85vw);background:var(--surface);border-left:1px solid var(--line);padding:76px 24px calc(24px + env(safe-area-inset-bottom,0px));flex-direction:column;flex-wrap:nowrap;align-items:stretch;gap:4px;z-index:11;overflow-y:auto;-webkit-overflow-scrolling:touch;box-shadow:-4px 0 24px rgba(40,42,37,.06);transform:translateX(100%);opacity:0;visibility:hidden;pointer-events:none;transition:transform .35s var(--ease),opacity .3s var(--ease),visibility .35s}
  .dashboard-menu[open] .nav-panel{transform:none;opacity:1;visibility:visible;pointer-events:all}
  .nav-panel>*{transform:translateX(14px);opacity:0;transition:transform .35s var(--ease),opacity .3s var(--ease)}
  .dashboard-menu[open] .nav-panel>*{transform:none;opacity:1}
  .dashboard-menu[open] .nav-panel>:nth-child(1){transition-delay:.05s}
  .dashboard-menu[open] .nav-panel>:nth-child(2){transition-delay:.09s}
  .dashboard-menu[open] .nav-panel>:nth-child(3){transition-delay:.13s}
  .dashboard-menu[open] .nav-panel>:nth-child(4){transition-delay:.17s}
  .dashboard-menu[open] .nav-panel>:nth-child(5){transition-delay:.21s}
  @starting-style{
    .dashboard-menu[open] .nav-panel{transform:translateX(100%);opacity:0}
    .dashboard-menu[open] .nav-panel>*{transform:translateX(14px);opacity:0}
  }
  .dashboard-menu[open] .nav-panel a,.dashboard-menu[open] .nav-panel .link-button{font-size:16px;padding:12px 0;border-bottom:1px solid var(--canvas);color:var(--ink);border-radius:0;background:none;min-height:44px;display:flex;align-items:center;width:100%;text-align:left;transition:color .2s var(--ease)}
  .dashboard-menu[open] .nav-panel a:hover,.dashboard-menu[open] .nav-panel .link-button:hover{color:var(--accent);background:none}
  .dashboard-menu[open] .nav-panel a[aria-current="page"]{font-weight:600;color:var(--accent);background:none}
  .dashboard-menu[open] .nav-panel .language{display:inline-flex;align-self:flex-start;margin:12px 0;padding:6px 12px;font-size:12px;border:1px solid var(--line);border-radius:6px;background:var(--canvas)}
  .dashboard-menu[open] .nav-panel form{margin:0;width:100%}
  .dashboard-shell{width:min(100% - 32px,1200px);padding-top:20px}
  .dash-head{flex-direction:column;align-items:flex-start}
  .dash-hero{grid-template-columns:1fr;gap:24px;min-height:0;padding-top:20px}
  .dash-hero-rail{align-self:stretch;padding:18px 0 0;border-left:0;border-top:1px solid var(--line)}
  .dash-actions{justify-content:flex-start}
  .dash-main{grid-template-columns:minmax(0,1fr);gap:20px}
  .card,.map-panel{padding:20px 18px}
  .auth-card{padding:28px 20px;margin-top:4vh}
  .search-form>div{display:grid}
  .mindmap-canvas{height:460px}
  .message{padding:18px}
  .namespace-list>li{flex-wrap:wrap;gap:12px}
  .namespace-actions{width:100%;justify-content:flex-start}
  .ns-empty[open]{width:100%;margin-top:4px}
  .ns-empty form{width:100%;min-width:0;max-width:100%;box-sizing:border-box}
  .recent-list a{flex-direction:column;align-items:flex-start;gap:6px;width:100%}
  .recent-main{width:100%;min-width:0;max-width:100%}
  .recent-date{max-width:100%}
  .recent-arrow{display:none}
}
`;
