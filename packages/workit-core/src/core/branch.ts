import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { repoBranchPreset } from "./branch-policy";
import { matchCommitFlavor } from "./commit-flavors";
import { gitContext } from "./git";
import {
  branchGlobPattern,
  readConfig,
  resolveBranchPolicy as resolveConfiguredBranchPolicy,
  resolveCommitPolicy as resolveConfiguredCommitPolicy,
} from "./config";
import {
  resolveRuntimeWorkspacePolicy,
  type WorkspaceBranchPolicy,
  type WorkspaceCommitPolicy,
} from "./workspaces";
import { vcsCliIdentity, vcsConfig } from "./vcs-config";
import {
  ReleaseTrackError,
  namingGlob,
  trackBranches,
  workspaceReleaseTracks,
} from "./release-tracks";

/**
 * Release tracks extend the branch policy: every track's long-lived branches
 * are protected (the union across tracks plus the explicit protected list),
 * and the tracks' naming templates are allowed branch patterns. A track read
 * that must fail closed (a `critical` field) throws, so callers block.
 */
const withReleaseTracks = (
  workspaceRoot: string,
  policy: ReturnType<typeof resolveConfiguredBranchPolicy>,
): ReturnType<typeof resolveConfiguredBranchPolicy> => {
  const read = workspaceReleaseTracks(workspaceRoot);
  if (read.error) throw new ReleaseTrackError(read.error);
  if (read.tracks.length === 0 && read.protectedBranches.length === 0) return policy;
  const known = new Set(policy.allowed.map((pattern) => pattern.source));
  const allowed = [...policy.allowed];
  for (const glob of read.tracks.flatMap((track) => Object.values(track.naming).map(namingGlob))) {
    const pattern = branchGlobPattern(glob);
    if (!known.has(pattern.source)) {
      known.add(pattern.source);
      allowed.push(pattern);
    }
  }
  return {
    ...policy,
    allowed,
    protected: new Set([
      ...policy.protected,
      // Fail-safe: every branch any track entry names, including dropped ones.
      ...[...trackBranches(read.tracks), ...read.protectedBranches].map((name) =>
        name.toLowerCase(),
      ),
    ]),
  };
};

function effectiveWorkspacePolicy(
  workspaceRoot: string,
  kind: "branch",
  profileName?: string,
): {
  branchPolicy: ReturnType<typeof resolveConfiguredBranchPolicy>;
  provenance: { branchPolicy: string };
};
function effectiveWorkspacePolicy(
  workspaceRoot: string,
  kind: "commit",
  profileName?: string,
): {
  commitPolicy: ReturnType<typeof resolveConfiguredCommitPolicy>;
  provenance: { commitPolicy: string };
};
function effectiveWorkspacePolicy(
  workspaceRoot: string,
  kind: "branch" | "commit",
  profileName?: string,
):
  | {
      branchPolicy: ReturnType<typeof resolveConfiguredBranchPolicy>;
      provenance: { branchPolicy: string };
    }
  | {
      commitPolicy: ReturnType<typeof resolveConfiguredCommitPolicy>;
      provenance: { commitPolicy: string };
    } {
  const selected = resolveRuntimeWorkspacePolicy(
    workspaceRoot,
    kind,
    profileName?.trim() || process.env.WORKFLOW_PROFILE?.trim() || undefined,
  );
  const config = readConfig();
  return kind === "branch"
    ? {
        branchPolicy: withReleaseTracks(
          workspaceRoot,
          resolveConfiguredBranchPolicy(
            config,
            selected.policy ? { branchPolicy: selected.policy as WorkspaceBranchPolicy } : null,
            () => repoBranchPreset(workspaceRoot),
          ),
        ),
        provenance: { branchPolicy: selected.source },
      }
    : {
        commitPolicy: resolveConfiguredCommitPolicy(
          config,
          selected.policy ? { commitPolicy: selected.policy as WorkspaceCommitPolicy } : null,
        ),
        provenance: { commitPolicy: selected.source },
      };
}

export type BranchNamePolicy = {
  allowed: readonly RegExp[];
  protected: ReadonlySet<string>;
};

export type BranchNamePolicyCheck =
  | { ok: true }
  | {
      ok: false;
      rule: "protected_ref" | "allowed_pattern" | "policy_unavailable";
      source: string;
      attempted: string;
      correction: string;
      error: string;
    };

