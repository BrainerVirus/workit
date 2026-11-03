import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

// #655: the host hook sees a worker die on a usage limit, marks the provider
// exhausted, tells the lead to re-dispatch once, and the next spawn of the
// role falls back.

let configHome: ConfigHome;
const saved = {
  state: process.env.WORKFLOW_TOOLKIT_STATE,
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
  process.env.WORKFLOW_TOOLKIT_STATE = temp("wk-model-limit-state-");
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
    ["WORKFLOW_TOOLKIT_STATE", saved.state],
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

test("G a completed OpenCode subagent whose long report mentions a usage limit, W observed, T nothing is marked", () => {
  observeSubagentLimit(
    cwd,
    {
      sessionID: "lead",
      input: { model: "anthropic/claude-sonnet-5" },
      result: `Report: added usage limit parsing. ${"detail ".repeat(120)}`,
    },
    new Map(),
  );
  expect(exhaustedProviders()).toEqual([]);
});
