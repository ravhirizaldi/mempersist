# MemPersist memory skill for coding agents

Applies to any coding agent connected to MemPersist (Codex CLI, Claude Code, Cursor,
ChatGPT desktop, IDE extensions). All tools are scoped to your account; namespaces with the
same name in another account are separate and invisible.

## When to record

Store a memory when it is a durable fact a future session would need:

- Architecture decisions and ADRs, and the reasons behind them.
- Breaking API, schema, contract, or migration changes and how to work with them.
- Deployments that change observable behavior (new endpoints, auth flows, tooling).
- Incident root causes and their fixes; recovery or rollback procedures.
- Completed milestones with what shipped and what is explicitly out of scope.

Do not store routine commits, "I did X" churn, or facts you can read from the repository.

## Namespace conventions

- Always store into `project/<slug>`, where `<slug>` is the repository folder name
  (lowercase, `a-z0-9._-/`). The first write to a name claims it for your account.
- Keep one conversation per project as the durable archive; append to it over time.
- Project events are their own conversations titled `EVENT <YYYY-MM-DD> <short summary>`
  and tagged `events`. Do not create an events namespace.
- Never write into `personal` or namespaces you did not create for this project.

## Workflow

1. **Search first.** Before storing or answering from memory, call `memory_search` with the
   project slug in mind. If an existing memory matches, do not create a duplicate.
2. **Verify before relying on a memory.** Use `memory_get_context` on a search hit to see
   the surrounding conversation before treating a decision as current; appends supersede.
3. **Store with full context.** `memory_store` with title, `project/<slug>`, tags, and
   messages that include the decision, the reasoning, and the constraints. Titles should be
   descriptive nouns, not commands.
4. **Update, never duplicate.** Use `memory_append` on the existing conversation id with the
   `base_revision_id` returned by the previous store/append. Append supersedes earlier text.
5. **Delete only on explicit user confirmation.** Remove specific memories with
   `memory_delete_conversations`; clear an entire project with `memory_empty_namespace`
   (exact confirmation required). Never delete memory unprompted.
6. **Never invent memory.** Cite the conversation ids and revision ids returned by the
   tools; if search returns nothing, say memory is empty for that project.

## Discovery

- `memory_list_namespaces` shows which namespaces your account owns.
- `memory_stats` shows per-namespace conversation/message counts and indexing health.
  If `indexing.pending` is nonzero, wait before relying on fresh search results.

## Tool reference

| Tool                          | Use                                                         |
| ----------------------------- | ----------------------------------------------------------- |
| `memory_search`               | find memories; tags + `tag_mode` filter                     |
| `memory_get_context`          | original messages around a search hit                       |
| `memory_get_conversation`     | page a full conversation                                    |
| `memory_list_conversations`   | metadata + tags per conversation                            |
| `memory_list_namespaces`      | namespaces you own                                          |
| `memory_stats`                | counts + indexing health                                    |
| `memory_store`                | durable new memory (claims `project/<slug>` on first write) |
| `memory_append`               | extend an existing conversation, optimistic revision check  |
| `memory_update_tags`          | change tags on an existing conversation                     |
| `memory_delete_conversations` | delete specific memories (user-confirmed)                   |
| `memory_empty_namespace`      | empty one of your namespaces (exact confirmation)           |
| `memory_import_status`        | ChatGPT import progress (owner only)                        |

## Pair with git

In a normal repository, git already tracks _what_ changed. MemPersist tracks _why_ and
_what it breaks_. Use them together every session:

1. **Check both before acting.** Run `git log`, `git blame`, `git status`, and `git diff`
   for the files you are about to touch, and run `memory_search` for the same area. A
   memory entry with a commit hash links the two.
2. **Record changes with git context.** When storing a change, include the short commit
   hash, the files touched, and the branch, plus: what changed, why, what it breaks, and
   what must run (migrations, reindex, build order).
3. **Diagnose crashes against both.** On a regression: `git log --oneline` since the last
   known-good deploy, `git blame` the failing line, then `memory_search` for that area.
   Store the incident as symptom → root cause → fix, with the fixing commit hash, so the
   next session skips the whole debugging loop.
4. **Tag for future filtering.** Use a small vocabulary: `decision`, `breaking`, `incident`,
   `runbook`, `events`. A `breaking` entry should always state the impact and the required
   follow-up command.

Git alone cannot say _"this was intentional because X and breaks Y"_ — that is exactly what
this skill writes down. If the repo has no other documentation, treat MemPersist as the
decision log for git history.