export type CommitMessagePolicyCheck =
  | { ok: true }
  | {
      ok: false;
      rule: "commit_style" | "policy_unavailable";
      source: string;
      attempted: string;
      correction: string;
      error: string;
    };

export const validateBranchNamePolicy = (
  name: string,
  policy: BranchNamePolicy,
  source: string,
): BranchNamePolicyCheck => {
  const allowed = policy.allowed.map((pattern) => `/${pattern.source}/${pattern.flags}`);
  if (policy.protected.has(name.toLowerCase())) {
    const correction = `choose a non-protected branch matching one of: ${allowed.join(", ")}`;
    return {
      ok: false,
      rule: "protected_ref",
      source,
      attempted: name,
      correction,
      error: `protected_ref: branch ${JSON.stringify(name)} is protected by ${source}; ${correction}`,
    };
  }
  if (!policy.allowed.some((pattern) => pattern.test(name))) {
    const correction = `choose a branch matching one of: ${allowed.join(", ")}`;
    return {
      ok: false,
      rule: "allowed_pattern",
      source,
      attempted: name,
      correction,
      error: `allowed_pattern: branch ${JSON.stringify(name)} violates ${source} policy; ${correction}`,
    };
  }
  return { ok: true };
};

export const branchPolicySnapshotFor = (workspaceRoot: string) => {
  const resolved = effectiveWorkspacePolicy(workspaceRoot, "branch");
  const branchPolicy = resolved.branchPolicy;
  const source = resolved.provenance.branchPolicy;
  const allowed = branchPolicy.allowed
    .map((pattern) => `${pattern.source}/${pattern.flags}`)
    .toSorted();
  const protectedRefs = [...branchPolicy.protected].map((name) => name.toLowerCase()).toSorted();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ allowed, protectedRefs, source }))
    .digest("hex");
  return {
    branchPolicy,
    namePolicy: { allowed: branchPolicy.allowed, protected: branchPolicy.protected },
    source,
    fingerprint,
  };
};

export const commitPolicySnapshotFor = (workspaceRoot: string) => {
  const resolved = effectiveWorkspacePolicy(workspaceRoot, "commit");
  const policy = resolved.commitPolicy;
  const source = resolved.provenance.commitPolicy;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ preset: policy.preset, pattern: policy.pattern ?? null, source }))
    .digest("hex");
  return { policy, source, fingerprint };
};

export const validateCommitMessagePolicy = (
  message: string,
  policy: { preset: Parameters<typeof matchCommitFlavor>[1]; pattern?: string },
  source: string,
): CommitMessagePolicyCheck => {
  const attempted = message.split("\n", 1)[0] ?? "";
  if (matchCommitFlavor(message, policy.preset, policy.pattern)) return { ok: true };
  const correction =
    policy.preset === "custom" && policy.pattern
      ? `use a commit subject matching ${JSON.stringify(policy.pattern)}`
      : `use a ${policy.preset} commit subject`;
  return {
    ok: false,
    rule: "commit_style",
    source,
    attempted,
    correction,
    error: `commit_style: commit subject ${JSON.stringify(attempted)} violates ${source} ${policy.preset} policy; ${correction}`,
  };
};

export const validateBranchNameFor = (
  workspaceRoot: string,
  name: string,
): BranchNamePolicyCheck => {
  try {
    const resolved = branchPolicySnapshotFor(workspaceRoot);
    return validateBranchNamePolicy(name, resolved.namePolicy, resolved.source);
  } catch (error) {
    const correction = "repair or select a valid workspace policy before creating a branch";
    return {
      ok: false,
      rule: "policy_unavailable",
      source: "workspaces.json",
      attempted: name,
      correction,
      error: `policy_unavailable: cannot validate branch ${JSON.stringify(name)} because ${error instanceof Error ? error.message : String(error)}; ${correction}`,
    };
  }
};

export const validateCommitMessageFor = (
  workspaceRoot: string,
  message: string,
): CommitMessagePolicyCheck => {
  const attempted = message.split("\n", 1)[0] ?? "";
  try {
    const resolved = commitPolicySnapshotFor(workspaceRoot);
    return validateCommitMessagePolicy(message, resolved.policy, resolved.source);
  } catch (error) {
    const correction = "repair or select a valid workspace policy before committing";
    return {
      ok: false,
      rule: "policy_unavailable",
      source: "workspaces.json",
      attempted,
      correction,
      error: `policy_unavailable: cannot validate commit subject ${JSON.stringify(attempted)} because ${error instanceof Error ? error.message : String(error)}; ${correction}`,
    };
  }
};

