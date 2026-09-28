import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRepoTools } from "@/packages/workit-opencode/src/tools/repo";
import {
  hostingApiHostMatches,
  mergePr,
  prBuildBody,
  prCreate,
  pushRemoteIdentity,
  pushTargetIsStable,
  safePushUrl,
} from "@/packages/workit-core/src/core/pr-create";
import { stubCli, stubPath as stubPathWith } from "@/test/shared/helpers/stub-cli";

// WF_PR_TARGET is chosen by the caller; the provider decides whether it accepts it.

const git = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env } });

const ENV_KEYS = [
  "WORKFLOW_TOOLKIT_CONFIG",
  "WORKFLOW_TOOLKIT_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "WORKFLOW_VCS_CONFIG",
  "WORKFLOW_WORKSPACE_ROOT",
  "WORKFLOW_YT_ISSUE",
  "WORKFLOW_GH_ISSUE",
  "WORKFLOW_GH_ISSUE_RELATION",
  "PATH",
];

const withEnv = <T>(overrides: Record<string, string | undefined>, fn: () => T): T => {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

let cfgDir: string;
let root: string;
let stubBin: string;
let logFile: string;
let bareRemote: string;
let previousSshCommand: string | undefined;
let previousBareRemote: string | undefined;

beforeEach(() => {
  cfgDir = mkdtempSync(path.join(os.tmpdir(), "wf-pr-create-cfg-"));
  root = mkdtempSync(path.join(os.tmpdir(), "wf-pr-create-repo-"));
  stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-pr-create-bin-"));
  logFile = path.join(stubBin, "gh-args.txt");
  bareRemote = mkdtempSync(path.join(os.tmpdir(), "wf-pr-create-remote-"));
  git(bareRemote, ["init", "-q", "--bare"]);
  previousSshCommand = process.env.GIT_SSH_COMMAND;
  previousBareRemote = process.env.WF_PR_TEST_BARE_REMOTE;
  const sshShim = path.join(stubBin, "ssh-push.cjs");
  writeFileSync(
    sshShim,
    `const { spawn } = require("node:child_process");
const service = process.argv.some((arg) => arg.includes("upload-pack")) ? "upload-pack" : "receive-pack";
const server = spawn("git", [service, process.env.WF_PR_TEST_BARE_REMOTE], { stdio: "inherit" });
server.on("error", () => process.exit(1));
server.on("exit", (code) => process.exit(code ?? 1));
`,
  );
  const shellPath = (value: string) => value.replaceAll("\\", "/");
  process.env.GIT_SSH_COMMAND = `"${shellPath(process.execPath)}" "${shellPath(sshShim)}"`;
  process.env.WF_PR_TEST_BARE_REMOTE = bareRemote;
  writeFileSync(path.join(stubBin, "ssh"), '#!/bin/sh\necho "hostname $2"\n', { mode: 0o755 });
  writeFileSync(path.join(stubBin, "ssh.cmd"), "@echo off\r\necho hostname %2\r\n");
  stubCli(stubBin, "gh", logFile, "https://github.com/o/r/pull/1");
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(stubBin, { recursive: true, force: true });
  rmSync(bareRemote, { recursive: true, force: true });
  if (previousSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
  else process.env.GIT_SSH_COMMAND = previousSshCommand;
  if (previousBareRemote === undefined) delete process.env.WF_PR_TEST_BARE_REMOTE;
  else process.env.WF_PR_TEST_BARE_REMOTE = previousBareRemote;
});

// Stub gh/glab are prepended to PATH so they win; the rest of PATH (including
// git) stays intact for the wrapper's branch lookups.
const stubPath = (): string => stubPathWith(stubBin);

test("push URL approval identity preserves SSH user and port while stripping HTTPS secrets", () => {
  expect(pushRemoteIdentity("ssh://git@github-work.com:2222/org/repo.git")).toBe(
    "ssh://git@github-work.com:2222/org/repo.git",
  );
  expect(safePushUrl("ssh://git@github-work.com:2222/org/repo.git")).toBe(
    "ssh://git@github-work.com:2222/org/repo.git",
  );
  expect(pushRemoteIdentity("https://token:secret@example.test:8443/org/repo.git")).toBe(
    "https://example.test:8443/org/repo.git",
  );
  expect(safePushUrl("https://token:secret@example.test:8443/org/repo.git")).toBe(
    "https://example.test:8443/org/repo.git",
  );
});

test("push URL approval identity and execution URL strip query credentials", () => {
  const remote = "https://example.test/org/repo.git?access_token=secret#fragment";
  expect(pushRemoteIdentity(remote)).toBe("https://example.test/org/repo.git");
  expect(safePushUrl(remote)).toBe("https://example.test/org/repo.git");
});

test("hosting API host must match the remote or its resolved SSH alias", () => {
  expect(hostingApiHostMatches("https://github.com/org/repo.git", "github.com")).toBe(true);
  expect(hostingApiHostMatches("https://github.com/org/repo.git", "gitlab.com")).toBe(false);
  expect(hostingApiHostMatches("https://github.com:8443/org/repo.git", "github.com")).toBe(false);
  expect(hostingApiHostMatches("https://github.com:8443/org/repo.git", "github.com:8443")).toBe(
    true,
  );
  expect(
    hostingApiHostMatches("git@github.com:org/repo.git", "github.com", () => ({
      host: "evil.test",
      port: "22",
    })),
  ).toBe(false);
  expect(
    hostingApiHostMatches("git@github.com:org/repo.git", "github.com", () => ({
      host: "ssh.github.com",
      port: "443",
    })),
  ).toBe(true);
  expect(
    hostingApiHostMatches("git@github-work:org/repo.git", "github.com", () => ({
      host: "github.com",
      port: "22",
    })),
  ).toBe(true);
  expect(
    hostingApiHostMatches("git@github-work:org/repo.git", "github.com", () => ({
      host: "other.example",
      port: "22",
    })),
  ).toBe(false);
  expect(hostingApiHostMatches("git@github-work:org/repo.git", "github.com", () => null)).toBe(
    false,
  );
  expect(
    hostingApiHostMatches("ssh://git@github.com:2222/org/repo.git", "github.com", () => ({
      host: "github.com",
      port: "2222",
    })),
  ).toBe(false);
  expect(
    hostingApiHostMatches("ssh://git@github.com:2222/org/repo.git", "github.com:2222", () => ({
      host: "github.com",
      port: "2222",
    })),
  ).toBe(true);
  expect(
    hostingApiHostMatches("ssh://git@ssh.github.com:443/org/repo.git", "github.com", () => ({
      host: "ssh.github.com",
      port: "443",
    })),
  ).toBe(true);
});

test("an explicitly pinned push URL is rejected if Git would rewrite its destination", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-push-rewrite-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["remote", "add", "origin", "https://github.com/org/repo.git"]);
    expect(pushTargetIsStable(root, "https://github.com/org/repo.git")).toBe(true);
    git(root, ["config", "url.https://mirror.example/org/.insteadOf", "https://github.com/org/"]);
    expect(pushTargetIsStable(root, "https://github.com/org/repo.git")).toBe(false);
    expect(pushTargetIsStable(root, "https://gitlab.com/org/repo.git")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const setupRepo = () => {
  git(root, ["init", "-q", "-b", "develop"]);
  git(root, ["config", "user.name", "Workflow Test"]);
  git(root, ["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "base"]);
};

// push-before-create (Task 2) needs a real pushable origin: a bare remote that
// already carries develop, so `git push -u origin <feature>` succeeds.
const setupRepoWithOrigin = () => {
  setupRepo();
  git(root, ["remote", "add", "origin", "git@workit-github-host.invalid:o/r.git"]);
  const pushed = git(root, ["push", "-q", "-u", "origin", "develop"]);
  if (pushed.status !== 0)
    throw new Error(`fixture push failed: ${pushed.stderr}; ssh=${process.env.GIT_SSH_COMMAND}`);
};

const writeConfig = (
  branchPolicy: Record<string, unknown>,
  defaultTargetBranch: string,
  pr?: Record<string, unknown>,
  provider: "github" | "gitlab" = "github",
) => {
  const remote = git(root, ["remote", "get-url", "--push", "origin"]);
  let host = provider === "github" ? "github.com" : "gitlab.com";
  if (remote.status === 0) {
    try {
      host = new URL(remote.stdout.trim()).hostname || host;
    } catch {
      const scp = /^(?:[^@\s]+@)?([^:]+):/u.exec(remote.stdout.trim());
      if (scp) host = scp[1].toLowerCase();
    }
  }
  writeFileSync(
    path.join(cfgDir, "config.json"),
    JSON.stringify({ branchPolicy }, null, 2),
    "utf8",
  );
  writeFileSync(
    path.join(cfgDir, "vcs.json"),
    JSON.stringify({
      provider,
      defaultTargetBranch,
      github: { host: provider === "github" ? host : "github.com" },
      gitlab: {
        host: provider === "gitlab" ? host : "gitlab.com",
        apiUrl: `https://${provider === "gitlab" ? host : "gitlab.com"}/api/v4`,
      },
      ...(pr ? { pr } : {}),
    }),
    "utf8",
  );
  writeFileSync(
    path.join(cfgDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "t",
          glob: `${root}/**`,
          vcs: { provider },
          issues: { provider, link_on_pr: true },
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(path.join(cfgDir, `${provider}.token`), "test-token\n", "utf8");
};

const customPolicy = {
  preset: "custom",
  allowed: ["main", "trunk", "feature/*"],
  protected: ["develop"],
};

test("merge binds an open request to its target and exact source SHA on both hosts", () => {
  setupRepo();
  const source = "feature/merge-target";
  git(root, ["checkout", "-q", "-b", source]);
  const sha = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const reply = path.join(stubBin, "merge-requests.json");
  const retargetReply = path.join(stubBin, "merge-requests-retargeted.json");
  const apiCount = path.join(stubBin, "merge-api-count");
  const mergeLog = path.join(stubBin, "merge.log");
  const writeCli = (name: string) => {
    writeFileSync(
      path.join(stubBin, name),
      `#!/bin/sh\nif [ "$1" = api ] && [ "$2" = user ]; then echo '{"login":"stub","username":"stub"}'; exit 0; fi\nif [ "$1" = api ]; then count=0; [ -f "${apiCount}" ] && count=$(cat "${apiCount}"); count=$((count + 1)); echo "$count" > "${apiCount}"; if [ "$count" -gt 1 ] && [ -f "${retargetReply}" ]; then cat "${retargetReply}"; else cat "${reply}"; fi; exit 0; fi\nprintf '%s\\n' "$*" >> "${mergeLog}"\nexit 0\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(stubBin, `${name}.cmd`),
      `@echo off\r\nif "%1 %2"=="api user" (echo {"login":"stub","username":"stub"} & exit /b 0)\r\nif "%1"=="api" goto api\r\n>>"${mergeLog}" echo %*\r\nexit /b 0\r\n:api\r\nset count=0\r\nif exist "${apiCount}" set /p count=<"${apiCount}"\r\nset /a count=count+1\r\necho %count%>"${apiCount}"\r\nif %count% GTR 1 if exist "${retargetReply}" goto retarget\r\ntype "${reply}"\r\nexit /b 0\r\n:retarget\r\ntype "${retargetReply}"\r\nexit /b 0\r\n`,
    );
  };
  writeCli("gh");
  writeCli("glab");
  writeFileSync(mergeLog, "");
  const cases = [
    {
      provider: "github" as const,
      remote: "https://github.com/o/r.git",
      host: "github.com",
      record: (target: string, sourceSha: string) => ({
        number: 42,
        state: "open",
        base: { ref: target },
        head: { ref: source, sha: sourceSha },
      }),
      mergeArgs: /pr merge 42 .*--match-head-commit/,
    },
    {
      provider: "gitlab" as const,
      remote: "https://gitlab.com/group/sub/r.git",
      host: "gitlab.com",
      record: (target: string, sourceSha: string) => ({
        iid: 7,
        state: "opened",
        target_branch: target,
        source_branch: source,
        sha: sourceSha,
      }),
      mergeArgs: /mr merge 7 .*--sha/,
    },
  ];
  for (const entry of cases) {
    writeFileSync(mergeLog, "");
    git(root, ["remote", "remove", "origin"]);
    git(root, ["remote", "add", "origin", entry.remote]);
    const invoke = () =>
      mergePr(root, {
        target: "develop",
        source,
        sourceCommit: sha,
        remote: pushRemoteIdentity(entry.remote)!,
        account: "stub",
        apiHost: entry.host,
      });
    withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "develop", undefined, entry.provider);
      writeFileSync(apiCount, "0");
      writeFileSync(reply, JSON.stringify([entry.record("main", sha)]));
      expect(invoke().error).toContain("exact approved merge request");
      expect(readFileSync(mergeLog, "utf8")).toBe("");
      writeFileSync(apiCount, "0");
      writeFileSync(reply, JSON.stringify([entry.record("develop", "f".repeat(40))]));
      expect(invoke().error).toContain("exact approved merge request");
      expect(readFileSync(mergeLog, "utf8")).toBe("");
      writeFileSync(apiCount, "0");
      writeFileSync(reply, JSON.stringify([entry.record("develop", sha)]));
      expect(invoke().ok).toBe(true);
      expect(readFileSync(mergeLog, "utf8")).toMatch(entry.mergeArgs);
      expect(readFileSync(mergeLog, "utf8")).toContain(sha);
      writeFileSync(mergeLog, "");
      writeFileSync(apiCount, "0");
      writeFileSync(reply, JSON.stringify([entry.record("develop", sha)]));
      writeFileSync(retargetReply, JSON.stringify([entry.record("release", sha)]));
      expect(invoke().error ?? "").toContain("changed before merge");
      expect(readFileSync(mergeLog, "utf8")).toBe("");
      rmSync(retargetReply, { force: true });
    });
  }
});

test(
  "B1: caller-supplied WF_PR_TARGET is validated against the branch policy",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/b1"]);
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk");
      const remote = git(root, ["remote", "get-url", "--push", "origin"]).stdout.trim();
      expect(remote).toBe("git@workit-github-host.invalid:o/r.git");
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: "main" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    expect(result.targetBranch).toBe("main");
    expect(readFileSync(logFile, "utf8")).toContain("--base main");
  },
  { timeout: 60_000 },
);

test(
  "B1: caller-selected PR targets are passed to the hosting CLI",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/b1"]);
    const run = (target: string) =>
      withEnv(
        {
          WORKFLOW_TOOLKIT_CONFIG: cfgDir,
          PATH: stubPath(),
        },
        () => {
          writeConfig(customPolicy, "trunk");
          return prCreate(
            { WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: target },
            root,
          );
        },
      );
    const protectedTarget = run("develop");
    expect(protectedTarget.ok).toBe(true);
    expect(protectedTarget.targetBranch).toBe("develop");
    const disallowed = run("random/x");
    expect(disallowed.ok).toBe(true);
    expect(disallowed.targetBranch).toBe("random/x");
  },
  { timeout: 60_000 },
);

test(
  "B1: no override still flows the configured default target (unvalidated)",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/b1"]);
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk");
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    expect(result.targetBranch).toBe("trunk");
  },
  { timeout: 60_000 },
);

test("prCreate refuses ambiguous origin push destinations", () => {
  setupRepoWithOrigin();
  git(root, ["checkout", "-q", "-b", "feature/multi-push-url"]);
  git(root, ["remote", "set-url", "--add", "--push", "origin", "https://github.com/o/r.git"]);
  git(root, ["remote", "set-url", "--add", "--push", "origin", "https://mirror.example/o/r.git"]);
  const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
    writeConfig({ preset: "gitflow" }, "develop");
    return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
  });
  expect(result.error).toContain("one supported push URL");
});

// CA-06: a caller-supplied WF_PR_TARGET equal to the resolved workspace default
// (main under github-flow, develop under gitflow) is authoritative — the same
// value flows unvalidated from config, so an explicit equal value must not be
// rejected as a protected override.

const setupMainRepo = () => {
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Workflow Test"]);
  git(root, ["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["remote", "add", "origin", "git@workit-github-host.invalid:o/r.git"]);
  git(root, ["push", "-q", "-u", "origin", "main"]);
};

test(
  "CA-06: default-equal WF_PR_TARGET is accepted under github-flow (main)",
  () => {
    setupMainRepo();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig({ preset: "github-flow" }, "main");
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: "main" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    expect(result.targetBranch).toBe("main");
    expect(readFileSync(logFile, "utf8")).toContain("--base main");
  },
  { timeout: 60_000 },
);

test(
  "CA-06: default-equal WF_PR_TARGET is accepted under gitflow (develop)",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig({ preset: "gitflow" }, "develop");
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: "develop" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    expect(result.targetBranch).toBe("develop");
    expect(readFileSync(logFile, "utf8")).toContain("--base develop");
  },
  { timeout: 60_000 },
);

test(
  "CA-06: non-default targets are passed to the provider",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    const run = (target: string) =>
      withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
        writeConfig({ preset: "gitflow" }, "develop");
        return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: target }, root);
      });
    const protectedTarget = run("main");
    expect(protectedTarget.ok).toBe(true);
    expect(protectedTarget.targetBranch).toBe("main");
    const disallowed = run("random/x");
    expect(disallowed.ok).toBe(true);
    expect(disallowed.targetBranch).toBe("random/x");
  },
  { timeout: 60_000 },
);

const withWrapperConfig = <T>(fn: () => Promise<T>): Promise<T> => {
  const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const previousPath = process.env.PATH;
  process.env.WORKFLOW_TOOLKIT_CONFIG = cfgDir;
  process.env.PATH = stubPath();
  return fn().finally(() => {
    if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
};

test(
  "CA-06: OpenCode wrapper resolves a valid target for the shared action path",
  async () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    const raw = await withWrapperConfig(() => {
      writeConfig({ preset: "gitflow" }, "develop");
      return createRepoTools().workit_pr_create.execute(
        { confirmed: true, title: "T", target_branch: "develop" },
        { directory: root, worktree: root } as never,
      );
    });
    // Decision ae03c569: the legacy wrapper resolves through the shared
    // contract and delegates; it never performs a raw provider create.
    const result = JSON.parse(raw as string);
    expect(result).toMatchObject({
      ok: false,
      code: "needs_input",
      details: { operation: "hosting.pull_request" },
    });
    expect(result.details.proposal.presented).toContain("to `develop`");
    expect(result.details.guidance).toContain("workit_external_action");
    expect(existsSync(logFile)).toBe(false);
  },
  { timeout: 60_000 },
);

test(
  "CA-06: OpenCode wrapper resolves the chosen target without contacting a provider",
  async () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    const raw = await withWrapperConfig(() => {
      writeConfig({ preset: "gitflow" }, "develop");
      return createRepoTools().workit_pr_create.execute(
        { confirmed: true, title: "T", target_branch: "main" },
        { directory: root, worktree: root } as never,
      );
    });
    const result = JSON.parse(raw as string);
    expect(result).toMatchObject({ ok: false, code: "needs_input" });
    expect(result.details.proposal.presented).toContain("to `main`");
    expect(existsSync(logFile)).toBe(false);
  },
  { timeout: 60_000 },
);

// The legacy CLI port must never perform a hosted create itself: it returns
// the same needs_input shape as the headless `workit action` route.

const cliPortPath = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "workit-core",
  "src",
  "core",
  "ports",
  "pr-create.ts",
);

const runCliPort = (target: string) =>
  withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
    const spawned = spawnSync(process.execPath, [cliPortPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        WORKFLOW_TOOLKIT_CONFIG: cfgDir,
        PATH: stubPath(),
        WF_PR_CONFIRMED: "true",
        WF_PR_TITLE: "T",
        WF_PR_TARGET: target,
      },
    });
    return { status: spawned.status, stdout: (spawned.stdout ?? "").trim() };
  });

test(
  "legacy CLI port returns needs_input for default and non-default targets",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    writeConfig({ preset: "gitflow" }, "develop");
    for (const target of ["develop", "main"]) {
      const result = runCliPort(target);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ ok: false, code: "needs_input" });
      expect(parsed.details.operation).toBe("hosting.pull_request");
      expect(parsed.details.guidance).toContain("workit action hosting.pull_request");
    }
    expect(existsSync(logFile)).toBe(false);
  },
  { timeout: 60_000 },
);

test(
  "B2: day-first date segments never derive a numeric issue id",
  () => {
    // the year-first cases are covered in workspaces-scripts.test.ts; these are
    // the day-first cases the advisory called out (15-01-2024 -> not Closes #15).
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/15-01-2024/fix" })).toBe("");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "15-01-2024/fix" })).toBe("");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/15-01-2024" })).toBe("");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/1-2-2024/foo" })).toBe("");
    // deliberate numeric issue branches still link
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/42-title" })).toBe("Closes #42");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/2024-fix" })).toBe("Closes #2024");
  },
  { timeout: 60_000 },
);

test(
  "AR-08: complete dates anywhere in a segment never close an issue",
  () => {
    // Task 22 advisory: date rejection was year-first only; an embedded year-first
    // or day-first date (release-2024-01-15, v2-2024-01-15-fix) still derived a
    // year/day id. Complete dates must be rejected anywhere in a segment.
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "release-2024-01-15" })).toBe("");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "v2-2024-01-15-fix" })).toBe("");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "release-2024-01-15/fix" })).toBe("");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "fix-2024-01-15" })).toBe("");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "fix-15-01-2024" })).toBe("");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/fix-15-01-2024" })).toBe("");
    // deliberate numeric issue branches still link
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/42-title" })).toBe("Closes #42");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/2024-fix" })).toBe("Closes #2024");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "release/2024-fix" })).toBe("Closes #2024");
  },
  { timeout: 60_000 },
);

test(
  "CA-04: merge integration finishes the feature into the target without a PR",
  () => {
    // bare origin remote, like branch-policy.test.ts's repoWithDevelop
    const remote = mkdtempSync(path.join(os.tmpdir(), "wf-merge-remote-"));
    try {
      git(remote, ["init", "-q", "--bare"]);
      setupRepo();
      git(root, ["remote", "add", "origin", remote]);
      git(root, ["push", "-q", "-u", "origin", "develop"]);
      git(root, ["branch", "main"]);
      git(root, ["checkout", "-q", "main"]);
      git(root, ["checkout", "-q", "-b", "feature/merge-mode"]);
      // the brief's literal test omitted a feature commit; without one develop is
      // up to date and --no-ff merges nothing, so the "T" commit never appears.
      writeFileSync(path.join(root, "feature.md"), "work\n");
      git(root, ["add", "feature.md"]);
      git(root, ["commit", "-q", "-m", "feature work"]);
      git(root, ["push", "-q", "-u", "origin", "feature/merge-mode"]);
      writeFileSync(
        path.join(cfgDir, "config.json"),
        JSON.stringify({ branchPolicy: { preset: "gitflow" } }, null, 2),
        "utf8",
      );
      writeFileSync(
        path.join(cfgDir, "vcs.json"),
        JSON.stringify({ provider: "github", defaultTargetBranch: "develop" }),
        "utf8",
      );
      writeFileSync(
        path.join(cfgDir, "workspaces.json"),
        JSON.stringify({
          workspaces: [
            {
              name: "t",
              glob: `${root}/**`,
              branchPolicy: { preset: "gitflow", integration: "merge" },
            },
          ],
        }),
        "utf8",
      );
      // no token written on purpose: merge mode is local git merge + push and must
      // work tokenless (SSH-push users have no glab/gh API token).
      const p = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () =>
        prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_BODY: "" }, root),
      );
      expect(p.ok, JSON.stringify(p)).toBe(true);
      expect(p.mode).toBe("merge");
      expect(p.targetBranch).toBe("develop");
      expect(p.merged).toBe(true);
      expect(p.pushed).toBe(true);
      const log = git(root, ["log", "--oneline", "-1", "develop"]).stdout;
      expect(log).toContain("T");
      const remoteLog = spawnSync(
        "git",
        ["--git-dir", remote, "log", "--oneline", "-1", "refs/heads/develop"],
        { encoding: "utf8" },
      ).stdout;
      expect(remoteLog).toContain("T");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "B6: OpenCode wrapper delegates hosted creation without inspecting issue-linking environment",
  async () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/b6"]);
    const previous = process.env.WORKFLOW_GH_ISSUE;
    const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
    const previousPath = process.env.PATH;
    process.env.WORKFLOW_TOOLKIT_CONFIG = cfgDir;
    process.env.WORKFLOW_GH_ISSUE = "42";
    process.env.PATH = stubPath();
    try {
      writeConfig(
        { preset: "gitflow", allowed: ["feature/*", "bugfix/*"], protected: ["main", "develop"] },
        "develop",
      );
      const raw = await createRepoTools().workit_pr_create.execute(
        { confirmed: true, title: "T" },
        {
          directory: root,
          worktree: root,
        } as never,
      );
      const result = JSON.parse(raw as string);
      expect(result).toMatchObject({
        ok: false,
        code: "needs_input",
        details: { operation: "hosting.pull_request" },
      });
      expect(JSON.stringify(result)).not.toContain("#42");
      expect(existsSync(logFile)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.WORKFLOW_GH_ISSUE;
      else process.env.WORKFLOW_GH_ISSUE = previous;
      if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
  { timeout: 60_000 },
);

// Task 2 — GitHub push-before-create honoring pr.pushBranch.

const branchOn = () => {
  git(root, ["checkout", "-q", "-b", "feature/t2"]);
  writeFileSync(path.join(root, "feature.txt"), "work\n");
  git(root, ["add", "feature.txt"]);
  git(root, ["commit", "-q", "-m", "feature work"]);
};

test(
  "T2: github pushBranch enabled pushes the branch before gh pr create",
  () => {
    setupRepoWithOrigin();
    branchOn();
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk", { pushBranch: true });
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    // the branch reached origin before gh ran (git push -u created it)
    expect(
      git(root, ["ls-remote", `file://${bareRemote}`, "refs/heads/feature/t2"]).stdout,
    ).toContain("feature/t2");
    expect(readFileSync(logFile, "utf8")).toContain("pr create");
  },
  { timeout: 60_000 },
);

test(
  "T2: github pushBranch false only creates from the already-published exact branch",
  () => {
    setupRepoWithOrigin();
    branchOn();
    git(root, ["push", "-q", "-u", "origin", "feature/t2"]);
    const remoteTip = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(path.join(bareRemote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk", { pushBranch: false });
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    expect(
      git(root, ["ls-remote", `file://${bareRemote}`, "refs/heads/feature/t2"]).stdout,
    ).toContain(remoteTip);
    expect(readFileSync(logFile, "utf8")).toContain("pr create");
  },
  { timeout: 60_000 },
);

test(
  "T2: github push failure returns a structured push failed result without gh",
  () => {
    setupRepo();
    git(root, ["remote", "add", "origin", "git@workit-github-host.invalid:o/r.git"]);
    git(root, ["push", "-q", "-u", "origin", "develop"]);
    // reject every subsequent push deterministically
    writeFileSync(path.join(bareRemote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    branchOn();
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk", { pushBranch: true });
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok).not.toBe(true);
    expect(result.error).toBe("push failed");
    expect(result.stderr).toBeTruthy();
    expect(git(root, ["rev-parse", "--verify", "origin/feature/t2"]).status).not.toBe(0);
    expect(existsSync(logFile)).toBe(false); // gh never ran
  },
  { timeout: 60_000 },
);

test(
  "T2: github pushBranch with an unborn HEAD (empty branch) fails closed without gh",
  () => {
    // a repo with no commits has no current branch: `git push -u origin ""`
    // would fail with git's raw refspec error, so the guard must return a
    // readable push-failed result and gh must never run.
    git(root, ["init", "-q", "-b", "develop"]);
    git(root, ["config", "user.name", "Workflow Test"]);
    git(root, ["config", "user.email", "workflow@example.test"]);
    git(root, ["remote", "add", "origin", "git@workit-github-host.invalid:o/r.git"]);
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk", { pushBranch: true });
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok).not.toBe(true);
    expect(result.error).toBe("push failed");
    expect(result.mode).toBe("push");
    expect(result.stderr).toContain("empty current branch");
    expect(existsSync(logFile)).toBe(false); // gh never ran
  },
  { timeout: 60_000 },
);

test(
  "T2: OpenCode wrapper delegates instead of pushing a branch before hosted creation",
  async () => {
    setupRepoWithOrigin();
    branchOn();
    const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
    const previousPath = process.env.PATH;
    process.env.WORKFLOW_TOOLKIT_CONFIG = cfgDir;
    process.env.PATH = stubPath();
    try {
      writeConfig(customPolicy, "trunk", { pushBranch: true });
      const raw = await createRepoTools().workit_pr_create.execute(
        { confirmed: true, title: "T" },
        {
          directory: root,
          worktree: root,
        } as never,
      );
      const result = JSON.parse(raw as string);
      expect(result).toMatchObject({ ok: false, code: "needs_input" });
      expect(
        git(root, ["ls-remote", `file://${bareRemote}`, "refs/heads/feature/t2"]).stdout,
      ).not.toContain("feature/t2");
      expect(existsSync(logFile)).toBe(false);
    } finally {
      if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
  { timeout: 60_000 },
);

test(
  "T2: gitlab parity — reserved push uses one target before glab MR creation",
  () => {
    const glabLog = path.join(stubBin, "glab-args.txt");
    stubCli(stubBin, "glab", glabLog, "https://gitlab.com/o/r/-/merge_requests/1");
    setupRepoWithOrigin();
    branchOn();
    git(root, ["remote", "set-url", "origin", "https://gitlab.com/o/r.git"]);
    git(root, ["remote", "set-url", "--push", "origin", "git@workit-gitlab-host.invalid:o/r.git"]);
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk", { pushBranch: true }, "gitlab");
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    const lines = readFileSync(glabLog, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("--push");
    // glab owns the push (stubbed here): prCreate itself never ran git push
    expect(
      git(root, ["ls-remote", `file://${bareRemote}`, "refs/heads/feature/t2"]).stdout,
    ).toContain("feature/t2");
  },
  { timeout: 60_000 },
);

test(
  "CLI port retains its pure body-builder mode",
  () => {
    const portPath = path.resolve(
      import.meta.dir,
      "..",
      "..",
      "packages",
      "workit-core",
      "src",
      "core",
      "ports",
      "pr-create.ts",
    );
    const result = Bun.spawnSync(["bun", portPath, "--build-body"], {
      cwd: root,
      env: { ...process.env, BODY: "Ready" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ body: "Ready" });
  },
  { timeout: 60_000 },
);
