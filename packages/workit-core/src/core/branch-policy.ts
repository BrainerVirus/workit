import { spawnSync } from "node:child_process";
import { PRESETS, type BranchPreset } from "./config";
import type { IntegrationMode } from "./workspaces";

const PREFIXES = {
  feature: "feature/*",
  bugfix: "bugfix/*",
  release: "release/*",
  hotfix: "hotfix/*",
};

/**
 * Local branch names plus origin's remote-tracking ones (`origin/develop`
 * counts as `develop`; a fork or mirror remote's branches do not).
 */
export const branchNames = (workspaceRoot: string): Set<string> => {
  const r = spawnSync(
    "git",
    ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  if (r.status !== 0) return new Set();
  return new Set(
    (r.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .map((ref) =>
        ref.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : ref.slice("refs/remotes/origin/".length),
      ),
  );
};

/**
 * The git-flow production branch: main when it exists (locally or on
 * origin), else master, else main.
 */
export const productionBranchOf = (names: ReadonlySet<string>): string =>
  names.has("main") ? "main" : names.has("master") ? "master" : "main";

export const detectBranchPolicy = (workspaceRoot: string) => {
  const names = branchNames(workspaceRoot);
  const develop = names.has("develop");
  const main = names.has("main");
  const master = names.has("master");
  const root = main ? "main" : master ? "master" : null;

  if (develop) {
    return {
      preset: "gitflow" as BranchPreset,
      developBranch: "develop",
      integration: "merge" as IntegrationMode,
      protected: root ? [root, "develop"] : ["develop"],
      allowed: [...PRESETS.gitflow.allowed],
      prefixes: PREFIXES,
    };
  }
  if (root === "main") {
    return {
      preset: "github-flow" as BranchPreset,
      developBranch: null,
      integration: "pr" as IntegrationMode,
      protected: [root],
      allowed: ["*"],
      prefixes: PREFIXES,
    };
  }
  if (root === "master") {
    return {
      preset: "trunk-based" as BranchPreset,
      developBranch: null,
      integration: "pr" as IntegrationMode,
      protected: [root],
      allowed: ["*"],
      prefixes: PREFIXES,
    };
  }
  return {
    preset: "gitflow" as BranchPreset,
    developBranch: null,
    integration: "merge" as IntegrationMode,
    protected: [],
    allowed: [],
    prefixes: PREFIXES,
  };
};

/**
 * The preset this repository's branches imply (develop -> gitflow, main ->
 * github-flow, master -> trunk-based), or null when they imply none. Used
 * only when no branch policy is configured anywhere (core/config.ts).
 */
export const repoBranchPreset = (workspaceRoot: string): BranchPreset | null => {
  const detected = detectBranchPolicy(workspaceRoot);
  return detected.developBranch || detected.allowed.length ? detected.preset : null;
};

/**
 * The release tag prefix (`v` in `v1.4.0`): the branch policy's
 * `releaseTagPrefix` when it names one, else git-flow's own
 * `gitflow.prefix.versiontag` (set but empty is a valid prefix: tags like
 * `1.4.0`), else `v`.
 */
export const releaseTagPrefixOf = (workspaceRoot: string, policyPrefix?: unknown): string => {
  if (typeof policyPrefix === "string") return policyPrefix.trim();
  const r = spawnSync("git", ["config", "--get", "gitflow.prefix.versiontag"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  return r.status === 0 ? (r.stdout ?? "").trim() : "v";
};
