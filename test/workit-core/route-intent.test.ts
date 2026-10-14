import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shellBranchPolicyViolation,
  shellBranchTarget,
  shellBranchTargets,
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

test("recognizes every raw branch-creation form agents use, wherever the option stands", () => {
  for (const [command, target] of [
    ["git switch -c feature/x", "feature/x"],
    ["git switch --create feature/x origin/main", "feature/x"],
    ["git switch --create=feature/x", "feature/x"],
    ["git switch -C feature/x", "feature/x"],
    ["git switch --no-track -c feature/x origin/develop", "feature/x"],
    ["git switch -c feature/x origin/develop --no-track", "feature/x"],
    ["git checkout -b feature/x", "feature/x"],
    ["git checkout -B feature/x origin/main", "feature/x"],
    ["git checkout --orphan feature/x", "feature/x"],
    ["git branch feature/x", "feature/x"],
    ["git branch feature/x origin/main", "feature/x"],
    ["git branch --no-track feature/x origin/main", "feature/x"],
    ["git branch -m feature/x", "feature/x"],
    ["git branch -m old feature/x", "feature/x"],
    ["git worktree add -b feature/x ../wt origin/main", "feature/x"],
    ["git worktree add ../wt -B feature/x", "feature/x"],
    ["git worktree add -bfeature/x ../wt", "feature/x"],
    ["git worktree add ../feature/x", "x"],
    ["git worktree add --lock --reason why ../wt-x", "wt-x"],
    ["git switch -cfeature/x", "feature/x"],
    ["git switch --orphan feature/x", "feature/x"],
    ["git checkout -bfeature/x origin/main", "feature/x"],
    // Wrappers, chains, directories and quoting (the raw-git tokenizer).
    ['git switch -c "feature/x"', "feature/x"],
    ["git switch -c feature/x && echo done", "feature/x"],
    ["cd repo && git switch -c feature/x", "feature/x"],
    ["env MODE=x git switch -c feature/x", "feature/x"],
    ["GIT_TRACE=0 git checkout -b feature/x", "feature/x"],
    ["/usr/bin/git switch -c feature/x", "feature/x"],
    ["git -C ../repo switch -c feature/x", "feature/x"],
    ["git -c core.x=y switch -c feature/x", "feature/x"],
    ["bash -c 'git switch -c feature/x'", "feature/x"],
    ["git fetch -q; git switch -c feature/x origin/main 2>&1 | tail -1", "feature/x"],
  ]) {
    expect(shellBranchTarget(command), command).toBe(target);
  }
});

test("Windows paths: posix sees C:/… (a backslash escapes), PowerShell keeps C:\\…; both name the directory git runs in", () => {
  expect(shellBranchTargets("cd C:/Users/me/repo/sub && git switch -c chore/x")).toEqual([
    { branch: "chore/x", dir: "C:/Users/me/repo/sub" },
  ]);
  expect(
    shellBranchTargets(String.raw`cd C:\Users\me\repo\sub; git switch -c chore/x`, "powershell"),
  ).toEqual([{ branch: "chore/x", dir: String.raw`C:\Users\me\repo\sub` }]);
  expect(
    shellBranchTargets(String.raw`git -C C:\Users\me\repo switch -c chore/x`, "powershell"),
  ).toEqual([{ branch: "chore/x", dir: String.raw`C:\Users\me\repo` }]);
});

test("leaves non-creating and unknowable commands to the host", () => {
  for (const command of [
    "git switch main",
    "git checkout main",
    "git checkout -- file.txt",
    "git branch",
    "git branch --show-current",
    "git branch -d feature/x",
    "git branch -D feature/x",
    "git branch --list 'feature/*'",
    "git branch -u origin/main",
    "git branch --set-upstream-to origin/main feature/x",
    "echo 'git switch -c main'",
    "git switch -c $BRANCH",
    "git switch -c `echo main`",
    "git worktree add --detach ../wt",
    "git worktree add ../wt main",
    "git worktree list",
    "gh pr create --fill",
    "gh pr merge 1",
    "git status --short",
    "",
  ]) {
    expect(shellBranchTarget(command), command).toBeNull();
  }
});

/** A POSIX shell (Git Bash on Windows) sees C:/… paths: a backslash there is an escape. */
const posix = (dir: string) => dir.replaceAll("\\", "/");

/** A git repository with a Workit store: a Workit workspace. */
const workitRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "workit-shell-policy-root-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"],
    { cwd: dir },
  );
  mkdirSync(join(dir, ".git", "workit"), { recursive: true });
  return dir;
};