/** CA-09: one policy resolver; profiles layer above the matched workspace. */
export const resolveBranchPolicyFor = (workspaceRoot: string, profileName?: string) =>
  effectiveWorkspacePolicy(workspaceRoot, "branch", profileName).branchPolicy;

/** Commit-flavor equivalent using the same profile and provenance chain. */
export const resolveCommitPolicyFor = (workspaceRoot: string, profileName?: string) =>
  effectiveWorkspacePolicy(workspaceRoot, "commit", profileName).commitPolicy;

const policy = (root: string) => resolveBranchPolicyFor(root);
const allowedBranch = (root: string, name: string) =>
  policy(root).allowed.some((r) => r.test(name));
const isProtected = (root: string, name: string) => policy(root).protected.has(name.toLowerCase());

/** Public guardrail: protected refs fail closed anywhere, never ask. */
export const isProtectedTarget = (root: string, name: string): boolean => {
  try {
    return isProtected(root, name);
  } catch {
    return true;
  }
};

/**
 * Push identity check as code: the credential actually used must belong to
 * the workspace area account. Anything unresolvable fails closed — an
 * unreachable host never reads as a match.
 */
export const verifyPushIdentity = (
  root: string,
  provider: string,
  account: string,
): { ok: true } | { ok: false; error: string } => {
  if (!account || typeof account !== "string")
    return { ok: false, error: "push identity requires a configured area account" };
  const identity = vcsCliIdentity(root);
  if (!identity.ok || identity.provider !== provider)
    return { ok: false, error: identity.error ?? "hosting CLI identity could not be resolved" };
  if (identity.username?.toLowerCase() !== account.toLowerCase())
    return {
      ok: false,
      error: `push identity ${identity.username || "(unknown)"} does not match area account ${account}`,
    };
  return { ok: true };
};
// RL-01: malformed vcs.json blocks branch resolution with an exact-path error.
// With release tracks, the base is the resolved track's base branch.
const baseBranch = (cwd: string): { base: string; trackBranches: string[] } | { error: string } => {
  const resolved = vcsConfig("resolve", cwd);
  if (resolved.ok === false) return { error: String(resolved.error) };
  // Creating a branch on an undetermined release line would guess the base.
  if (resolved.releaseTrack?.blocking) return { error: String(resolved.releaseTrack.blocking) };
  return {
    base: String(resolved.baseBranch ?? resolved.defaultTargetBranch ?? "develop"),
    trackBranches: resolved.releaseTrack ? trackBranches(resolved.releaseTrack.tracks) : [],
  };
};
const DECLARE_RE = /^\s*\*+Branch:\*+\s*`?([^`\s|]+)`?\s*$/gim;
const USE_CURRENT_RE = /^\s*\*+Branch:\*+\s*use-current\s*$/im;
// Windows portability: journal lines and stash-coverage sets carry
// repo-relative paths, which must match git's POSIX separator output even
// though path.join emits platform separators.
const readSafe = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

const normalizeBranch = (root: string, name: string): string | null => {
  const n = name.trim().replace(/`/g, "").replace(/\.+$/, "");
  if (!validateBranchNameFor(root, n).ok) return null;
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
      if (!current) return { error: `use-current but HEAD ${current} is not an allowed branch` };
      const policyCheck = validateBranchNameFor(cwd, current);
      if (!policyCheck.ok)
        return { error: `use-current but HEAD ${current} is not allowed: ${policyCheck.error}` };
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
    const policyCheck = validateBranchNameFor(cwd, declaredButInvalid);
    return {
      error: policyCheck.ok
        ? `declared branch ${JSON.stringify(declaredButInvalid)} is not a valid branch name`
        : policyCheck.error,
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

  if (
    current === base ||
    current === "main" ||
    current === "master" ||
    current === "develop" ||
    baseResolved.trackBranches.includes(current)
  ) {
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
const fastForwardBase = (
  cwd: string,
  base: string,
  expectedRemoteBase?: string,
  expectedLocalBase?: string | null,
): { ok: boolean; error?: string } => {
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
    if (expectedLocalBase !== undefined) {
      let localBase: string | null = null;
      try {
        localBase = run(["rev-parse", "--verify", `refs/heads/${base}`]).trim();
      } catch {}
      if (localBase !== expectedLocalBase)
        return { ok: false, error: "approved local base changed before branch setup" };
    }
    if (hasLocalBase) {
      run(["checkout", base]);
      if (expectedLocalBase && run(["rev-parse", "HEAD"]).trim() !== expectedLocalBase)
        return { ok: false, error: "approved local base changed before branch setup" };
      try {
        run(["merge", "--ff-only", expectedRemoteBase ?? `origin/${base}`]);
      } catch {
        /* non-fast-forward: keep local */
      }
    } else if (expectedRemoteBase) {
      run(["checkout", "-b", base, expectedRemoteBase]);
      run(["branch", "--set-upstream-to", `origin/${base}`, base]);
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

export type BranchSetupResult =
  | {
      action: "setup";
      ok: true;
      branch: string;
      previous_branch: string;
      stash_ref: string | null;
      manifest: string;
    }
  | { action: "reapply_stash"; ok: true }
  | { error: string; phase: "preflight" | "post_mutation" };

// Port of scripts/branch/setup-branch.sh
export type BranchDirt = "clean" | "carry" | "stash-required";

/**
 * Classify working-tree dirt for branch setup. Untracked files ride along
 * (`git switch -c` never touches them), and tracked modifications confined
 * to `docs/` are branch-owned by construction in this workflow — both
 * auto-carry with no stash question. Anything else keeps the stash-bound
 * proposal, since the base-checkout sequence could disturb it. Any
 * inspection failure reads as clean so a broken git surfaces at its own
 * error instead of inventing a stash demand.
 */
export const classifyBranchDirt = (workspaceRoot: string): BranchDirt => {
  let raw: string;
  try {
    raw = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: path.resolve(workspaceRoot),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return "clean";
  }
  let dirty = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    dirty = true;
    const code = line.slice(0, 2);
    if (code === "??") continue;
    let entry = line.slice(3);
    const arrow = entry.indexOf(" -> ");
    if (arrow >= 0) entry = entry.slice(arrow + 4);
    const unquoted = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (unquoted !== "docs" && !unquoted.startsWith("docs/")) return "stash-required";
  }
  return dirty ? "carry" : "clean";
};

export const branchSetup = ({
  action,
  sdd_dir,
  target_branch,
  stash,
  workspace_root,
  log,
  expected_remote_base,
  expected_local_base,
}: {
  action?: string;
  sdd_dir?: string;
  target_branch?: string;
  stash?: string;
  workspace_root: string;
  log?: (message: string) => void;
  expected_remote_base?: string;
  expected_local_base?: string | null;
}): BranchSetupResult => {
  const cwd = path.resolve(workspace_root);
  const exec = (args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const current = gitContext(cwd).branch;
  if (!current || current === "unknown")
    return { error: "not in a git repository", phase: "preflight" };
  const sdd = sdd_dir ?? "docs";
  const manifestPath = path.isAbsolute(sdd)
    ? path.join(sdd, "manifest.json")
    : path.join(cwd, sdd, "manifest.json");
  const ensureManifestDir = () => {
    const dir = path.dirname(manifestPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
  };
  const readManifest = (): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      return {};
    }
  };
  const writeManifest = (data: Record<string, unknown>) => {
    ensureManifestDir();
    writeFileSync(manifestPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  };

  const journal = (message: string) => log?.(`branch-setup: ${message}`);

  if (action === "reapply_stash") {
    const manifest = readManifest();
    const ref = manifest.stash_ref;
    if (!ref) return { error: "no stash_ref in manifest", phase: "preflight" };
    journal(`pre-pop: ${String(ref)}`);
    try {
      exec(["stash", "pop", String(ref)]);
    } catch (error) {
      journal("pop: failed");
      return {
        error: error instanceof Error ? error.message : "stash pop failed",
        phase: "post_mutation",
      };
    }
    journal("pop: ok");
    delete manifest.stash_ref;
    delete manifest.stash_created_at;
    writeManifest(manifest);
    return { action: "reapply_stash", ok: true };
  }

  const target = target_branch ?? "";
  if (!target)
    return {
      error: "target_branch (the working branch to create or switch to) is required for setup",
      phase: "preflight",
    };
  if (expected_remote_base && !/^[a-f0-9]{40,64}$/i.test(expected_remote_base))
    return { error: "approved remote base commit is invalid", phase: "preflight" };
  try {
    exec(["check-ref-format", "--branch", target]);
  } catch {
    return { error: `invalid Git branch name ${target}`, phase: "preflight" };
  }

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
    const namePolicy = validateBranchNameFor(cwd, target);
    if (!namePolicy.ok) return { error: namePolicy.error, phase: "preflight" };
  }
  if (!targetExists) {
    const baseResolved = baseBranch(cwd);
    if ("error" in baseResolved) return { error: baseResolved.error, phase: "preflight" };
    base = baseResolved.base;
  }
  journal(`entry: current=${current} target=${target} base=${base ?? "-"}`);

  let stash_ref: string | undefined;
  // Best-effort restore; if the pop itself fails, the caller's error gains a
  // suffix pointing at the stash so stranded work stays discoverable.
  const failAfterStash = (
    message: string,
    phase: "preflight" | "post_mutation" = "post_mutation",
  ): { error: string; phase: "preflight" | "post_mutation" } => {
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
    return { error: `${message}${suffix}`, phase: stash_ref ? "post_mutation" : phase };
  };
  if (current !== target) {
    const dirty = Boolean(gitContext(cwd).status_short.trim());
    if (classifyBranchDirt(cwd) === "stash-required" && stash !== "yes") {
      return {
        error:
          "dirty working tree — obtain native host approval before stashing and setting up the branch",
        phase: "preflight",
      };
    }
    // CA-02: validate origin/<base> before ANY mutation (no snapshot, no
    // stash push, no checkout) so a missing origin/<base> fails with the
    // tree untouched. The mutating fast-forward stays below: it checks out
    // the base branch — unsafe on a dirty tree.
    let validatedBase: string | undefined;
    let validatedRemoteBase: string | undefined;
    let validatedLocalBase: string | null | undefined;
    if (!targetExists && base !== undefined) {
      const ready = originBaseReady(cwd, base);
      if (!ready.ok)
        return { error: ready.error ?? "ensure-base-branch failed", phase: "preflight" };
      const fetchedBase = exec(["rev-parse", "--verify", `refs/remotes/origin/${base}`]).trim();
      if (expected_remote_base && fetchedBase !== expected_remote_base)
        return { error: "approved remote base changed before branch setup", phase: "preflight" };
      if (expected_local_base !== undefined) {
        let localBase: string | null = null;
        try {
          localBase = exec(["rev-parse", "--verify", `refs/heads/${base}`]).trim();
        } catch {}
        if (localBase !== expected_local_base)
          return { error: "approved local base changed before branch setup", phase: "preflight" };
        validatedLocalBase = expected_local_base;
      }
      if (expected_remote_base) validatedRemoteBase = expected_remote_base;
      validatedBase = base;
    }
    if (dirty && stash === "yes") {
      try {
        exec(["stash", "push", "-u", "-m", `workit: pre-checkout ${target}`]);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "stash push failed",
          phase: "post_mutation",
        };
      }
      stash_ref = "stash@{0}";
      journal(`stash push: ${stash_ref}`);
    }
    try {
      exec(["checkout", target]);
      journal("post-checkout");
    } catch (error) {
      const message = error instanceof Error ? error.message : "checkout failed";
      if (/worktree/i.test(message)) {
        return failAfterStash(
          `branch ${target} is locked by an existing git worktree — remove it first (we do not use worktrees)`,
          "preflight",
        );
      }
      try {
        let effectiveBase = base;
        if (effectiveBase === undefined) {
          const lateResolved = baseBranch(cwd);
          if ("error" in lateResolved) return failAfterStash(lateResolved.error, "preflight");
          effectiveBase = lateResolved.base;
        }
        // Pre-validated above when the target was missing: only the
        // fast-forward mutation remains post-stash.
        const baseResult =
          validatedBase !== undefined
            ? fastForwardBase(cwd, effectiveBase, validatedRemoteBase, validatedLocalBase)
            : ensureBaseBranch(cwd, effectiveBase);
        if (!baseResult.ok) return failAfterStash(baseResult.error ?? "ensure-base-branch failed");
        const targetBase = exec(["rev-parse", "HEAD"]).trim();
        if (
          validatedRemoteBase &&
          validatedLocalBase !== undefined &&
          ![validatedRemoteBase, validatedLocalBase].includes(targetBase)
        )
          return failAfterStash("approved branch base changed before branch creation", "preflight");
        exec(["checkout", "-b", target, targetBase]);
        journal("post-create");
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
      } catch {
        try {
          exec(["checkout", "-m", current]);
        } catch {}
      }
    }
    return result;
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
