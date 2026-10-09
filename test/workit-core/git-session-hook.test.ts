import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SESSION_HOOK_MARKER,
  SESSION_HOOK_SCRIPT,
  inspectSessionHook,
  installSessionHook,
  manualTrailerLine,
} from "@/packages/workit-core/src/git/session-hook";

// The prepare-commit-msg hook `workit doctor --fix` installs: a plain
// `git commit` in an agent session gets the Workit-Session trailer, and
// another tool's hook (husky, lefthook) is never touched. Every repository
// here is a scratch repo under the OS temp dir.

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const lefthookBin = path.join(repoRoot, "node_modules", ".bin");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
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
    if (!SESSION_VARS.has(k) && !k.startsWith("GIT_") && !k.startsWith("LEFTHOOK")) env[k] = v;
  return {
    ...env,
    PATH: `${lefthookBin}${path.delimiter}${process.env.PATH ?? ""}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "wk-session-hook-no-global-config"),
    GIT_AUTHOR_NAME: "Workit Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Workit Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
};

const sh = (cmd: string, cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...baseEnv(), ...env } });
const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  sh("git", cwd, args, env);
const ok = (cwd: string, args: string[], env: Record<string, string> = {}): string => {
  const r = git(cwd, args, env);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
};
const lefthook = (cwd: string, ...args: string[]) => {
  const r = sh(path.join(lefthookBin, "lefthook"), cwd, args);
  if (r.status !== 0) throw new Error(`lefthook ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

const repo = (): string => {
  const root = tmp();
  ok(root, ["init", "-q", "-b", "main"]);
  ok(root, ["config", "commit.gpgsign", "false"]);
  ok(root, ["config", "core.autocrlf", "false"]);
  ok(root, ["commit", "-q", "--allow-empty", "-m", "chore: init"]);
  return root;
};
const hookOf = (root: string) => path.join(root, ".git", "hooks", "prepare-commit-msg");
const message = (cwd: string, rev = "HEAD") => ok(cwd, ["log", "-1", "--format=%B", rev]);
const sessions = (cwd: string, rev = "HEAD") =>
  message(cwd, rev)
    .split("\n")
    .filter((line) => line.startsWith("Workit-Session:"));
const S = { WORKIT_SESSION_ID: "lead-1" };
const commit = (root: string, msg: string, env: Record<string, string> = S) =>
  git(root, ["commit", "-q", "--allow-empty", "-m", msg], env);

// A user commit-msg check (what commitlint does): a subject must start with
// feat/fix/chore; it records whether it saw the trailer.
const subjectCheck = (log: string) =>
  `#!/bin/sh\ngrep -q 'Workit-Session' "$1" && echo saw >> "${log}"\nhead -1 "$1" | grep -Eq '^(feat|fix|chore)'\n`;

test("Given an empty slot, When installed, Then a plain commit in a session carries the trailer, even with --no-verify, and one outside a session is unchanged", () => {
  const root = repo();
  expect(inspectSessionHook(root).state).toBe("missing");
  const done = installSessionHook(root);
  expect(done.action).toBe("installed");
  expect(done.status.state).toBe("installed");
  expect(readFileSync(hookOf(root), "utf8")).toBe(SESSION_HOOK_SCRIPT);
  expect(SESSION_HOOK_SCRIPT).toContain("Workit (https://github.com/BrainerVirus/workit)");
  if (process.platform !== "win32") expect(statSync(hookOf(root)).mode & 0o111).not.toBe(0);
  expect(readdirSync(path.dirname(hookOf(root))).filter((f) => f.includes("workit-new"))).toEqual(
    [],
  );

  ok(root, ["commit", "-q", "--allow-empty", "-m", "feat: one"], S);
  expect(message(root)).toBe("feat: one\n\nWorkit-Session: lead-1");
  ok(root, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "feat: nv"], S);
  expect(message(root)).toBe("feat: nv\n\nWorkit-Session: lead-1");
  const file = path.join(tmp(), "msg");
  writeFileSync(file, "feat: from file\n");
  ok(root, ["commit", "-q", "--allow-empty", "-F", file], S);
  expect(message(root)).toBe("feat: from file\n\nWorkit-Session: lead-1");
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
  ok(root, ["commit", "-q", "--amend", "--allow-empty", "-m", "fix: b"], S);
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

test("Given a rebase replaying another session's commits, When it runs in a session, Then the replayed commits keep only their own trailers", () => {
  const root = repo();
  installSessionHook(root);
  ok(root, ["switch", "-q", "-c", "topic"]);
  writeFileSync(path.join(root, "t.txt"), "t\n");
  ok(root, ["add", "t.txt"]);
  ok(root, ["commit", "-q", "-m", "feat: worker"], { WORKIT_SESSION_ID: "w-1" });
  ok(root, ["switch", "-q", "main"]);
  writeFileSync(path.join(root, "m.txt"), "m\n");
  ok(root, ["add", "m.txt"]);
  ok(root, ["commit", "-q", "-m", "feat: main"], S);
  ok(root, ["switch", "-q", "topic"]);
  ok(root, ["rebase", "-q", "main"], S);
  expect(sessions(root)).toEqual(["Workit-Session: w-1"]);
});

test("Given a comment-only message or an unedited template, When committing, Then the hook adds nothing and git still aborts", () => {
  const root = repo();
  installSessionHook(root);
  const dir = tmp();
  const file = path.join(dir, "msg");
  writeFileSync(file, "feat: commented\n\nbody\n# a comment\n");
  ok(root, ["commit", "-q", "--allow-empty", "--cleanup=strip", "-F", file], S);
  expect(message(root)).toBe("feat: commented\n\nbody\n\nWorkit-Session: lead-1");
  writeFileSync(file, "# only a comment\n\n");
  const empty = git(root, ["commit", "-q", "--allow-empty", "--cleanup=strip", "-F", file], S);
  expect(empty.status).not.toBe(0);
  expect(empty.stderr).toContain("empty commit message");

  const template = path.join(dir, "template");
  writeFileSync(template, "feat: template subject\n");
  const unedited = git(root, ["commit", "-q", "--allow-empty", "-t", template], {
    ...S,
    GIT_EDITOR: "true",
  });
  expect(unedited.status).not.toBe(0);
  expect(unedited.stderr).toContain("did not edit the message");
});

test("Given host session variables, When committing, Then the hook picks the session as host-session.ts does and skips unsafe ids", () => {
  const root = repo();
  installSessionHook(root);
  const commitWith = (env: Record<string, string>) => {
    ok(root, ["commit", "-q", "--allow-empty", "-m", "chore: s"], env);
    return sessions(root);
  };
  expect(commitWith({ CODEX_THREAD_ID: "thread-9" })).toEqual(["Workit-Session: thread-9"]);
  expect(commitWith({ PI_SESSION_ID: " pi-3 " })).toEqual(["Workit-Session: pi-3"]);
  expect(commitWith({ OPENCODE_SESSION_ID: "ses_1", CODEX_THREAD_ID: "t" })).toEqual([
    "Workit-Session: ses_1",
  ]);
  // Inherited from an outer Claude Code session: the inner host's own id wins.
  expect(
    commitWith({ WORKIT_SESSION_ID: "outer", WORKIT_HOST: "claude_code", CODEX_THREAD_ID: "in" }),
  ).toEqual(["Workit-Session: in"]);
  expect(
    commitWith({ WORKIT_SESSION_ID: "mine", WORKIT_HOST: "codex_cli", CODEX_THREAD_ID: "in" }),
  ).toEqual(["Workit-Session: mine"]);
  // Set but empty opts out of the host fallback.
  expect(commitWith({ WORKIT_SESSION_ID: "", CODEX_THREAD_ID: "in" })).toEqual([]);
  expect(commitWith({ WORKIT_SESSION_ID: "bad id; rm -rf /" })).toEqual([]);
  expect(commitWith({ WORKIT_SESSION_ID: "x".repeat(129) })).toEqual([]);
});

test("Given the user's own commit-msg check, When the hook is installed, Then that check still rejects a bad message and sees the trailer on a good one", () => {
  const root = repo();
  const log = path.join(tmp(), "saw");
  const userHook = subjectCheck(log);
  writeFileSync(path.join(root, ".git", "hooks", "commit-msg"), userHook, { mode: 0o755 });
  expect(installSessionHook(root).action).toBe("installed");
  expect(readFileSync(path.join(root, ".git", "hooks", "commit-msg"), "utf8")).toBe(userHook);
  const head = ok(root, ["rev-parse", "HEAD"]);
  expect(commit(root, "bad subject").status).not.toBe(0);
  expect(ok(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(commit(root, "feat: good").status).toBe(0);
  expect(readFileSync(log, "utf8")).toContain("saw");
});

// husky 9.1.7 `husky` script, installed as `.husky/_/h` by `husky` (index.js).
// husky is MIT licensed: Copyright (c) 2021 typicode. Reproduced unchanged so
// the test runs husky's own dispatch.
const HUSKY_H = `#!/usr/bin/env sh
[ "$HUSKY" = "2" ] && set -x
n=$(basename "$0")
s=$(dirname "$(dirname "$0")")/$n

[ ! -f "$s" ] && exit 0

if [ -f "$HOME/.huskyrc" ]; then
	echo "husky - '~/.huskyrc' is DEPRECATED, please move your code to ~/.config/husky/init.sh"
fi
i="\${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh"
[ -f "$i" ] && . "$i"

[ "\${HUSKY-}" = "0" ] && exit 0

export PATH="node_modules/.bin:$PATH"
sh -e "$s" "$@"
c=$?

[ $c != 0 ] && echo "husky - $n script failed (code $c)"
[ $c = 127 ] && echo "husky - command not found in PATH=$PATH"
exit $c
`;
// What husky 9.1.7 index.js writes for every hook it manages.
const HUSKY_HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-push"];
const HUSKY_STUB = `#!/usr/bin/env sh\n. "$(dirname "$0")/h"`;
const huskyInstall = (root: string) => {
  ok(root, ["config", "core.hooksPath", ".husky/_"]);
  const dir = path.join(root, ".husky", "_");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".gitignore"), "*");
  writeFileSync(path.join(dir, "h"), HUSKY_H, { mode: 0o755 });
  for (const hook of HUSKY_HOOKS) writeFileSync(path.join(dir, hook), HUSKY_STUB, { mode: 0o755 });
  return dir;
};

test("Given husky v9, When --fix runs, Then the husky stub is left alone, the user's commitlint still runs, and the manual line adds the trailer", () => {
  const root = repo();
  const stubs = huskyInstall(root);
  const log = path.join(tmp(), "saw");
  writeFileSync(path.join(root, ".husky", "commit-msg"), subjectCheck(log));

  const done = installSessionHook(root);
  expect(done.action).toBe("skipped");
  expect(done.status).toMatchObject({ state: "blocked", owner: "husky" });
  const userScript = path.join(realpathSync(root), ".husky", "prepare-commit-msg");
  expect(done.status.manual).toBe(
    `add this line to ${userScript} (husky runs it): ${manualTrailerLine()}`,
  );
  for (const hook of HUSKY_HOOKS)
    expect(readFileSync(path.join(stubs, hook), "utf8")).toBe(HUSKY_STUB);
  expect(readdirSync(stubs).toSorted()).toEqual([".gitignore", "h", ...HUSKY_HOOKS].toSorted());
  expect(commit(root, "bad subject").status).not.toBe(0);

  // The manual fix, applied as husky users write hooks.
  writeFileSync(userScript, `${manualTrailerLine()}\n`);
  expect(commit(root, "feat: husky").status).toBe(0);
  expect(sessions(root)).toEqual(["Workit-Session: lead-1"]);
  expect(readFileSync(log, "utf8")).toContain("saw");
  expect(commit(root, "bad again").status).not.toBe(0);
  expect(ok(root, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
});

test("Given lefthook, When --fix runs and lefthook reinstalls later, Then our hook keeps working beside lefthook's, and once lefthook takes the slot we report blocked with a snippet that works", () => {
  const root = repo();
  const log = path.join(tmp(), "saw");
  const config = path.join(root, "lefthook.yml");
  const commitMsgOnly = [
    "commit-msg:",
    "  jobs:",
    "    - name: subject",
    `      run: grep -q 'Workit-Session' {1} && echo saw >> '${log}'; head -1 {1} | grep -Eq '^(feat|fix|chore)'`,
    "",
  ].join("\n");
  writeFileSync(config, commitMsgOnly);
  lefthook(root, "install");
  expect(installSessionHook(root).action).toBe("installed");
  expect(commit(root, "bad subject").status).not.toBe(0);
  expect(commit(root, "feat: lefthook").status).toBe(0);
  expect(sessions(root)).toEqual(["Workit-Session: lead-1"]);
  expect(readFileSync(log, "utf8")).toContain("saw");

  // A later `lefthook install` for commit-msg only leaves our slot alone.
  lefthook(root, "install", "--force");
  expect(readFileSync(hookOf(root), "utf8")).toBe(SESSION_HOOK_SCRIPT);
  expect(commit(root, "feat: again").status).toBe(0);
  expect(sessions(root)).toEqual(["Workit-Session: lead-1"]);

  // lefthook takes prepare-commit-msg: ours becomes .old, which nothing runs.
  writeFileSync(
    config,
    `${commitMsgOnly}prepare-commit-msg:\n  jobs:\n    - name: other\n      run: "true"\n`,
  );
  lefthook(root, "install");
  const blocked = inspectSessionHook(root);
  expect(blocked).toMatchObject({ state: "blocked", owner: "lefthook" });
  expect(blocked.reason).toContain("prepare-commit-msg.old");
  const lefthookHook = readFileSync(hookOf(root), "utf8");
  expect(installSessionHook(root).action).toBe("skipped");
  expect(readFileSync(hookOf(root), "utf8")).toBe(lefthookHook);
  const manual = blocked.manual!;
  expect(manual.split("\n")[0]).toBe(
    `add this job to ${path.join(realpathSync(root), "lefthook.yml")}, then run \`lefthook install\`:`,
  );

  // The snippet, merged into the user's config, adds the trailer.
  const snippet = manual.split("\n").slice(2).join("\n");
  writeFileSync(config, `${commitMsgOnly}prepare-commit-msg:\n${snippet}\n`);
  lefthook(root, "install");
  expect(commit(root, "feat: snippet").status).toBe(0);
  expect(sessions(root)).toEqual(["Workit-Session: lead-1"]);
  expect(commit(root, "bad subject").status).not.toBe(0);
});

test("Given another hand-written prepare-commit-msg, When --fix runs, Then it is left byte for byte and the manual line names it", () => {
  const root = repo();
  const own = "#!/bin/sh\n# mine\nexit 0\n";
  writeFileSync(hookOf(root), own, { mode: 0o755 });
  const done = installSessionHook(root);
  expect(done.status).toMatchObject({
    state: "blocked",
    owner: "other",
    manual: `add this line to ${hookOf(realpathSync(root))}: ${manualTrailerLine()}`,
  });
  expect(readFileSync(hookOf(root), "utf8")).toBe(own);
});

test("Given an older Workit hook, When installed, Then it is rewritten to the current script", () => {
  const root = repo();
  writeFileSync(hookOf(root), `#!/bin/sh\n${SESSION_HOOK_MARKER} v1\n`, { mode: 0o755 });
  expect(inspectSessionHook(root).state).toBe("outdated");
  expect(installSessionHook(root).action).toBe("updated");
  expect(readFileSync(hookOf(root), "utf8")).toBe(SESSION_HOOK_SCRIPT);
});

test("Given files left by the earlier commit-msg design, When inspected, Then they are reported with recovery steps and left in place", () => {
  const root = repo();
  const hooks = path.join(root, ".git", "hooks");
  writeFileSync(path.join(hooks, "commit-msg"), `#!/bin/sh\n${SESSION_HOOK_MARKER} v1\n`);
  writeFileSync(path.join(hooks, "commit-msg.workit-chained"), "#!/bin/sh\nexit 0\n");
  const status = inspectSessionHook(root);
  expect(status.leftover).toContain("move it back to");
  expect(existsSync(path.join(hooks, "commit-msg.workit-chained"))).toBe(true);
  rmSync(path.join(hooks, "commit-msg.workit-chained"));
  expect(inspectSessionHook(root).leftover).toContain("delete it");
});

test("Given core.hooksPath outside the repository or in an unignored working-tree dir, When installed, Then nothing is written", () => {
  const outside = repo();
  const global = tmp();
  ok(outside, ["config", "core.hooksPath", global]);
  const o = installSessionHook(outside);
  expect(o.status.state).toBe("blocked");
  expect(o.status.reason).toContain("outside the repository");
  expect(existsSync(path.join(global, "prepare-commit-msg"))).toBe(false);

  // A committed .githooks directory without the slot: a new file there would
  // show up as untracked.
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
  expect(t.status.reason).toContain("not ignored");
  expect(readdirSync(path.join(tracked, ".githooks"))).toEqual(["commit-msg"]);
  expect(ok(tracked, ["status", "--porcelain"])).toBe("");
});

test("Given a hooks directory that cannot be written, When installed, Then it throws and leaves no staged file", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const root = repo();
  const hooks = path.join(root, ".git", "hooks");
  chmodSync(hooks, 0o555);
  dirs.push(hooks);
  expect(() => installSessionHook(root)).toThrow();
  chmodSync(hooks, 0o755);
  expect(readdirSync(hooks).filter((f) => f.startsWith("prepare-commit-msg"))).toEqual([
    "prepare-commit-msg.sample",
  ]);
});

test("Given a linked worktree, When installed from it, Then the hook lands in the shared hooks dir and covers the main checkout", () => {
  const root = repo();
  const wt = path.join(tmp(), "wt");
  ok(root, ["worktree", "add", "-q", "-b", "side", wt]);
  expect(installSessionHook(wt).status.hookPath).toBe(hookOf(realpathSync(root)));
  ok(root, ["commit", "-q", "--allow-empty", "-m", "feat: main"], S);
  expect(sessions(root)).toEqual(["Workit-Session: lead-1"]);
});

test("Given a directory that is not a git repository, When inspected or installed, Then nothing is written", () => {
  const dir = tmp();
  expect(inspectSessionHook(dir).state).toBe("not_git");
  expect(installSessionHook(dir).action).toBe("skipped");
  expect(existsSync(path.join(dir, ".git"))).toBe(false);
});
