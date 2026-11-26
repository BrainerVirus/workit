// #891: the Stop hook reads set verdicts and the sealed additiveRiskPaths
// override as the merge gate does, so it never asks a session that delivered
// a PR for a verdict the gate no longer needs.
import { afterAll, afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import {
  appendHookObserved,
  appendObserved,
  recordVerdict,
  type LedgerResult,
} from "@/packages/workit-core/src/ledger";
import { recordSetVerdict } from "@/packages/workit-core/src/core/verdict-set";
import { useConfigHome, type ConfigHome } from "@/test/shared/grant-home";
import { fixture, tempRoot } from "./hook-fixtures";

setDefaultTimeout(process.platform === "win32" ? 60_000 : 30_000);

let savedState: string | undefined;
let home: ConfigHome;
beforeEach(() => {
  savedState = process.env.WORKIT_STATE_DIR;
  process.env.WORKIT_STATE_DIR = tempRoot("workit-hook-state-");
  home = useConfigHome("workit-stop-set-home-");
  writeFileSync(
    path.join(home.configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
});
afterEach(() => {
  home.restore();
  if (savedState === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = savedState;
});

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

const value = <T>(result: LedgerResult<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
};

const SESSION = "s-lead";
const actor = (session: string, host = "claude_code") => ({ host, session, agentId: null });

/** Workspace "w" over every test root: endpoint green, plus `entry`. */
const workspace = (entry: Record<string, unknown> = {}) =>
  writeFileSync(
    path.join(home.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${path.dirname(roots[0] ?? "").replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
          autonomy: { push: true, pr: true, merge: "verified" },
          defaultEndpoint: "green",
          ...entry,
        },
      ],
    }),
  );

/**
 * A checkout on feature/x whose main holds `base` and whose one commit, by
 * this session, writes `change`; pushed, with a PR this session opened.
 */
const delivered = (base: Record<string, string>, change: Record<string, string>) => {
  const parent = tempRoot("workit-stop-set-");
  roots.push(parent);
  const root = path.join(parent, "work");
  const origin = path.join(parent, "origin.git");
  git(parent, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  const write = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    git(root, "add", "-A");
  };
  write({ "README.md": "# app\n", ...base });
  git(root, "commit", "-q", "-m", "init");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main");
  git(root, "checkout", "-q", "-b", "feature/x");
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  write(change);
  git(root, "commit", "-q", "-m", "feat: change");
  const sha = git(root, "rev-parse", "HEAD");
  appendHookObserved(root, {
    type: "commit.recorded",
    actor: actor(SESSION),
    branch: "feature/x",
    head: sha,
    sha,
    session: SESSION,
    agentId: null,
    subject: "feat: change",
    files: Object.keys(change),
    fileCount: Object.keys(change).length,
  });
  git(root, "push", "-q", "origin", "feature/x");
  appendObserved(root, {
    type: "pr.created",
    actor: actor(SESSION),
    branch: "feature/x",
    head: sha,
    pr: 8,
    base: "main",
    url: "https://github.com/o/r/pull/8",
    forge: "github",
    repo: "o/r",
    created: true,
  });
  return root;
};

const claudeStop = (cwd: string) =>
  dispatchHook(claudeCodeAdapter, fixture("claude-code", "stop", cwd, { session_id: SESSION }))
    .json as { decision?: string; reason?: string };

const RISKY = { "src/hooks/guard.ts": "export const guard = true;\n" };

test("G a set verdict on the same diff from another repository, W the session that delivered PR B stops, T no verdict is asked; without it one is", () => {
  const a = delivered({}, RISKY);
  const b = delivered({}, RISKY);
  workspace();
  const before = claudeStop(b);
  expect(before.decision).toBe("block");
  expect(before.reason).toContain("an independent verdict");
  rmSync(path.join(b, ".git", "workit", "hooks"), { recursive: true, force: true });
  const verdict = value(
    recordVerdict(
      { cwd: a, actor: actor("lead-A:ver-1", "cli"), branch: "feature/x" },
      { result: "verified", how: "exercised the guard" },
    ),
  );
  value(recordSetVerdict(a, verdict, "s1"));
  expect(claudeStop(b)).toEqual({});
});

const CI = `name: CI
on:
  push:
    branches: [main]
jobs:
  lint:
    uses: acme/workflows/.github/workflows/node.yml@v3
    with:
      lint_command: npm run lint
`;
const APPEND = {
  ".github/workflows/ci.yml": CI.replace("npm run lint\n", "npm run lint && npm run x:check\n"),
  "src/app.ts": "export const app = 2;\n",
};

test("G a self verdict on a small change with an additive ci.yml append, W the session stops, T it asks for an independent verdict; under a sealed additiveRiskPaths it does not", () => {
  const root = delivered(
    { ".github/workflows/ci.yml": CI, "src/app.ts": "export const app = 1;\n" },
    APPEND,
  );
  workspace();
  recordVerdict(
    { cwd: root, actor: actor(SESSION), branch: "feature/x" },
    { result: "tests-verified", how: "bun test", self: true },
  );
  const out = claudeStop(root);
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("an independent verdict");
  rmSync(path.join(root, ".git", "workit", "hooks"), { recursive: true, force: true });
  workspace({ additiveRiskPaths: [".github/workflows/ci.yml"] });
  expect(claudeStop(root)).toEqual({});
});
