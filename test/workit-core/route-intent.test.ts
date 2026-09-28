import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shellBranchPolicyViolation,
  shellBranchTarget,
} from "@/packages/workit-core/src/core/route-intent";

const previous = {
  config: process.env.WORKFLOW_TOOLKIT_CONFIG,
  configDir: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
  profile: process.env.WORKFLOW_PROFILE,
  workspace: process.env.WORKFLOW_WORKSPACE_NAME,
};
let configDir: string;
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "workit-shell-policy-config-"));
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = configDir;
  delete process.env.WORKFLOW_PROFILE;
  delete process.env.WORKFLOW_WORKSPACE_NAME;
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
});
afterAll(() => {
  if (previous.config === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  else process.env.WORKFLOW_TOOLKIT_CONFIG = previous.config;
  if (previous.configDir === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previous.configDir;
  if (previous.profile === undefined) delete process.env.WORKFLOW_PROFILE;
  else process.env.WORKFLOW_PROFILE = previous.profile;
  if (previous.workspace === undefined) delete process.env.WORKFLOW_WORKSPACE_NAME;
  else process.env.WORKFLOW_WORKSPACE_NAME = previous.workspace;
  rmSync(configDir, { recursive: true, force: true });
});

test("recognizes direct literal Git branch-creation forms", () => {
  for (const [command, target] of [
    ["git switch -c feature/x", "feature/x"],
    ["git switch --create feature/x origin/main", "feature/x"],
    ["git switch -C feature/x", "feature/x"],
    ["git checkout -b feature/x", "feature/x"],
    ["git checkout -B feature/x origin/main", "feature/x"],
    ["git branch feature/x", "feature/x"],
    ["git branch feature/x origin/main", "feature/x"],
  ]) {
    expect(shellBranchTarget(command), command).toBe(target);
  }
});

test("leaves unsupported shell syntax and non-branch effects to the host", () => {
  for (const command of [
    "git switch main",
    "git branch --show-current",
    "git branch -d feature/x",
    'git switch -c "main"',
    "git switch -c feature/x && echo done",
    "cd repo && git switch -c feature/x",
    "env MODE=x git switch -c feature/x",
    "/usr/bin/git switch -c feature/x",
    "echo 'git switch -c main'",
    "git switch -c $BRANCH",
    "git switch -c `echo main`",
    "git worktree add ../feature/x",
    "gh pr create --fill",
    "gh pr merge 1",
    "git status --short",
    "",
  ]) {
    expect(shellBranchTarget(command), command).toBeNull();
  }
});

test("validates the current exact branch policy on each recognized operation", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-shell-policy-root-"));
  try {
    expect(shellBranchPolicyViolation(root, "git switch -c feature/ok")).toEqual({ ok: true });

    const protectedRef = shellBranchPolicyViolation(root, "git checkout -b main");
    expect(protectedRef?.ok).toBe(false);
    if (protectedRef?.ok === false) {
      expect(protectedRef.rule).toBe("protected_ref");
      expect(protectedRef.source).toBe("user-default");
      expect(protectedRef.attempted).toBe("main");
      expect(protectedRef.correction).toContain("feature");
    }

    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        branchPolicy: { preset: "custom", allowed: ["release/*"], protected: ["main"] },
      }),
    );
    const staleName = shellBranchPolicyViolation(root, "git branch feature/ok");
    expect(staleName?.ok).toBe(false);
    if (staleName?.ok === false) {
      expect(staleName.rule).toBe("allowed_pattern");
      expect(staleName.attempted).toBe("feature/ok");
      expect(staleName.error).toContain("release");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
