import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gitContext } from "./git";
import { readConfig, resolveBranchPolicy } from "./config";
import { resolveWorkspace } from "./workspaces";
import { vcsConfig } from "./vcs-config";

/** CA-09: the one policy resolver every consumer calls. */
export const resolveBranchPolicyFor = (workspaceRoot: string) =>
  resolveBranchPolicy(readConfig(), resolveWorkspace(workspaceRoot));

const policy = (root: string) => resolveBranchPolicyFor(root);
const allowedBranch = (root: string, name: string) =>
  policy(root).allowed.some((r) => r.test(name));
const isProtected = (root: string, name: string) => policy(root).protected.has(name.toLowerCase());
// RL-01: malformed vcs.json blocks branch resolution with an exact-path error.
const baseBranch = (cwd: string): { base: string } | { error: string } => {
  const resolved = vcsConfig("resolve", cwd);
  if (resolved.ok === false) return { error: String(resolved.error) };
  return { base: String(resolved.defaultTargetBranch ?? "develop") };
};
const DECLARE_RE = /^\s*\*+Branch:\*+\s*`?([^`\s|]+)`?\s*$/gim;
const USE_CURRENT_RE = /^\s*\*+Branch:\*+\s*use-current\s*$/im;
const readSafe = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

const normalizeBranch = (root: string, name: string): string | null => {
  const n = name.trim().replace(/`/g, "").replace(/\.+$/, "");
  if (isProtected(root, n)) return null;
  if (!allowedBranch(root, n)) return null;
  const parts = n
    .toLowerCase()
    .split("/")
    .map((p) =>
      p
        .replace(/[^\w.-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-"),
    );
  if (parts.some((p) => !p)) return null;
  return parts.join("/");
};

const deriveSlug = (planPath: string): string => {
  // New layout: plan lives at docs/<slug>/plan.md — slug is the dir name.
  const dirName = path.basename(path.dirname(planPath));
  return dirName === "." || dirName === "/" || dirName === "" ? "" : dirName;
};

const deriveKind = (
  planPath: string,
  fallback: "feature" | "bugfix" = "feature",
): "feature" | "bugfix" => {
  const slug = deriveSlug(planPath);
  const text = readSafe(planPath) ?? "";
  let kind = fallback;
  if (/\bbugfix\b/i.test(slug) || /^fix-/i.test(slug)) {
    kind = "bugfix";
  } else {
    const goal =
      text
        .split("\n")
        .find((line) => line.startsWith("**Goal:**"))
        ?.toLowerCase() ?? "";
    if (/\b(bugfix|bug fix)\b/.test(goal) && !/\b(feat|feature|upgrade|add)\b/.test(goal)) {
      kind = "bugfix";
    }
  }
  return kind;
};

// Port of scripts/lib/resolve-handoff-branch.sh
export const resolveBranch = ({
  spec_path,
  plan_path,
  workspace_root,
}: {
  spec_path: string;
  plan_path: string;
  workspace_root: string;
}) => {
  const cwd = path.resolve(workspace_root);
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(cwd, p));
  const spec = abs(spec_path);
  const plan = abs(plan_path);
  const git = gitContext(cwd);
  const current = git.branch;

  const finish = (branch: string, source: string) => ({
    branch,
    source,
    current_branch: current,
    dirty: Boolean(git.status_short.trim()),
    needs_checkout: current !== branch,
  });

  for (const file of [spec, plan]) {
    const text = readSafe(file);
    if (!text) continue;
    if (USE_CURRENT_RE.test(text)) {
      if (!current || !allowedBranch(cwd, current) || isProtected(cwd, current)) {
        return { error: `use-current but HEAD ${current} is not an allowed branch` };
      }
      return finish(current, "use-current");
    }
  }

  if (current && allowedBranch(cwd, current) && !isProtected(cwd, current))
    return finish(current, "keep-current");

  let declaredButInvalid: string | null = null;
  for (const file of [spec, plan]) {
    const text = readSafe(file);
    if (!text) continue;
    for (const match of text.matchAll(DECLARE_RE)) {
      const normalized = normalizeBranch(cwd, match[1]);
      if (normalized) return finish(normalized, file === spec ? "spec" : "plan");
      declaredButInvalid ??= match[1];
    }
  }
  if (declaredButInvalid) {
    return {
      error: `declared branch ${JSON.stringify(declaredButInvalid)} is not allowed by the branch policy`,
    };
  }

  const slug = deriveSlug(plan);
  if (!slug) return { error: `cannot derive branch slug from plan ${plan}` };
  const kind = deriveKind(plan);
  return finish(`${kind}/${slug}`, "derived");
};

