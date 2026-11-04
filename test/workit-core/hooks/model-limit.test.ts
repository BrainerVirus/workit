import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exhaustedProviders } from "@/packages/workit-core/src/core/model-fallback";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { claudeProjectSlug } from "@/packages/workit-core/src/hooks/model-limit";
import {
  applySpawnModel,
  injectLeadSwitch,
  injectSpawnNotes,
  observeSubagentLimit,
  type SpawnNotes,
} from "@/packages/workit-opencode/src/v2/spawn-model";
import { PLUGIN_DIR, runHook } from "@/test/workit-claude-code/plugin-helpers";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

// #655: the host hook sees a worker die on a usage limit, marks the provider
// exhausted, tells the lead to re-dispatch once, and the next spawn of the
// role falls back.

let configHome: ConfigHome;
const saved = {
  state: process.env.WORKIT_STATE_DIR,
  claude: process.env.CLAUDE_CONFIG_DIR,
};
let cwd: string;
let claudeDir: string;
const dirs: string[] = [];
const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const reset = (): void => {
  process.env.WORKIT_STATE_DIR = temp("wk-model-limit-state-");
  claudeDir = temp("wk-model-limit-claude-");
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  cwd = temp("wk-model-limit-cwd-");
};
beforeAll(() => {
  configHome = useConfigHome("wk-model-limit-");
  reset();
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
  reset();
});
afterAll(() => {
  configHome.restore();
  for (const [key, value] of [
    ["WORKIT_STATE_DIR", saved.state],
    ["CLAUDE_CONFIG_DIR", saved.claude],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const LIMIT = "You've hit your weekly limit · resets 7pm (America/Santiago)";

/** A subagent transcript as Claude Code writes it: spawn prompt first, the API error last. */
const transcript = (prompt: string, last: Record<string, unknown>): void => {
  const dir = path.join(claudeDir, "projects", claudeProjectSlug(cwd), "session-1", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "agent-a1.jsonl"),
    [
      { type: "user", message: { role: "user", content: prompt } },
      {
        type: "assistant",
        message: { model: "claude-opus-5", content: [{ type: "text", text: "working" }] },
      },
      last,
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
};
const apiError = (text: string) => ({
  type: "assistant",
  isApiErrorMessage: true,
  error: "rate_limit",
  message: { model: "<synthetic>", content: [{ type: "text", text }] },
});

type Out = { hookSpecificOutput?: { additionalContext?: string } };
const spawn = (input: Record<string, unknown>): Out =>
  dispatchHook(claudeCodeAdapter, {
    ...fixture("claude-code", "pre-tool-use-bash", cwd),
    tool_name: "Agent",
    tool_input: { description: "d", prompt: "do it", ...input },
  }).json;

test("G a Claude Code worker whose transcript ends on the weekly-limit API error, W the next Agent spawn runs, T Anthropic is exhausted and the lead is told to re-dispatch once", () => {
  transcript("GOAL: x\nWORKTREE: /w", apiError(LIMIT));
  const out = spawn({ subagent_type: "workit:verifier" });
  expect(exhaustedProviders().map((one) => one.provider)).toEqual(["anthropic"]);
  const context = out.hookSpecificOutput?.additionalContext ?? "";
  expect(context).toContain("died on a usage limit");
  expect(context).toContain("Re-dispatch it once with the same prompt");
  expect(
    spawn({ subagent_type: "workit:verifier" }).hookSpecificOutput?.additionalContext,
  ).not.toContain("died on a usage limit");
});

test("G a worker whose own final report discusses a usage limit, W the next spawn runs, T nothing is marked exhausted", () => {
  transcript("GOAL: x", {
    type: "assistant",
    message: {
      model: "claude-opus-5",
      content: [{ type: "text", text: "Done: Workit now parses the usage limit text." }],
    },
  });
  spawn({ subagent_type: "workit:verifier" });
  expect(exhaustedProviders()).toEqual([]);
});

const OPENCODE_LIST = {
  models: { roles: { verifier: { opencode: ["anthropic/claude-sonnet-5", "openai/gpt-5.5"] } } },
};

test("G an OpenCode verifier whose subagent call errors on a usage limit, W the next verifier spawn runs, T it gets the second model and the lead is told to re-dispatch", () => {
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify(OPENCODE_LIST));
  const notes: SpawnNotes = new Map();
  const first = { agent: "workit-verifier", prompt: "verify x" } as Record<string, unknown>;
  applySpawnModel(cwd, { sessionID: "lead", input: first }, notes);
  expect(first.model).toBe("anthropic/claude-sonnet-5");
  notes.clear();
  observeSubagentLimit(
    cwd,
    { sessionID: "lead", input: first, error: new Error(`AI_APICallError: 429 ${LIMIT}`) },
    notes,
  );
  const second = { agent: "workit-verifier", prompt: "verify x" } as Record<string, unknown>;
  applySpawnModel(cwd, { sessionID: "lead", input: second }, notes);
  expect(second.model).toBe("openai/gpt-5.5");
  const system: Array<{ type: "text"; text: string }> = [];
  injectSpawnNotes(notes, "lead", system);
  expect(system.map((one) => one.text).join("\n")).toContain("Re-dispatch it once");
});

test("G an OpenCode lead on an exhausted provider, W its context builds twice, T one switch notice names the next lead model", () => {
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      models: { lead: { opencode: ["anthropic/claude-opus-5", "openai/gpt-5.5"] } },
    }),
  );
  const notes: SpawnNotes = new Map();
  observeSubagentLimit(
    cwd,
    { sessionID: "lead", input: { model: "anthropic/claude-opus-5" }, error: LIMIT },
    notes,
  );
  const told = new Set<string>();
  const system: Array<{ type: "text"; text: string }> = [];
  injectLeadSwitch(cwd, "lead", "anthropic/claude-opus-5", told, system);
  injectLeadSwitch(cwd, "lead", "anthropic/claude-opus-5", told, system);
  expect(system).toHaveLength(1);
  expect(system[0].text).toContain("Switch the lead to openai/gpt-5.5 with /models");
});

test("G a completed OpenCode subagent whose short report mentions a usage limit or a 429, W the plugin's execute.after runs, T only an error is read and nothing is marked", () => {
  const source = readFileSync(
    path.join(import.meta.dir, "../../../packages/workit-opencode/src/v2/plugin.ts"),
    "utf8",
  );
  expect(source).toMatch(/if \(event\.status !== "completed"\)\s+observeSubagentLimit\(/u);
  for (const report of [
    "Done: I added a usage limit banner to the settings page.",
    "Done: handles a 429 with retry-after: 3600.",
  ])
    observeSubagentLimit(
      cwd,
      { sessionID: "lead", input: { model: "anthropic/claude-sonnet-5" }, error: report },
      new Map(),
    );
  expect(exhaustedProviders()).toEqual([]);
});

const subagentStop = (last: string, agentId = "a1") => ({
  hook_event_name: "SubagentStop",
  session_id: "lead-1",
  transcript_path: "/tmp/x.jsonl",
  cwd,
  permission_mode: "default",
  stop_hook_active: false,
  agent_id: agentId,
  agent_type: "workit:implementer",
  agent_transcript_path: "/tmp/a.jsonl",
  last_assistant_message: last,
});

test("G a Claude Code worker that stops on a usage limit, W SubagentStop runs, T Anthropic is marked exhausted at once and the stop is not blocked (W2.19)", () => {
  const out = dispatchHook(claudeCodeAdapter, subagentStop(LIMIT));
  expect(out.json).toEqual({});
  expect(exhaustedProviders().map((one) => one.provider)).toEqual(["anthropic"]);
});

test("G a worker whose final report only discusses limits, W SubagentStop runs, T nothing is marked exhausted (W2.19)", () => {
  dispatchHook(claudeCodeAdapter, subagentStop("Done: Workit now parses the usage limit text."));
  dispatchHook(claudeCodeAdapter, subagentStop(`Report.\n${"x".repeat(1200)}\n${LIMIT}`, "a2"));
  expect(exhaustedProviders()).toEqual([]);
});

test("G the Claude Code launcher, W a SubagentStop carries a usage limit, T it loads the runtime and marks the provider; a plain stop stays on the fast path (W2.19)", () => {
  const env = {
    WORKIT_STATE_DIR: process.env.WORKIT_STATE_DIR,
    CLAUDE_CONFIG_DIR: claudeDir,
  };
  const plain = runHook(PLUGIN_DIR, subagentStop("All done.", "a3"), env);
  expect(plain.status, plain.stderr).toBe(0);
  expect(exhaustedProviders()).toEqual([]);
  const limited = runHook(PLUGIN_DIR, subagentStop(LIMIT, "a4"), env);
  expect(limited.status, limited.stderr).toBe(0);
  expect(limited.json).toEqual({});
  expect(exhaustedProviders().map((one) => one.provider)).toEqual(["anthropic"]);
}, 60_000);
