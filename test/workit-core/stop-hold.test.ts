// #769: after the user says "not yet" for a branch, `workit git hold` records
// it and the Stop hook stops asking to push or open a PR for that branch,
// across new heads, until the next push that moves it or `--clear`.
import { afterAll, afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { appendHookObserved, appendObserved } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "@/test/shared/grant-home";
import { fixture, tempRoot } from "./hooks/hook-fixtures";

setDefaultTimeout(process.platform === "win32" ? 60_000 : 30_000);

let savedState: string | undefined;
let home: ConfigHome;
const roots: string[] = [];
beforeEach(() => {
  savedState = process.env.WORKIT_STATE_DIR;
  process.env.WORKIT_STATE_DIR = tempRoot("workit-hold-state-");
  home = useConfigHome("workit-hold-home-");
  writeFileSync(
    path.join(home.configDir, "config.json"),
    JSON.stringify({
      branchPolicy: {
        preset: "custom",
        allowed: ["feature/*"],
        protected: ["main"],
      },
    }),
  );
});
afterEach(() => {
  home.restore();
  if (savedState === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = savedState;
});
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

const SESSION = "s-lead";
const actor = { host: "claude_code", session: SESSION, agentId: null };

/** A Workit checkout on feature/x (endpoint pr) whose origin has main only. */
const repo = () => {
  const parent = tempRoot("workit-hold-");
  roots.push(parent);
  const root = path.join(parent, "work");
  const origin = path.join(parent, "origin.git");
  git(parent, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main");
  git(root, "checkout", "-q", "-b", "feature/x");
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  writeFileSync(
    path.join(home.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${parent.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
          autonomy: { push: true, pr: true, merge: "verified" },
          defaultEndpoint: "pr",
        },
      ],
    }),
  );
  return root;
};

const commit = (root: string, name: string) => {
  writeFileSync(path.join(root, name), `${name}\n`);
  git(root, "add", name);
  git(root, "commit", "-q", "-m", `feat: ${name}`);
  const sha = git(root, "rev-parse", "HEAD");
  appendHookObserved(root, {
    type: "commit.recorded",
    actor,
    branch: "feature/x",
    head: sha,
    sha,
    session: SESSION,
    agentId: null,
    subject: `feat: ${name}`,
    files: [name],
    fileCount: 1,
  });
  return sha;
};

const row = (root: string, type: string, extra: Record<string, unknown> = {}) =>
  appendObserved(root, {
    type,
    actor,
    branch: "feature/x",
    head: git(root, "rev-parse", "HEAD"),
    ...extra,
  });

const stop = (cwd: string) =>
  dispatchHook(claudeCodeAdapter, fixture("claude-code", "stop", cwd, { session_id: SESSION }))
    .json as { decision?: string; reason?: string };

test("Given no hold, When the agent stops with an unpushed commit, Then it blocks and names the hold command for the user's 'not yet'", () => {
  const root = repo();
  commit(root, "a.txt");
  const out = stop(root);
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("`workit git push`");
  expect(out.reason).toContain('`workit git hold --why "<their words>"`');
});

test("Given a hold on the branch, When new heads are created and the agent stops, Then it never blocks for push or PR", () => {
  const root = repo();
  commit(root, "a.txt");
  row(root, "branch.hold", { why: "no PR yet" });
  expect(stop(root)).toEqual({});
  commit(root, "b.txt");
  expect(stop(root)).toEqual({});
  commit(root, "c.txt");
  expect(stop(root)).toEqual({});
});

test("Given a hold, When a push moves the branch or the hold is cleared, Then the next unpushed head blocks again", () => {
  const pushed = repo();
  commit(pushed, "a.txt");
  row(pushed, "branch.hold", { why: "not yet" });
  git(pushed, "push", "-q", "origin", "feature/x");
  row(pushed, "push.verified", { remote: "origin", pushed: true });
  commit(pushed, "b.txt");
  expect(stop(pushed).decision).toBe("block");

  const cleared = repo();
  commit(cleared, "a.txt");
  row(cleared, "branch.hold", { why: "not yet" });
  row(cleared, "branch.hold.cleared");
  commit(cleared, "b.txt");
  expect(stop(cleared).decision).toBe("block");
});

test("Given a hold on another branch, or one a hook rather than the CLI wrote, Then it does not hold this branch", () => {
  const other = repo();
  commit(other, "a.txt");
  appendObserved(other, {
    type: "branch.hold",
    actor,
    branch: "feature/y",
    head: null,
    why: "x",
  });
  expect(stop(other).decision).toBe("block");

  const forged = repo();
  commit(forged, "a.txt");
  appendHookObserved(forged, {
    type: "branch.hold",
    actor,
    branch: "feature/x",
    head: null,
    why: "x",
  });
  expect(stop(forged).decision).toBe("block");
});
