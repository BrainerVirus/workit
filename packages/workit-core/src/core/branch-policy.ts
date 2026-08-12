import { spawnSync } from "node:child_process";
import { PRESETS, type BranchPreset } from "./config";
import type { IntegrationMode } from "./workspaces";

const PREFIXES = {
  feature: "feature/*",
  bugfix: "bugfix/*",
  release: "release/*",
  hotfix: "hotfix/*",
};

export const detectBranchPolicy = (workspaceRoot: string) => {
  const branchExists = (name: string): boolean => {
    const r = spawnSync("git", ["branch", "--list", name], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    return r.status === 0 && (r.stdout ?? "").trim() !== "";
  };
  const develop = branchExists("develop");
  const main = branchExists("main");
  const master = branchExists("master");
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
