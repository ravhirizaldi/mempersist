import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { sha256, verifySecret } from "./crypto";
import type { AppEnv } from "./domain";
import { normalizeEmail } from "./tenant";

export const MAGIC_LINK_TTL_SECONDS = 900;
const MAGIC_LINK_MAX_PER_EMAIL = 5;
const MAGIC_LINK_TOKEN_BYTES = 32;

export type MagicLinkMode = "register" | "login";

export interface MagicLinkIssue {
  token: string;
  tokenHash: string;
  email: string;
  mode: MagicLinkMode;
}

export interface MagicLinkChallenge {
  tokenHash: string;
  email: string;
  mode: MagicLinkMode;
  oauthRequest: AuthRequest;
}

type AuthEnv = Pick<AppEnv, "MEMORY_DB">;

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(MAGIC_LINK_TOKEN_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function authRequest(value: string): AuthRequest | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const request = parsed as Record<string, unknown>;
    if (
      typeof request.responseType !== "string" ||
      typeof request.clientId !== "string" ||
      typeof request.redirectUri !== "string" ||
      typeof request.state !== "string"
    ) {
      return null;
    }
    if (!Array.isArray(request.scope)) return null;
    const scope = request.scope.filter((item): item is string => typeof item === "string");
    if (scope.length !== request.scope.length) return null;
    if (request.codeChallenge !== undefined && typeof request.codeChallenge !== "string") {
      return null;
    }
    if (
      request.codeChallengeMethod !== undefined &&
      typeof request.codeChallengeMethod !== "string"
    ) {
      return null;
    }
    let resource: string | string[] | undefined;
    if (typeof request.resource === "string") resource = request.resource;
    else if (Array.isArray(request.resource)) {
      const resources = request.resource.filter((item): item is string => typeof item === "string");
      if (resources.length !== request.resource.length) return null;
      resource = resources;
    } else if (request.resource !== undefined) return null;
    if (request.issuer !== undefined && typeof request.issuer !== "string") return null;
    const result: AuthRequest = {
      responseType: request.responseType,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scope,
      state: request.state,
    };
    if (typeof request.codeChallenge === "string") result.codeChallenge = request.codeChallenge;
    if (typeof request.codeChallengeMethod === "string") {
      result.codeChallengeMethod = request.codeChallengeMethod;
    }
    if (resource !== undefined) result.resource = resource;
    if (typeof request.issuer === "string") result.issuer = request.issuer;
    return result;
  } catch {
    return null;
  }
}

export async function issueMagicLink(
  env: AuthEnv,
  mode: MagicLinkMode | "continue",
  email: string,
  oauthRequest: AuthRequest,
  now = new Date(),
): Promise<MagicLinkIssue | null> {
  const normalizedEmail = normalizeEmail(email);
  const user = await env.MEMORY_DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(normalizedEmail)
    .first<{ id: string }>();
  const resolvedMode: MagicLinkMode = mode === "continue" ? (user ? "login" : "register") : mode;
  if ((resolvedMode === "register" && user) || (resolvedMode === "login" && !user)) return null;

  const createdAt = now.toISOString();
  const cutoff = new Date(now.getTime() - MAGIC_LINK_TTL_SECONDS * 1000).toISOString();
  const recent = await env.MEMORY_DB.prepare(
    "SELECT COUNT(*) AS count FROM auth_magic_links WHERE email = ? AND created_at > ?",
  )
    .bind(normalizedEmail, cutoff)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= MAGIC_LINK_MAX_PER_EMAIL) return null;

  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_SECONDS * 1000).toISOString();
  await env.MEMORY_DB.batch([
    env.MEMORY_DB.prepare(
      "DELETE FROM auth_magic_links WHERE consumed_at IS NOT NULL OR expires_at <= ?",
    ).bind(createdAt),
    env.MEMORY_DB.prepare(
      `INSERT INTO auth_magic_links
       (token_hash, email, mode, oauth_request_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      tokenHash,
      normalizedEmail,
      resolvedMode,
      JSON.stringify(oauthRequest),
      createdAt,
      expiresAt,
    ),
  ]);
  return { token, tokenHash, email: normalizedEmail, mode: resolvedMode };
}

export async function discardMagicLink(env: AuthEnv, tokenHash: string): Promise<void> {
  await env.MEMORY_DB.prepare("DELETE FROM auth_magic_links WHERE token_hash = ?")
    .bind(tokenHash)
    .run();
}

export async function consumeMagicLink(
  env: AuthEnv,
  token: string,
  now = new Date(),
): Promise<MagicLinkChallenge | null> {
  const tokenHash = await sha256(token);
  const consumedAt = now.toISOString();
  const consumed = await env.MEMORY_DB.prepare(
    `UPDATE auth_magic_links
     SET consumed_at = ?
     WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  )
    .bind(consumedAt, tokenHash, consumedAt)
    .run();
  if (consumed.meta.changes !== 1) return null;

  const row = await env.MEMORY_DB.prepare(
    "SELECT email, mode, oauth_request_json FROM auth_magic_links WHERE token_hash = ?",
  )
    .bind(tokenHash)
    .first<{ email: string; mode: MagicLinkMode; oauth_request_json: string }>();
  const oauthRequest = row ? authRequest(row.oauth_request_json) : null;
  if (!row || (row.mode !== "register" && row.mode !== "login") || !oauthRequest) {
    await discardMagicLink(env, tokenHash);
    return null;
  }
  return { tokenHash, email: row.email, mode: row.mode, oauthRequest };
}

export async function isAuthorized(request: Request, env: AppEnv): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  if (!token || !env.MEMORY_API_TOKEN) return false;
  return verifySecret(token, env.MEMORY_API_TOKEN);
}

export function unauthorized(): Response {
  return Response.json(
    { error: { code: "AUTHENTICATION", message: "Valid bearer token required" } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}
