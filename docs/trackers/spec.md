# Spec: GitHub + GitLab issue reads (`context.read`)

**Status:** spec only — no implementation in this task (user decision: spec both trackers).
**Branch:** `feature/workit-v1`

## Gap

Issue-tracker *reads* are YouTrack-only (`fetchYouTrackIssueBody` →
summary+description+state via `customFields(name,value(name))`). GitHub has
PR-body *links* only (`docs/gh-issues-linking`); GitLab has no issue surface
at all (VCS provider only). A github/gitlab workspace cannot ground task
context on its own issues.

## Shape (mirror YouTrack, read-only)

- New `context.read` kinds `github_issue` / `gitlab_issue` returning the same
  triple: `{ title, body, state }`. Same redaction rules as YouTrack reads.
- GitHub: `gh issue view {n} --repo {owner}/{repo} --json
  number,title,body,state` when the CLI is installed (per-directory identity
  comes free), else `GET /repos/{owner}/{repo}/issues/{n}` with the vcs
  `github.tokenFile` bearer pattern (workspace `vcs.tokenFile` wins, else the
  global file). Issue ref parsing reuses `parseGhIssue` /
  `deriveGhIssueFromBranch` from `pr-create.ts` (3+-digit boundary rules stay).
- GitLab: `glab issue view {iid} -R {path} -F json` when installed, else `GET
  {apiUrl}/projects/{id}/issues/{iid}` with the `PRIVATE-TOKEN` pattern and
  `gitlab.apiUrl` from `vcs.json`. Project id resolves from the workspace
  remote exactly like `parseGhRepo` (scp-style + `.git` suffix handling).
- Token storage mirrors existing files: GitHub reuses `github.token`;
  GitLab reuses the vcs `gitlab.tokenFile`. No new secret files, no new env
  names beyond the existing `WORKFLOW_GITHUB_*` / `WORKFLOW_GITLAB_*` set.
- Wizard: extend `IssueTracker` with `gitlab` and generalize `skipsYoutrack`
  to a per-tracker skip (none/github already skip the youtrack screen;
  gitlab skips it too until a gitlab screen exists). No new wizard screen.

## Non-goals

- Writes stay YouTrack-only: no comments, state transitions, or time logging
  for GitHub/GitLab in this spec.
- No new daemon, cache, or webhook; reads are on-demand like YouTrack.
- Cursor/Codex expose the new kinds as MCP resources (`workit://context/{kind}`),
  same as the existing contexts — no new transport.

## Acceptance

- `context.read kind=github_issue|gitlab_issue` returns title/body/state for a
  live issue with a seeded token, and a fail-closed error without one.
- Full suite + tsc green; parity test proves identical triples across
  OpenCode/Cursor/Pi/CLI surfaces.
