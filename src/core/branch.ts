import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gitContext } from "./git";

const PROTECTED = new Set(["main", "develop", "master", "prod", "production"]);
const DECLARE_RE = /^\s*\*+Branch:\*+\s*`?((?:feature|bugfix)\/[^`\s|]+)`?\s*$/gim;
const USE_CURRENT_RE = /^\s*\*+Branch:\*+\s*use-current\s*$/im;
const BRANCH_PAT = /^(feature|bugfix)\/[a-z0-9][a-z0-9._/-]*$/i;
const readSafe = (p: string): string | null => {
  try { return readFileSync(p, "utf8"); } catch { return null; }
};

const normalizeBranch = (name: string): string | null => {
  let n = name.trim().replace(/`/g, "").replace(/\.+$/, "");
  if (PROTECTED.has(n.toLowerCase())) return null;
  if (!BRANCH_PAT.test(n)) return null;
  const [kind, ...restParts] = n.split("/");
  const rest = restParts.join("/").toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  if (!rest) return null;
  return `${kind.toLowerCase()}/${rest}`;
};

const deriveSlug = (planPath: string): string => {
  // New layout: plan lives at docs/<slug>/plan.md — slug is the dir name.
  const dirName = path.basename(path.dirname(planPath));
  return dirName === "." || dirName === "/" || dirName === "" ? "" : dirName;
};

const deriveKind = (planPath: string, fallback: "feature" | "bugfix" = "feature"): "feature" | "bugfix" => {
  const slug = deriveSlug(planPath);
  const text = readSafe(planPath) ?? "";
  let kind = fallback;
  if (/\bbugfix\b/i.test(slug) || /^fix-/i.test(slug)) {
    kind = "bugfix";
  } else {
    const goal = text.split("\n").find((line) => line.startsWith("**Goal:**"))?.toLowerCase() ?? "";
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
}: { spec_path: string; plan_path: string; workspace_root: string }) => {
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
      if (!current || !BRANCH_PAT.test(current)) {
        return { error: "use-current but HEAD is not feature/* or bugfix/*" };
      }
      return finish(current, "use-current");
    }
  }

  if (current && BRANCH_PAT.test(current)) return finish(current, "keep-current");

  for (const file of [spec, plan]) {
    const text = readSafe(file);
    if (!text) continue;
    for (const match of text.matchAll(DECLARE_RE)) {
      const normalized = normalizeBranch(match[1]);
      if (normalized) return finish(normalized, file === spec ? "spec" : "plan");
    }
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
}: { plan_path?: string; kind?: string; workspace_root: string }) => {
  const cwd = path.resolve(workspace_root);
  const git = gitContext(cwd);
  const current = git.branch;
  const kindArg = (kind ?? "feature").toLowerCase();

  if (current && BRANCH_PAT.test(current)) {
    return { branch: current, action: "keep", current_branch: current, base: "develop", dirty: Boolean(git.status_short.trim()) };
  }
  if (current === "main" || current === "master" || current === "develop") {
    let slug = "";
    if (plan_path) {
      const plan = path.isAbsolute(plan_path) ? plan_path : path.join(cwd, plan_path);
      slug = deriveSlug(plan);
    }
    if (!slug) {
      return { error: "plan_path required to derive branch slug when not on feature/* or bugfix/*" };
    }
    const branchKind = kindArg === "bugfix" ? "bugfix" : "feature";
    return { branch: `${branchKind}/${slug}`, action: "create_from_develop", current_branch: current, base: "develop", dirty: Boolean(git.status_short.trim()) };
  }
  return { error: `cannot resolve docs branch from HEAD ${JSON.stringify(current)}` };
};

