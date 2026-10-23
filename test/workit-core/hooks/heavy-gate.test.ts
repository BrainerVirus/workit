// Issue #325, ruling mvid5onk: a raw heavy command runs under the heavy-check
// lease on every host, after every Workit gate passed on the original, and
// only where no host permission rule names it. One simple heavy command is
// rewritten (Claude Code, OpenCode, Pi) or denied with the exact rewrite
// (Codex, Cursor); a chain with heavy parts is denied with the split, never
// wrapped in `bash -c`; the gates judge `workit check … -- <cmd>` as if the
// command ran raw.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { markerFile } from "@/packages/workit-core/src/core/live-session";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { handleCodexHook } from "@/packages/workit-codex/hooks/workit-hook";
import { handleCursorHook } from "@/packages/workit-cursor/hooks/workit-hook";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { observeShellBefore } from "@/packages/workit-opencode/src/v2/shell";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { main } from "@/packages/workit-cli/src/main";

const KEYS = [
  "PATH",
  "HOME",
  "WORKFLOW_TOOLKIT_STATE",
  "WORKFLOW_TOOLKIT_CONFIG_DIR",
  "WORKFLOW_TOOLKIT_CONFIG",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const dirs: string[] = [];
let home: string;
let state: string;
let sleeper: ChildProcess | undefined;

beforeAll(() => {
  const bin = mkdtempSync(path.join(tmpdir(), "workit-heavy-bin-"));
  writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "workit"), 0o755);
  home = mkdtempSync(path.join(tmpdir(), "workit-heavy-home-"));
  state = mkdtempSync(path.join(tmpdir(), "workit-heavy-gate-state-"));
  const config = mkdtempSync(path.join(tmpdir(), "workit-heavy-config-"));
  writeFileSync(
    path.join(config, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
  dirs.push(bin, home, state, config);
  for (const key of [
    "CLAUDE_PROJECT_DIR",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "WORKFLOW_TOOLKIT_CONFIG",
  ])
    delete process.env[key];
  Object.assign(process.env, {
    PATH: `${bin}${path.delimiter}${saved.PATH ?? ""}`,
    HOME: home,
    WORKFLOW_TOOLKIT_STATE: state,
    WORKFLOW_TOOLKIT_CONFIG_DIR: config,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
  });
});
afterEach(() => {
  rmSync(path.join(state, "heavy-commands.json"), { force: true });
  rmSync(path.join(home, ".claude"), { recursive: true, force: true });
  rmSync(path.join(home, ".codex"), { recursive: true, force: true });
  rmSync(path.join(home, ".cursor"), { recursive: true, force: true });
  rmSync(path.join(home, ".config"), { recursive: true, force: true });
});
afterAll(() => {
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  sleeper?.kill();
});

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });

/** A Workit-managed git checkout on feature/x (its store dir exists). */
const repo = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-heavy-gate-")));
  dirs.push(root);
  git(root, "init", "-q", "-b", "feature/x");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, ".git", "workit"));
  return root;
};

const claude = (root: string, command: string, extra: Record<string, unknown> = {}) =>
  dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: root,
    transcript_path: "/tmp/transcript.jsonl",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command, description: "run it" },
    tool_use_id: "toolu_1",
    ...extra,
  }).json.hookSpecificOutput as
    | {
        permissionDecision?: string;
        permissionDecisionReason?: string;
        updatedInput?: Record<string, unknown>;
        additionalContext?: string;
      }
    | undefined;

const codex = (root: string, command: string) =>
  handleCodexHook({
    session_id: "session-1",
    cwd: root,
    model: "test",
    permission_mode: "default",
    transcript_path: null,
    hook_event_name: "PreToolUse",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
    tool_name: "bash",
    tool_input: { command },
  }).hookSpecificOutput as {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };

const cursor = (root: string, command: string) =>
  handleCursorHook({
    hook_event_name: "beforeShellExecution",
    conversation_id: "session-1",
    workspace_roots: [root],
    cwd: root,
    command,
  }) as { permission?: string; agent_message?: string };

const pi = (root: string, command: string) => {
  const input = { command };
  const result = enforceToolPolicy(
    { toolName: "bash", toolCallId: "call-1", input } as never,
    { cwd: root, isProjectTrusted: () => true } as never,
  ) as { block?: boolean; reason?: string } | undefined;
  return { result, command: input.command };
};

