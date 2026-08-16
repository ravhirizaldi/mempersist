# 0013: Conversation tags as filterable metadata

- Status: Accepted

## Context

Search had one structural filter (namespace) plus free text. Conversation-level metadata such as
story arcs, characters, locations, or topics could not be attached intentionally, so precision
queries such as "all battle scenes in the dragon arc" required the text to mention those terms. The
`conversation_tags` table has existed since the initial schema but was never written or read.

## Decision

Add conversation-level tags as first-class, user-supplied metadata:

- `memory_store` and `memory_append` accept up to 20 tags of at most 64 characters. Tags are
  trimmed, Unicode-normalized, lowercased, and deduplicated.
- Tags are durable twice: in the canonical revision manifest (per-revision, immutable) and in the
  existing `conversation_tags` D1 table for the current conversation. Appends add to the tag set
  (union); there is no tag removal API in V1. Conversation deletion already cascades the table.
- `memory_search` accepts an optional tag list with AND semantics: a conversation must match every
  requested tag. The filter is applied across all retrieval channels after candidate merge.
- Matching conversation tags add a bounded ranking boost of at most `0.25` (0.1 per matched tag)
  in ranking strategy `normalized-weighted-v3`.
- `memory_list_conversations` and search results include each conversation's tags.

Tags are deliberately excluded from FTS bodies and chunk embeddings. Adding them to derived chunks
would change chunk strategy and require a new generation plus a full rebuild for a metadata signal
that D1 can already join at query time.

## Consequences

Precision searches on story or topic metadata work without changing chunks, embeddings, Vectorize
metadata, or canonical objects; no index rebuild is required. The filter is a post-merge predicate
over a candidate pool of `min(50, max(20, limit * 4))`, so very narrow tag filters can underfill on
indexed channels. The recent-canonical channel is not affected because tags join the catalog, not
canonical reads.

## Alternatives

Tag ranking weighted heavily toward filters, tag auto-extraction from message text, per-message
tags, and a tag removal API were rejected for V1: auto-extraction is non-deterministic LLM work,
per-message tags multiply schema surface, and removal adds a concurrent-write surface without a
measured need.
