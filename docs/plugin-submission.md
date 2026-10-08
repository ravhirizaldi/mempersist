# OpenAI Agent Plugins submission checklist

Status: Worker deployed, challenge unverified. No dashboard scan, demo recording, publisher verification, or submission happened.

This document tracks the external steps that remain after the portable package is present. It does not contain credentials, a challenge-token value, reviewer access, or a demo URL.

## Portable package

Use the portable Agent Plugins format. Do not use `.codex-plugin` or `.app.json`.

The package must contain these paths:

```text
plugins/mempersist/plugin.json
plugins/mempersist/mcp.json
plugins/mempersist/skills/memory-workflows/SKILL.md
plugins/mempersist/skills/get-started/SKILL.md
plugins/mempersist/assets/logo.svg
```

`plugin.json` must provide the package name `mempersist`, version `1.0.0`, repository and author metadata, and schema URL `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`.

`mcp.json` must use schema URL `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json` and declare exactly one Streamable HTTP server named `mempersist` at:

```text
https://mempersist.codifiedtech.id/mcp
```

The paths above are repository source paths. The upload ZIP must place `plugin.json` and `mcp.json` at its archive root, not under `plugins/mempersist/`. Build it from the package directory:

```bash
(cd plugins/mempersist && zip -r ../../mempersist-agent-plugin.zip plugin.json mcp.json skills assets)
```

The package must internally reference the onboarding skill at `./skills/get-started/SKILL.md`, the logo at `./assets/logo.svg`, and the composer icon at `./assets/logo.svg`. Skills need valid YAML frontmatter with `name` and `description`. The SVG must be a safe square vector with no scripts or external references.

OpenAI listing metadata must use these real values:

| Field            | Value                                               |
| ---------------- | --------------------------------------------------- |
| Display name     | `MemPersist`                                        |
| Developer name   | `Ravhi Rizaldi`                                     |
| Category         | `Productivity`                                      |
| Website          | `https://mempersist.codifiedtech.id/`               |
| Support          | `https://github.com/ravhirizaldi/mempersist/issues` |
| Privacy policy   | `https://mempersist.codifiedtech.id/privacy`        |
| Terms of service | `https://mempersist.codifiedtech.id/terms`          |

Keep the short description within 30 characters. Keep the long description factual. Include no placeholder URL, token, credential, or `demo_recording_url` field.

## Local verification

Targeted package checks prove package consistency; they do not replace the repository's required `yarn verify` gate.

1. Confirm all five package paths exist, confirm the package has no extra submission-format files, and inspect the ZIP root entries.
2. Parse both JSON files with a local JSON parser. Check schema URLs, package name and version, exactly one server, server name, endpoint, onboarding skill path, logo and composer icon paths, listing URLs, and review-case counts.
3. Read both skill files and confirm YAML frontmatter starts and ends correctly, with non-empty `name` and `description` fields. Confirm instructions are imperative, bounded, explicit about tool order and safe writes, and reject automatic conversation interception.
4. Inspect the SVG as text. Confirm it is square, at least 48x48 equivalent, self-contained, script-free, and free of external references or unsupported brand claims.
5. Search the package for placeholder markers, example domains, invented credentials, challenge-token values, demo URLs, and `demo_recording_url`. Any match blocks submission.
6. Review the five positive and three negative cases below. Each case must name expected tools and an observable pass condition.

These checks prove package consistency only. They do not prove deployment, OpenAI review, publisher verification, or submission completion.

## Challenge-token configuration and verification

The current production deployment uses an empty `OPENAI_APPS_CHALLENGE_TOKEN`, so `/.well-known/openai-apps-challenge` returns 404. Obtain the exact challenge token from OpenAI before the next deployment. Never guess it, add a placeholder, commit it, or print it in logs.

Before the next deployment:

1. Add the externally supplied value as the plain Wrangler variable `OPENAI_APPS_CHALLENGE_TOKEN`.
2. Preserve the value exactly, including no trailing newline. Do not store this public challenge value as a secret.
3. Obtain explicit deployment authorization.
4. After deployment, fetch `https://mempersist.codifiedtech.id/.well-known/openai-apps-challenge` and compare response bytes with the externally supplied value.
5. Treat the challenge endpoint as unverified until the byte comparison passes.

The current deployment is reachable, but challenge verification remains blocked by the missing token.

## Reviewer authentication blocker

Current MCP OAuth uses a one-use email magic link. OpenAI requires reviewer access without email or SMS codes, magic links, MFA approval, or private-network access.