/** OpenCode: execute.before (the rewrite), then permission.evaluate on what will run. */
const opencode = (root: string, command: string, effect = "allow") => {
  const input = { command };
  observeShellBefore(root, { tool: "shell", sessionID: "ses_1", id: "call-1", input }, new Map());
  const event = {
    sessionID: "ses_1",
    action: "shell",
    resources: [input.command],
    effect,
    message: undefined as string | undefined,
  };
  evaluateShellPermission(root, event);
  return { command: input.command, effect: event.effect, message: event.message };
};

test("Given a raw `npx jest` on Claude Code, When the hook runs, Then updatedInput runs it under the lease with no permission decision and a wait below the tool timeout", () => {
  const output = claude(repo(), "npx jest");
  expect(output?.permissionDecision).toBeUndefined();
  expect(output?.updatedInput).toEqual({
    command: "workit check --heavy -- npx jest",
    description: "run it",
  });
  expect(output?.additionalContext).toContain("heavy-check lease");
});

test("Given a raw `npx jest` on OpenCode and Pi, When the shell hook runs, Then the input is rewritten in place and nothing is denied", () => {
  const root = repo();
  expect(opencode(root, "npx jest")).toEqual({
    command: "workit check --heavy -- npx jest",
    effect: "allow",
    message: undefined,
  });
  expect(pi(root, "npx jest")).toEqual({
    result: undefined,
    command: "workit check --heavy -- npx jest",
  });
});

test("Given a raw `npm run test:ci` or `pip install requests` on Codex or Cursor, When the hook runs, Then it is denied with the exact workit check --heavy rewrite", () => {
  const root = repo();
  for (const command of ["npm run test:ci", "pip install requests"]) {
    const exact = `Run exactly: workit check --heavy -- ${command}`;
    const codexOutput = codex(root, command);
    expect(codexOutput.permissionDecision).toBe("deny");
    expect(codexOutput.permissionDecisionReason).toContain(exact);
    const cursorOutput = cursor(root, command);
    expect(cursorOutput.permission).toBe("deny");
    expect(cursorOutput.agent_message).toContain(exact);
  }
});

test("Given the rewritten command, When any host's hook sees it, Then it passes unchanged (no double wrap)", () => {
  const root = repo();
  const wrapped = "workit check --heavy -- npm run test:ci";
  expect(codex(root, wrapped).permissionDecision).toBeUndefined();
  expect(cursor(root, wrapped).permission).not.toBe("deny");
  expect(claude(root, wrapped)?.updatedInput).toBeUndefined();
  expect(pi(root, wrapped)).toEqual({ result: undefined, command: wrapped });
  expect(opencode(root, wrapped).command).toBe(wrapped);
});

test("Given `git status --short && make test && touch pwned.txt`, When each host's hook runs, Then it is denied with the split and never rewritten", () => {
  // One checkout per host: the touch makes each session claim its checkout.
  const command = "git status --short && make test && touch pwned.txt";
  const split = "workit check --heavy -- make test";
  const claudeRoot = repo();
  const reasons = [
    claude(claudeRoot, command)?.permissionDecisionReason,
    codex(repo(), command).permissionDecisionReason,
    cursor(repo(), command).agent_message,
  ];
  expect(claude(claudeRoot, command)?.updatedInput).toBeUndefined();
  const piRun = pi(repo(), command);
  expect(piRun.command).toBe(command);
  expect(piRun.result?.block).toBe(true);
  reasons.push(piRun.result?.reason);
  const oc = opencode(repo(), command);
  expect(oc.command).toBe(command);
  expect(oc.effect).toBe("deny");
  reasons.push(oc.message);
  for (const reason of reasons) {
    expect(reason).toContain(split);
    expect(reason).not.toContain("bash -c");
  }
});

test("Given a gate bypass inside the wrapper, When each host's hook runs, Then it is denied like the raw form", () => {
  const root = repo();
  for (const command of [
    "workit check --heavy -- bash -c 'gh pr merge 1'",
    "workit check -- gh pr merge 1",
  ]) {
    expect(claude(root, command)?.permissionDecision, command).toBe("deny");
    expect(codex(root, command).permissionDecision, command).toBe("deny");
    expect(cursor(root, command).permission, command).toBe("deny");
    expect(pi(root, command).result?.block, command).toBe(true);
    expect(opencode(root, command).effect, command).toBe("deny");
  }
});

