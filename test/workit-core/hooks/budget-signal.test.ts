// Retro P9: a worker's brief names `N tool calls`; at N (and 2N) one line
// tells it to checkpoint, report and stop, on the standing-order channel.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  budgetLine,
  claimSpawnBudget,
  noteSpawnBudget,
  observeHookBudget,
  spawnBudget,
  tickBudget,
} from "@/packages/workit-core/src/hooks/budget-signal";
import { handleHook } from "@/packages/workit-core/src/hooks/handle";
import { CLAUDE_CODE_DESCRIPTOR } from "@/packages/workit-core/src/hooks/hosts/claude-code";
import { CODEX_DESCRIPTOR } from "@/packages/workit-core/src/hooks/hosts/codex";
import type { HookDecision, HookInput } from "@/packages/workit-core/src/hooks/protocol";

const LEAD = "11111111-aaaa-bbbb-cccc-000000000002";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repo = (): string => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-budget-")));
  dirs.push(root);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
};

const brief = (n: number) =>
  `GOAL: x\nTIMEBOX: 30 minutes, ${n} tool calls; past it without a new commit you will be replaced\n`;

const call = (cwd: string, host: HookInput["host"], agentId: string | null): HookInput => ({
  host,
  cwd,
  session: { id: LEAD, agentId, agentType: null, parentId: agentId ? LEAD : null },
  permissionMode: "default",
  transcriptPath: null,
  event: { kind: "tool.pre", tool: "Read", toolUseId: "t1" },
});

const start = (cwd: string, host: HookInput["host"], agentId: string, type: string): HookInput => ({
  ...call(cwd, host, null),
  event: { kind: "subagent.start", agentId, agentType: type, task: null },
});

const text = (decision: HookDecision): string | null =>
  decision.kind === "context" ? decision.text : null;

const LINE = "Tool-call budget reached (3): commit your work, write your report, stop.";

for (const [host, descriptor] of [
  ["claude_code", CLAUDE_CODE_DESCRIPTOR],
  ["codex_cli", CODEX_DESCRIPTOR],
] as const)
  test(`[${host}] Given a worker spawned with a budget of 3, When it makes its 3rd and 6th call, Then one line each, never a deny`, () => {
    const root = repo();
    const deps = { descriptor, addendum: null };
    noteSpawnBudget(root, LEAD, "workit:implementer", brief(3));
    handleHook(start(root, host, "agent-1", "workit:implementer"), deps);
    const told: Array<string | null> = [];
    for (let i = 1; i <= 7; i++) {
      const due = tickBudget(root, LEAD, "agent-1");
      expect(due, `call ${i}`).toBe(i === 3 || i === 6);
      const decision = handleHook(call(root, host, "agent-1"), deps);
      expect(decision.kind === "deny").toBe(false);
      told.push(text(decision));
    }
    expect(told).toEqual([
      null,
      null,
      LINE,
      null,
      null,
      "Tool-call budget reached (6): commit your work, write your report, stop.",
      null,
    ]);
  });

test("Given no budget on the spawn, When the worker calls tools, Then nothing is counted or said", () => {
  const root = repo();
  const deps = { descriptor: CLAUDE_CODE_DESCRIPTOR, addendum: null };
  noteSpawnBudget(root, LEAD, "workit:implementer", "GOAL: x\nTIMEBOX: 30 minutes\n");
  handleHook(start(root, "claude_code", "agent-1", "workit:implementer"), deps);
  for (let i = 0; i < 5; i++) expect(tickBudget(root, LEAD, "agent-1")).toBe(false);
  expect(budgetLine(root, LEAD, "agent-1")).toBeNull();
});

test("Given two queued spawns, When subagents start, Then each claims the budget of its own type once", () => {
  const root = repo();
  noteSpawnBudget(root, LEAD, "workit:implementer", brief(5));
  noteSpawnBudget(root, LEAD, "workit:verifier", brief(7));
  expect(claimSpawnBudget(root, LEAD, "v", "workit:verifier")).toBe(7);
  expect(claimSpawnBudget(root, LEAD, "i", "workit:implementer")).toBe(5);
  expect(claimSpawnBudget(root, LEAD, "j", "workit:implementer")).toBeNull();
});

test("Given TIMEBOX lines, Then only `N tool calls` on the TIMEBOX line is a budget", () => {
  expect(spawnBudget(brief(120))).toBe(120);
  expect(spawnBudget("TIMEBOX: 45 minutes\nnotes: 9 tool calls")).toBeNull();
  expect(spawnBudget("TIMEBOX: 0 tool calls")).toBeNull();
});

test("Given the Claude Code launcher's copy, Then it parses the same TIMEBOX budget as core", () => {
  const launcher = readFileSync(
    path.resolve(import.meta.dir, "../../../packages/workit-claude-code/bin/workit-hook.mjs"),
    "utf8",
  );
  const core = readFileSync(
    path.resolve(import.meta.dir, "../../../packages/workit-core/src/hooks/budget-signal.ts"),
    "utf8",
  );
  const pattern = (source: string) => /\/\^TIMEBOX:[^\n]*?\/mu/u.exec(source)?.[0] ?? "(missing)";
  expect(pattern(launcher)).toBe(pattern(core));
  for (const source of [launcher, core]) {
    expect(source).toContain('"budget"');
    expect(source).toContain("`spawns-${");
    expect(source).toContain("`${base}.calls`");
  }
});

