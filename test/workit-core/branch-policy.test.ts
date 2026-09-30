import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  docsBranch,
  resolveBranch,
  resolveBranchPolicyFor,
} from "@/packages/workit-core/src/core/branch";
import { vcsConfig } from "@/packages/workit-core/src/core/vcs-config";
import { resolveWorkspace } from "@/packages/workit-core/src/core/workspaces";
import { prCreate } from "@/packages/workit-core/src/core/pr-create";
import { writeConfig } from "@/packages/workit-core/src/core/config";
import { stubCli, stubPath } from "@/test/shared/helpers/stub-cli";

const git = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env } });

// Isolate from the developer's global config: tests assume gitflow semantics
// (PRESETS.gitflow in src/core/config.ts), like CI with no global config.
const previousXdg = process.env.XDG_CONFIG_HOME;
let isolatedConfig: string;
beforeAll(() => {
  isolatedConfig = mkdtempSync(path.join(os.tmpdir(), "wf-test-config-"));
  writeFileSync(
    path.join(isolatedConfig, "config.json"),
    JSON.stringify(
      {
        locale: "en",
        localeOptions: ["en"],
        timezone: "UTC",
        branchPolicy: {
          preset: "gitflow",
          allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
          protected: ["main", "develop", "master", "prod", "production"],
        },
      },
      null,
      2,
    ),
  );
  process.env.XDG_CONFIG_HOME = isolatedConfig;
});
afterAll(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(isolatedConfig, { recursive: true, force: true });
});

const repoWithDevelop = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-branch-policy-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "wf-branch-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["init", "-q", "-b", "develop"]);
  git(root, ["config", "user.name", "Workflow Test"]);
  git(root, ["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-q", "-u", "origin", "develop"]);
  git(root, ["branch", "main"]);
  git(root, ["checkout", "-q", "main"]);
  return { root, remote };
};

