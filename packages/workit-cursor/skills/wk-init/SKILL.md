---
name: wk-init
description: One-time workit setup — MCP deps, YouTrack, and VCS (GitLab/GitHub) config. Tokens edited locally only. Use /wk-init.
disable-model-invocation: true
---

# Init

Scaffold config via MCP. **Never paste API tokens in chat.**

**Agent language:** English unless the user writes in another language.

## Step 1 — Status (required)

Call MCP `workit_init_status`. Show `items[]` in English.

### YouTrack settings (when `youtrack_config` present)

| Setting | Value |
|---------|-------|
| Config file | clickable `config_edit_path` |
| Base URL | `baseUrl` |
| Meeting issue | `meetingIssue` + `meetingIssueUrl` |
| Manager mention | `defaultMention` |
| Timezone / locale | `timezone` / `locale` |
| Meeting time | `/wk-meetings` |
| Task updates | `/wk-issue-update` |

### VCS / PR settings (when `vcs_config` present)

| Setting | Value |
|---------|-------|
| Config file | `config_edit_path` → `vcs.json` |
| Provider | `provider` (`gitlab` or `github`) |
| Target branch | `defaultTargetBranch` (usually `develop`) |
| PR skill | `/wk-pr` |
| Squash on merge | `pr.squashOnMerge` |
| Remove source branch | `pr.removeSourceBranch` (default `true`) |
| Switch provider | `switchHint` |

## Step 2 — Apply missing pieces

### mcp_deps

Native `AskQuestion` asks whether to install MCP dependencies → on yes: `workit_init_apply` action=`npm_install` confirmed=`true`

### YouTrack scaffold

Native `AskQuestion` asks whether to create the YouTrack scaffold → on yes: `workit_init_apply` action=`youtrack_scaffold` confirmed=`true`

### VCS scaffold (GitLab + GitHub token files)

Only when `items[vcs_json].ok` is **false**:

1. Native `AskQuestion` asks for GitLab or GitHub → remember `provider` (`gitlab` | `github`).
2. Native `AskQuestion` asks `Create vcs.json and token placeholders for <provider>?`
   → on yes: `workit_init_apply` action=`vcs_scaffold` confirmed=`true` **`vcs_provider=<chosen provider>`**

Both `gitlab.token` and `github.token` are always created (switch later by editing `provider` in `vcs.json`). Tell the user which token file is **active** for `/wk-pr` based on the chosen provider.

Optional: `vcs_target_branch` if user states a non-`develop` default.

## Step 3 — User edits tokens (outside chat)

### YouTrack

Show from `youtrack_config.tokenCreate` or `items[youtrack_token]`:

| Field | Source |
|-------|--------|
| Create token (click) | `token_create_url` — opens Profile → **Account Security** (Tokens section) |
| Paste token into | `token_edit_path` on `youtrack_token` item |
| Prefilled name | `token_name` → `workit` |
| Scope | `token_scopes` → `YouTrack` only |

YouTrack does **not** support URL prefill for name/scopes — after the link opens, click **New token** and enter name + scope manually (`token_create_steps` if present).

1. [Create YouTrack token](<token_create_url>) → **New token** → name **workit**, scope **YouTrack** → **Create token**
2. Copy token → open [youtrack.token](<token_edit_path>) → replace `YOUR_TOKEN_HERE` → save
3. **`/wk-status`**

### VCS (active provider)

For the **active** provider (`vcs_config.provider`), show from `vcs_config.tokenCreate` or `items[gitlab_token|github_token].token_create_url`:

| Field | Source |
|-------|--------|
| Create token (click) | `token_create_url` — opens provider form with **name**, **description**, and **scopes/permissions** prefilled |
| GitHub classic fallback | `token_create_url_classic` on `github_token` item only |
| Paste token into | `token_edit_path` on the active provider item |
| Prefilled name | `workit` |
| GitLab scopes | `api` |
| GitHub permissions | `pull_requests:write`, `contents:write`, `metadata:read` |

**Active provider (gitlab example):**

1. [Create GitLab token](<token_create_url>) — form opens with name/scopes filled → click **Create**
2. Copy token → open [gitlab.token](<token_edit_path>) → replace `YOUR_TOKEN_HERE` → save
3. **`/wk-status`**

**Inactive provider:** show `vcs_config.tokenCreateUrls.<other>` link for later; only the active token file is required now.

## Rules

- Never ask for or accept tokens in chat.
- Mutations only via `workit_init_apply` with `confirmed: true`.
- Verification is **`/wk-status`** only — not part of init.
