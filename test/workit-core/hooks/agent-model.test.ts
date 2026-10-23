import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

// #420: a Claude Code subagent spawn that names no model gets its role's
// model and effort through PreToolUse updatedInput; an explicit model wins.

let configHome: ConfigHome;
let cwd: string;
beforeAll(() => {
  configHome = useConfigHome("wk-agent-model-");
  cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-agent-model-cwd-")));
});
afterAll(() => {
  configHome.restore();
  rmSync(cwd, { recursive: true, force: true });
});

type Out = {
  hookSpecificOutput?: {
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    permissionDecision?: string;
  };
};
const spawn = (tool: string, input: Record<string, unknown>): Out =>
  dispatchHook(claudeCodeAdapter, {
    ...fixture("claude-code", "pre-tool-use-bash", cwd),
    tool_name: tool,
    tool_input: { description: "d", prompt: "do it", ...input },
  }).json;

test("G a workit:verifier spawn with no model, W PreToolUse runs, T updatedInput carries sonnet and the input is otherwise kept", () => {
  const out = spawn("Agent", { subagent_type: "workit:verifier" });
  expect(out.hookSpecificOutput?.updatedInput).toEqual({
    description: "d",
    prompt: "do it",
    subagent_type: "workit:verifier",
    model: "sonnet",
  });
  expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  expect(out.hookSpecificOutput?.additionalContext).toContain("role verifier");
});

test("G a spawn that names model opus, W PreToolUse runs, T the model is left as is", () => {
  const out = spawn("Agent", { subagent_type: "workit:verifier", model: "opus" });
  expect(out.hookSpecificOutput?.updatedInput).toBeUndefined();
});

test("G an Explore spawn, W PreToolUse runs, T it gets haiku; the legacy Task name works too", () => {
  expect(spawn("Agent", { subagent_type: "Explore" }).hookSpecificOutput?.updatedInput?.model).toBe(
    "haiku",
  );
  expect(spawn("Task", { subagent_type: "Explore" }).hookSpecificOutput?.updatedInput?.model).toBe(
    "haiku",
  );
});

test("G Plan, general-purpose and an unknown type, W PreToolUse runs, T the input is unchanged", () => {
  for (const subagent_type of ["Plan", "general-purpose", "someone:else", undefined])
    expect(spawn("Agent", { subagent_type }).hookSpecificOutput?.updatedInput).toBeUndefined();
});

test("G an implementer brief with TIER: hard, W PreToolUse runs, T it gets opus; no tier line means standard", () => {
  const hard = spawn("Agent", {
    subagent_type: "workit:implementer",
    prompt: "GOAL: x\nTIER: hard\n",
  });
  expect(hard.hookSpecificOutput?.updatedInput?.model).toBe("opus");
  expect(
    spawn("Agent", { subagent_type: "workit:implementer" }).hookSpecificOutput?.updatedInput?.model,
  ).toBe("sonnet");
});

test("G a configured verifier effort and a model the Agent tool cannot take, W PreToolUse runs, T effort is filled and the unusable model skipped", () => {
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      models: {
        roles: {
          verifier: { claude_code: { model: "claude-sonnet-5-5", effort: "high" } },
          reviewer: { claude_code: { model: "haiku", effort: "high" } },
        },
      },
    }),
  );
  try {
    const verifier = spawn("Agent", { subagent_type: "workit:verifier" }).hookSpecificOutput
      ?.updatedInput;
    expect(verifier?.model).toBeUndefined();
    expect(verifier?.effort).toBe("high");
    // an explicit effort stays
    const reviewer = spawn("Agent", { subagent_type: "workit:reviewer", effort: "low" })
      .hookSpecificOutput?.updatedInput;
    expect(reviewer).toMatchObject({ model: "haiku", effort: "low" });
  } finally {
    rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
  }
});
