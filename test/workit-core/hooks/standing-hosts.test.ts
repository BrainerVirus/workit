// #320 through the built hook entries of the hook-process hosts: a standing
// order the lead adds reaches a running worker's next tool call once, and a
// call with nothing new stays on the launcher's fast path.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installedPlugin, PLUGIN_DIR, runHook } from "@/test/workit-claude-code/plugin-helpers";
import { LEAD, addOrder, cleanup, standingRepo } from "./standing-fixture";

const ROOT = path.resolve(import.meta.dir, "../../..");
const out = mkdtempSync(path.join(tmpdir(), "wk-standing-hosts-"));
const state = mkdtempSync(path.join(tmpdir(), "wk-standing-hosts-state-"));
const env = { WORKFLOW_TOOLKIT_STATE: state, HOME: state, CLAUDE_CONFIG_DIR: state };

const build = (entry: string, dir: string, split: boolean): string => {
  const built = spawnSync(
    process.execPath,
    [
      "build",
      path.join(ROOT, entry),
      "--target",
      "node",
      "--format",
      "esm",
      "--outdir",
      path.join(out, dir),
      ...(split ? ["--splitting", "--chunk-naming", "chunk-[hash].js"] : []),
      "--entry-naming",
      "entry.js",
    ],
    { encoding: "utf8" },
  );
  if (built.status !== 0) throw new Error(built.stderr || built.stdout);
  return path.join(out, dir, "entry.js");
};

let codexDist = "";
let cursorDist = "";
beforeAll(() => {
  codexDist = build("packages/workit-codex/hooks/launcher.ts", "codex", true);
  cursorDist = build("packages/workit-cursor/hooks/workit-hook.ts", "cursor", false);
});
afterAll(() => {
  cleanup();
  rmSync(out, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

const node = (entry: string, payload: unknown): Record<string, unknown> => {
  const child = spawnSync("node", [entry], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  if (child.status !== 0 && child.status !== 2) throw new Error(child.stderr);
  return JSON.parse(child.stdout);
};

const ORDER = "new: close every browser tab you opened before reporting";

for (const [label, plugin] of [
  ["local pin (source)", () => PLUGIN_DIR],
  ["installed (dist)", installedPlugin],
] as const)
  test(`[Claude Code ${label}] Given a subagent of the lead, When the lead adds an order, Then its next PreToolUse carries it as additionalContext once`, () => {
    const { root, slice } = standingRepo();
    const call = (agentId: string) => ({
      hook_event_name: "PreToolUse",
      session_id: LEAD,
      agent_id: agentId,
      agent_type: "workit:implementer",
      transcript_path: "/tmp/x.jsonl",
      cwd: slice,
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command: "ls", description: "d" },
      tool_use_id: "toolu_1",
    });
    addOrder(root, "no new dependencies");
    const start = runHook(
      plugin(),
      {
        hook_event_name: "SubagentStart",
        session_id: LEAD,
        agent_id: "agent-1",
        agent_type: "workit:implementer",
        transcript_path: "/tmp/x.jsonl",
        cwd: root,
      },
      env,
    );
    expect(start.status, start.stderr).toBe(0);
    expect(runHook(plugin(), call("agent-1"), env).json).toEqual({});
    addOrder(root, "close every browser tab you opened before reporting");
    const next = runHook(plugin(), call("agent-1"), env).json as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(next.hookSpecificOutput?.additionalContext).toContain(ORDER);
    expect(next.hookSpecificOutput?.additionalContext).not.toContain("no new dependencies");
    expect(runHook(plugin(), call("agent-1"), env).json).toEqual({});
  }, 60_000);

for (const entry of ["source", "dist"] as const)
  test(`[Codex ${entry}] Given a subagent of the lead, When the lead adds an order, Then its next PreToolUse carries it as additionalContext once`, () => {
    const { root, slice } = standingRepo();
    const payload = {
      session_id: LEAD,
      agent_id: "agent-1",
      cwd: slice,
      model: "gpt-5",
      permission_mode: "default",
      transcript_path: null,
      hook_event_name: "PreToolUse",
      turn_id: "turn-1",
      tool_use_id: "tool-1",
      tool_name: "bash",
      tool_input: { command: "ls" },
    };
    const run = () =>
      entry === "dist"
        ? node(codexDist, payload)
        : JSON.parse(
            spawnSync(
              process.execPath,
              [path.join(ROOT, "packages/workit-codex/hooks/launcher.ts")],
              { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env } },
            ).stdout,
          );
    addOrder(root, "close every browser tab you opened before reporting");
    expect(JSON.stringify(run())).toContain(ORDER);
    expect(run()).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
  }, 60_000);

test("[Cursor dist] Given a session on a slice branch, When the lead adds an order, Then its next beforeShellExecution carries it as agent_message once", () => {
  const { root, slice } = standingRepo();
  const payload = {
    hook_event_name: "beforeShellExecution",
    conversation_id: "cursor-worker-1",
    workspace_roots: [slice],
    cwd: slice,
    command: "ls",
  };
  addOrder(root, "close every browser tab you opened before reporting");
  const first = node(cursorDist, payload);
  expect(first.permission).toBe("allow");
  expect(String(first.agent_message)).toContain(ORDER);
  expect(node(cursorDist, payload)).toEqual({ permission: "allow" });
}, 60_000);
