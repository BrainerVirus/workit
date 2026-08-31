---
name: wk-status
description: Full workit health check — MCP deps, YouTrack + VCS (GitLab/GitHub) API verify. Use /wk-status after editing token files.
disable-model-invocation: true
---

# Status

Deterministic health check. **Tools only — no manual git/curl.**

**Agent language:** English unless the user writes in another language.

## Step 1 — Full status (required)

Call MCP `workit_status` once.

Use the return value as ground truth. Do not infer state yourself.

## Step 2 — Report (English)

Show a table from `items[]`:

| Item                 | OK                       | Notes                              |
| -------------------- | ------------------------ | ---------------------------------- |
| MCP npm dependencies | items[mcp_deps].ok       | path                               |
| YouTrack config      | items[youtrack_json].ok  | path                               |
| YouTrack token file  | items[youtrack_token].ok | placeholder? → show `token_create_url` + `token_edit_path` |
| VCS config           | items[vcs_json].ok       | path                               |
| GitLab token         | items[gitlab_token].ok   | required when provider=gitlab      |
| GitHub token         | items[github_token].ok   | required when provider=github      |

### YouTrack settings (required when `youtrack_config` present)

Always show this block from tool output — user expects to see meeting issue and time-logging targets:

| Setting | Value |
|---------|-------|
| Config file | clickable `youtrack_config.config_edit_path` |
| Meeting issue | `meetingIssue` — time only via `/wk-meetings` |
| Meeting URL | `meetingIssueUrl` as markdown link |
| Manager tag | `@` + `defaultMention` |
| Task issue (time + comment) | from active spec/plan `**YouTrack:**` — not stored in json |
| Timezone | `timezone` |

Then **YouTrack API** from `youtrack_verify`:

- `ok: true` → show `login`, `name`, `meetingIssue`, `meetingIssueSummary` if present
- `ok: false` → show `error` and `next_step` from tool

### VCS / PR settings (when `vcs_config` present)

| Setting | Value |
|---------|-------|
| Config | `vcs_config.config_edit_path` |
| Provider | `provider` (`gitlab` / `github`) |
| Target branch | `defaultTargetBranch` |
| Squash on merge | `pr.squashOnMerge` |
| Remove source branch | `pr.removeSourceBranch` |

**VCS API** from `vcs_verify`:

- `ok: true` → show `username`, `provider`
- `ok: false` → show `vcs_token_edit_path` or token `fix` from items when placeholder

## Step 3 — Verdict

- `ready: true` → "All checks passed. Toolkit is ready."
- `ready: false` with `placeholder: true` on **YouTrack** → show both links:

```markdown
1. [Create YouTrack token](<token_create_url>) — New token → name **workit**, scope **YouTrack**
2. Paste into [youtrack.token](<token_edit_path>) — replace `YOUR_TOKEN_HERE`, save, then `/wk-status`
```

Use `items[youtrack_token].token_create_url` / `token_edit_path`, or top-level `token_create_url` + `token_edit_path` from tool output.

- `ready: false` with VCS placeholder → show **`vcs_token_edit_path`** and active provider `token_create_url` from items.

- `ready: false` (other) → show `next_step` and `youtrack_verify.error` from tool output.

## Rules

- Do not call YouTrack HTTP directly — `workit_status` includes verify.
- Do not ask user to paste token — point them to edit the token file if `placeholder: true`.
- Optional: `workit_youtrack_verify_token` only if user asks to re-test API alone.
