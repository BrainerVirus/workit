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
  const resolvedDefault = String(
    cfg.defaultTargetBranch ?? policy.defaultTargetBranch ?? "develop",
  );
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
  const mergeBaseResult =
    policy.integration === "merge"
      ? spawnSync("git", ["rev-parse", "--verify", `refs/heads/${target}`], {
          cwd: root,
          encoding: "utf8",
        })
      : null;
  const mergeBaseCommit =
    mergeBaseResult?.status === 0 ? (mergeBaseResult.stdout ?? "").trim() : "";
  if (
    policy.integration === "merge" &&
    ((env.WORKIT_EXPECTED_REMOTE && !env.WORKIT_EXPECTED_MERGE_BASE_COMMIT) ||
      !mergeBaseCommit ||
      (env.WORKIT_EXPECTED_MERGE_BASE_COMMIT &&
        env.WORKIT_EXPECTED_MERGE_BASE_COMMIT !== mergeBaseCommit))
  )
    return { error: "approved merge target branch changed before execution" };

  if (policy.integration === "merge") {
    const finish = (): Record<string, any> => {
      if (!sourceCommit || !mergeBaseCommit)
        return {
          error: "merge failed",
          mode: "merge",
          targetBranch: target,
          stderr: "source or target branch commit could not be resolved",
        };
      const merge = spawnSync("git", ["merge", "--no-ff", sourceCommit, "-m", title], {
        cwd: root,
        encoding: "utf8",
      });
      if (merge.status !== 0)
        return {
          error: "merge failed",
          mode: "merge",
          targetBranch: target,
          stderr: (merge.stderr ?? "").slice(0, 800),
        };
      const mergedCommit = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      });
      if (mergedCommit.status !== 0)
        return { error: "merge commit could not be resolved", mode: "merge" };
      const updateTarget = spawnSync(
        "git",
        ["update-ref", `refs/heads/${target}`, mergedCommit.stdout.trim(), mergeBaseCommit],
        { cwd: root, encoding: "utf8" },
      );
      if (updateTarget.status !== 0)
        return { error: "merge target branch changed before update", mode: "merge" };
      const push = spawnSync(
        "git",
        ["push", targetUrl, `${mergedCommit.stdout.trim()}:refs/heads/${target}`],
        { cwd: root, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" } },
      );
      if (push.status !== 0)
        return {
          error: "push failed",
          mode: "merge",
          targetBranch: target,
          stderr: (push.stderr ?? "").slice(0, 800),
        };
      return {
        ok: true,
        mode: "merge",
        targetBranch: target,
        merged: true,
        pushed: true,
        output: (push.stdout ?? "").trim(),
      };
    };
    const co = spawnSync("git", ["checkout", "--detach", mergeBaseCommit], {
      cwd: root,
      encoding: "utf8",
    });
    if (co.status !== 0)
      return {
        error: `cannot checkout target ${target}`,
        mode: "merge",
        targetBranch: target,
        stderr: (co.stderr ?? "").slice(0, 800),
      };
    // finish() returns error objects, it never throws, so the best-effort
    // `git checkout branch` restore below runs on ALL outcomes (success,
    // merge failure, and push failure) — the tree always returns to the
    // feature branch. Deliberately not a try/finally: the restore is
    // best-effort and its own failure is not actionable on this path.
    const result = finish();
    spawnSync("git", ["checkout", branch], { cwd: root, encoding: "utf8" }); // best-effort return
    return result;
  }

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

