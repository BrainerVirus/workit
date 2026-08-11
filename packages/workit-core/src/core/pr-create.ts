import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { vcsConfig } from "./vcs-config";
import { readConfig, resolveBranchPolicy } from "./config";

// Port of scripts/pr-create.sh — build MR/PR body issue linking + create via glab/gh.

function parseGhRepo(remote: string): string | null {
  remote = (remote || "").trim().replace(/\/+$/, "");
  if (!remote) return null;
  if (remote.endsWith(".git")) remote = remote.slice(0, -4);
  if (remote.includes(":")) remote = remote.split(":").pop() ?? ""; // drop git@host part (scp-style URL)
  const parts = remote.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : null;
}

function parseGhIssue(value: string): string {
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

function buildBody(
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

const truthy = (v: string | undefined): boolean =>
  ["1", "true", "yes"].includes(String(v ?? "").toLowerCase());

// Port of python's shutil.which — scan PATH in-process (no `which` binary needed).
function whichOnPath(tool: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, tool);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

function repoRoot(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : cwd;
}

/** Port of pr-create.sh --build-body — pure body builder, no network. */
export function prBuildBody(env: NodeJS.ProcessEnv, cwd?: string): string {
  const ghLinkOnPr = truthy(env.GH_LINK_ON_PR);
  let ghRepo = env.GH_REPO || null;
  if (!ghRepo && ghLinkOnPr) {
    const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
    if (result.status === 0) ghRepo = parseGhRepo(result.stdout ?? "");
  }
  return buildBody(
    env.BODY ?? "",
    env.BRANCH ?? "",
    truthy(env.LINK_ISSUES),
    env.YT_BASE_URL ?? "",
    env.WORKFLOW_YT_ISSUE ?? "",
    ghLinkOnPr,
    env.WORKFLOW_GH_ISSUE ?? "",
    env.WORKFLOW_GH_ISSUE_RELATION ?? "closes",
    ghRepo,
  );
}

/** Port of scripts/pr-create.sh create mode — glab/gh MR/PR creation. */
export function prCreate(env: NodeJS.ProcessEnv, cwd: string): Record<string, any> {
  const root = process.env.WORKFLOW_WORKSPACE_ROOT ?? repoRoot(cwd);
  const cfg = vcsConfig("load", root);
  if (!cfg.ok) return { error: cfg.error ?? "vcs config missing" };
  if (!cfg.tokenReady)
    return { error: "VCS token not ready — run /wk-init and edit token file locally" };

  const provider = cfg.provider as string;
  if (provider !== "gitlab" && provider !== "github")
    return { error: `unsupported provider: ${provider}` };

  // B1/RL-03: WF_PR_TARGET is the one deliberate override knob on the create
  // surface (resolvePrBranchContext/docsBranch have none). Unlike the config
  // default — which is authoritative by construction — a caller-supplied
  // target is validated against the resolved branch policy so a PR can never
  // be aimed at a protected or disallowed branch.
  const targetOverride = env.WF_PR_TARGET;
  const target = targetOverride || String(cfg.defaultTargetBranch ?? "develop");
  if (targetOverride) {
    const { allowed, protected: protectedTargets } = resolveBranchPolicy(readConfig());
    if (protectedTargets.has(targetOverride.toLowerCase()))
      return {
        error: `PR target ${JSON.stringify(targetOverride)} is a protected branch — override must be an allowed non-protected target`,
      };
    if (!allowed.some((r) => r.test(targetOverride)))
      return {
        error: `PR target ${JSON.stringify(targetOverride)} is not allowed by the branch policy`,
      };
  }

  const cli = provider === "gitlab" ? "glab" : "gh";
  const installUrl =
    provider === "gitlab" ? "https://gitlab.com/gitlab-org/cli" : "https://cli.github.com";
  if (whichOnPath(cli) === null) {
    return {
      ok: false,
      cli_missing: true,
      error: `workflow CLI missing: ${cli} (required for ${provider}). Install: ${installUrl}`,
      install_url: installUrl,
    };
  }

  const pr = (cfg.pr ?? {}) as Record<string, any>;
  const token = fs.readFileSync(cfg.tokenPath as string, "utf8").trim();
  const title = String(env.WF_PR_TITLE ?? "");
  const body = env.WF_PR_BODY ?? "";
  const draft = String(env.WF_PR_DRAFT ?? "false").toLowerCase() === "true";

  const br = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  const branch = br.status === 0 ? (br.stdout ?? "").trim() : "";

  let baseUrl = cfg.youtrack_base_url as string | undefined;
  if (!baseUrl) {
    const ytCfg =
      process.env.WORKFLOW_YOUTRACK_CONFIG ??
      path.join(path.dirname(String(cfg.configPath)), "youtrack.json");
    try {
      const yt = JSON.parse(fs.readFileSync(ytCfg, "utf8")) as Record<string, any>;
      if (yt && typeof yt === "object") baseUrl = yt.baseUrl;
    } catch {
      /* optional */
    }
  }
  const ghLinkOnPr = cfg.issues_provider === "github" && cfg.link_on_pr === true;
  let ghRepo: string | null = null;
  if (ghLinkOnPr) {
    const rr = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
    if (rr.status === 0) ghRepo = parseGhRepo(rr.stdout ?? "");
  }
  const finalBody = buildBody(
    body,
    branch,
    cfg.link_issues === true,
    baseUrl ?? "",
    env.WORKFLOW_YT_ISSUE ?? "",
    ghLinkOnPr,
    env.WORKFLOW_GH_ISSUE ?? "",
    env.WORKFLOW_GH_ISSUE_RELATION ?? "closes",
    ghRepo,
  );

  const squash = pr.squashOnMerge !== false;
  const removeBranch = pr.removeSourceBranch !== false;
  const push = pr.pushBranch !== false;
  const skipConfirm = pr.confirmSkip !== false;

  let cmd: string[];
  let cmdEnv: NodeJS.ProcessEnv;
  if (provider === "gitlab") {
    // glab non-interactive mode requires BOTH title and description flags (issue #652).
    cmd = ["glab", "mr", "create", "-t", title, "-d", finalBody || "", "-b", target];
    cmd.push(squash ? "--squash-before-merge" : "--squash-before-merge=false");
    cmd.push(removeBranch ? "--remove-source-branch" : "--remove-source-branch=false");
    if (draft) cmd.push("--draft");
    if (push) cmd.push("--push");
    if (skipConfirm) cmd.push("--yes");
    cmdEnv = { ...process.env, GITLAB_TOKEN: token };
  } else {
    cmd = ["gh", "pr", "create", "--title", title, "--base", target];
    if (finalBody) cmd.push("--body", finalBody);
    if (draft) cmd.push("--draft");
    cmdEnv = { ...process.env, GH_TOKEN: token };
  }

  const result = spawnSync(cmd[0], cmd.slice(1), { cwd: root, encoding: "utf8", env: cmdEnv });
  if (result.status !== 0) {
    const err = (result.stderr ?? result.stdout ?? "").trim();
    let hint: Record<string, any> | null = null;
    if (
      provider === "gitlab" &&
      (err.includes("409") || err.toLowerCase().includes("already exists"))
    ) {
      const list = spawnSync("glab", ["mr", "list", `--source-branch=${branch}`, "--output=json"], {
        cwd: root,
        encoding: "utf8",
        env: cmdEnv,
      });
      if (list.status === 0 && (list.stdout ?? "").trim()) {
        try {
          const mrs = JSON.parse(list.stdout ?? "") as Array<Record<string, any>>;
          if (mrs.length) {
            hint = {
              reason: "merge_request_already_exists",
              existing: mrs[0],
              next_step: "Use glab mr update or close the open MR before creating again",
            };
          }
        } catch {
          /* no hint */
        }
      }
    }
    const payload: Record<string, any> = {
      error: "create failed",
      provider,
      stderr: err.slice(0, 800),
    };
    if (hint) payload.hint = hint;
    return payload;
  }

  return {
    ok: true,
    provider,
    targetBranch: target,
    squashOnMerge: squash,
    removeSourceBranch: removeBranch,
    output: (result.stdout ?? "").trim(),
  };
}

export { buildBody, parseGhRepo, parseGhIssue };
