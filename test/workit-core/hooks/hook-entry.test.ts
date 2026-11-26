// #984: an agent's shell must not run Workit's own hook entry with a payload
// it wrote (a forged SubagentStart issues a real token), and must not remove
// or move `.git/workit`, `.git` or a dir that holds the ledger. Every host
// denies both; the host's own hook runs never pass through its shell tool.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_CODE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
  CURSOR_DESCRIPTOR,
  handleHook,
  OPENCODE_DESCRIPTOR,
  PI_DESCRIPTOR,
  type HookInput,
} from "@/packages/workit-core/src/hooks/index";
import type { HostDescriptor } from "@/packages/workit-core/src/hooks/descriptor";
import { hookEntryRun } from "@/packages/workit-core/src/hooks/hook-entry";
import { mayHitHookGuard } from "@/packages/workit-core/src/hooks/hook-entry-hint";
import { PLUGIN_DIR, runHook } from "@/test/workit-claude-code/plugin-helpers";

const ROOT = path.resolve(import.meta.dir, "../../..");
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-hook-entry-")));
const repo = path.join(tmp, "repo");
spawnSync("git", ["init", "-q", "-b", "feature/x", repo], { timeout: 30_000 });
mkdirSync(path.join(repo, ".git", "workit", "ledger"), { recursive: true });
writeFileSync(path.join(repo, ".git", "workit", "ledger", "ledger.jsonl"), "{}\n");
mkdirSync(path.join(repo, "sub"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HOSTS: Array<[HostDescriptor, HookInput["host"]]> = [
  [CLAUDE_CODE_DESCRIPTOR, "claude_code"],
  [CODEX_DESCRIPTOR, "codex_cli"],
  [CURSOR_DESCRIPTOR, "cursor"],
  [OPENCODE_DESCRIPTOR, "opencode"],
  [PI_DESCRIPTOR, "pi"],
];

const shellPre = (
  cwd: string,
  command: string,
  [descriptor, host]: [HostDescriptor, HookInput["host"]] = HOSTS[0],
  dialect: "posix" | "powershell" = "posix",
) =>
  handleHook(
    {
      host,
      cwd,
      session: { id: "s-lead", agentId: null, agentType: null, parentId: null },
      permissionMode: "default",
      transcriptPath: null,
      event: { kind: "shell.pre", command, toolUseId: null, toolInput: { command }, dialect },
    },
    { descriptor, addendum: null },
  );
const deniedBy = (decision: ReturnType<typeof shellPre>, guard: string) =>
  decision.kind === "deny" && decision.reason.includes(guard);

const CC = "packages/workit-claude-code";
const RUN = "packages/workit-core/src/hooks/run.ts";
const RUNS_ENTRY = [
  `echo '{"hook_event_name":"SubagentStart","agent_id":"ghost"}' | node "$CLAUDE_PLUGIN_ROOT/bin/workit-hook.mjs"`,
  `node \${CLAUDE_PLUGIN_ROOT}/bin/workit-hook.mjs < /tmp/payload.json`,
  `bun ${RUN} claude_code < /tmp/payload.json`,
  `bun ./${RUN} claude_code`,
  `bun run ${RUN} claude_code`,
  `WORKIT_STATE_DIR=/tmp/x FOO=1 bun ${RUN} claude_code`,
  `env FOO=1 node ${CC}/bin/workit-hook.mjs`,
  `env -S 'node ${CC}/bin/workit-hook.mjs'`,
  `timeout 5 nice -n 5 node ${CC}/bin/workit-hook.mjs`,
  `sudo -u me node ${CC}/bin/workit-hook.mjs`,
  `node --import ./x.mjs '${CC}/bin/workit-hook.mjs'`,
  `node "${CC}/bin/workit-hook.mjs"`,
  `node < ${CC}/bin/workit-hook.mjs`,
  `${CC}/bin/workit-hook.mjs < /tmp/payload.json`,
  `"./${CC}/bin/workit-hook.mjs"`,
  `node ${CC}/bin/workit-h*.mjs`,
  "bun packages/workit-c?re/src/hooks/r*.ts claude_code",
  `npx tsx ${CC}/src/hook.ts`,
  `bunx tsx ${CC}/src/run.ts`,
  `deno run -A ${RUN} claude_code`,
  `sh -c 'node ${CC}/bin/workit-hook.mjs'`,
  `bash -c "cd ${CC} && node bin/workit-hook.mjs"`,
  `bash <<'EOF'\nnode ${CC}/bin/workit-hook.mjs\nEOF`,
  `x=$(node ${CC}/bin/workit-hook.mjs)`,
  `cd ${CC} && node bin/workit-hook.mjs`,
  `cd ${CC}; node ./bin/workit-hook.mjs`,
  `cd packages/workit-core/src/hooks && bun run.ts claude_code`,
  `P=${CC}/bin; node $P/workit-hook.mjs`,
  `export P=$PWD/${RUN}; bun $P claude_code`,
  `ln -s $PWD/${RUN} /tmp/r.ts && bun /tmp/r.ts claude_code`,
  `node packages/workit-codex/dist/workit-hook.js`,
  `node packages/workit-codex/dist/workit-hook-a1b2c3.js`,
  `node packages/workit-cursor/hooks/launch.mjs workit-cursor-hook`,
  `node packages/workit-cursor/dist/cursor-session-start.js`,
  `bun packages/workit-codex/hooks/launcher.ts`,
  "workit-codex-hook < /tmp/payload.json",
  "npx -y @workit-dev/cursor workit-cursor-hook",
  "npx -y @workit-dev/codex",
  "workit-cursor-session-start",
];

test("Given each spelling of a hook entry run, When an agent's shell command runs it, Then every host denies it with the hook guard", () => {
  for (const command of RUNS_ENTRY) {
    expect(hookEntryRun(ROOT, command), command).not.toBeNull();
    for (const host of HOSTS)
      expect(
        deniedBy(shellPre(ROOT, command, host), "workit hook guard"),
        `${host[1]}: ${command}`,
      ).toBe(true);
  }
});

test("Given PowerShell, When it runs an entry with & or an interpreter, Then it is denied", () => {
  for (const command of [
    `& node "C:\\Users\\me\\.claude\\plugins\\workit\\bin\\workit-hook.mjs"`,
    `node.exe C:/Users/me/.claude/plugins/workit/bin/workit-hook.mjs`,
    `cmd /c node ${CC}/bin/workit-hook.mjs`,
  ])
    expect(
      deniedBy(shellPre(ROOT, command, HOSTS[0], "powershell"), "workit hook guard"),
      command,
    ).toBe(true);
});

test("Given an installed plugin or a symlink to an entry, When run through it, Then the resolved path names the entry; another package's launch.mjs passes", () => {
  const cursor = path.join(tmp, "cursor-plugin");
  mkdirSync(path.join(cursor, ".cursor-plugin"), { recursive: true });
  mkdirSync(path.join(cursor, "hooks"));
  writeFileSync(path.join(cursor, ".cursor-plugin", "plugin.json"), '{"name":"workit"}');
  writeFileSync(path.join(cursor, "hooks", "launch.mjs"), "");
  const other = path.join(tmp, "other");
  mkdirSync(path.join(other, "hooks"), { recursive: true });
  writeFileSync(path.join(other, "package.json"), '{"name":"other"}');
  writeFileSync(path.join(other, "hooks", "launch.mjs"), "");
  symlinkSync(path.join(ROOT, RUN), path.join(tmp, "renamed.ts"));
  expect(
    hookEntryRun(tmp, "node cursor-plugin/hooks/launch.mjs workit-cursor-hook"),
  ).not.toBeNull();
  expect(hookEntryRun(tmp, "cd cursor-plugin/hooks && node launch.mjs")).not.toBeNull();
  expect(hookEntryRun(tmp, "bun renamed.ts claude_code")).not.toBeNull();
  expect(hookEntryRun(tmp, "node other/hooks/launch.mjs")).toBeNull();
});

test("Given ordinary commands near the hook entry, When an agent runs them, Then the hook guard lets them through", () => {
  for (const command of [
    `ls ${CC}/bin`,
    `ls "$CLAUDE_PLUGIN_ROOT"`,
    `cat ${CC}/bin/workit-hook.mjs`,
    `cat "$CLAUDE_PLUGIN_ROOT/bin/workit-hook.mjs"`,
    `head -20 ${RUN}`,
    `git diff -- ${CC}/bin/workit-hook.mjs`,
    "node --version",
    "git status",
    "rm -rf build",
    "bun run lint",
    "bun test test/workit-core/hooks/hook-entry.test.ts",
    `bun build ${CC}/src/hook.ts --outfile /tmp/x.js`,
    "node scripts/other.mjs",
  ]) {
    expect(hookEntryRun(ROOT, command), command).toBeNull();
    for (const host of HOSTS)
      expect(
        deniedBy(shellPre(ROOT, command, host), "workit hook guard"),
        `${host[1]}: ${command}`,
      ).toBe(false);
  }
});

test("Given a repository ledger, When a command removes or moves it, the git dir or a dir above it, Then every host denies it with the ledger guard", () => {
  const sub = path.join(repo, "sub");
  for (const [cwd, command] of [
    [repo, "rm -rf .git/workit"],
    [repo, "rm -r -f ./.git/workit/"],
    [repo, "rm -rf .git"],
    [repo, "mv .git/workit /tmp/elsewhere"],
    [repo, "mv -t /tmp .git"],
    [repo, "cd .git && rm -rf workit"],
    [repo, "find .git/workit -delete"],
    [repo, "find . -type f -exec rm {} +"],
    [repo, `rm -rf ${repo}`],
    [sub, "rm -rf .."],
    [repo, "sudo rm -rf .git/workit"],
  ])
    for (const host of HOSTS)
      expect(deniedBy(shellPre(cwd, command, host), "ledger guard"), `${host[1]}: ${command}`).toBe(
        true,
      );
  expect(
    deniedBy(
      shellPre(repo, "Remove-Item -Recurse -Force .git/workit", HOSTS[0], "powershell"),
      "ledger guard",
    ),
  ).toBe(true);
});

test("Given a repository ledger, When ordinary removals and git commands run, Then the ledger guard lets them through", () => {
  for (const command of [
    "rm -rf build",
    "rm -f notes.txt",
    "rm -rf node_modules dist",
    "mv a.txt b.txt",
    "rm -f .git/index.lock",
    "git status",
    "git rm -r --cached build",
    "git gc",
    "find . -name x -exec cat {} \\;",
    "find . -name '*.tmp' -delete",
  ])
    for (const host of HOSTS)
      expect(
        deniedBy(shellPre(repo, command, host), "ledger guard"),
        `${host[1]}: ${command}`,
      ).toBe(false);
});

test("Given the launchers' cheap pre-check, When a command may run an entry or remove a ledger's dir, Then it leaves the fast path; plain commands stay", () => {
  for (const command of [...RUNS_ENTRY, "rm -rf ..", "rm -rf /abs/repo", "mv ~/x /tmp"])
    expect(mayHitHookGuard(command), command).toBe(true);
  for (const command of ["ls -la", "rm -rf build", "bun run lint", "echo hi"])
    expect(mayHitHookGuard(command), command).toBe(false);
});

test("Given Claude Code's launcher, When a command runs a hook entry or removes a ledger's dir, Then it reaches the runtime's guard; a plain ls stays fast", () => {
  const env = { WORKIT_CLAUDE_RUNTIME: "source", WORKIT_BUN: path.join(tmp, "no-bun") };
  const reached = (command: string) =>
    runHook(
      PLUGIN_DIR,
      {
        hook_event_name: "PreToolUse",
        session_id: `s-${crypto.randomUUID()}`,
        transcript_path: "/tmp/x.jsonl",
        cwd: tmp,
        permission_mode: "default",
        tool_name: "Bash",
        tool_input: { command, description: "d" },
        tool_use_id: "toolu_hook_entry",
      },
      env,
    ).stderr.includes("hook unavailable");
  for (const command of [
    `echo '{}' | node "$CLAUDE_PLUGIN_ROOT/bin/workit-hook.mjs"`,
    `bun ${RUN} claude_code`,
    "cd packages/workit-core/src/hooks && bun run.ts claude_code",
    "rm -rf ..",
  ])
    expect(reached(command), command).toBe(true);
  expect(reached("ls -la")).toBe(false);
}, 120_000);

test("Given the Claude Code launcher's copy of the pre-check, Then its patterns equal the core module's", () => {
  const core = readFileSync(
    path.join(ROOT, "packages/workit-core/src/hooks/hook-entry-hint.ts"),
    "utf8",
  );
  const launcher = readFileSync(path.join(PLUGIN_DIR, "bin", "workit-hook.mjs"), "utf8");
  for (const name of ["HOOK_ENTRY_TEXT", "RUNS_SCRIPT", "REMOVES_ABOVE"]) {
    const pattern = new RegExp(`const ${name} =\\s*(\\/.+\\/[a-z]+);`);
    expect(pattern.exec(launcher)?.[1], name).toBe(pattern.exec(core)?.[1] ?? "missing");
  }
});

// Verdict mwxpl6dz (#989 round 2): the verifier's cases, compound commands first.
const H = path.join(ROOT, CC, "bin", "workit-hook.mjs");
const R = path.join(ROOT, RUN);
const ROUND_2 = [
  `{ bun ${R} claude_code < ghost.json > ghost.out; }`,
  `if bun ${R} claude_code < ghost.json > ghost.out; then :; fi`,
  `{ echo '{}' | node ${H}; }`,
  `true && { node ${H} < p.json; }`,
  `for i in 1; do node ${H} < p.json; done`,
  `while node ${H} < p.json; do break; done`,
  `until node ${H}; do break; done`,
  `if true; then :; elif x; then node ${H}; else node ${H}; fi`,
  `case x in x) node ${H} < p.json;; esac`,
  `f(){ node ${H}; }; f < p.json`,
  `function f { node ${H}; }; f`,
  `( node ${H} )`,
  `! node ${H}`,
  `bash -c '{ node ${H}; }'`,
  `bash -c 'if true; then node ${H}; fi'`,
  `bash <<'EOF'\n{ node ${H} < p.json; }\nEOF`,
  `bash <<'EOF'\nfor i in 1; do bun ${R} claude_code; done\nEOF`,
  // Wrappers Workit does not follow: denied when their words name an entry beside an interpreter.
  `flock /tmp/l node ${H}`,
  `flock /tmp/l -c 'node ${H}'`,
  `script -qc 'node ${H}' /dev/null`,
  `su -c 'node ${H}' me`,
  `systemd-run --user node ${H}`,
  `parallel node ::: ${H}`,
  `tmux new -d 'node ${H}'`,
  `screen -dm node ${H}`,
  `ssh localhost node ${H}`,
  `docker run --rm -v /:/h node node /h${H}`,
  `find ${path.dirname(H)} -name 'workit-hook.mjs' -exec node {} +`,
  `find ${path.dirname(H)} -name 'w*.mjs' -exec node {} + < p.json`,
  `ls ${H} | xargs node`,
  `echo ${H} | xargs node`,
  `awk 'BEGIN{system("node ${H}")}'`,
  `git -c alias.h='!node ${H}' h`,
  `workit check --name x -- node ${H}`,
  `cmd /c "node C:\\p\\bin\\workit-hook.mjs < p.json"`,
  `cmd /c node C:\\p\\bin\\workit-hook.mjs`,
  `cmd /c start node C:\\p\\bin\\workit-hook.mjs`,
  // Options through the environment.
  `NODE_OPTIONS='--import ${H}' node -e 0`,
  `NODE_OPTIONS=--import=${H} node -e 0`,
  `NODE_OPTIONS='-r ${H}' node -e 0`,
  `export NODE_OPTIONS="--require ${H}"; node -e 0`,
  `BUN_OPTIONS='--preload ${R}' bun -e 0`,
  `export BUN_OPTIONS='--preload ${R}' && bun -e 0`,
  `node --import ${H} -e 0`,
  `bun --preload ${R} -e 0`,
  // File descriptors and stdin.
  `node <(cat ${H})`,
  `bash <(cat ${H})`,
  `exec 3<${H}; node /dev/fd/3 < p.json`,
  `cat ${H} | node`,
  `cat ${H} | node --input-type=module -`,
  // Literal substitutions.
  `P=$(ls ${H}); node "$P" < p.json`,
  `node "$(printf %s ${H})"`,
  `node $(echo ${path.dirname(H)}/workit-h)ook.mjs`,
];

test("Given the round-2 spellings (compound commands, unfollowed wrappers, NODE_OPTIONS, fds), When an agent runs them, Then every host denies them with the hook guard", () => {
  for (const command of ROUND_2) {
    expect(hookEntryRun(ROOT, command), command).not.toBeNull();
    for (const host of HOSTS)
      expect(
        deniedBy(shellPre(ROOT, command, host), "workit hook guard"),
        `${host[1]}: ${command}`,
      ).toBe(true);
  }
  const list = path.join(tmp, "list.txt");
  writeFileSync(list, `${H}\n`);
  expect(hookEntryRun(ROOT, `xargs node < ${list}`)).not.toBeNull();
  for (const command of [
    `start node C:\\Users\\u\\.claude\\plugins\\cache\\workit\\workit\\1.11.0\\bin\\workit-hook.mjs`,
    `Start-Process node -ArgumentList 'C:\\p\\bin\\workit-hook.mjs'`,
    `Get-Content p.json | node $env:CLAUDE_PLUGIN_ROOT\\bin\\workit-hook.mjs`,
  ])
    expect(
      deniedBy(shellPre(ROOT, command, HOSTS[0], "powershell"), "workit hook guard"),
      command,
    ).toBe(true);
});

test("Given a ledger, When a removal names it through a glob, $PWD, find tests or rsync --delete, Then every host denies it", () => {
  for (const [cwd, command] of [
    [repo, "rm -rf .git/w*"],
    [repo, "rm -rf .git/workit/*"],
    [repo, "cd .git/workit && rm -rf *"],
    [repo, "cd .git/workit && rm -rf ."],
    [repo, "rm -rf .[!.]* *"],
    [repo, "rm -rf $PWD/.git/workit"],
    [repo, "rm -rf ${PWD}/.git"],
    [repo, "D=.git/workit; rm -rf $D"],
    [repo, "rm -rf ./.git/../.git/workit"],
    [repo, "find .git/workit -name '*.jsonl' -delete"],
    [repo, "find .git/workit -name '*' -delete"],
    [repo, "find .git -path '*workit*' -delete"],
    [repo, "find . -name ledger -exec rm -rf {} +"],
    [repo, "find .git/workit -type f -exec rm {} +"],
    [repo, "find . -delete"],
    [repo, `rsync -a --delete ${tmp}/empty/ .git/workit/`],
    [repo, `rsync -a --delete-after ${tmp}/empty/ .git/workit/ledger/`],
  ])
    for (const host of HOSTS)
      expect(deniedBy(shellPre(cwd, command, host), "ledger guard"), `${host[1]}: ${command}`).toBe(
        true,
      );
});

// The verifier's ordinary commands (verdict mwxpl6dz): none of them meets either guard.
const ORDINARY = [
  `cat ${H}`,
  `ls -la ${path.dirname(H)}`,
  "ls ~/.claude/plugins/cache/workit/workit/",
  `head -50 ${R}`,
  `grep -n fastAllow ${H}`,
  `git diff -- ${CC}/bin/workit-hook.mjs`,
  `wc -l ${R}`,
  "bun run build",
  "bun test test/workit-core/hooks/hook-entry.test.ts",
  "bun test test/workit-claude-code/workit-hook.test.ts",
  `bun build ${R} --outfile ${tmp}/out.js`,
  "bun packages/workit-claude-code/scripts/build.ts",
  "node scripts/build.mjs",
  "node --test test/*.test.js",
  "npx tsx src/index.ts",
  "npx tsc --noEmit",
  "bunx oxlint",
  `oxfmt ${CC}/bin/workit-hook.mjs`,
  `git add ${CC}/bin/workit-hook.mjs && git status`,
  `cp ${H} ${tmp}/copy-for-reading.txt`,
  `diff ${H} ${ROOT}/${CC}/bin/workit-hook.mjs`,
  `node -e "console.log('workit-hook.mjs')"`,
  "echo node workit-hook.mjs",
  "workit doctor",
  "workit check lint",
  "node --version",
  "bash scripts/release.sh",
  "sh ./session-start.sh",
  "node server.js",
  "bun run dev",
  "find . -name '*.tmp' -delete",
  "find . -name node_modules -prune -o -name '*.log' -exec rm {} +",
  "find /tmp/build -delete",
  `find ${tmp}/junk -type f -delete`,
  "rm -rf node_modules dist",
  "rm -rf ./build",
  `rm -rf ${tmp}/junk`,
  "rm a.txt",
  "mv a.txt b.txt",
  `rm -rf ${tmp}/clone`,
  "rm -rf /tmp/some-test-repo",
  "rm -rf ./*",
  "git status",
  "git checkout -b feature/y",
  "git stash",
  "git worktree remove ../wt-x",
  "git branch -D old",
  "git rm a.txt",
  "git mv a.txt c.txt",
  "git clean -fd",
  "git reset --hard HEAD~1",
  "rm -rf ~/.cache/foo",
  "rm -rf $TMPDIR/x",
  "mv ~/Downloads/a.zip .",
  "rm ../sibling/file.txt",
  "rm -f *.log",
  'git commit -m "fix: node bin/workit-hook.mjs is the hook"',
  `find . -name '*.ts' | while read f; do grep -c x "$f"; done`,
  "find . -name '*.test.mjs' -exec node {} +",
];

test("Given the verifier's ordinary commands in a repository with a ledger, When run, Then neither the hook guard nor the ledger guard denies them", () => {
  for (const command of ORDINARY)
    for (const host of HOSTS) {
      const decision = shellPre(repo, command, host);
      expect(
        deniedBy(decision, "workit hook guard") || deniedBy(decision, "ledger guard"),
        `${host[1]}: ${command}`,
      ).toBe(false);
    }
});