test("Given `workit check -- git checkout -b x`, When the hook runs, Then branch policy judges the inner branch", () => {
  const root = repo();
  const output = claude(root, "workit check -- git checkout -b x");
  expect(output?.permissionDecision).toBe("deny");
  expect(output?.permissionDecisionReason).toContain("branch_policy_denied");
  expect(opencode(root, "workit check -- git checkout -b x").effect).toBe("deny");
});

test("Given an open product choice, When a write runs inside the wrapper, Then the before-write gate denies it like raw touch", () => {
  const root = repo();
  const core = new WorkitCore(new TaskStore(root), {
    root,
    caller: { host: "workit_cli", actor: "cli" },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  expect(core.policy({ action: "assess", productChoiceOpen: "yes" }).ok).toBe(true);
  for (const command of [
    "touch src/a.ts",
    "workit check -- touch src/a.ts",
    "workit check -- bash -c 'echo x > src/a.ts'",
  ]) {
    expect(claude(root, command)?.permissionDecisionReason, command).toContain("before-write gate");
    expect(cursor(root, command).permission, command).toBe("deny");
    expect(pi(root, command).result?.block, command).toBe(true);
    expect(opencode(root, command).effect, command).toBe("deny");
  }
});

test("Given another live session owns the checkout, When a write runs inside the wrapper, Then the live-session guard denies it", () => {
  const root = repo();
  sleeper ??= spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
  const file = markerFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      session: "other-session",
      leads: ["other-session"],
      host: "opencode",
      pid: sleeper.pid,
      machine: os.hostname(),
      checkout: root,
      heartbeatAt: new Date().toISOString(),
    }),
  );
  const output = claude(root, "workit check -- touch src/a.ts");
  expect(output?.permissionDecisionReason).toContain("live-session guard");
});

test("Given Claude Code rules, When a heavy command is named or only workit is allowlisted, Then it runs as typed with a note, and bypassPermissions skips the allowlist check", () => {
  const root = repo();
  const settings = path.join(home, ".claude", "settings.json");
  mkdirSync(path.dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ permissions: { deny: ["Bash(npx:*)"] } }));
  const named = claude(root, "npx jest");
  expect(named?.updatedInput).toBeUndefined();
  expect(named?.permissionDecision).toBeUndefined();
  expect(named?.additionalContext).toContain("runs outside the heavy-check lease");
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(workit:*)"] } }));
  expect(claude(root, "make test")?.updatedInput).toBeUndefined();
  expect(claude(root, "make test", { permission_mode: "bypassPermissions" })?.updatedInput).toEqual(
    {
      command: "workit check --heavy -- make test",
      description: "run it",
    },
  );
  writeFileSync(settings, "{ broken");
  expect(claude(root, "make test")?.updatedInput).toBeUndefined();
});

test("Given OpenCode permission rules, When a heavy command runs, Then a named one is left alone and the host's decision stands", () => {
  const root = repo();
  writeFileSync(
    path.join(root, "opencode.json"),
    JSON.stringify({ permission: { bash: { "npx *": "deny" } } }),
  );
  expect(opencode(root, "npx jest", "deny")).toMatchObject({ command: "npx jest", effect: "deny" });
  writeFileSync(
    path.join(root, "opencode.json"),
    JSON.stringify({ permission: { bash: { "workit *": "allow", "*": "ask" } } }),
  );
  expect(opencode(root, "make test", "ask")).toMatchObject({ command: "make test", effect: "ask" });
  rmSync(path.join(root, "opencode.json"));
  expect(opencode(root, "git status && npm test", "ask")).toMatchObject({ effect: "ask" });
});

test("Given `gh pr merge 1 && npm test` on OpenCode, When it runs, Then the raw-git deny stands and the input is unchanged", () => {
  const root = repo();
  const result = opencode(root, "gh pr merge 1 && npm test");
  expect(result.command).toBe("gh pr merge 1 && npm test");
  expect(result.effect).toBe("deny");
  expect(result.message).not.toContain("heavy_command");
});

