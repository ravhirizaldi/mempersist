# ADR 0008: OAuth 2.1 for ChatGPT MCP access

- Status: Accepted
- Date: 2026-08-14

## Context

ChatGPT can connect to remote MCP servers but does not accept MemPersist's private static bearer token as its interactive authorization protocol. MCP authorization discovery expects OAuth metadata, authorization code flow, and PKCE. This service remains single-user and must not add a general identity platform.

## Decision

Use `@cloudflare/workers-oauth-provider` around `/mcp`, backed by the private `OAUTH_KV` namespace. Enable PKCE S256, Client ID Metadata Documents, and dynamic client registration for compatibility. Pin the OAuth resource audience to the deployed `/mcp` URL and expose one coarse `memory` scope.

The application-owned `/authorize` page authenticates the owner with `MEMORY_API_TOKEN`, requires a secure double-submit CSRF value, renders escaped client metadata, and grants access only after explicit consent. Existing developer bearer-token access remains available through the provider's external-token validation hook. `/api/*` retains its existing static-token boundary.

## Consequences

- ChatGPT can discover, authorize, refresh, revoke, and use MemPersist without receiving the owner key.
- OAuth clients, hashed tokens, encrypted props, and grants add one disposable KV dependency; loss of KV disconnects clients but cannot delete canonical memory.
- The static owner key remains a high-value secret and must never be logged or stored in source.
- V1 does not implement accounts, social login, per-tool scopes, or a grant dashboard.

## Alternatives considered

- Hand-written OAuth: rejected because the official package already implements protocol validation, token hashing, PKCE, discovery, refresh rotation, and revocation more safely.
- Cloudflare Access as the MCP authorization server: rejected for V1 because it adds identity-policy configuration and does not remove the need for MCP-compatible OAuth discovery.
- Unauthenticated MCP or sharing the owner bearer token with ChatGPT: rejected because either exposes private history or bypasses the client's supported authorization flow.