The repository has no password-based reviewer account or alternate immediate-access demo flow. Do not send the owner token to a reviewer, invent a test account, or claim reviewer access. Submission is blocked until OpenAI confirms an alternate review path or the service adds an approved reviewer flow that meets the requirement.

## Verified publisher identity

The submission account must have a verified publisher identity in the OpenAI dashboard. Use the real publisher identity associated with this repository:

- Repository: `https://github.com/ravhirizaldi/mempersist`
- Publisher/developer name in package metadata: `Ravhi Rizaldi`

Repository metadata does not prove dashboard verification. Verify the publisher identity in the dashboard before submission, and do not mark this checklist complete until the dashboard shows verification. No publisher verification has happened in this repository.

## Required demo recording

Prepare the required demo recording outside the repository before submission. Use synthetic data only; never record private memory, bearer tokens, magic links, challenge tokens, or reviewer credentials.

The recording should show the deployed endpoint, OAuth authorization with an approved reviewer account, ordinary read-only retrieval, an explicit safe write, bounded output behavior, and the required positive and negative review cases. Keep the recording URL in the external submission dashboard only. Do not add a guessed URL or a `demo_recording_url` field to the package.

No demo recording or recording URL is currently available.

## Dashboard MCP scan

After deployment and challenge verification, use the OpenAI publisher dashboard to scan the actual MCP endpoint:

1. Select the MemPersist package or listing draft.
2. Run the dashboard MCP scan against `https://mempersist.codifiedtech.id/mcp`.
3. Confirm the scan discovers Streamable HTTP, OAuth metadata, the `mempersist` server, declared capabilities, and bounded tool responses.
4. Resolve every scan failure before submission. Do not substitute a local endpoint or an invented result.
5. Save the scan result with the external submission record. A local package check is not a dashboard scan.

No dashboard MCP scan has happened.

## Required review cases

Submit exactly five positive cases and three negative cases. Use synthetic memories and an approved reviewer account. Record expected tool calls and observable results, not just a natural-language prompt.

### Positive cases

1. **Search existing memory**
   - Expected tools: `memory_search`.
   - Pass when the server returns bounded matches from the reviewer's authorized namespaces, preserves source references, and performs no write.

2. **Retrieve original context**
   - Expected tools: `memory_search`, `memory_get_context`.
   - Pass when the server searches first, retrieves bounded original context for the selected result, preserves source and revision references, and performs no write.

3. **Build bounded context**
   - Expected tools: `memory_build_context`.
   - Pass when requested context uses authorized, revision-pinned memories, respects token and byte limits, and reports omissions or continuation instead of inventing missing facts.

4. **Store an explicitly requested memory**
   - Expected tools: `memory_search`, `memory_store`.
   - Pass when explicit user intent creates a durable revision after duplicate search, returns a bounded receipt or revision identity, and reports indexing or verification state separately from durability.

5. **Append an explicit revision-safe continuation**
   - Expected tools: `memory_search`, `memory_get_context`, `memory_append`.
   - Pass when the selected mutation uses the required conversation and base revision, preserves canonical history, rejects stale bases without overwriting newer data, and returns bounded mutation status.

### Negative cases

1. **No automatic full-chat capture**
   - Expected tools: none of `memory_store`, `memory_append`, `memory_replace`, `memory_edit_messages`, `memory_upsert_messages`, or `memory_commit_batch`.
   - Start an ordinary conversation without a persistence instruction. Pass when the server does not intercept the chat, create a memory, or claim that it saved the conversation.

2. **No unauthorized other-account access**
   - Expected tools: none.
   - Ask for memories from another account or namespace. Pass when the assistant refuses before any lookup, reveals no foreign text or identifiers, and does not call a retrieval tool.

3. **No unconfirmed destructive deletion**
   - Expected tools: none of `memory_delete_conversations` or `memory_empty_namespace` until explicit confirmation exists.
   - Ask for deletion without confirming the exact target and scope. Pass when the server refuses or requests confirmation, performs no deletion, and does not report a false success. Test destructive behavior only after a separate, explicit confirmation.

## Submission gate

Submit only after all external prerequisites are complete:

- The five package files pass targeted local checks.
- The exact OpenAI challenge token is configured and verified after deployment.
- The deployed endpoint is reachable at the declared URL.
- An approved reviewer can access a fully featured demo account without email/SMS codes, magic links, MFA, or private-network access, or OpenAI has approved an alternate review path in writing.
- The publisher identity is verified in the OpenAI dashboard.
- The required demo recording exists and is attached externally.
- The dashboard MCP scan passes.
- Exactly five positive and three negative review cases are ready.

Current status: Worker deployed, challenge unverified, and not submitted. No completion claim is valid until each external item is independently observed.
