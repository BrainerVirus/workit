import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { detectBranchPolicy } from "../../packages/workit-core/src/core/branch-policy";
import type { BranchPreset } from "../../packages/workit-core/src/core/config";
import type { IntegrationMode } from "../../packages/workit-core/src/core/workspaces";

const repoWith = (branches: string[]) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-detect-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q", "-b", branches[0] ?? "main"]);
  run(["config", "user.name", "T"]);
  run(["config", "user.email", "t@t"]);
  writeFileSync(path.join(root, "r.md"), "x");
  run(["add", "r.md"]);
  run(["commit", "-q", "-m", "base"]);
  for (const b of branches.slice(1)) run(["branch", "-q", b]);
  return root;
};

test("CA-02: detection matrix maps branch presence to the proposal", () => {
  const cases: Array<[string[], BranchPreset, string | null, IntegrationMode]> = [
    [["main", "develop"], "gitflow", "develop", "merge"],
    [["master", "develop"], "gitflow", "develop", "merge"],
    [["develop"], "gitflow", "develop", "merge"],
    [["main"], "github-flow", null, "pr"],
    [["master"], "trunk-based", null, "pr"],
  ];
  for (const [branches, preset, developBranch, integration] of cases) {
    const root = repoWith(branches);
    try {
      const d = detectBranchPolicy(root);
      expect(d.preset, branches.join(",")).toBe(preset);
      expect(d.developBranch).toBe(developBranch);
      expect(d.integration).toBe(integration);
      if (preset === "gitflow") {
        expect(d.protected).toEqual(expect.arrayContaining(["develop", branches[0]]));
        expect(d.prefixes).toEqual({
          feature: "feature/*",
          bugfix: "bugfix/*",
          release: "release/*",
          hotfix: "hotfix/*",
        });
      } else {
        expect(d.allowed).toEqual(["*"]);
        expect(d.protected).toEqual([branches[0]]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("CA-02: a non-repo directory falls back to gitflow defaults", () => {
  // bare non-git temp dir (not a repo with an origin) — the fallback path
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-detect-empty-"));
  try {
    const d = detectBranchPolicy(root);
    expect(d.preset).toBe("gitflow");
    expect(d.developBranch).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
