# Session transcripts (opt-in, this workspace only)

Transcripts are the most expensive source and can hold private material. Read
them only after the user says yes to a question such as "Also read the last 10
session transcripts for this workspace? (local files, read-only)". The default
is no: the ledger, `pr status` and git are enough for most retros.

## Where they live

Typical locations; confirm each exists. Resolve the path from this workspace's
absolute path, never with a wildcard across projects. If a host's layout
differs from the one below, say so and skip it rather than search wider.

| Host | Location |
| --- | --- |
| Claude Code | `~/.claude/projects/<folder>/*.jsonl`, one folder per path from `git worktree list`: the absolute path with every `/` and `.` replaced by `-`. Compute each folder name; never glob for it |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. To filter, parse only line 1 (`session_meta`) and read only its `cwd` field; skip files whose `cwd` is not this workspace without reading or reporting anything else from them |
| Cursor | `~/.cursor/projects/<workspace slug>/agent-transcripts/` |
| Pi | `~/.pi/agent/sessions/--<workspace path, / replaced by ->--/*.jsonl` |
| OpenCode | this project's sessions from `opencode session list`, read with `opencode export <id>` |

Linked worktrees of the same repository count as this workspace; other
repositories never do.

## How to read them

- Newest first, at most the agreed number of sessions.
- On a host with subagents, one read-only analyst per lens, each returning
  only cited occurrences (session file plus line or message index):
  - navigation: searches and reads before the right file was found, stale docs
    followed;
  - tool economy: hand-run commands where a `workit` verb exists, repeated
    reads of the same file, long outputs nobody used;
  - repeated work: the same fix or check redone, a step undone later;
  - request conflicts: instructions the agent had to reconcile or ask about.
