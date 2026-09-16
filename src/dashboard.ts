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
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${value}'; style-src 'nonce-${value}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    "Content-Type": "text/html; charset=UTF-8",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    Vary: "Accept-Language, Cookie",
  };
}

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
  const nav = options.session
    ? `<nav class="dashboard-nav" aria-label="${messages(locale).shared.mainNav}">${brand(messages(locale).shared.homeLabel)}<div><a href="/dashboard">${t.dashboard}</a><a href="/dashboard/mindmap">${t.memoryMap}</a><a href="/dashboard/export">${t.export}</a>${language}<form method="post" action="/logout"><input type="hidden" name="csrf" value="${options.session.csrf}"><button class="link-button" type="submit">${t.logout}</button></form></div></nav>`
    : `<nav class="dashboard-nav">${brand(messages(locale).shared.homeLabel)}<div>${language}</div></nav>`;
  return new Response(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · MemPersist</title>${FAVICON}<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"><style nonce="${n}">${BASE_CSS}${DASHBOARD_CSS}</style></head><body><a class="skip-link" href="#main">${messages(locale).shared.skip}</a>${nav}<main id="main" class="dashboard-shell" tabindex="-1">${body}</main>${options.script ? `<script nonce="${n}">${options.script}</script>` : ""}</body></html>`,
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
    return page(
      t.loginTitle,
      `<section class="auth-card"><p class="eyebrow">PASSWORDLESS</p><h1>${t.loginTitle}</h1><p>${t.loginBody}</p><form method="post" action="/login"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><label for="email">${t.email}</label><input id="email" name="email" type="email" required maxlength="320" autocomplete="email"><button class="button" type="submit">${t.sendLink} <span aria-hidden="true">↗</span></button></form></section>`,
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
    `<section class="auth-card"><p class="eyebrow">${t.checkEmail}</p><h1>${t.checkEmail}</h1><p>${t.linkSent}</p><a class="button secondary" href="/">${messages(locale).oauth.back}</a></section>`,
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
    .map(
      (row) =>
        `<li><div class="ns-meta"><strong>${escapeHtml(row.namespace)}</strong><span>${row.conversations} ${t.conversations.toLowerCase()} · ${row.messages} ${t.messages.toLowerCase()}${row.deletion_job_id ? ` · ${t.pending}` : ""}</span></div>${row.deletion_job_id ? "" : `<details class="ns-empty"><summary>${t.empty}</summary><form method="post" action="/dashboard/namespaces/empty"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="namespace" value="${escapeHtml(row.namespace)}"><label><span>${t.emptyHelp}</span><input name="confirm_namespace" required autocomplete="off"></label><button class="button danger" type="submit">${t.empty}</button></form></details>`}</li>`,
    )
    .join("");
  const recent = data.recent.length
    ? data.recent
        .map(
          (item) =>
            `<li><a href="/dashboard/conversations/${encodeURIComponent(item.id)}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.namespace)}${item.updated_at ? ` · ${escapeHtml(item.updated_at)}` : ""}</span></a></li>`,
        )
        .join("")
    : `<li>${t.noMemories}</li>`;
  const account = data.deletion
    ? `<div class="notice" role="status"><strong>${t.pending}</strong><span>${t.deleteDue}: ${escapeHtml(data.deletion.due_at)}</span><form method="post" action="/dashboard/account/cancel"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="job_id" value="${data.deletion.id}"><button class="button secondary" type="submit">${t.cancelDeletion}</button></form></div>`
    : `<section class="card danger-zone"><details><summary><strong>${t.accountDeletion}</strong></summary><p>${t.accountHelp}</p><form method="post" action="/dashboard/account/delete"><input type="hidden" name="csrf" value="${session.csrf}"><label>${t.email}<input name="confirm_email" type="email" required autocomplete="off"></label><button class="button danger" type="submit">${t.schedule}</button></form></details></section>`;
  return page(
    t.dashboard,
    `<header class="dash-head"><div><p class="eyebrow">${t.dashboard}</p><h1>${escapeHtml(session.user.display_name ?? session.user.email)}</h1></div><p>${t.overview}</p></header>${data.deletion ? account : ""}<section class="stats"><article><span>${t.namespaces}</span><strong>${data.namespaces.length}</strong></article><article><span>${t.conversations}</span><strong>${totals.conversations}</strong></article><article><span>${t.messages}</span><strong>${totals.messages}</strong></article></section><div class="dash-main"><div class="dash-side"><section class="card"><h2>${t.profile}</h2><form method="post" action="/dashboard/profile"><input type="hidden" name="csrf" value="${session.csrf}"><label>${t.displayName}<input name="display_name" maxlength="80" required value="${escapeHtml(session.user.display_name ?? "")}"></label><button class="button" type="submit"${data.deletion ? " disabled" : ""}>${t.save}</button></form></section>${data.deletion ? "" : account}</div><div class="dash-content"><section class="card"><div class="section-heading"><h2>${t.namespaces}</h2><a href="/dashboard/mindmap">${t.memoryMap} →</a></div><ul class="namespace-list">${namespaceRows}</ul></section><section class="card"><h2>${t.recent}</h2><ul class="recent-list">${recent}</ul></section></div></div>`,
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
            `<li><a href="/dashboard/conversations/${encodeURIComponent(conversation.id)}">${escapeHtml(conversation.title)}</a>${conversation.tags.length ? `<span>${conversation.tags.map(escapeHtml).join(", ")}</span>` : ""}</li>`,
        )
        .join("");
      return `<li><details open><summary>${escapeHtml(namespace.namespace)} (${namespace.conversations})</summary><ul>${children || `<li>${t.noMemories}</li>`}</ul></details></li>`;
    })
    .join("")}</ul>`;
}

async function mindmap(env: AppEnv, locale: Locale, session: DashboardSession): Promise<Response> {
  const t = copy[locale];
  const initial = await mindmapData(env, session.user.id, { limit: 50 });
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
    `<header class="hero"><p class="eyebrow">${t.memoryMap}</p><h1>${t.memoryMap}</h1><p>${t.mapHint}</p></header><form id="map-search" class="search-form"><label for="map-query">${t.search}</label><div><input id="map-query" name="q" maxlength="100"><button class="button" type="submit">${t.searchButton}</button></div></form><section class="map-panel" aria-labelledby="map-status"><div class="map-toolbar" role="toolbar" aria-label="${escapeHtml(t.memoryMap)}"><div class="map-actions"><button id="map-collapse-all" class="chip-button" type="button">${t.collapseAll}</button><button id="map-expand-all" class="chip-button" type="button">${t.expandAll}</button><button id="map-reset-view" class="chip-button" type="button">${t.resetView}</button></div><div class="map-actions"><button id="map-zoom-out" class="chip-button" type="button" aria-label="Zoom out">−</button><button id="map-zoom-in" class="chip-button" type="button" aria-label="Zoom in">+</button></div></div><div id="map-viewport" class="map-viewport"><p id="map-status" role="status">${t.loading}</p><div id="memory-map" class="mindmap-canvas" aria-hidden="true" tabindex="0"></div><div id="map-tooltip" class="map-tooltip" hidden></div></div><button id="load-more" class="button secondary" type="button" hidden>${t.loadMore}</button></section><section class="card"><h2>${t.accessibleTree}</h2>${accessibleTree(initial, locale)}</section>`,
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
        `<article class="message"><header><strong>${escapeHtml(message.role ?? "unknown")}</strong><span>${escapeHtml(message.createdAt ?? "")}</span></header><p>${escapeHtml(message.text)}</p><details><summary>${t.metadata}</summary><pre>${escapeHtml(JSON.stringify({ sourceNodeId: message.sourceNodeId, modelSlug: message.modelSlug, metadata: message.metadata }, null, 2))}</pre></details></article>`,
    )
    .join("");
  const previous = offset > 0 ? Math.max(0, offset - 20) : null;
  return page(
    result.conversation.title,
    `<a href="/dashboard">← ${t.back}</a><header class="hero compact"><p class="eyebrow">${t.conversation}</p><h1>${escapeHtml(result.conversation.title)}</h1><p>${escapeHtml(result.conversation.namespace)} · ${result.total} ${t.messages.toLowerCase()}</p><div class="tags">${result.conversation.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div></header><section>${items || `<p>${t.noMemories}</p>`}</section><nav class="pagination" aria-label="Pagination">${previous === null ? "" : `<a class="button secondary" href="?offset=${previous}&revision_id=${pinned}">${t.previous}</a>`}${result.nextOffset === null ? "" : `<a class="button secondary" href="?offset=${result.nextOffset}&revision_id=${pinned}">${t.next}</a>`}</nav>`,
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
      return await mindmap(env, locale, session);
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
    if (url.pathname === "/dashboard/namespaces/empty") {
      const namespace = form.get("namespace");
      const confirmation = form.get("confirm_namespace");
      if (typeof namespace !== "string" || confirmation !== namespace) {
        throw new AppError("VALIDATION", "Namespace confirmation must match exactly", 400);
      }
      await assertAccountWritable(env, session.user.id, namespace);
      await scheduleNamespaceDeletion(env, session.user.id, namespace);
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
.dashboard-nav{min-height:76px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:24px;padding:14px max(20px,calc((100vw - 1160px)/2))}.dashboard-nav>div{display:flex;align-items:center;gap:18px;flex-wrap:wrap}.dashboard-nav a,.link-button{font-size:13px;text-decoration:none}.dashboard-nav form{margin:0}.link-button{border:0;background:none;color:inherit;padding:8px}.language{display:flex;gap:6px;font:10px var(--mono)}.language a[aria-current]{color:var(--accent);font-weight:600}.dashboard-shell{width:min(1160px,calc(100% - 40px));margin:0 auto;padding:28px 0 48px}.dash-head{display:flex;align-items:baseline;justify-content:space-between;gap:4px 16px;flex-wrap:wrap;margin-bottom:16px}.dash-head h1{font-size:clamp(24px,3.4vw,32px);margin:0}.dash-head p{margin:4px 0 0;font-size:13px}.dash-head .eyebrow{margin:0 0 6px}.hero{max-width:760px;margin-bottom:40px}.hero.compact{margin-top:34px}.hero h1{font-size:clamp(38px,7vw,68px);margin:0}.hero p{font-size:17px}.auth-card{width:min(100%,520px);margin:8vh auto 0;padding:36px;border:1px solid var(--line);background:var(--surface);border-radius:8px}.auth-card h1{font-size:clamp(30px,7vw,48px);margin:0}.auth-card form,.card form{display:grid;gap:14px;margin-top:28px}label{display:grid;gap:8px;font-size:13px}input{min-width:0;width:100%;min-height:46px;padding:10px 12px;border:1px solid #a8ada0;border-radius:5px;background:var(--surface);color:var(--ink)}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:16px}.stats article{display:grid;gap:2px;padding:12px 16px;background:var(--surface)}.stats span{font:10px var(--mono);color:var(--muted);text-transform:uppercase}.stats strong{font-size:22px;font-weight:500}.dashboard-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:28px;margin-bottom:28px}.dash-main{display:grid;grid-template-columns:300px minmax(0,1fr);gap:16px;margin-bottom:16px}.dash-side,.dash-content{display:grid;gap:16px;align-content:start;min-width:0}.dash-main .card{padding:16px 18px}.dash-main .card h2{margin:0 0 10px;font-size:15px}.dash-main .card form{gap:10px;margin-top:12px}.dash-main input{min-height:38px;padding:8px 10px}.dash-main .section-heading{gap:12px}.dash-main .section-heading h2{margin:0}.card,.map-panel{padding:28px;border:1px solid var(--line);background:var(--surface);border-radius:7px}.card h2{margin-top:0}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:20px}.recent-list,.namespace-list,.tree-list{list-style:none;padding:0;margin:0}.recent-list li+li,.namespace-list>li+li{border-top:1px solid var(--line)}.recent-list a{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:8px 0;text-decoration:none;font-size:13px}.recent-list a strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.recent-list a span{flex-shrink:0}.recent-list span,.namespace-list span,.tree-list span{font-size:12px;color:var(--muted)}.namespace-list>li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0}.namespace-list>li>div{display:grid;align-content:start;min-width:0}.namespace-list>li strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ns-meta{min-width:0}.ns-meta span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ns-empty{flex-shrink:0}.ns-empty summary{cursor:pointer;font-size:12px;text-decoration:underline;text-underline-offset:3px}.ns-empty form{display:grid;gap:10px;margin-top:10px;min-width:min(260px,60vw)}.namespace-list form{margin:0}.namespace-list label span{font-size:11px}.button.danger{background:#8d322f;border-color:#8d322f}.danger-zone{margin-top:0;border-color:#d7b4b2}.danger-zone details summary{cursor:pointer;font-size:13px}.danger-zone form{display:grid;gap:10px;margin-top:12px}.notice{display:grid;gap:12px;padding:16px 18px;margin-bottom:16px;border:1px solid #c9a95c;background:#fff7dc}.notice form{margin:0}.search-form{display:grid;gap:10px;margin-bottom:20px}.search-form>div{display:flex;gap:10px}.map-panel{overflow:hidden;margin-bottom:28px}.map-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 12px}.map-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.chip-button{min-height:32px;padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink);font:11px var(--mono);transition:background .2s,color .2s}.chip-button:hover{background:var(--tint);border-color:var(--accent);color:var(--accent)}.map-viewport{position:relative}.map-viewport>p{font:11px var(--mono);margin:0 0 10px}.mindmap-canvas{display:block;width:100%;height:620px;background:radial-gradient(circle at 20% 10%,#fbfaf6,var(--canvas) 62%);border:1px solid var(--line);border-radius:6px;outline-offset:2px;touch-action:none}.mindmap-canvas canvas{cursor:grab}.map-tooltip{position:absolute;z-index:2;display:grid;gap:2px;max-width:248px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface);box-shadow:0 12px 28px -18px rgba(40,42,37,.55);pointer-events:none;font:11px/1.5 var(--mono);color:var(--muted)}.map-tooltip strong{font:500 12px/1.4 Outfit,sans-serif;color:var(--ink)}.tree-list ul{margin:8px 0 16px}.tree-list summary{cursor:pointer;font-weight:500}.tree-list a{display:inline-block;margin-right:12px}.message{padding:24px 0;border-top:1px solid var(--line)}.message header{display:flex;justify-content:space-between;gap:20px;font:11px var(--mono);color:var(--muted)}.message p{white-space:pre-wrap;color:var(--ink)}pre{overflow:auto;padding:16px;background:var(--canvas);font:11px/1.6 var(--mono)}.tags{display:flex;gap:8px;flex-wrap:wrap}.tags span{padding:4px 8px;background:var(--tint);font:10px var(--mono)}.pagination{display:flex;justify-content:space-between;gap:20px;margin-top:32px}@media(max-width:720px){.dashboard-nav{align-items:flex-start;flex-wrap:wrap}.dashboard-nav>div{width:100%;justify-content:flex-start}.dashboard-shell{width:min(100% - 24px,1160px);padding-top:24px}.stats{grid-template-columns:repeat(3,1fr)}.stats article{padding:10px 12px}.dash-head h1{font-size:26px}.dash-main{grid-template-columns:1fr}.dashboard-grid{grid-template-columns:1fr}.namespace-list>li{flex-wrap:wrap}.search-form>div{display:grid}.card,.map-panel{padding:18px}.mindmap-canvas{height:460px}.map-tooltip{max-width:none}.message header{display:grid;gap:4px}}`;
