# 0002: R2 is the canonical memory store

- Status: Accepted

## Context

Conversation bodies, raw exports, branches, and unknown metadata must survive index deletion, schema/model changes, and failed processing.

## Decision

Preserve original uploads unchanged and normalized immutable revision segments/manifests in R2. Use content hashes and portable JSON/JSONL formats.

## Consequences

Canonical reads may require an R2 object fetch and storage must be backed up independently. Rebuilds do not require the user to re-upload history.

## Alternatives

D1-only bodies were rejected due row limits, growth, and making catalog loss equivalent to memory loss. One object per message was rejected due operation overhead.
