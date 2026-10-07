import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { hostingApiHostMatches, vcsCliIdentity, vcsConfig } from "./vcs-config";
export { hostingApiHostMatches } from "./vcs-config";
import { resolveBranchPolicyFor } from "./branch";
import { buildBody, parseGhIssue, parseGhRepo } from "../forge/pr-body";

// Port of scripts/pr-create.sh — build MR/PR body issue linking + create via glab/gh.
// Hosted creation is enabled (decision ae03c569): every create path pre-binds
// the approved source SHA through WORKIT_EXPECTED_* and the shared executor
// post-verifies the provider PR head before reporting success. The residual
// non-atomic source-SHA race is accepted.
const remoteRepoPath = (
  remote: string,
): { host: string; path: string; protocol: string } | null => {
  const raw = remote.trim();
  if (!raw) return null;
  if (!raw.includes("://")) {
    const scp = /^(?:[^@\s]+@)?([^:]+):(.+)$/u.exec(raw);
    if (scp)
      return {
        host: scp[1].toLowerCase(),
        path: scp[2].replace(/^\//u, "").replace(/\.git$/u, ""),
        protocol: "ssh:",
      };
  }
  try {
    const url = new URL(raw);
    return {
      host: url.hostname.toLowerCase(),
      path: url.pathname
        .replace(/^\//u, "")
        .replace(/\.git$/u, "")
        .replace(/\/$/u, ""),
      protocol: url.protocol,
    };
  } catch {
    return null;
  }
};

const cliRepository = (
  remote: string,
  provider: "github" | "gitlab",
  cfg: Record<string, any>,
): string | null => {
  const parsed = remoteRepoPath(remote);
  if (!parsed?.path) return null;
  const host = String(
    provider === "github" ? (cfg.github?.host ?? "github.com") : (cfg.gitlab?.host ?? "gitlab.com"),
  ).toLowerCase();
  if (provider === "github") return `${host}/${parsed.path}`;
  return host === "gitlab.com" ? parsed.path : `https://${host}/${parsed.path}`;
};

const truthy = (v: string | undefined): boolean =>
  ["1", "true", "yes"].includes(String(v ?? "").toLowerCase());

// Port of python's shutil.which — scan PATH in-process (no `which` binary needed).
function whichOnPath(tool: string): string | null {
  // win32 CLIs/stubs carry .exe/.cmd suffixes (gh.exe, gh.cmd), so probe them
  // too — accessSync with the bare name would never find them.
  const names = process.platform === "win32" ? [tool, `${tool}.exe`, `${tool}.cmd`] : [tool];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/** Whether the configured hosting provider's native CLI is available. */
export const hostingCliAvailable = (provider: string): boolean =>
  whichOnPath(provider === "gitlab" ? "glab" : "gh") !== null;

function repoRoot(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : cwd;
}

/** Git pushes to every configured push URL; authorization binds only one target. */
export const pushRemote = (cwd: string): string | null => {
  const result = spawnSync("git", ["remote", "get-url", "--push", "--all", "origin"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const urls = (result.stdout ?? "")
    .split(/\r?\n/u)
    .map((url) => url.trim())
    .filter(Boolean);
  return urls.length === 1 ? urls[0] : null;
};

export const safePushUrl = (remote: string): string | null => {
  const raw = remote.trim();
  if (path.isAbsolute(raw)) return pathToFileURL(raw).href;
  if (!raw.includes("://")) {
    const scp = /^(?:([^@\s]+)@)?([^:]+):(.+)$/u.exec(raw);
    if (scp) return `${scp[1] || "git"}@${scp[2]}:${scp[3]}`;
  }
  try {
    const url = new URL(raw);
    if (!["file:", "git:", "http:", "https:", "ssh:"].includes(url.protocol)) return null;
    url.password = "";
    if (url.protocol !== "ssh:") url.username = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

export const pushRemoteIdentity = (remote: string): string | null => {
  const raw = remote.trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return pathToFileURL(raw).href;
  if (!raw.includes("://")) {
    const scp = /^(?:([^@\s]+)@)?([^:]+):(.+)$/u.exec(raw);
    if (scp)
      return `ssh://${scp[1] || "git"}@${scp[2].toLowerCase()}/${scp[3].replace(/^\//u, "")}`;
  }
  try {
    const url = new URL(raw);
    url.password = "";
    if (url.protocol !== "ssh:") url.username = "";
    url.hostname = url.hostname.toLowerCase();
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
};

/** Git's URL rewrite rules also apply to explicit push URLs. */
export const pushTargetIsStable = (cwd: string, remote: string): boolean => {
  const target = safePushUrl(remote);
  if (!target) return false;
  const result = spawnSync(
    "git",
    ["config", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0 && result.status !== 1) return false;
  const prefixes = (result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim().slice(line.trim().indexOf(" ") + 1))
    .filter(Boolean);
  return !prefixes.some((prefix) => target.startsWith(prefix));
};

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
  // An explicitly supplied, already-approved checkout root outranks ambient
  // process state; otherwise an unrelated env root could redirect the effect.
  const root = cwd ? repoRoot(cwd) : (process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd());
  const policy = resolveBranchPolicyFor(root);
  const cfg = vcsConfig("load", root);
  if (!cfg.ok) return { error: cfg.error ?? "vcs config missing" };

  const provider = cfg.provider as string;
  if (provider !== "gitlab" && provider !== "github")
    return { error: `unsupported provider: ${provider}` };
  const cli = provider === "gitlab" ? "glab" : "gh";
  const installUrl =
    provider === "gitlab" ? "https://gitlab.com/gitlab-org/cli" : "https://cli.github.com";
  if (whichOnPath(cli) === null)
    return {
      ok: false,
      cli_missing: true,
      error: `workflow CLI missing: ${cli} (required for ${provider}). Install: ${installUrl}`,
      install_url: installUrl,
    };
  const identity = vcsCliIdentity(root);
  if (!identity.ok) return { error: identity.error };
  if (env.WORKIT_EXPECTED_API_HOST && env.WORKIT_EXPECTED_API_HOST !== identity.host)
    return { error: "approved hosting API host changed before execution" };
  const pushUrl = pushRemote(root);
  const targetUrl = pushUrl ? safePushUrl(pushUrl) : null;
  const targetIdentity = pushUrl ? pushRemoteIdentity(pushUrl) : null;
  const targetRepo = pushUrl ? cliRepository(pushUrl, provider, cfg) : null;
  if (!pushUrl || !targetUrl || !targetIdentity || !pushTargetIsStable(root, pushUrl))
    return {
      error: "origin must have exactly one supported push URL for a reserved hosting action",
    };
  const localOnlyTarget = path.isAbsolute(pushUrl) || pushUrl.startsWith("file://");
  if (
    (!localOnlyTarget || env.WORKIT_EXPECTED_API_HOST) &&
    !hostingApiHostMatches(pushUrl, identity.host)
  )
    return { error: "hosting API host does not match the push destination" };
  if (env.WORKIT_EXPECTED_REMOTE && env.WORKIT_EXPECTED_REMOTE !== targetIdentity)
    return { error: "approved push destination changed before execution" };
  if (
    env.WORKIT_EXPECTED_ACCOUNT &&
    identity.username?.toLowerCase() !== env.WORKIT_EXPECTED_ACCOUNT.toLowerCase()
  )
    return { error: "approved hosting account changed before execution" };

  // The caller selects the target; GitHub/GitLab enforce their own protections.
  const targetOverride = env.WF_PR_TARGET;
  let resolvedDefault = String(cfg.defaultTargetBranch ?? policy.defaultTargetBranch ?? "develop");
  if (!targetOverride) {
    // Release tracks resolve in resolve mode: the target is the branch's line.
    const resolved = vcsConfig("resolve", root);
    if (resolved.ok === false) return { error: String(resolved.error) };
    if (resolved.releaseTrack?.blocking) return { error: String(resolved.releaseTrack.blocking) };
    resolvedDefault = String(resolved.defaultTargetBranch ?? resolvedDefault);
  }
  const target = targetOverride || resolvedDefault;
  const title = String(env.WF_PR_TITLE ?? "");
  const br = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  const branch = br.status === 0 ? (br.stdout ?? "").trim() : "";
  const sourceResult = branch
    ? spawnSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
        cwd: root,
        encoding: "utf8",
      })
    : null;
  const sourceCommit = sourceResult?.status === 0 ? (sourceResult.stdout ?? "").trim() : "";
  if (
    env.WORKIT_EXPECTED_REMOTE &&
    (!env.WORKIT_EXPECTED_SOURCE_BRANCH || !env.WORKIT_EXPECTED_SOURCE_COMMIT)
  )
    return { error: "approved PR source branch and commit are incomplete" };
  if (
    (env.WORKIT_EXPECTED_SOURCE_BRANCH && env.WORKIT_EXPECTED_SOURCE_BRANCH !== branch) ||
    (env.WORKIT_EXPECTED_SOURCE_COMMIT && env.WORKIT_EXPECTED_SOURCE_COMMIT !== sourceCommit)
  )
    return { error: "approved PR source branch or commit changed before execution" };
  const pr = (cfg.pr ?? {}) as Record<string, any>;
  const body = env.WF_PR_BODY ?? "";
  const draft = String(env.WF_PR_DRAFT ?? "false").toLowerCase() === "true";

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
    ghRepo = remoteRepoPath(pushUrl)?.path ?? null;
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
  const remoteBranchTip = (): string | null => {
    const read = spawnSync("git", ["ls-remote", targetUrl, `refs/heads/${branch}`], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });
    return read.status === 0 ? (read.stdout ?? "").trim().split(/\s+/u)[0] || null : null;
  };
  if (!branch || !sourceCommit)
    return {
      error: "push failed",
      provider,
      mode: "push",
      targetBranch: target,
      stderr: branch
        ? "source branch commit could not be resolved"
        : "empty current branch (detached HEAD or unborn HEAD)",
    };
  if (push) {
    const pushed = spawnSync(
      "git",
      ["push", "-u", targetUrl, `${sourceCommit}:refs/heads/${branch}`],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" } },
    );
    if (pushed.status !== 0)
      return { error: "push failed", provider, stderr: (pushed.stderr ?? "").slice(0, 800) };
  }
  if (remoteBranchTip() !== sourceCommit)
    return { error: "push destination branch does not match the approved source commit" };

  let cmd: string[];
  let cmdEnv: NodeJS.ProcessEnv;
  if (provider === "gitlab") {
    // glab non-interactive mode requires BOTH title and description flags (issue #652).
    cmd = [
      "glab",
      "mr",
      "create",
      ...(targetRepo ? ["-R", targetRepo] : []),
      "-t",
      title,
      "-d",
      finalBody || "",
      "-b",
      target,
    ];
    cmd.push(squash ? "--squash-before-merge" : "--squash-before-merge=false");
    cmd.push(removeBranch ? "--remove-source-branch" : "--remove-source-branch=false");
    if (draft) cmd.push("--draft");
    if (skipConfirm) cmd.push("--yes");
    // bun's Windows spawn only consults PATH when the env object carries an
    // explicit PATH key — a spread-only PATH is invisible to the lookup and
    // uv_spawn fails with ENOENT even though the CLI is on PATH.
    cmdEnv = { ...process.env, PATH: process.env.PATH ?? "", GITLAB_HOST: identity.host };
  } else {
    cmd = [
      "gh",
      "pr",
      "create",
      ...(targetRepo ? ["--repo", targetRepo] : []),
      "--title",
      title,
      "--base",
      target,
    ];
    if (finalBody) cmd.push("--body", finalBody);
    if (draft) cmd.push("--draft");
    cmdEnv = { ...process.env, PATH: process.env.PATH ?? "", GH_HOST: identity.host };
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

// Moved to forge/pr-body.ts (S11); re-exported for the managed action path until S16.
export { buildBody, parseGhRepo, parseGhIssue };
