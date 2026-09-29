import {
  getOAuthApi,
  OAuthProvider,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import app from "./app";
import { handleDashboardRequest } from "./dashboard";
import { processDeletionJobMessage } from "./deletion-jobs";
import { verifySecret } from "./crypto";
import type { AppEnv, JobMessage } from "./domain";
import { processJobMessage } from "./jobs";
import { createMemoryMcpServer } from "./mcp";
import {
  handleAuthorization,
  handleMagicLink,
  MCP_ORIGIN,
  MCP_SCOPE,
  mcpOriginForRequest,
  overrideOrigin,
  type OAuthEnv,
} from "./oauth";
import { resolveTenant } from "./tenant";

const mcpHandler = {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    // The OAuth provider decrypts grant props onto this ExecutionContext before
    // dispatching the MCP route; getMcpAuthContext() is not populated until
    // createMcpHandler wraps the request, so read props from ctx here.
    const props = (ctx as ExecutionContext & { props?: unknown }).props;
    const tenant = await resolveTenant(env, props);
    const handler = createMcpHandler(() => createMemoryMcpServer(env, tenant), {
      route: "/mcp",
      corsOptions: false,
    });
    return handler(request, env, ctx);
  },
};

const defaultHandler = {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/authorize") {
      return handleAuthorization(request, env as OAuthEnv);
    }
    if (path === "/auth/magic-link") {
      return handleMagicLink(request, env as OAuthEnv);
    }
    if (
      path === "/login" ||
      path === "/logout" ||
      path === "/auth/dashboard" ||
      path === "/dashboard" ||
      path.startsWith("/dashboard/")
    ) {
      return handleDashboardRequest(request, env);
    }
    return app.fetch(request, env, ctx);
  },
};

function oauthOptions(origin: string): OAuthProviderOptions<AppEnv> {
  const resource = `${origin}/mcp`;
  return {
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [MCP_SCOPE],
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      scopes_supported: [MCP_SCOPE],
      resource_name: "MemPersist conversation memory",
    },
    resolveExternalToken: async ({ token, env }) =>
      (await verifySecret(token, env.MEMORY_API_TOKEN))
        ? { props: { userId: "owner", authType: "static" }, audience: resource }
        : null,
  };
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    // The audience origin is deployment configuration, not request state: a
    // development override resolves to the same value for every request.
    const provider = new OAuthProvider<AppEnv>(oauthOptions(mcpOriginForRequest(request, env)));
    return provider.fetch(request, { ...env }, ctx);
  },

  async queue(batch: MessageBatch<JobMessage>, env: AppEnv): Promise<void> {
    const oauthApi = getOAuthApi(oauthOptions(overrideOrigin(env) ?? MCP_ORIGIN), env);
    for (const message of batch.messages) {
      try {
        if (message.body.version !== 1 || typeof message.body.job_id !== "string") {
          console.error(JSON.stringify({ message: "invalid_queue_message", queue: batch.queue }));
          message.ack();
          continue;
        }
        if (!(await processDeletionJobMessage(env, message.body, oauthApi))) {
          await processJobMessage(env, message.body);
        }
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "queue_job_failed",
            queue: batch.queue,
            job_id: message.body.job_id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<AppEnv, JobMessage>;
