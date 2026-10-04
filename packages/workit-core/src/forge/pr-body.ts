// PR/MR body issue linking (port of scripts/pr-create.sh --build-body), shared
// by the managed `hosting.pull_request` action (core/pr-create.ts re-exports
// these until S16) and `workit pr create` (S11), which passes typed input
// instead of environment variables.
import { vcsConfig } from "../core/vcs-config";

export function parseGhRepo(remote: string): string | null {
  remote = (remote || "").trim().replace(/\/+$/, "");
  if (!remote) return null;
  if (remote.endsWith(".git")) remote = remote.slice(0, -4);
  if (remote.includes(":")) remote = remote.split(":").pop() ?? ""; // drop git@host part (scp-style URL)
  const parts = remote.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : null;
}

export function parseGhIssue(value: string): string {
  const m = /issues\/(\d+)/.exec(value);
  return m ? m[1] : String(value).trim().replace(/^#/, "");
}

// RL-03/CA-25/AR-08: a branch-derived numeric issue id must be a bare number at
// a segment or dash boundary — and never part of a date segment. Year-first
// (feature/2024-01-15/x) and day-first (feature/15-01-2024/x) dates are both
// skipped — a complete date anywhere in a segment (release-2024-01-15,
// v2-2024-01-15-fix) — so no date digit ever closes an issue. Deliberate
// numeric issue branches (feature/42-title, feature/2024-fix) keep linking.
function deriveGhIssueFromBranch(branch: string): string {
  for (const segment of branch.split("/")) {
    if (/^\d{4}-\d/.test(segment)) continue; // year-first date-like segment (incl. year-month)
    if (/\d{4}-\d{1,2}-\d{1,2}/.test(segment)) continue; // complete year-first date anywhere
    if (/\d{1,2}-\d{1,2}-\d{4}/.test(segment)) continue; // complete day-first date anywhere
    const m = /(?:^|-)(\d+)(?:-|$)/.exec(segment);
    if (m) return m[1];
  }
  return "";
}

export function buildBody(
  body: string,
  branch: string,
  linkIssues: boolean,
  baseUrl: string,
  ytIssue: string,
  ghLinkOnPr: boolean,
  ghIssue: string,
  ghRelation: string,
  ghRepo: string | null,
): string {
  let line: string | null = null;
  if (linkIssues) {
    let issue = ytIssue;
    if (!issue && branch) {
      // anchored prefix + \b boundary, 3+ digits so version-like tokens (POSTGRES-16, HTTP-3) never link
      const m = /(?:^|\/|-)([A-Z]{2,}-\d{3,})\b/.exec(branch);
      if (m) issue = m[1];
    }
    if (issue && baseUrl) line = `Related to: ${baseUrl.replace(/\/+$/, "")}/issue/${issue}`;
  } else if (ghLinkOnPr) {
    let issue = parseGhIssue(ghIssue);
    if (!issue && branch) {
      // pure-number issue id (feature/42-title -> 42); digits must be followed by a dash or end-of-string
      // so version tokens (release/1.2.3, backport/8.0.1, lodash-4.17.21, 2024.1) never link
      issue = deriveGhIssueFromBranch(branch);
    }
    if (issue) {
      if (ghRelation === "related") {
        line = `Related to #${issue}`;
        if (ghRepo) line += ` — https://github.com/${ghRepo}/issues/${issue}`;
      } else {
        line = `Closes #${issue}`;
      }
    }
  }
  if (line === null) return body;
  return body ? `${body}\n\n${line}` : line;
}

/**
 * The body `workit pr create` sends: the agent's text plus the workspace's
 * issue link (YouTrack `link_issues`, or GitHub `issues.link_on_pr` with the
 * issue number derived from the branch). Reads config, never writes it.
 */
export function prBodyFor(
  cwd: string,
  input: { body: string; branch: string; repo: string | null },
): string {
  const resolved = vcsConfig("resolve", cwd);
  if (resolved.ok === false) return input.body;
  return buildBody(
    input.body,
    input.branch,
    resolved.link_issues === true,
    typeof resolved.youtrack_base_url === "string" ? resolved.youtrack_base_url : "",
    "",
    resolved.link_on_pr === true,
    "",
    "closes",
    input.repo,
  );
}