test("Given a Codex rule or a Cursor deny naming npx, When `npx jest` runs, Then it passes through", () => {
  const root = repo();
  mkdirSync(path.join(home, ".codex", "rules"), { recursive: true });
  writeFileSync(
    path.join(home, ".codex", "rules", "default.rules"),
    'prefix_rule(pattern=["npx"], decision="forbidden")\n',
  );
  expect(codex(root, "npx jest").permissionDecision).toBeUndefined();
  mkdirSync(path.join(root, ".cursor"), { recursive: true });
  writeFileSync(
    path.join(root, ".cursor", "cli.json"),
    JSON.stringify({ permissions: { deny: ["Shell(npx)"] } }),
  );
  expect(cursor(root, "npx jest").permission).not.toBe("deny");
});

test("Given light commands (ls, git status), When the hook runs on each host, Then nothing changes", () => {
  const root = repo();
  for (const command of ["ls", "git status"]) {
    const output = claude(root, command);
    expect(output?.updatedInput).toBeUndefined();
    expect(output?.permissionDecision).toBeUndefined();
    expect(codex(root, command).permissionDecision).toBeUndefined();
    expect(cursor(root, command).permission).not.toBe("deny");
    expect(pi(root, command)).toEqual({ result: undefined, command });
    expect(opencode(root, command).command).toBe(command);
  }
});

test("Given `workit lock heavy add 'mvn verify'` and a custom pattern, When those commands run next, Then they are gated", async () => {
  const root = repo();
  const io = { cwd: root, env: process.env, stdout: () => {}, stderr: () => {} };
  expect(codex(root, "./ci/integration.sh --all").permissionDecision).toBeUndefined();
  expect(await main(["lock", "heavy", "add", "mvn verify"], io)).toBe(0);
  expect(await main(["lock", "heavy", "add", "./ci/integration.sh"], io)).toBe(0);
  expect(existsSync(path.join(state, "heavy-commands.json"))).toBe(true);
  expect(codex(root, "mvn verify").permissionDecisionReason).toContain(
    "Run exactly: workit check --heavy -- mvn verify",
  );
  expect(codex(root, "./ci/integration.sh --all").permissionDecisionReason).toContain(
    "Run exactly: workit check --heavy -- ./ci/integration.sh --all",
  );
  expect(opencode(root, "./ci/integration.sh --all").command).toBe(
    "workit check --heavy -- ./ci/integration.sh --all",
  );
});

test("Given no workit on PATH or a directory outside git, When a heavy command runs, Then the gate stays out of the way", () => {
  const root = repo();
  const outside = mkdtempSync(path.join(tmpdir(), "workit-heavy-nogit-"));
  dirs.push(outside);
  expect(opencode(outside, "npx jest").command).toBe("npx jest");
  expect(existsSync(path.join(outside, ".workit"))).toBe(false);
  const before = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    expect(codex(root, "npx jest").permissionDecision).toBeUndefined();
    expect(opencode(root, "npx jest").command).toBe("npx jest");
  } finally {
    process.env.PATH = before;
  }
});

/** The flags `workit check` accepts in 8.14.0, the oldest CLI the plugin may meet. */
const CLI_8_14_FLAGS = new Set([
  "--heavy",
  "--name",
  "--shell",
  "--timeout",
  "--task",
  "--json",
  "--",
]);
const wrapperFlags = (command: string): string[] => {
  const words = command.split(/\s+/u);
  const at = words.indexOf("check");
  const end = words.indexOf("--", at);
  return [...words.slice(at + 1, end).filter((word) => word.startsWith("-")), "--"];
};

test("Given a plugin newer than the CLI, When each rewrite host wraps a heavy command, Then the wrapper uses only flags CLI 8.14.0 accepts, whatever the tool timeout", () => {
  const root = repo();
  const rewrites = [
    claude(root, "make test", { tool_input: { command: "make test", timeout: 600000 } })
      ?.updatedInput?.command,
    claude(root, "npx jest")?.updatedInput?.command,
    pi(root, "make test").command,
  ];
  const input = { command: "make test", timeout: 600000 };
  observeShellBefore(root, { tool: "shell", sessionID: "ses_2", id: "call-2", input }, new Map());
  rewrites.push(input.command);
  for (const command of rewrites) {
    expect(String(command)).toStartWith("workit check --heavy");
    for (const flag of wrapperFlags(String(command)))
      expect(CLI_8_14_FLAGS.has(flag), `${String(command)}: ${flag}`).toBe(true);
  }
});