test("Given a scratch or new repository, When a command changes into it, Then the cwd workspace's policy never judges it; an existing name is never new", () => {
  const root = workitRepo();
  const scratch = mkdtempSync(join(tmpdir(), "workit-shell-scratch-"));
  try {
    // Directly in the workspace: judged.
    expect(shellBranchPolicyViolation(root, "git switch -c chore/x")?.ok).toBe(false);
    for (const command of [
      'cd "$(mktemp -d)" && git init && git checkout -b chore/x',
      "git init newrepo && cd newrepo && git switch -c wip",
      "git clone ../origin.git fresh && cd fresh && git switch -c wip",
      "for d in a b; do (cd $d && git switch -c chore/x); done",
      // An existing directory outside every Workit workspace.
      `cd ${posix(scratch)} && git checkout -b chore/x`,
      `git -C ${posix(scratch)} switch -c chore/x`,
    ])
      expect(shellBranchPolicyViolation(root, command), command).toBeNull();
    // A branch that already exists is not a new name: resetting it is fine.
    spawnSync("git", ["branch", "my-legacy"], { cwd: root });
    expect(shellBranchPolicyViolation(root, "git branch -f my-legacy HEAD")).toBeNull();
    expect(shellBranchPolicyViolation(root, "git checkout -B my-legacy")).toBeNull();
    expect(shellBranchPolicyViolation(root, "git branch -f my-new HEAD")?.ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Given the ui-kit chore/* chain (8.4.1 let it through), When checked, Then it is denied with the allowed kinds and the closest name", () => {
  const root = workitRepo();
  try {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ branchPolicy: { preset: "gitflow" } }),
    );
    // Verbatim shape from the 2026-10-09 transcript (claude-uikit-d598a8cf F2).
    const command = `cd ${posix(root)} && git fetch origin develop -q && git switch -c chore/untrack-agents origin/develop --no-track; git log --oneline -1; git ls-files .agents | wc -l`;
    const verdict = shellBranchPolicyViolation(root, command);
    expect(verdict?.ok).toBe(false);
    if (verdict?.ok === false) {
      expect(verdict.rule).toBe("allowed_pattern");
      expect(verdict.attempted).toBe("chore/untrack-agents");
      expect(verdict.correction).toContain('use "feature/untrack-agents"');
      expect(verdict.correction).toContain("feature/, bugfix/, hotfix/, release/");
    }
    const fix = shellBranchPolicyViolation(root, "git checkout -b fix/login");
    expect(fix?.ok === false && fix.correction).toContain('use "bugfix/login"');
    expect(shellBranchPolicyViolation(root, "git status")).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
      }),
    );
  }
});

test("Given a workspace policy on one repo, When git runs in its subdirectory or a linked worktree, Then that repo's policy decides", () => {
  const base = mkdtempSync(join(tmpdir(), "workit-shell-policy-ws-"));
  const repo = join(base, "repo");
  const linked = join(base, "linked");
  const elsewhere = join(base, "elsewhere");
  const run = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  try {
    mkdirSync(join(repo, "sub"), { recursive: true });
    mkdirSync(elsewhere);
    run(repo, "init", "-q", "-b", "main");
    run(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    );
    run(repo, "worktree", "add", "-q", "-b", "feature/linked", linked);
    // Everything goes globally; only this repo's workspace limits the kinds.
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
    );
    writeFileSync(
      join(configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            name: "ws",
            glob: `${repo.replaceAll("\\", "/")}/**`,
            branchPolicy: {
              preset: "custom",
              allowed: ["feature/*", "bugfix/*"],
              protected: ["main"],
            },
          },
        ],
      }),
    );
    expect(shellBranchPolicyViolation(elsewhere, "git switch -c chore/x")).toEqual({ ok: true });
    // PowerShell keeps the native backslash path.
    for (const [cwd, command, dialect] of [
      [elsewhere, `cd ${posix(repo)}/sub && git switch -c chore/x`, "posix"],
      [join(repo, "sub"), "git switch -c chore/x", "posix"],
      [elsewhere, `git -C ${posix(linked)} switch -c chore/x`, "posix"],
      [linked, "git branch chore/x", "posix"],
      [elsewhere, `cd ${join(repo, "sub")}; git switch -c chore/x`, "powershell"],
      [elsewhere, `git -C ${linked} switch -c chore/x`, "powershell"],
    ] as const) {
      const verdict = shellBranchPolicyViolation(cwd, command, dialect);
      expect(verdict?.ok, command).toBe(false);
      if (verdict?.ok === false) expect(verdict.correction).toContain('use "feature/x"');
    }
    expect(shellBranchPolicyViolation(linked, "git switch -c bugfix/x")).toEqual({ ok: true });
  } finally {
    rmSync(join(configDir, "workspaces.json"), { force: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
      }),
    );
    rmSync(base, { recursive: true, force: true });
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