// Port of scripts/lib/resolve-docs-branch.sh
export const docsBranch = ({
  plan_path,
  kind,
  workspace_root,
}: {
  plan_path?: string;
  kind?: string;
  workspace_root: string;
}) => {
  const cwd = path.resolve(workspace_root);
  const git = gitContext(cwd);
  const current = git.branch;
  const kindArg = (kind ?? "feature").toLowerCase();
  const baseResolved = baseBranch(cwd);
  if ("error" in baseResolved) return { error: baseResolved.error };
  const base = baseResolved.base;

  if (current === base || current === "main" || current === "master" || current === "develop") {
    let slug = "";
    if (plan_path) {
      const plan = path.isAbsolute(plan_path) ? plan_path : path.join(cwd, plan_path);
      slug = deriveSlug(plan);
    }
    if (!slug) {
      return {
        error: "plan_path required to derive branch slug when not on feature/* or bugfix/*",
      };
    }
    const branchKind = kindArg === "bugfix" ? "bugfix" : "feature";
    return {
      branch: `${branchKind}/${slug}`,
      action: base === "develop" ? "create_from_develop" : "create_from_base",
      current_branch: current,
      base,
      dirty: Boolean(git.status_short.trim()),
    };
  }
  if (current && allowedBranch(cwd, current) && !isProtected(cwd, current)) {
    return {
      branch: current,
      action: "keep",
      current_branch: current,
      base,
      dirty: Boolean(git.status_short.trim()),
    };
  }
  return { error: `cannot resolve docs branch from HEAD ${JSON.stringify(current)}` };
};

// Port of scripts/lib/ensure-develop-base.sh
export const ensureBaseBranch = (cwd: string, base: string): { ok: boolean; error?: string } => {
  const git = gitContext(cwd);
  if (!git.branch || git.branch === "unknown")
    return { ok: false, error: "not in a git repository" };
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  try {
    try {
      run(["fetch", "origin", base, "--prune"]);
    } catch {
      run(["fetch", "origin", "--prune"]);
    }
    let hasOriginBase = true;
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${base}`], {
        cwd,
        stdio: "pipe",
      });
    } catch {
      hasOriginBase = false;
    }
    if (!hasOriginBase)
      return {
        ok: false,
        error: `origin/${base} missing — push ${base} before creating feature/* or bugfix/* branches`,
      };
    let hasLocalBase = true;
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${base}`], {
        cwd,
        stdio: "pipe",
      });
    } catch {
      hasLocalBase = false;
    }
    if (hasLocalBase) {
      run(["checkout", base]);
      try {
        run(["merge", "--ff-only", `origin/${base}`]);
      } catch {
        /* non-fast-forward: keep local */
      }
    } else {
      run(["checkout", "-b", base, "--track", `origin/${base}`]);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "ensure-base-branch failed",
    };
  }
};