/** Merge the exact approved open PR/MR (squash + delete per pr settings). */
export function mergePr(
  cwd: string,
  opts: {
    target: string;
    source: string;
    sourceCommit: string;
    remote: string;
    account: string;
    apiHost: string;
  },
): Record<string, any> {
  const root = repoRoot(cwd);
  const cfg = vcsConfig("load", root);
  if (!cfg.ok) return { error: cfg.error ?? "vcs config missing" };
  const provider = cfg.provider as string;
  if (provider !== "gitlab" && provider !== "github")
    return { error: `unsupported provider: ${provider}` };
  const identity = vcsCliIdentity(root);
  if (!identity.ok) return { error: identity.error };
  if (opts.apiHost !== identity.host)
    return { error: "approved hosting API host changed before execution" };
  const remote = pushRemote(root);
  const remoteIdentity = remote ? pushRemoteIdentity(remote) : null;
  if (
    !remote ||
    !remoteIdentity ||
    !pushTargetIsStable(root, remote) ||
    opts.remote !== remoteIdentity
  )
    return { error: "approved merge destination changed before execution" };
  if (!hostingApiHostMatches(remote, identity.host))
    return { error: "hosting API host does not match the merge destination" };
  if (identity.username?.toLowerCase() !== opts.account.toLowerCase())
    return { error: "approved hosting account changed before execution" };
  if (!/^[a-f0-9]{40,64}$/i.test(opts.sourceCommit))
    return { error: "approved merge source commit is invalid" };
  const currentCommit = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${opts.source}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (currentCommit.status !== 0 || currentCommit.stdout.trim() !== opts.sourceCommit)
    return { error: "approved merge source commit changed before execution" };
  const repository = cliRepository(remote, provider, cfg);
  const repoPath = remoteRepoPath(remote)?.path;
  if (!repository || !repoPath?.includes("/"))
    return { error: "hosting repository could not be resolved" };
  if (!hostingCliAvailable(provider))
    return { error: `workflow CLI missing (required for ${provider})` };
  const owner = repoPath.split("/")[0];
  const endpoint =
    provider === "github"
      ? `repos/${repository.replace(/^[^/]+\//u, "")}/pulls?state=open&head=${encodeURIComponent(`${owner}:${opts.source}`)}&base=${encodeURIComponent(opts.target)}&per_page=100`
      : `projects/${encodeURIComponent(repoPath)}/merge_requests?state=opened&source_branch=${encodeURIComponent(opts.source)}&target_branch=${encodeURIComponent(opts.target)}&per_page=100`;
  const listOpen = () =>
    spawnSync(provider === "github" ? "gh" : "glab", ["api", endpoint], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        ...(provider === "github" ? { GH_HOST: identity.host } : { GITLAB_HOST: identity.host }),
      },
    });
  const listedId = (stdout: string): string | null => {
    try {
      const records = JSON.parse(stdout) as Array<Record<string, any>>;
      if (!Array.isArray(records) || records.length >= 100) return null;
      const matches = records.filter((record) =>
        provider === "github"
          ? record.state === "open" &&
            record.head?.ref === opts.source &&
            record.head?.sha === opts.sourceCommit &&
            record.base?.ref === opts.target
          : record.state === "opened" &&
            record.source_branch === opts.source &&
            record.sha === opts.sourceCommit &&
            record.target_branch === opts.target,
      );
      if (matches.length !== 1) return null;
      const id = provider === "github" ? matches[0].number : matches[0].iid;
      return typeof id === "number" ? String(id) : null;
    } catch {
      return null;
    }
  };
  const list = listOpen();
  if (list.status !== 0) return { error: "approved merge request could not be resolved" };
  const mergeId = listedId(list.stdout ?? "");
  if (!mergeId) return { error: "exact approved merge request is not open" };
  // The PR/MR target can change after the first lookup. Re-resolve the
  // target-filtered request immediately before calling the provider merge CLI.
  const current = listOpen();
  if (current.status !== 0 || listedId(current.stdout ?? "") !== mergeId)
    return { error: "approved merge target or source changed before merge" };
  const pr = (cfg.pr ?? {}) as Record<string, any>;
  const squash = pr.squashOnMerge !== false;
  const removeBranch = pr.removeSourceBranch !== false;
  let cmd: string[];
  let cmdEnv: NodeJS.ProcessEnv;
  if (provider === "gitlab") {
    cmd = ["glab", "mr", "merge", mergeId, "--repo", repository, "--sha", opts.sourceCommit];
    cmd.push(squash ? "--squash" : "--squash=false");
    if (removeBranch) cmd.push("--remove-source-branch");
    cmd.push("--yes");
    cmdEnv = { ...process.env, PATH: process.env.PATH ?? "", GITLAB_HOST: identity.host };
  } else {
    cmd = [
      "gh",
      "pr",
      "merge",
      mergeId,
      "--repo",
      repository,
      "--match-head-commit",
      opts.sourceCommit,
    ];
    cmd.push(squash ? "--squash" : "--merge");
    if (removeBranch) cmd.push("--delete-branch");
    // NOTE: gh pr merge has no --yes flag; fully-specified flags merge
    // non-interactively on their own.
    cmdEnv = { ...process.env, PATH: process.env.PATH ?? "", GH_HOST: identity.host };
  }
  const result = spawnSync(cmd[0], cmd.slice(1), { cwd: root, encoding: "utf8", env: cmdEnv });
  if (result.status !== 0)
    return {
      error: "merge failed",
      provider,
      stderr: (result.stderr ?? result.stdout ?? "").trim().slice(0, 800),
    };
  return {
    ok: true,
    provider,
    targetBranch: opts.target,
    sourceBranch: opts.source,
    output: (result.stdout ?? "").trim(),
  };
}

// Moved to forge/pr-body.ts (S11); re-exported for the managed action path until S16.
export { buildBody, parseGhRepo, parseGhIssue };