// Port of scripts/lib/ensure-develop-base.sh
export const ensureDevelopBase = (cwd: string): { ok: boolean; error?: string } => {
  const git = gitContext(cwd);
  if (!git.branch || git.branch === "unknown") return { ok: false, error: "not in a git repository" };
  const run = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  try {
    try {
      run(["fetch", "origin", "develop", "--prune"]);
    } catch {
      run(["fetch", "origin", "--prune"]);
    }
    let hasOriginDevelop = true;
    try { execFileSync("git", ["show-ref", "--verify", "--quiet", "refs/remotes/origin/develop"], { cwd, stdio: "pipe" }); } catch { hasOriginDevelop = false; }
    if (!hasOriginDevelop) return { ok: false, error: "origin/develop missing — push develop before creating feature/* or bugfix/* branches" };
    let hasLocalDevelop = true;
    try { execFileSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/develop"], { cwd, stdio: "pipe" }); } catch { hasLocalDevelop = false; }
    if (hasLocalDevelop) {
      run(["checkout", "develop"]);
      try { run(["merge", "--ff-only", "origin/develop"]); } catch { /* non-fast-forward: keep local */ }
    } else {
      run(["checkout", "-b", "develop", "--track", "origin/develop"]);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "ensure-develop-base failed" };
  }
};

// Port of scripts/branch/setup-branch.sh
export const branchSetup = ({
  action,
  sdd_dir,
  target_branch,
  stash,
  workspace_root,
}: { action?: string; sdd_dir?: string; target_branch?: string; stash?: string; workspace_root: string }) => {
  const cwd = path.resolve(workspace_root);
  const exec = (args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const current = gitContext(cwd).branch;
  if (!current || current === "unknown") return { error: "not in a git repository" };
  const sdd = sdd_dir ?? "docs";
  const manifestPath = path.isAbsolute(sdd) ? path.join(sdd, "manifest.json") : path.join(cwd, sdd, "manifest.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o755 });
  const readManifest = (): Record<string, unknown> => {
    try { return JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return {}; }
  };
  const writeManifest = (data: Record<string, unknown>) =>
    writeFileSync(manifestPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  if (action === "reapply_stash") {
    const manifest = readManifest();
    const ref = manifest.stash_ref;
    if (!ref) return { error: "no stash_ref in manifest" };
    try { exec(["stash", "pop", String(ref)]); } catch (error) {
      return { error: error instanceof Error ? error.message : "stash pop failed" };
    }
    delete manifest.stash_ref;
    delete manifest.stash_created_at;
    writeManifest(manifest);
    return { action: "reapply_stash", ok: true };
  }

  const target = target_branch ?? "";
  if (!target) return { error: "target branch required" };
  if (PROTECTED.has(target)) return { error: `protected branch ${target}` };
  if (!/^(feature|bugfix)\//.test(target)) return { error: `target must be feature/* or bugfix/* — got ${target}` };

  let stash_ref: string | undefined;
  if (current !== target) {
    const dirty = Boolean(gitContext(cwd).status_short.trim());
    if (dirty) {
      if (stash !== "yes") {
        return { error: "dirty working tree — ask with native question, then call workflow_branch_setup with stash=yes" };
      }
      try {
        exec(["stash", "push", "-u", "-m", `workflow-toolkit: pre-checkout ${target}`, "--", ":!docs/*/sdd"]);
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
        return { error: `branch ${target} is locked by an existing git worktree — remove it first (we do not use worktrees)` };
      }
      try {
        // Branch does not exist yet: base it on develop (never main/master).
        const current = gitContext(cwd).branch;
        if (current === "main" || current === "master") {
          const baseResult = ensureDevelopBase(cwd);
          if (!baseResult.ok) return { error: baseResult.error };
        } else {
          // Already on develop or another feature branch: still require origin/develop to exist.
          const baseResult = ensureDevelopBase(cwd);
          if (!baseResult.ok) return { error: baseResult.error };
        }
        exec(["checkout", "-b", target]);
      } catch (createError) {
        return { error: createError instanceof Error ? createError.message : "branch create failed" };
      }
    }
  }

  const manifest = readManifest();
  manifest.branch = target;
  manifest.previous_branch = current;
  if (stash_ref) {
    manifest.stash_ref = stash_ref;
    manifest.stash_created_at = new Date().toISOString();
  }
  writeManifest(manifest);
  return { action: "setup", ok: true, branch: target, previous_branch: current, stash_ref: stash_ref ?? null, manifest: manifestPath };
};