test(
  "docsBranch keeps current feature branch",
  () => {
    const { root, remote } = repoWithDevelop();
    git(root, ["checkout", "-q", "-b", "feature/current"]);
    try {
      const result = docsBranch({ kind: "feature", workspace_root: root });
      expect(result.action).toBe("keep");
      expect(result.branch).toBe("feature/current");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "docsBranch proposes create_from_develop on main",
  () => {
    const { root, remote } = repoWithDevelop();
    mkdirSync(path.join(root, "docs", "2026-08-04-gates"), { recursive: true });
    const plan = "docs/2026-08-04-gates/plan.md";
    writeFileSync(path.join(root, plan), "# Plan\n");
    try {
      const result = docsBranch({ plan_path: plan, workspace_root: root });
      expect(result.action).toBe("create_from_develop");
      expect(result.branch).toBe("feature/2026-08-04-gates");
      expect(result.current_branch).toBe("main");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "docs branch recognizes a custom configured base",
  () => {
    const { root, remote } = repoWithDevelop();
    const workspaces = path.join(isolatedConfig, "workit", "workspaces.json");
    const config = path.join(isolatedConfig, "workit", "config.json");
    try {
      git(root, ["checkout", "-q", "-b", "trunk"]);
      git(root, ["push", "-q", "-u", "origin", "trunk"]);
      mkdirSync(path.dirname(workspaces), { recursive: true });
      writeFileSync(
        workspaces,
        JSON.stringify({
          workspaces: [
            {
              name: "custom",
              glob: `${root}/**`,
              vcs: { provider: "github", defaultTargetBranch: "trunk" },
            },
          ],
        }),
      );
      writeFileSync(
        config,
        JSON.stringify({
          branchPolicy: { preset: "custom", allowed: ["trunk", "feature/*"], protected: ["main"] },
        }),
      );
      mkdirSync(path.join(root, "docs", "custom-base"), { recursive: true });
      writeFileSync(path.join(root, "docs/custom-base/plan.md"), "# Plan\n");

      const resolved = docsBranch({ plan_path: "docs/custom-base/plan.md", workspace_root: root });
      expect(resolved.action).toBe("create_from_base");
      expect(resolved.base).toBe("trunk");
      expect(resolved.branch).toBe("feature/custom-base");
    } finally {
      rmSync(workspaces, { force: true });
      rmSync(config, { force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "branch resolution honors use-current and bugfix slug/kind derivation",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wf-branch-derive-"));
    try {
      const run = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      run(["init", "-q", "-b", "develop"]);
      run(["config", "user.name", "T"]);
      run(["config", "user.email", "t@t"]);
      writeFileSync(path.join(dir, "r.md"), "x");
      run(["add", "r.md"]);
      run(["commit", "-q", "-m", "base"]);
      run(["branch", "feature/current"]);
      run(["branch", "feature/base"]);
      run(["checkout", "-q", "feature/base"]);

      mkdirSync(path.join(dir, "docs", "uc"), { recursive: true });
      mkdirSync(path.join(dir, "docs", "x"), { recursive: true });
      mkdirSync(path.join(dir, "docs", "fix-x"), { recursive: true });
      mkdirSync(path.join(dir, "docs", "g"), { recursive: true });
      mkdirSync(path.join(dir, "docs", "feat"), { recursive: true });
      writeFileSync(path.join(dir, "docs/uc/spec.md"), "# UC\n\n**Branch:** use-current\n");
      writeFileSync(
        path.join(dir, "docs/uc/plan.md"),
        "# UC\n\n**Spec:** `docs/uc/spec.md`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
      );
      const useCurrent = resolveBranch({
        spec_path: "docs/uc/spec.md",
        plan_path: "docs/uc/plan.md",
        workspace_root: dir,
      });
      expect("error" in useCurrent ? useCurrent.error : useCurrent.source).toBe("use-current");
      expect("error" in useCurrent ? useCurrent.error : useCurrent.branch).toBe("feature/base");

      run(["branch", "main"]);
      run(["checkout", "-q", "main"]);
      writeFileSync(
        path.join(dir, "docs/fix-x/plan.md"),
        "# Fix x\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
      );
      const fixSlug = resolveBranch({
        spec_path: "missing.md",
        plan_path: "docs/fix-x/plan.md",
        workspace_root: dir,
      });
      expect("error" in fixSlug ? fixSlug.error : fixSlug.branch).toBe("bugfix/fix-x");

      writeFileSync(
        path.join(dir, "docs/g/plan.md"),
        "# G\n\n**Goal:** bug fix without adding features\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
      );
      const goal = resolveBranch({
        spec_path: "missing.md",
        plan_path: "docs/g/plan.md",
        workspace_root: dir,
      });
      expect("error" in goal ? goal.error : goal.branch).toBe("bugfix/g");

      writeFileSync(
        path.join(dir, "docs/feat/plan.md"),
        "# F\n\n**Goal:** Add cool feature\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
      );
      const feat = resolveBranch({
        spec_path: "missing.md",
        plan_path: "docs/feat/plan.md",
        workspace_root: dir,
      });
      expect("error" in feat ? feat.error : feat.branch).toBe("feature/feat");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test("docsBranch reports keep and create_from_develop and HEAD errors", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-docs-branch-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    run(["init", "-q", "-b", "feature/current"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(path.join(dir, "r.md"), "x");
    run(["add", "r.md"]);
    run(["commit", "-q", "-m", "base"]);
    const kept = docsBranch({ kind: "feature", workspace_root: dir });
    expect(kept.action).toBe("keep");
    expect(kept.branch).toBe("feature/current");

    run(["checkout", "-q", "-b", "develop"]);
    mkdirSync(path.join(dir, "docs", "x"), { recursive: true });
    writeFileSync(path.join(dir, "docs/x/plan.md"), "# X\n");
    const created = docsBranch({
      plan_path: "docs/x/plan.md",
      kind: "bugfix",
      workspace_root: dir,
    });
    expect(created.action).toBe("create_from_develop");
    expect(created.branch).toBe("bugfix/x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CA-01: workspace branchPolicy overrides global config policy across consumers", async () => {
  const stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-ca01-bin-"));
  const logFile = path.join(stubBin, "glab-args.txt");
  stubCli(stubBin, "glab", logFile, "https://gitlab.com/o/r/-/merge_requests/1");
  const prevPath = process.env.PATH;
  const { root, remote } = repoWithDevelop();
  try {
    process.env.PATH = stubPath(stubBin);
    writeFileSync(
      path.join(isolatedConfig, "workit", "config.json"),
      JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
    );
    writeFileSync(
      path.join(isolatedConfig, "workit", "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            name: "w",
            glob: `${root}/**`,
            branchPolicy: { preset: "gitflow", integration: "merge" },
          },
        ],
      }),
    );
    writeFileSync(
      path.join(isolatedConfig, "workit", "vcs.json"),
      JSON.stringify({ provider: "gitlab", defaultTargetBranch: "develop" }),
    );
    writeFileSync(path.join(isolatedConfig, "workit", "gitlab.token"), "test-token\n");
    git(root, ["checkout", "-q", "-b", "feature/rel03"]);
    const pol = resolveBranchPolicyFor(root);
    expect(pol.preset).toBe("gitflow");
    expect(pol.integration).toBe("merge");
    expect(pol.protected).toContain("develop");
    const db = docsBranch({ plan_path: "docs/x/plan.md", workspace_root: root });
    expect(db.base).toBe("develop");
    const p = prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    expect(p.ok, JSON.stringify(p)).toBe(true);
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    rmSync(stubBin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test(
  "CA-01: unmatched repo falls back to global policy, then preset defaults",
  async () => {
    const { root, remote } = repoWithDevelop();
    try {
      writeFileSync(
        path.join(isolatedConfig, "workit", "config.json"),
        JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
      );
      writeFileSync(path.join(isolatedConfig, "workit", "workspaces.json"), '{"workspaces":[]}');
      git(root, ["checkout", "-q", "-b", "feature/x"]);
      expect(resolveBranchPolicyFor(root).preset).toBe("github-flow");
      rmSync(path.join(isolatedConfig, "workit", "config.json"), { force: true });
      expect(resolveBranchPolicyFor(root).preset).toBe("gitflow"); // PRESETS default
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "CA-05: defaultTargetBranch is preset-aware when unset",
  async () => {
    // vcs.defaultTargetBranch stays consistent when unset: github-flow -> main,
    // gitflow -> develop. Explicit workspace/global values still win (RL-03).
    const stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-ca05-bin-"));
    const ghLog = path.join(stubBin, "gh-args.txt");
    stubCli(stubBin, "gh", ghLog, "https://github.com/o/r/pull/1");
    const prevPath = process.env.PATH;
    const mainOnlyRepo = () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ca05-main-"));
      const remote = mkdtempSync(path.join(os.tmpdir(), "wf-ca05-main-remote-"));
      git(remote, ["init", "-q", "--bare"]);
      git(dir, ["init", "-q", "-b", "main"]);
      git(dir, ["config", "user.name", "Workflow Test"]);
      git(dir, ["config", "user.email", "workflow@example.test"]);
      writeFileSync(path.join(dir, "README.md"), "base\n");
      git(dir, ["add", "README.md"]);
      git(dir, ["commit", "-q", "-m", "base"]);
      git(dir, ["remote", "add", "origin", remote]);
      git(dir, ["push", "-q", "-u", "origin", "main"]);
      return { dir, remote };
    };
    try {
      process.env.PATH = stubPath(stubBin);
      const mainOnly = mainOnlyRepo();
      try {
        writeFileSync(
          path.join(isolatedConfig, "workit", "workspaces.json"),
          JSON.stringify({
            workspaces: [
              { name: "w", glob: `${mainOnly.dir}/**`, branchPolicy: { preset: "github-flow" } },
            ],
          }),
        );
        writeFileSync(
          path.join(isolatedConfig, "workit", "vcs.json"),
          JSON.stringify({ provider: "github" }),
        );
        writeFileSync(path.join(isolatedConfig, "workit", "github.token"), "test-token\n");
        mkdirSync(path.join(mainOnly.dir, "docs", "x"), { recursive: true });
        writeFileSync(path.join(mainOnly.dir, "docs/x/plan.md"), "# Plan\n");
        expect(vcsConfig("resolve", mainOnly.dir).defaultTargetBranch).toBe("main");
        const db = docsBranch({ plan_path: "docs/x/plan.md", workspace_root: mainOnly.dir });
        expect("error" in db).toBe(false);
        if (!("error" in db)) expect(db.base).toBe("main");
        const p = prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, mainOnly.dir);
        expect(p.ok, JSON.stringify(p)).toBe(true);
        expect(p.targetBranch).toBe("main");
      } finally {
        rmSync(mainOnly.dir, { recursive: true, force: true });
        rmSync(mainOnly.remote, { recursive: true, force: true });
      }
      const { root, remote } = repoWithDevelop();
      try {
        writeFileSync(
          path.join(isolatedConfig, "workit", "workspaces.json"),
          JSON.stringify({
            workspaces: [{ name: "w", glob: `${root}/**`, branchPolicy: { preset: "gitflow" } }],
          }),
        );
        writeFileSync(
          path.join(isolatedConfig, "workit", "vcs.json"),
          JSON.stringify({ provider: "github" }),
        );
        git(root, ["checkout", "-q", "-b", "feature/ca05"]);
        expect(vcsConfig("resolve", root).defaultTargetBranch).toBe("develop");
        const db2 = docsBranch({ plan_path: "docs/x/plan.md", workspace_root: root });
        expect("error" in db2).toBe(false);
        if (!("error" in db2)) expect(db2.base).toBe("develop");
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(remote, { recursive: true, force: true });
      }
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      rmSync(stubBin, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "CA-02: a matched workspace's branchPolicy default beats a global vcs defaultTargetBranch",
  async () => {
    // PR #43 regression: a global vcs.json defaultTargetBranch ("develop")
    // shadowed the personal github-flow workspace's policy-derived "main".
    // Spec'd order — workspace tier (explicit vcs default, then branchPolicy
    // default) > global vcs.json > preset — must hold; unmatched repos keep the
    // global vcs.json fallback.
    const githubFlow = repoWithDevelop();
    const gitflow = repoWithDevelop();
    const unmatched = repoWithDevelop();
    try {
      writeFileSync(
        path.join(isolatedConfig, "workit", "workspaces.json"),
        JSON.stringify({
          workspaces: [
            {
              name: "personal",
              glob: `${githubFlow.root}/**`,
              vcs: { provider: "github" },
              branchPolicy: { preset: "github-flow" },
            },
            {
              name: "work",
              glob: `${gitflow.root}/**`,
              vcs: { provider: "gitlab", defaultTargetBranch: "develop" },
              branchPolicy: { preset: "gitflow" },
            },
          ],
        }),
      );
      writeFileSync(
        path.join(isolatedConfig, "workit", "vcs.json"),
        JSON.stringify({ provider: "gitlab", defaultTargetBranch: "staging" }),
      );

      // the global "staging" must NOT shadow the github-flow policy default "main"
      expect(resolveWorkspace(githubFlow.root)?.name).toBe("personal");
      expect(resolveBranchPolicyFor(githubFlow.root).defaultTargetBranch).toBe("main");
      expect(vcsConfig("resolve", githubFlow.root).defaultTargetBranch).toBe("main");

      // explicit workspace vcs.defaultTargetBranch stays authoritative: develop,
      // not the genuinely-different global "staging"
      expect(resolveWorkspace(gitflow.root)?.name).toBe("work");
      expect(vcsConfig("resolve", gitflow.root).defaultTargetBranch).toBe("develop");

      // unmatched repo keeps the global vcs.json default as a fallback
      expect(resolveWorkspace(unmatched.root)).toBeNull();
      expect(vcsConfig("resolve", unmatched.root).defaultTargetBranch).toBe("staging");
    } finally {
      for (const r of [githubFlow, gitflow, unmatched]) {
        rmSync(r.root, { recursive: true, force: true });
        rmSync(r.remote, { recursive: true, force: true });
      }
    }
  },
  { timeout: 60_000 },
);

test(
  "explicit workspace vcs.defaultTargetBranch beats the workspace branchPolicy default",
  async () => {
    // A workspace declaring BOTH an explicit vcs.defaultTargetBranch and a
    // branchPolicy whose preset default differs must resolve the explicit value
    // — the tier that the CA-02 test leaves coincident (its work workspace's
    // explicit "develop" equals the gitflow preset default).
    const { root, remote } = repoWithDevelop();
    try {
      writeFileSync(
        path.join(isolatedConfig, "workit", "workspaces.json"),
        JSON.stringify({
          workspaces: [
            {
              name: "w",
              glob: `${root}/**`,
              vcs: { provider: "github", defaultTargetBranch: "release" },
              branchPolicy: { preset: "github-flow" },
            },
          ],
        }),
      );
      expect(vcsConfig("resolve", root).defaultTargetBranch).toBe("release");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "invalid branch policy is rejected by the runtime policy resolver",
  async () => {
    const { root, remote } = repoWithDevelop();
    try {
      writeFileSync(
        path.join(isolatedConfig, "workit", "config.json"),
        JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
      );
      writeFileSync(
        path.join(isolatedConfig, "workit", "workspaces.json"),
        JSON.stringify({
          workspaces: [{ name: "w", glob: `${root}/**`, branchPolicy: { preset: "gitflo" } }],
        }),
      );
      expect(() => resolveBranchPolicyFor(root)).toThrow(
        /invalid branch policy configuration.*unsupported branch preset/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "RL-03b: provider reconciles with the actual origin remote across PR surfaces",
  async () => {
    // A stale config provider (gitlab) must not drive glab on a github.com-hosted
    // repo: vcsConfig load/resolve and prCreate derive the provider from the
    // origin remote when no explicit workspace vcs.provider overrides it.
    const stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-remote-bin-"));
    const ghLog = path.join(stubBin, "gh-args.txt");
    const glabLog = path.join(stubBin, "glab-args.txt");
    stubCli(stubBin, "gh", ghLog, "https://github.com/acme/workit/pull/1");
    stubCli(stubBin, "glab", glabLog, "https://gitlab.com/acme/workit/-/merge_requests/1");
    const cfgDir = mkdtempSync(path.join(os.tmpdir(), "wf-remote-cfg-"));
    const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
    const prevPath = process.env.PATH;
    const prevSshCommand = process.env.GIT_SSH_COMMAND;
    const prevBareRemote = process.env.WORKIT_TEST_BARE_REMOTE;
    const sshShim = path.join(stubBin, "ssh-push.cjs");
    writeFileSync(
      sshShim,
      `const { spawn } = require("node:child_process");
const service = process.argv.some((arg) => arg.includes("upload-pack")) ? "upload-pack" : "receive-pack";
const server = spawn("git", [service, process.env.WORKIT_TEST_BARE_REMOTE], { stdio: "inherit" });
server.on("error", () => process.exit(1));
server.on("exit", (code) => process.exit(code ?? 1));
`,
    );
    const shellPath = (value: string) => value.replaceAll("\\", "/");
    process.env.GIT_SSH_COMMAND = `"${shellPath(process.execPath)}" "${shellPath(sshShim)}"`;
    writeFileSync(
      path.join(stubBin, "ssh"),
      '#!/bin/sh\ncase "$2" in workit-github-host.invalid) echo "hostname github.com";; workit-gitlab-host.invalid) echo "hostname gitlab.com";; *) echo "hostname $2";; esac\n',
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(stubBin, "ssh.cmd"),
      '@echo off\r\nif "%2"=="workit-github-host.invalid" (echo hostname github.com & exit /b 0)\r\nif "%2"=="workit-gitlab-host.invalid" (echo hostname gitlab.com & exit /b 0)\r\necho hostname %2\r\n',
    );
    const writeCfg = (provider: string) => {
      // pushBranch: false — each source branch is pre-published to a local bare
      // remote, while PR/MR provider routing remains bound to the fetch origin.
      writeFileSync(
        path.join(cfgDir, "vcs.json"),
        JSON.stringify({ provider, defaultTargetBranch: "main", pr: { pushBranch: false } }),
      );
      writeFileSync(path.join(cfgDir, "gitlab.token"), "gitlab-token\n", { mode: 0o600 });
      writeFileSync(path.join(cfgDir, "github.token"), "github-token\n", { mode: 0o600 });
    };
    const repoWithRemote = (url: string) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "wf-remote-repo-"));
      const remote = mkdtempSync(path.join(os.tmpdir(), "wf-remote-bare-"));
      git(remote, ["init", "-q", "--bare"]);
      const run = (args: string[]) =>
        spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env } });
      run(["init", "-q", "-b", "feature/t"]);
      run(["config", "user.name", "T"]);
      run(["config", "user.email", "t@t"]);
      writeFileSync(path.join(root, "r.md"), "x");
      run(["add", "r.md"]);
      run(["commit", "-q", "-m", "base"]);
      run(["remote", "add", "origin", url]);
      const host = new URL(url).hostname;
      const sshHost =
        host === "github.com" ? "workit-github-host.invalid" : "workit-gitlab-host.invalid";
      run(["remote", "set-url", "--push", "origin", `git@${sshHost}:acme/workit.git`]);
      process.env.WORKIT_TEST_BARE_REMOTE = remote;
      const pushed = run(["push", "-q", "-u", "origin", "feature/t"]);
      if (pushed.status !== 0) throw new Error(`fixture push failed: ${pushed.stderr}`);
      return { root, remote };
    };
    try {
      process.env.WORKFLOW_TOOLKIT_CONFIG = cfgDir;
      process.env.PATH = stubPath(stubBin);
      const { root: ghRoot, remote: ghRemote } = repoWithRemote(
        "https://github.com/acme/workit.git",
      );
      try {
        writeCfg("gitlab");
        expect(vcsConfig("resolve", ghRoot).provider).toBe("github");
        const loaded = vcsConfig("load", ghRoot);
        expect(loaded.provider).toBe("github");
        expect(loaded.tokenPath).toBeUndefined();
        const p = prCreate(
          { WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_BODY: "", WF_PR_DRAFT: "false" },
          ghRoot,
        );
        expect(p.ok, JSON.stringify(p)).toBe(true);
        expect(p.provider).toBe("github");
        expect(existsSync(glabLog)).toBe(false);
        expect(readFileSync(ghLog, "utf8")).toContain("pr create");
      } finally {
        rmSync(ghRoot, { recursive: true, force: true });
        rmSync(ghRemote, { recursive: true, force: true });
      }
      rmSync(glabLog, { force: true });
      rmSync(ghLog, { force: true });
      const { root: glRoot, remote: glRemote } = repoWithRemote(
        "https://gitlab.com/acme/workit.git",
      );
      try {
        writeCfg("github");
        expect(vcsConfig("resolve", glRoot).provider).toBe("gitlab");
        const p = prCreate(
          { WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_BODY: "", WF_PR_DRAFT: "false" },
          glRoot,
        );
        expect(p.ok, JSON.stringify(p)).toBe(true);
        expect(p.provider).toBe("gitlab");
        expect(existsSync(ghLog)).toBe(false);
        expect(readFileSync(glabLog, "utf8")).toContain("mr create");
      } finally {
        rmSync(glRoot, { recursive: true, force: true });
        rmSync(glRemote, { recursive: true, force: true });
      }
    } finally {
      if (prevConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      else process.env.WORKFLOW_TOOLKIT_CONFIG = prevConfig;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = prevSshCommand;
      if (prevBareRemote === undefined) delete process.env.WORKIT_TEST_BARE_REMOTE;
      else process.env.WORKIT_TEST_BARE_REMOTE = prevBareRemote;
      rmSync(stubBin, { recursive: true, force: true });
      rmSync(cfgDir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test("RL-01: malformed config.json throws the exact-path error from policy-aware resolve", () => {
  // The now-policy-aware vcs resolve and resolveBranchPolicyFor both call
  // readConfig(), which throws on malformed config.json instead of silently
  // falling back to defaults — the diagnostic carries the exact file path.
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-malformed-cfg-repo-"));
  const cfg = mkdtempSync(path.join(os.tmpdir(), "wf-malformed-cfg-"));
  const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(path.join(root, "r.md"), "x");
    run(["add", "r.md"]);
    run(["commit", "-q", "-m", "base"]);
    writeFileSync(path.join(cfg, "config.json"), "{ not json\n", "utf8");
    process.env.WORKFLOW_TOOLKIT_CONFIG = cfg;
    expect(() => vcsConfig("resolve", root)).toThrow(/is not valid JSON/);
    expect(() => resolveBranchPolicyFor(root)).toThrow(/is not valid JSON/);
  } finally {
    if (prevConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prevConfig;
    rmSync(root, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test(
  "branch policy rejects codex/ under gitflow and allows under custom",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wf-branch-policy-"));
    const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
    try {
      process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
      delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      const repo = mkdtempSync(path.join(os.tmpdir(), "wf-branch-policy-repo-"));
      try {
        const run = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
        run(["init", "-q", "-b", "develop"]);
        run(["config", "user.name", "T"]);
        run(["config", "user.email", "t@t"]);
        writeFileSync(path.join(repo, "r.md"), "x");
        run(["add", "r.md"]);
        run(["commit", "-q", "-m", "base"]);
        run(["checkout", "-q", "-b", "main"]);
        mkdirSync(path.join(repo, "docs", "codex-feat"), { recursive: true });
        writeFileSync(
          path.join(repo, "docs/codex-feat/spec.md"),
          "# S\n\n**Branch:** `codex/feature/x`\n",
        );
        writeFileSync(
          path.join(repo, "docs/codex-feat/plan.md"),
          "# P\n\n**Spec:** `docs/codex-feat/spec.md`\n**Branch:** `codex/feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
        );

        const gitflowRes = resolveBranch({
          spec_path: "docs/codex-feat/spec.md",
          plan_path: "docs/codex-feat/plan.md",
          workspace_root: repo,
        });
        expect("error" in gitflowRes).toBe(true);

        writeConfig({
          locale: "en",
          localeOptions: ["en"],
          timezone: "UTC",
          branchPolicy: { preset: "custom", allowed: ["codex/*"], protected: ["main"] },
          commitPolicy: { preset: "conventional" },
        });
        const customRes = resolveBranch({
          spec_path: "docs/codex-feat/spec.md",
          plan_path: "docs/codex-feat/plan.md",
          workspace_root: repo,
        });
        expect("error" in customRes).toBe(false);
        if (!("error" in customRes)) expect(customRes.branch).toBe("codex/feature/x");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    } finally {
      delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
      if (prevConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      else process.env.WORKFLOW_TOOLKIT_CONFIG = prevConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);
