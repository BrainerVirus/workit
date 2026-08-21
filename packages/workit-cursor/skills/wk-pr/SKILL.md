---
name: wk-pr
description: Draft or create PR/MR via workit_pr_context + glab/gh. Squash on merge + delete source branch. Use /wk-pr.
---

# PR — Draft or Create

Draft a merge request / pull request body, or create it on GitLab (`glab`) / GitHub (`gh`) using `~/.config/workit/vcs.json`.

**Setup:** `/wk-init` → pick provider → VCS scaffold → edit active token file.

**Active provider:** read `vcs_config.provider` from `workit_pr_context` (or `provider` in `~/.config/workit/vcs.json`). That decides `glab` vs `gh`.

## Step 1 — Gather facts (required)

Call MCP `workit_pr_context` with **no `range` argument** unless the user supplied an explicit git range string.

**Repository calls:** For every repository-scoped `workflow_*` call, pass the active Cursor workspace as `workspace_root`; never rely on the MCP process default.

On `feature/*` or `bugfix/*`, the tool compares **only against `develop`** (never `main`).

Use the tool return as ground truth. Pay attention to:

- `body_style_rules` and `merged_pr_style.examples` — match your recent merged MRs
- `vcs_config` — provider, `defaultTargetBranch`, `pr.squashOnMerge`, `pr.removeSourceBranch`
- `commits`, `diff_stat`, `files` — **for drafting only**, never paste into the published body

## Step 2 — Draft body (required)

Write title + body per rules below. Read `merged_pr_style` if present.

### Body rules (from your merged MRs)

**Include:**

- `## Summary` — short outcome bullets (what changed for the user/reviewer)
- `## Validation` or `## Test plan` — only checks you actually ran (`[x]` when done)

**Never include:**

- `## Notes` with branch names, `develop..HEAD`, commit counts, or file counts
- Commit log, `diff_stat`, or changed-files list
- Git sync warnings, `range_mode`, or agent meta
- Long nested `###` sections duplicating the diff
- Scope disclaimers ("scoped to branch X…") unless the user explicitly asks

Title: Conventional Commits — `type(scope): subject`, imperative, lowercase, no trailing period.

## Step 3 — Review (show before confirm)

Show:

```md
Title:
<copy-paste title>

Body:
<copy-paste body>
```

## Step 4 — Create (optional)

Use native `AskQuestion`: title `Create MR/PR`; prompt `Create the reviewed MR/PR now?`; options `Create` and `Cancel`. On `Create`:

`workit_pr_create` with `confirmed: true`, `title`, `body`, optional `target_branch` (defaults from vcs.json).

**On failure:** show the tool `error` / `stderr` / `hint` and stop. **Never** fall back to running `glab` or `gh` in the shell — creation must go through `workit_pr_create` only.

Creation uses vcs.json flags (both default `true`):

- **squash on merge** — single commit when you merge in GitLab/GitHub UI
- **remove source branch** — branch deleted after merge (clean `develop`, no stale `feature/*`)
- **push branch** — pushes current branch before create

GitLab: `glab mr create` with `-t`, `-d` (required in non-interactive mode), `--squash-before-merge`, `--remove-source-branch`  
GitHub: use **Squash and merge** + **Delete branch** in the UI (or `gh pr merge --squash --delete-branch`); create step sets title/body only.

## Branch policy (tool-enforced)

| Current branch | `/wk-pr` without args |
| -------------- | --------------------- |
| `feature/*`, `bugfix/*` | OK — base `develop` |
| protected branches | Error |

## Rules

- Do not edit product files in this skill (except user asks to fix PR template).
- Never paste VCS tokens in chat.
- **Never run `glab` or `gh` directly** — only `workit_pr_create`.
- Do not claim validation passed unless evidence exists.
