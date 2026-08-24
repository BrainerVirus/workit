import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
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

// Read-only half of ensureBaseBranch (fetch --prune + show-ref origin/base):
// safe to run before any mutation so a missing origin/<base> fails before a
// stash push empties the tree.
const originBaseReady = (cwd: string, base: string): { ok: boolean; error?: string } => {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  try {
    try {
      run(["fetch", "origin", base, "--prune"]);
    } catch {
      run(["fetch", "origin", "--prune"]);
    }
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${base}`], {
        cwd,
        stdio: "pipe",
      });
    } catch {
      return {
        ok: false,
        error: `origin/${base} missing — push ${base} before creating feature/* or bugfix/* branches`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "ensure-base-branch failed",
    };
  }
};

// Mutating half of ensureBaseBranch: fast-forwards the local base (creating
// it from origin/<base> if needed). Only safe on a clean tree.
const fastForwardBase = (cwd: string, base: string): { ok: boolean; error?: string } => {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  try {
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

export const ensureBaseBranch = (cwd: string, base: string): { ok: boolean; error?: string } => {
  const git = gitContext(cwd);
  if (!git.branch || git.branch === "unknown")
    return { ok: false, error: "not in a git repository" };
  const ready = originBaseReady(cwd, base);
  if (!ready.ok) return ready;
  return fastForwardBase(cwd, base);
};

// CA-05: flow-state snapshots live under the OS tempdir scoped by a hash of
// the workspace path — never inside the repository or docs/.
export const snapshotFlowState = (cwd: string): string => {
  const root = path.join(
    tmpdir(),
    `workit-flow-guard-${createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16)}`,
  );
  rmSync(root, { recursive: true, force: true }); // drop a stale guard from a crashed run
  mkdirSync(root, { recursive: true });
  const docsDir = path.join(path.resolve(cwd), "docs");
  let slugs: string[] = [];
  try {
    slugs = readdirSync(docsDir);
  } catch {
    return root; // no docs/ yet — zero-file snapshot
  }
  for (const slug of slugs) {
    const src = path.join(docsDir, slug, "sdd", "flow.json");
    try {
      if (!statSync(src).isFile()) continue;
    } catch {
      continue;
    }
    const dest = path.join(root, "docs", slug, "sdd", "flow.json");
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
  return root;
};

// CA-04: restore-if-missing keeps the newest working-tree bytes; the snapshot
// root is removed only after every file is handled and retained on failure.
// A caught failure must not vanish: the message is returned so callers can
// surface it to operators as a warning.
export const restoreFlowSnapshot = (snapDir: string, cwd: string): string | undefined => {
  const walk = (dir: string, rel: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name), path.join(rel, entry.name))
        : [path.join(rel, entry.name)],
    );
  try {
    const workspace = path.resolve(cwd);
    for (const rel of walk(snapDir, "")) {
      const dest = path.join(workspace, rel);
      if (existsSync(dest)) continue;
      mkdirSync(path.dirname(dest), { recursive: true });
      // Atomic publish: a crash mid-copy must never leave a truncated flow.json
      // at the destination.
      const tmpDest = `${dest}.tmp-${process.pid}`;
      try {
        copyFileSync(path.join(snapDir, rel), tmpDest);
        renameSync(tmpDest, dest);
      } catch (error) {
        rmSync(tmpDest, { force: true });
        throw error;
      }
    }
    rmSync(snapDir, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return `flow state snapshot restore failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
};

// Port of scripts/branch/setup-branch.sh
export const branchSetup = ({
  action,
  sdd_dir,
  target_branch,
  stash,
  workspace_root,
  log,
}: {
  action?: string;
  sdd_dir?: string;
  target_branch?: string;
  stash?: string;
  workspace_root: string;
  log?: (message: string) => void;
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

  let snapDir: string | null = null;
  // CA-01: flow-guard journal brackets the stash/checkout mutation window so a
  // mid-window wipe is pinpointable between adjacent checkpoint lines. With no
  // logger injected every call below is a no-op and nothing extra runs —
  // behaviorally identical to the pre-journal code.
  const journal = (message: string) => log?.(`flow-guard: ${message}`);
  const snapshotRelPaths = (): string[] => {
    const dir = snapDir;
    if (!dir || !log) return [];
    try {
      const walk = (from: string, rel: string): string[] =>
        readdirSync(from, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? walk(path.join(from, entry.name), path.join(rel, entry.name))
            : [path.join(rel, entry.name)],
        );
      return walk(dir, "");
    } catch {
      return [];
    }
  };
  const journalSnapshot = () => {
    const dir = snapDir;
    if (!dir || !log) return;
    const rels = snapshotRelPaths();
    journal(`snapshot: ${rels.length} file(s)`);
    for (const rel of rels) {
      let shortHash = "";
      try {
        shortHash = createHash("sha256").update(readFileSync(path.join(dir, rel))).digest("hex").slice(0, 8);
      } catch {}
      journal(`snapshot: ${rel} sha=${shortHash}`);
    }
  };
  const journalPresence = (phase: string) => {
    for (const rel of snapshotRelPaths()) {
      journal(`${phase}: ${rel} ${existsSync(path.join(cwd, rel)) ? "present" : "MISSING"}`);
    }
  };
  const restoreWithWarning = (dir: string | null): string[] => {
    if (!dir) return [];
    let planned: string | undefined;
    if (log) {
      const rels = snapshotRelPaths();
      const missing = rels.filter((rel) => !existsSync(path.join(cwd, rel)));
      planned = `restore: restored=${missing.length} skipped=${rels.length - missing.length}`;
    }
    const warning = restoreFlowSnapshot(dir, cwd);
    if (planned) journal(`${planned}${warning ? ` warning: ${warning}` : ""}`);
    else if (warning) journal(`restore warning: ${warning}`);
    return warning ? [warning] : [];
  };

  if (action === "reapply_stash") {
    const manifest = readManifest();
    const ref = manifest.stash_ref;
    if (!ref) return { error: "no stash_ref in manifest" };
    // D-03: guard flow.json across the stash pop window.
    snapDir = snapshotFlowState(cwd);
    journalSnapshot();
    journal(`pre-pop: ${String(ref)}`);
    try {
      exec(["stash", "pop", String(ref)]);
    } catch (error) {
      // CA-03: the snapshot ran before the pop — a failing pop must still
      // restore a mid-window-wiped flow.json before returning.
      journal("pop: failed");
      const [warning] = restoreWithWarning(snapDir);
      return {
        error: `${error instanceof Error ? error.message : "stash pop failed"}${
          warning ? `; ${warning}` : ""
        }`,
      };
    }
    journal("pop: ok");
    delete manifest.stash_ref;
    delete manifest.stash_created_at;
    writeManifest(manifest);
    const warnings = restoreWithWarning(snapDir);
    return { action: "reapply_stash", ok: true, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  const target = target_branch ?? "";
  if (!target) return { error: "target branch required" };
  if (isProtected(cwd, target)) return { error: `protected branch ${target}` };
  if (!allowedBranch(cwd, target))
    return { error: `target branch ${target} is not allowed by the branch policy` };

  // CA-02: resolve the base up front so an unresolvable base fails before
  // any mutation. The origin/<base> validation runs after the stash gate
  // below but still BEFORE any mutation (no snapshot, no stash push).
  let base: string | undefined;
  let targetExists = true;
  try {
    exec(["rev-parse", "--verify", "--quiet", `refs/heads/${target}`]);
  } catch {
    targetExists = false;
  }
  if (!targetExists) {
    const baseResolved = baseBranch(cwd);
    if ("error" in baseResolved) return { error: baseResolved.error };
    base = baseResolved.base;
  }
  journal(`entry: current=${current} target=${target} base=${base ?? "-"}`);

  let stash_ref: string | undefined;
  // Best-effort restore; if the pop itself fails, the caller's error gains a
  // suffix pointing at the stash so stranded work stays discoverable.
  const failAfterStash = (message: string): { error: string } => {
    let suffix = "";
    if (stash_ref) {
      journal(`pre-pop: ${stash_ref}`);
      try {
        exec(["stash", "pop", stash_ref]);
        stash_ref = undefined;
        journal("pop: ok");
      } catch {
        journal("pop: failed");
        suffix = " (changes preserved in stash)";
      }
    }
    // CA-03: the snapshot ran before the stash push, so every error return
    // here must still restore a mid-window-wiped flow.json and drop the
    // guard root (a retained root is destroyed by the next run's
    // stale-root rmSync). Never masks the original error.
    const [warning] = restoreWithWarning(snapDir);
    return { error: `${message}${suffix}${warning ? `; ${warning}` : ""}` };
  };
  if (current !== target) {
    const dirty = Boolean(gitContext(cwd).status_short.trim());
    if (dirty && stash !== "yes") {
      return {
        error:
          "dirty working tree — ask with native question, then call workit_branch_setup with stash=yes",
      };
    }
    // CA-02: validate origin/<base> before ANY mutation (no snapshot, no
    // stash push, no checkout) so a missing origin/<base> fails with the
    // tree untouched. The mutating fast-forward stays below: it checks out
    // the base branch — unsafe on a dirty tree.
    let validatedBase: string | undefined;
    if (!targetExists && base !== undefined) {
      const ready = originBaseReady(cwd, base);
      if (!ready.ok) return { error: ready.error ?? "ensure-base-branch failed" };
      validatedBase = base;
    }
    if (dirty) {
      try {
        // CA-03: snapshot before the stash push so flow.json survives the
        // stash/checkout window even if the pathspec exclusion misses.
        snapDir = snapshotFlowState(cwd);
        journalSnapshot();
        exec(["stash", "push", "-u", "-m", `workit: pre-checkout ${target}`, "--", ":!docs/*/sdd"]);
      } catch (error) {
        return { error: error instanceof Error ? error.message : "stash push failed" };
      }
      stash_ref = "stash@{0}";
      journal(`stash push: ${stash_ref}`);
    }
    try {
      exec(["checkout", target]);
      journalPresence("post-checkout");
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
        // Pre-validated above when the target was missing: only the
        // fast-forward mutation remains post-stash.
        const baseResult =
          validatedBase !== undefined
            ? fastForwardBase(cwd, effectiveBase)
            : ensureBaseBranch(cwd, effectiveBase);
        if (!baseResult.ok) return failAfterStash(baseResult.error ?? "ensure-base-branch failed");
        exec(["checkout", "-b", target]);
        journalPresence("post-create");
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
    const result = failAfterStash(
      error instanceof Error
        ? `manifest update failed: ${error.message}`
        : "manifest update failed",
    );
    // After a successful pop, don't strand HEAD on the half-created target:
    // return to the originating branch (best-effort; a conflicting tree can
    // still refuse the checkout and keeps the popped state).
    if (stash_ref === undefined && gitContext(cwd).branch !== current) {
      try {
        exec(["checkout", current]);
      } catch {}
    }
    return result;
  }
  const warnings = restoreWithWarning(snapDir);
  return {
    action: "setup",
    ok: true,
    branch: target,
    previous_branch: current,
    stash_ref: stash_ref ?? null,
    manifest: manifestPath,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};
