import type { AppEnv } from "./domain";
import { verifySecret } from "./crypto";

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