// Port of scripts/branch/setup-branch.sh
export const branchSetup = ({
  action,
  sdd_dir,
  target_branch,
  stash,
  workspace_root,
}: {
  action?: string;
  sdd_dir?: string;
  target_branch?: string;
  stash?: string;
  workspace_root: string;
}) => {
  const cwd = path.resolve(workspace_root);
  const exec = (args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const current = gitContext(cwd).branch;
  if (!current || current === "unknown") return { error: "not in a git repository" };
  const sdd = sdd_dir ?? "docs";
  const manifestPath = path.isAbsolute(sdd)
    ? path.join(sdd, "manifest.json")
    : path.join(cwd, sdd, "manifest.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o755 });
  const readManifest = (): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      return {};
    }
  };
  const writeManifest = (data: Record<string, unknown>) =>
    writeFileSync(manifestPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  if (action === "reapply_stash") {
    const manifest = readManifest();
    const ref = manifest.stash_ref;
    if (!ref) return { error: "no stash_ref in manifest" };
    try {
      exec(["stash", "pop", String(ref)]);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "stash pop failed" };
    }
    delete manifest.stash_ref;
    delete manifest.stash_created_at;
    writeManifest(manifest);
    return { action: "reapply_stash", ok: true };
  }

  const target = target_branch ?? "";
  if (!target) return { error: "target branch required" };
  if (isProtected(cwd, target)) return { error: `protected branch ${target}` };
  if (!allowedBranch(cwd, target))
    return { error: `target branch ${target} is not allowed by the branch policy` };

  // CA-02: resolve the base before any mutation so a missing origin/<base>
  // fails with the tree untouched instead of after a stash push.
  // ensureBaseBranch itself deliberately stays post-stash below: it checks out
  // the base branch — a mutation unsafe on a dirty tree.
  let base: string | undefined;
  let targetExists = true;
  try {
    exec(["rev-parse", "--verify", "--quiet", `refs/heads/${target}`]);
  } catch {
    targetExists = false;
  }
  if (!targetExists) {
    try {
      const baseResolved = baseBranch(cwd);
      if ("error" in baseResolved) return { error: baseResolved.error };
      base = baseResolved.base;
    } catch (error) {
      return { error: error instanceof Error ? error.message : "base resolution failed" };
    }
  }

  let stash_ref: string | undefined;
  // Best-effort restore; if the pop itself fails, the caller's error gains a
  // suffix pointing at the stash so stranded work stays discoverable.
  const failAfterStash = (message: string): { error: string } => {
    let suffix = "";
    if (stash_ref) {
      try {
        exec(["stash", "pop", stash_ref]);
        stash_ref = undefined;
      } catch {
        suffix = " (changes preserved in stash)";
      }
    }
    return { error: `${message}${suffix}` };
  };
  if (current !== target) {
    const dirty = Boolean(gitContext(cwd).status_short.trim());
    if (dirty) {
      if (stash !== "yes") {
        return {
          error:
            "dirty working tree — ask with native question, then call workit_branch_setup with stash=yes",
        };
      }
      try {
        exec(["stash", "push", "-u", "-m", `workit: pre-checkout ${target}`, "--", ":!docs/*/sdd"]);
      } catch (error) {
        return { error: error instanceof Error ? error.message : "stash push failed" };
      }
      stash_ref = "stash@{0}";
    }
    try {
      exec(["checkout", target]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "checkout failed";
      if (/worktree/i.test(message)) {
        return failAfterStash(
          `branch ${target} is locked by an existing git worktree — remove it first (we do not use worktrees)`,
        );
      }
      try {
        let effectiveBase = base;
        if (effectiveBase === undefined) {
          const lateResolved = baseBranch(cwd);
          if ("error" in lateResolved) return failAfterStash(lateResolved.error);
          effectiveBase = lateResolved.base;
        }
        const baseResult = ensureBaseBranch(cwd, effectiveBase);
        if (!baseResult.ok) return failAfterStash(baseResult.error ?? "ensure-base-branch failed");
        exec(["checkout", "-b", target]);
      } catch (createError) {
        return failAfterStash(
          createError instanceof Error ? createError.message : "branch create failed",
        );
      }
    }
  }

  try {
    const manifest = readManifest();
    manifest.branch = target;
    manifest.previous_branch = current;
    if (stash_ref) {
      manifest.stash_ref = stash_ref;
      manifest.stash_created_at = new Date().toISOString();
    }
    writeManifest(manifest);
  } catch (error) {
    return failAfterStash(
      error instanceof Error
        ? `manifest update failed: ${error.message}`
        : "manifest update failed",
    );
  }
  return {
    action: "setup",
    ok: true,
    branch: target,
    previous_branch: current,
    stash_ref: stash_ref ?? null,
    manifest: manifestPath,
  };
};
