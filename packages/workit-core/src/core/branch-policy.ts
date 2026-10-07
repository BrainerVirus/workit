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
const branchNames = (workspaceRoot: string): Set<string> => {
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
