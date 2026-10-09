import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHAINED_HOOK_NAME,
  SESSION_HOOK_MARKER,
  SESSION_HOOK_SCRIPT,
  inspectSessionHook,
  installSessionHook,
} from "@/packages/workit-core/src/git/session-hook";

// The commit-msg hook `workit doctor --fix` installs: plain `git commit` in an
// agent session gets the Workit-Session trailer; existing hooks are chained.
// Every repository here is a scratch repo under the OS temp dir.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wk-session-hook-"));
  dirs.push(dir);
  return dir;
};

// The ambient session variables (this test may itself run in an agent
// session) and any user/system git config never reach the scratch repos.
const SESSION_VARS = new Set([
  "WORKIT_SESSION_ID",
  "WORKIT_HOST",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
  "CODEX_THREAD_ID",
]);
const baseEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!SESSION_VARS.has(k) && !k.startsWith("GIT_")) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "wk-session-hook-no-global-config"),
    GIT_AUTHOR_NAME: "Workit Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Workit Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
};

const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync("git", args, { cwd, encoding: "utf8", env: { ...baseEnv(), ...env } });
const ok = (cwd: string, args: string[], env: Record<string, string> = {}): string => {
  const r = git(cwd, args, env);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const repo = (): string => {
  const root = tmp();
  ok(root, ["init", "-q", "-b", "main"]);
  ok(root, ["config", "commit.gpgsign", "false"]);
  ok(root, ["config", "core.autocrlf", "false"]);
  ok(root, ["commit", "-q", "--allow-empty", "-m", "chore: init"]);
  return root;
};
const message = (cwd: string, rev = "HEAD") => ok(cwd, ["log", "-1", "--format=%B", rev]);
const sessions = (cwd: string, rev = "HEAD") =>
  message(cwd, rev)
    .split("\n")
    .filter((line) => line.startsWith("Workit-Session:"));
const S = { WORKIT_SESSION_ID: "lead-1" };

test("Given no commit-msg hook, When installed, Then a plain commit in a session carries the trailer and one outside a session is unchanged", () => {
  const root = repo();
  expect(inspectSessionHook(root).state).toBe("missing");
  const done = installSessionHook(root);
  expect(done.action).toBe("installed");
  expect(done.status.state).toBe("installed");
  const hook = path.join(root, ".git", "hooks", "commit-msg");
  expect(readFileSync(hook, "utf8")).toBe(SESSION_HOOK_SCRIPT);
  if (process.platform !== "win32") expect(statSync(hook).mode & 0o111).not.toBe(0);

  ok(root, ["commit", "-q", "--allow-empty", "-m", "feat: one"], S);
  expect(message(root)).toBe("feat: one\n\nWorkit-Session: lead-1");
  ok(root, ["commit", "-q", "--allow-empty", "-m", "feat: two"]);
  expect(message(root)).toBe("feat: two");
  ok(root, ["commit", "-q", "--allow-empty", "-m", "feat: three"], { WORKIT_SESSION_ID: "" });
  expect(message(root)).toBe("feat: three");
  expect(installSessionHook(root).action).toBe("unchanged");
});

test("Given the trailer already present, When committing or amending, Then it is never duplicated and another session's amend adds its own", () => {
  const root = repo();
  installSessionHook(root);
  ok(root, ["commit", "-q", "--allow-empty", "-m", "fix: a\n\nWorkit-Session: lead-1"], S);
  expect(sessions(root)).toEqual(["Workit-Session: lead-1"]);
  ok(root, ["commit", "-q", "--amend", "--no-edit", "--allow-empty"], S);
  expect(sessions(root)).toEqual(["Workit-Session: lead-1"]);
  ok(
    root,
    ["commit", "-q", "--amend", "--allow-empty", "-m", "fix: b\n\nWorkit-Session: lead-1"],
    S,
  );
  expect(message(root)).toBe("fix: b\n\nWorkit-Session: lead-1");
  ok(root, ["commit", "-q", "--amend", "--no-edit", "--allow-empty"], { WORKIT_SESSION_ID: "w-2" });
  expect(sessions(root)).toEqual(["Workit-Session: lead-1", "Workit-Session: w-2"]);
});

test("Given merge and squash commits, When made in a session, Then each ends with exactly one trailer for the session", () => {
  const root = repo();
  installSessionHook(root);
  ok(root, ["switch", "-q", "-c", "topic"]);
  ok(root, ["commit", "-q", "--allow-empty", "-m", "feat: x"], { WORKIT_SESSION_ID: "w-1" });
  writeFileSync(path.join(root, "f.txt"), "x\n");
  ok(root, ["add", "f.txt"]);
  ok(root, ["commit", "-q", "-m", "feat: y"], { WORKIT_SESSION_ID: "w-1" });
  ok(root, ["switch", "-q", "main"]);
  ok(root, ["merge", "-q", "--no-ff", "--no-edit", "topic"], S);
  expect(message(root)).toBe("Merge branch 'topic'\n\nWorkit-Session: lead-1");

  ok(root, ["reset", "-q", "--hard", "HEAD~1"]);
  ok(root, ["merge", "-q", "--squash", "topic"], S);
  ok(root, ["commit", "-q", "--no-edit"], S);
  const squashed = message(root);
  expect(squashed.startsWith("Squashed commit of the following:")).toBe(true);
  expect(squashed.endsWith("\n\nWorkit-Session: lead-1")).toBe(true);
  expect(sessions(root)).toEqual(["Workit-Session: lead-1"]);
});

test("Given a message with comments or nothing but comments, When committing, Then comments are stripped as usual and an empty message still aborts", () => {
  const root = repo();
  installSessionHook(root);
  const file = path.join(root, "..", `${path.basename(root)}-msg`);
  dirs.push(file);
  writeFileSync(file, "feat: commented\n\nbody\n# a comment\n");
  ok(root, ["commit", "-q", "--allow-empty", "--cleanup=strip", "-F", file], S);
  expect(message(root)).toBe("feat: commented\n\nbody\n\nWorkit-Session: lead-1");
  writeFileSync(file, "# only a comment\n\n");
  const empty = git(root, ["commit", "-q", "--allow-empty", "--cleanup=strip", "-F", file], S);
  expect(empty.status).not.toBe(0);
  expect(empty.stderr).toContain("empty commit message");
});

test("Given host session variables, When committing, Then the hook picks the session as host-session.ts does and skips unsafe ids", () => {
  const root = repo();
  installSessionHook(root);
  const commit = (env: Record<string, string>) => {
    ok(root, ["commit", "-q", "--allow-empty", "-m", "chore: s"], env);
    return sessions(root);
  };
  expect(commit({ CODEX_THREAD_ID: "thread-9" })).toEqual(["Workit-Session: thread-9"]);
  expect(commit({ PI_SESSION_ID: " pi-3 " })).toEqual(["Workit-Session: pi-3"]);
  expect(commit({ OPENCODE_SESSION_ID: "ses_1", CODEX_THREAD_ID: "t" })).toEqual([
    "Workit-Session: ses_1",
  ]);
  // Inherited from an outer Claude Code session: the inner host's own id wins.
  expect(
    commit({ WORKIT_SESSION_ID: "outer", WORKIT_HOST: "claude_code", CODEX_THREAD_ID: "inner" }),
  ).toEqual(["Workit-Session: inner"]);
  expect(
    commit({ WORKIT_SESSION_ID: "mine", WORKIT_HOST: "codex_cli", CODEX_THREAD_ID: "inner" }),
  ).toEqual(["Workit-Session: mine"]);
  // Set but empty opts out of the host fallback.
  expect(commit({ WORKIT_SESSION_ID: "", CODEX_THREAD_ID: "inner" })).toEqual([]);
  expect(commit({ WORKIT_SESSION_ID: "bad id; rm -rf /" })).toEqual([]);
  expect(commit({ WORKIT_SESSION_ID: "x".repeat(129) })).toEqual([]);
});

test("Given an existing commit-msg hook (lefthook), When installed, Then it is chained: kept byte for byte, run first, and its failure fails the commit", () => {
  const root = repo();
  const hooks = path.join(root, ".git", "hooks");
  const log = path.join(root, "..", `${path.basename(root)}-ran`);
  dirs.push(log);
  const original = `#!/bin/sh\n# lefthook stand-in\necho "$1" >> "${log}"\n[ -z "$FAIL_HOOK" ]\n`;
  writeFileSync(path.join(hooks, "commit-msg"), original, { mode: 0o755 });
  expect(inspectSessionHook(root).state).toBe("foreign");
  const done = installSessionHook(root);
  expect(done.action).toBe("chained");
  expect(done.status).toMatchObject({
    state: "installed",
    chained: path.join(hooks, CHAINED_HOOK_NAME),
  });
  expect(readFileSync(path.join(hooks, CHAINED_HOOK_NAME), "utf8")).toBe(original);
  expect(existsSync(path.join(hooks, "commit-msg.workit-new"))).toBe(false);

  ok(root, ["commit", "-q", "--allow-empty", "-m", "feat: chained"], S);
  expect(message(root)).toBe("feat: chained\n\nWorkit-Session: lead-1");
  expect(readFileSync(log, "utf8")).toContain("COMMIT_EDITMSG");
  const head = ok(root, ["rev-parse", "HEAD"]);
  const refused = git(root, ["commit", "-q", "--allow-empty", "-m", "feat: no"], {
    ...S,
    FAIL_HOOK: "1",
  });
  expect(refused.status).not.toBe(0);
  expect(ok(root, ["rev-parse", "HEAD"])).toBe(head);

  // A second foreign hook with the chained slot taken is never overwritten.
  writeFileSync(path.join(hooks, "commit-msg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const blocked = installSessionHook(root);
  expect(blocked.action).toBe("skipped");
  expect(blocked.status.state).toBe("blocked");
  expect(readFileSync(path.join(hooks, "commit-msg"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
  expect(readFileSync(path.join(hooks, CHAINED_HOOK_NAME), "utf8")).toBe(original);
});

test("Given an older Workit hook, When installed, Then it is rewritten to the current script", () => {
  const root = repo();
  const hook = path.join(root, ".git", "hooks", "commit-msg");
  writeFileSync(hook, `#!/bin/sh\n${SESSION_HOOK_MARKER} v0\n`, { mode: 0o755 });
  expect(inspectSessionHook(root).state).toBe("outdated");
  expect(installSessionHook(root).action).toBe("updated");
  expect(readFileSync(hook, "utf8")).toBe(SESSION_HOOK_SCRIPT);
});

test("Given core.hooksPath, When installed, Then an ignored in-repo hooks dir is used, and a tracked hook or one outside the repository is left alone", () => {
  const root = repo();
  // husky-style: an ignored generated directory in the working tree.
  ok(root, ["config", "core.hooksPath", ".husky/_"]);
  mkdirSync(path.join(root, ".husky", "_"), { recursive: true });
  writeFileSync(path.join(root, ".husky", "_", ".gitignore"), "*\n");
  expect(installSessionHook(root).action).toBe("installed");
  expect(readFileSync(path.join(root, ".husky", "_", "commit-msg"), "utf8")).toBe(
    SESSION_HOOK_SCRIPT,
  );
  mkdirSync(path.join(root, "sub"));
  ok(path.join(root, "sub"), ["commit", "-q", "--allow-empty", "-m", "feat: husky"], S);
  expect(sessions(root)).toEqual(["Workit-Session: lead-1"]);
  expect(ok(root, ["status", "--porcelain"])).toBe("");

  // A committed .githooks directory: the tracked hook is never moved.
  const tracked = repo();
  ok(tracked, ["config", "core.hooksPath", ".githooks"]);
  mkdirSync(path.join(tracked, ".githooks"));
  writeFileSync(path.join(tracked, ".githooks", "commit-msg"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  ok(tracked, ["add", ".githooks"]);
  ok(tracked, ["commit", "-q", "-m", "chore: hooks"]);
  const t = installSessionHook(tracked);
  expect(t.action).toBe("skipped");
  expect(t.status.reason).toContain("tracked by git");
  expect(existsSync(path.join(tracked, ".githooks", CHAINED_HOOK_NAME))).toBe(false);

  // A global hooks path outside the repository is never written.
  const outside = repo();
  const global = tmp();
  ok(outside, ["config", "core.hooksPath", global]);
  const o = installSessionHook(outside);
  expect(o.status.state).toBe("blocked");
  expect(o.status.reason).toContain("outside the repository");
  expect(existsSync(path.join(global, "commit-msg"))).toBe(false);
});

test("Given a linked worktree, When installed from it, Then the hook lands in the shared hooks dir and covers the main checkout", () => {
  const root = repo();
  const wt = path.join(tmp(), "wt");
  ok(root, ["worktree", "add", "-q", "-b", "side", wt]);
  expect(installSessionHook(wt).status.hookPath).toBe(
    path.join(realpathSync(root), ".git", "hooks", "commit-msg"),
  );
  ok(root, ["commit", "-q", "--allow-empty", "-m", "feat: main"], S);
  expect(sessions(root)).toEqual(["Workit-Session: lead-1"]);
});

test("Given a directory that is not a git repository, When inspected or installed, Then nothing is written", () => {
  const dir = tmp();
  expect(inspectSessionHook(dir).state).toBe("not_git");
  expect(installSessionHook(dir).action).toBe("skipped");
  expect(existsSync(path.join(dir, ".git"))).toBe(false);
});