test("[codex] Given a lead tool call whose input carries a 2-call brief, When the subagent's PreToolUse payloads arrive, Then the 2nd is due", () => {
  const root = repo();
  const pre = (extra: Record<string, unknown>) =>
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: LEAD, cwd: root, ...extra });
  expect(
    observeHookBudget(
      pre({ tool_name: "spawn_agent", tool_input: { agent_type: "worker", message: brief(2) } }),
    ),
  ).toBe(false);
  expect(claimSpawnBudget(root, LEAD, "agent-x", "worker")).toBe(2);
  const shell = pre({ agent_id: "agent-x", tool_name: "shell", tool_input: { command: "ls" } });
  expect([observeHookBudget(shell), observeHookBudget(shell)]).toEqual([false, true]);
});

const budgetFiles = (root: string): string[] => {
  try {
    return readdirSync(path.join(root, ".git", "workit", "budget")).filter(
      (name) => !name.startsWith("spawns-"),
    );
  } catch {
    return [];
  }
};

const queued = (root: string): string => {
  const dir = path.join(root, ".git", "workit", "budget");
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith("spawns-"))
      .map((name) => readFileSync(path.join(dir, name), "utf8"))
      .join("");
  } catch {
    return "";
  }
};

const spawnCall = (cwd: string, agentInput: Record<string, unknown>): HookInput => ({
  ...call(cwd, "claude_code", null),
  event: { kind: "tool.pre", tool: "Agent", toolUseId: "t-spawn", agentInput },
});

test("[claude_code] Given an implementer spawn the gate denies, When the corrected spawn runs, Then only the allowed spawn is queued", () => {
  const root = repo();
  const deps = { descriptor: CLAUDE_CODE_DESCRIPTOR, addendum: null };
  const denied = handleHook(
    spawnCall(root, { subagent_type: "workit:implementer", model: "opus", prompt: brief(3) }),
    deps,
  );
  expect(denied.kind).toBe("deny");
  expect(queued(root)).toBe("");
  const allowed = handleHook(
    spawnCall(root, {
      subagent_type: "workit:implementer",
      model: "opus",
      prompt: `WORKTREE: ${root}\n${brief(4)}`,
    }),
    deps,
  );
  expect(allowed.kind === "deny").toBe(false);
  expect(queued(root)).toBe('{"type":"workit:implementer","n":4}\n');
  expect(claimSpawnBudget(root, LEAD, "agent-1", "workit:implementer")).toBe(4);
  expect(claimSpawnBudget(root, LEAD, "agent-2", "workit:implementer")).toBeNull();
});

test("Given an unbudgeted spawn queued before a budgeted one of the same type, When both start, Then the first gets none and the second keeps its N", () => {
  const root = repo();
  noteSpawnBudget(root, LEAD, "general-purpose", "look around");
  noteSpawnBudget(root, LEAD, "general-purpose", brief(5));
  expect(claimSpawnBudget(root, LEAD, "first", "general-purpose")).toBeNull();
  expect(claimSpawnBudget(root, LEAD, "second", "general-purpose")).toBe(5);
  expect(tickBudget(root, LEAD, "first")).toBe(false);
  expect(budgetFiles(root)).toEqual(expect.arrayContaining([expect.stringMatching(/\.json$/u)]));
});

for (const [host, descriptor] of [
  ["claude_code", CLAUDE_CODE_DESCRIPTOR],
  ["codex_cli", CODEX_DESCRIPTOR],
] as const)
  test(`[${host}] Given a budgeted subagent, When it stops, Then its budget files are gone`, () => {
    const root = repo();
    const deps = { descriptor, addendum: null };
    noteSpawnBudget(root, LEAD, "workit:implementer", brief(3));
    handleHook(start(root, host, "agent-1", "workit:implementer"), deps);
    tickBudget(root, LEAD, "agent-1");
    expect(budgetFiles(root).length).toBe(2);
    handleHook(
      {
        ...call(root, host, null),
        event: {
          kind: "subagent.stop",
          agentId: "agent-1",
          agentType: "workit:implementer",
          lastMessage: null,
          stopHookActive: false,
        },
      },
      deps,
    );
    expect(budgetFiles(root)).toEqual([]);
  });

test("Given budget files older than 7 days, When a new budget starts, Then they are aged out", () => {
  const root = repo();
  noteSpawnBudget(root, LEAD, "t", brief(3));
  claimSpawnBudget(root, LEAD, "old", "t");
  const dir = path.join(root, ".git", "workit", "budget");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  for (const name of budgetFiles(root)) utimesSync(path.join(dir, name), old, old);
  noteSpawnBudget(root, LEAD, "t", brief(3));
  claimSpawnBudget(root, LEAD, "new", "t");
  expect(budgetFiles(root)).toHaveLength(1);
});
