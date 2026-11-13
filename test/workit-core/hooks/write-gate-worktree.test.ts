// `git worktree add <path>` writes a whole checkout at <path>: the write gate
// counts <path> as a write (past `-b`/`-B`/`--reason` values, relative to
// `git -C <dir>`), so the guarded-path check and implementer confinement see
// it on every host's entry. These tests only dispatch the hooks: no command
// below is ever run.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grantsHome } from "@/packages/workit-core/src/autonomy";
import { configDir } from "@/packages/workit-core/src/core/workit-paths.mjs";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { codexAdapter } from "@/packages/workit-core/src/hooks/hosts/codex";
import { cursorAdapter } from "@/packages/workit-core/src/hooks/hosts/cursor";
import { shellMutationTargets } from "@/packages/workit-core/src/hooks/write-gate";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { fixture } from "./hook-fixtures";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-gate-worktree-")));
const home = path.join(base, "home");
const state = path.join(base, "state");
const root = path.join(base, "repo");
const KEYS = [
  "HOME",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "WORKIT_CONFIG",
  "WORKIT_CONFIG_DIR",
  "WORKIT_STATE_DIR",
];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const savedResolve = grantsHome.resolve;
beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.WORKIT_STATE_DIR = state;
  grantsHome.resolve = () => path.join(base, "account");
});
afterEach(() => {
  grantsHome.resolve = savedResolve;
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const sh = (file: string) => file.replaceAll("\\", "/");
const ACCOUNT = configDir({ HOME: path.join(base, "account") });
const ISSUED = path.join(state, "issued");
for (const dir of [ISSUED, ACCOUNT, root]) mkdirSync(dir, { recursive: true });

type Verdict = { deny: boolean; reason: string };
type Out = { permissionDecision?: string; permissionDecisionReason?: string };
const SHELLS: Record<string, (command: string) => Verdict> = {
  "Claude Code": (command) => {
    const payload = fixture("claude-code", "pre-tool-use-write", root, {
      tool_name: "Bash",
      tool_input: { command },
    });
    const out = (dispatchHook(claudeCodeAdapter, payload).json as { hookSpecificOutput?: Out })
      .hookSpecificOutput;
    return {
      deny: out?.permissionDecision === "deny",
      reason: out?.permissionDecisionReason ?? "",
    };
  },
  Codex: (command) => {
    const payload = fixture("codex", "pre-tool-use-bash", root, { tool_input: { command } });
    const out = (dispatchHook(codexAdapter, payload).json as { hookSpecificOutput?: Out })
      .hookSpecificOutput;
    return {
      deny: out?.permissionDecision === "deny",
      reason: out?.permissionDecisionReason ?? "",
    };
  },
  Cursor: (command) => {
    const out = dispatchHook(
      cursorAdapter,
      fixture("cursor", "before-shell-execution", root, { command }),
    ).json as { permission?: string; agent_message?: string };
    return { deny: out.permission === "deny", reason: out.agent_message ?? "" };
  },
  OpenCode: (command) => {
    const event = { action: "shell", resources: [command], effect: "allow", message: "" };
    evaluateShellPermission(root, event);
    return { deny: event.effect === "deny", reason: event.message };
  },
  Pi: (command) => {
    const ctx = { cwd: root, isProjectTrusted: () => true } as never;
    const out = enforceToolPolicy({ toolName: "bash", input: { command } } as never, ctx) as
      | { block?: boolean; reason?: string }
      | undefined;
    return { deny: Boolean(out?.block), reason: out?.reason ?? "" };
  },
};

test("Given git worktree add, When its path spells out flags, values and -C, Then the gate counts the new checkout's path as a write", () => {
  const targets = (command: string) => shellMutationTargets(root, command, "posix", true);
  const tmp = path.join(base, "tmp-wt");
  for (const command of [
    `git worktree add ${sh(tmp)}`,
    `git worktree add -b feature/x ${sh(tmp)} main`,
    `git worktree add --reason why -B y --detach ${sh(tmp)}`,
    `git -C ${sh(base)} worktree add tmp-wt`,
  ])
    expect(
      targets(command).map((target) => path.resolve(target)),
      command,
    ).toContain(tmp);
  expect(targets(`git worktree list`).some((target) => path.resolve(target) === tmp)).toBeFalse();
});

test("Given git worktree add into a guarded dir (the issued registry, the account config dir), When each host's shell gate judges it, Then it is denied; into a temp path it is allowed", () => {
  const guarded = [
    `git worktree add ${sh(path.join(ISSUED, "wt"))}`,
    `git worktree add -b x ${sh(path.join(ACCOUNT, "wt"))}`,
    `git -C ${sh(state)} worktree add issued/wt`,
  ];
  const free = `git worktree add -b feature/x ${sh(path.join(base, "tmp-wt"))}`;
  for (const [host, run] of Object.entries(SHELLS)) {
    for (const command of guarded) expect(run(command).deny, `${host}: ${command}`).toBeTrue();
    expect(run(free).deny, `${host}: ${free}`).toBeFalse();
  }
});