// Issue #388: `cd <dir> && workit …` is rewritten to `workit --cwd <dir> …` on
// Claude Code (updatedInput, no permission decision); every other shape is left alone.
test("Given `cd /tmp/wt && workit pr merge --pr 7 2>&1 | tail -3` on Claude Code, When PreToolUse runs, Then updatedInput.command is the --cwd form with the filter kept", () => {
  const output = claude(repo(), "cd /tmp/wt && workit pr merge --pr 7 2>&1 | tail -3");
  expect(output?.permissionDecision).toBeUndefined();
  expect(output?.updatedInput).toEqual({
    command: "workit pr --cwd /tmp/wt merge --pr 7 2>&1 | tail -3",
    description: "run it",
  });
});

test("Given a quoted literal directory, When PreToolUse runs, Then the quoting is kept in the rewrite", () => {
  expect(
    claude(repo(), `cd "/tmp/my wt" && workit git push | head -5`)?.updatedInput?.command,
  ).toBe(`workit git --cwd "/tmp/my wt" push | head -5`);
});

// Issue #297: the verb goes first so an enumerated `Bash(workit <verb> *)` rule matches.
test.each([
  ["cd /x && workit --json pr status", "workit pr --cwd /x --json status"],
  ["cd /x && workit check test", "workit --cwd /x check test"],
  [
    "workit --cwd /tmp/wt git commit -m 'feat: x' -- a.ts",
    "workit git --cwd /tmp/wt commit -m 'feat: x' -- a.ts",
  ],
  ["workit --json --cwd=/w pr merge --pr 7", "workit pr --json --cwd=/w merge --pr 7"],
  [
    `workit --cwd "/tmp/my wt" ledger verdict verified`,
    `workit ledger --cwd "/tmp/my wt" verdict verified`,
  ],
])("Given `%s` on Claude Code, When PreToolUse runs, Then it becomes `%s`", (command, expected) => {
  const output = claude(repo(), command);
  expect(output?.permissionDecision).toBeUndefined();
  expect(output?.updatedInput?.command).toBe(expected);
});

test.each([
  ["workit --cwd /x check -- rm -rf y"],
  ["workit --cwd /x lock run -- rm -rf y"],
  ["workit --cwd /x grant set w merge=true"],
  ["workit --session s --cwd /x git push"],
  ["workit --cwd $W git push"],
  ["workit git push --cwd /x"],
])(
  "Given `%s` on Claude Code, When PreToolUse runs, Then the words are not reordered",
  (command) => {
    expect(claude(repo(), command)?.updatedInput).toBeUndefined();
  },
);

test.each([
  ['cd "$W" && workit git push'],
  ["cd $W && workit git push"],
  ["cd - && workit git push"],
  ["cd && workit git push"],
  ["cd /x; workit git push"],
  ["cd /x || workit git push"],
  ["cd /x && workit git push && git log"],
  ["cd /x && git log && workit git push"],
  ["cd /x && workit git push ; echo done"],
  ["cd /x && workit git push | tee out.txt"],
  ["cd /x && workit git push > out.txt"],
  ["cd /x && workit git push | tail -3 && echo hi"],
  ["cd /x && workit --cwd /y git push"],
  ["cd /x && FOO=1 workit git push"],
  ["cd /x && workit git push &"],
  ["cd /x && workit git push $(date)"],
  ["cd /x && workit git push --cwd=/y"],
  ["cd /x && workit pr status | grep -r y ."],
  ["cd /x && workit pr status | grep y notes.txt"],
  ["cd /x && workit pr status | tail -F relfile"],
  ["cd /x && workit pr status | head --output=f"],
])("Given `%s` on Claude Code, When PreToolUse runs, Then it is not rewritten", (command) => {
  expect(claude(repo(), command)?.updatedInput).toBeUndefined();
});

test("Given a cd-workit compound on Codex and Cursor, When the hook runs, Then it is neither denied nor rewritten", () => {
  const root = repo();
  const command = "cd /tmp/wt && workit pr merge --pr 7";
  expect(codex(root, command)?.permissionDecision).toBeUndefined();
  expect(cursor(root, command).permission).not.toBe("deny");
});

test("Given a cd-workit compound wrapping a heavy command, When PreToolUse runs, Then it is never rewritten to a command that skips the lease", () => {
  const output = claude(repo(), "cd /tmp/wt && workit check test -- npx jest");
  expect(output?.permissionDecision).toBeUndefined();
  expect(String(output?.updatedInput?.command ?? "workit")).toStartWith("workit");
});
