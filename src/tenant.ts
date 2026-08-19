import { domainId } from "./crypto";
import type { AppEnv } from "./domain";
import { AppError } from "./errors";

export const OWNER_USER_ID = "owner";
export const OWNER_DB_USER_ID = "e541a1b8fba085f027f1065926b0da4d80226db3d14ad76ec87b8284449e4a8e";
export const OWNER_NAMESPACE = "personal";
export const OWNER_EMAIL = "vhie1046@gmail.com";

export interface Tenant {
  userId: string;
  defaultNamespace: string;
  namespaces: string[];
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

export async function userIdForEmail(email: string): Promise<string> {
  return domainId("user", normalizeEmail(email));
}

export async function grantNamespace(
  env: Pick<AppEnv, "MEMORY_DB">,
  userId: string,
  namespace: string,
): Promise<void> {
  await env.MEMORY_DB.prepare(
    "INSERT OR IGNORE INTO user_namespaces (user_id, namespace, created_at) VALUES (?, ?, ?)",
  )
    .bind(userId, namespace, new Date().toISOString())
    .run();
}

export async function listUserNamespaces(
  env: Pick<AppEnv, "MEMORY_DB">,
  userId: string,
): Promise<string[]> {
  const rows = await env.MEMORY_DB.prepare(
    "SELECT namespace FROM user_namespaces WHERE user_id = ? ORDER BY namespace",
  )
    .bind(userId)
    .all<{ namespace: string }>();
  return rows.results.map((row) => row.namespace);
}

export async function getOrCreateUser(
  env: Pick<AppEnv, "MEMORY_DB">,
  email: string,
): Promise<{ id: string; email: string; namespace: string }> {
  const normalized = normalizeEmail(email);
  const id = await userIdForEmail(normalized);
  await env.MEMORY_DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, namespace, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, normalized, id, new Date().toISOString())
    .run();
  const row = await env.MEMORY_DB.prepare("SELECT id, email, namespace FROM users WHERE id = ?")
    .bind(id)
    .first<{ id: string; email: string; namespace: string }>();
  if (!row) throw new AppError("CANONICAL_STORAGE", "User provisioning failed", 500);
  await grantNamespace(env, row.id, row.namespace);
  return row;
}

export async function resolveTenant(
  env: Pick<AppEnv, "MEMORY_DB">,
  props?: unknown,
): Promise<Tenant> {
  const rawUserId = (props as { userId?: string } | undefined)?.userId ?? OWNER_USER_ID;
  const dbUserId = rawUserId === OWNER_USER_ID ? OWNER_DB_USER_ID : rawUserId;
  const row = await env.MEMORY_DB.prepare("SELECT namespace FROM users WHERE id = ?")
    .bind(dbUserId)
    .first<{ namespace: string }>();
  if (!row) throw new AppError("AUTHENTICATION", "Unknown user", 401);
  const namespaces = await listUserNamespaces(env, dbUserId);
  return {
    userId: dbUserId,
    defaultNamespace: row.namespace,
    namespaces: namespaces.length > 0 ? namespaces : [row.namespace],
  };
}

// Resolve the namespaces a caller may touch. A requested namespace must
// belong to the caller; omitting it means every namespace the caller owns.
export function scopeNamespaces(tenant: Tenant, requested?: string): string[] {
  if (requested) {
    if (!tenant.namespaces.includes(requested)) {
      throw new AppError("AUTHENTICATION", "Namespace is not accessible to this account", 403);
    }
    return [requested];
  }
  return tenant.namespaces;
}

// Resolve the caller's allowed namespaces. A requested namespace must belong
// to the caller; omitting it means every namespace the caller owns.
export async function resolveNamespaces(
  env: Pick<AppEnv, "MEMORY_DB">,
  props: unknown,
  requested?: string,
): Promise<{ tenant: Tenant; namespaces: string[] }> {
  const tenant = await resolveTenant(env, props);
  return { tenant, namespaces: scopeNamespaces(tenant, requested) };
}
