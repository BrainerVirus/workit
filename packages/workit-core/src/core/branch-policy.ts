import { spawnSync } from "node:child_process";
import type { BranchPreset } from "./config";
import type { IntegrationMode } from "./workspaces";

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

  if (develop && root) {
    return {
      preset: "gitflow" as BranchPreset,
      developBranch: "develop",
      integration: "merge" as IntegrationMode,
      protected: [root, "develop"],
      allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
      prefixes: {
        feature: "feature/*",
        bugfix: "bugfix/*",
        release: "release/*",
        hotfix: "hotfix/*",
      },
    };
  }
  if (root === "main") {
    return {
      preset: "github-flow" as BranchPreset,
      developBranch: null,
      integration: "pr" as IntegrationMode,
      protected: [root],
      allowed: ["*"],
      prefixes: {
        feature: "feature/*",
        bugfix: "bugfix/*",
        release: "release/*",
        hotfix: "hotfix/*",
      },
    };
  }
  if (root === "master") {
    return {
      preset: "trunk-based" as BranchPreset,
      developBranch: null,
      integration: "pr" as IntegrationMode,
      protected: [root],
      allowed: ["*"],
      prefixes: {
        feature: "feature/*",
        bugfix: "bugfix/*",
        release: "release/*",
        hotfix: "hotfix/*",
      },
    };
  }
  return {
    preset: "gitflow" as BranchPreset,
    developBranch: null,
    integration: "merge" as IntegrationMode,
    protected: [],
    allowed: [],
    prefixes: {
      feature: "feature/*",
      bugfix: "bugfix/*",
      release: "release/*",
      hotfix: "hotfix/*",
    },
  };
};
