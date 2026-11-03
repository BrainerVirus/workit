import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

// #420, #654: a Claude Code subagent spawn gets its role's model and effort
// through PreToolUse updatedInput; an explicit model wins over a built-in
// default, and over a configured one only with models.allowLeadOverride.

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
    prompt: "GOAL: x\nTIER: hard\nWORKTREE: /w/x\n",
  });
  expect(hard.hookSpecificOutput?.updatedInput?.model).toBe("opus");
  expect(
    spawn("Agent", { subagent_type: "workit:implementer", prompt: "WORKTREE: /w/x" })
      .hookSpecificOutput?.updatedInput?.model,
  ).toBe("sonnet");
});

const withConfig = (models: unknown, run: () => void): void => {
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify({ models }));
  try {
    run();
  } finally {
    rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
  }
};

test("G a configured verifier effort and a full Claude model id, W PreToolUse runs, T the id is applied as its alias with the effort", () => {
  withConfig(
    {
      roles: {
        verifier: { claude_code: { model: "claude-sonnet-5-5", effort: "high" } },
        reviewer: { claude_code: { model: "haiku", effort: "high" } },
        explore: "anthropic/claude-opus-5",
      },
    },
    () => {
      const verifier = spawn("Agent", { subagent_type: "workit:verifier" }).hookSpecificOutput
        ?.updatedInput;
      expect(verifier).toMatchObject({ model: "sonnet", effort: "high" });
      expect(
        spawn("Agent", { subagent_type: "Explore" }).hookSpecificOutput?.updatedInput?.model,
      ).toBe("opus");
      // an explicit effort stays
      const reviewer = spawn("Agent", { subagent_type: "workit:reviewer", effort: "low" })
        .hookSpecificOutput?.updatedInput;
      expect(reviewer).toMatchObject({ model: "haiku", effort: "low" });
    },
  );
});

test("G a configured model the Agent tool cannot take, W PreToolUse runs, T the spawn runs as written and a note names the value and the fix", () => {
  withConfig({ roles: { verifier: "gpt-5" } }, () => {
    const out = spawn("Agent", { subagent_type: "workit:verifier" }).hookSpecificOutput;
    expect(out?.updatedInput).toBeUndefined();
    expect(out?.additionalContext).toContain("could not apply gpt-5");
    expect(out?.additionalContext).toContain("workit models show --role verifier");
  });
});

test("G a configured verifier model, W the lead names another model, T the configured one wins with a note; allowLeadOverride true keeps the lead's", () => {
  withConfig({ roles: { verifier: "haiku" } }, () => {
    const out = spawn("Agent", {
      subagent_type: "workit:verifier",
      model: "opus",
    }).hookSpecificOutput;
    expect(out?.updatedInput?.model).toBe("haiku");
    expect(out?.additionalContext).toContain("replaced model opus with haiku");
    expect(out?.additionalContext).toContain('"allowLeadOverride": true');
  });
  withConfig({ roles: { verifier: "haiku" }, allowLeadOverride: true }, () => {
    expect(
      spawn("Agent", { subagent_type: "workit:verifier", model: "opus" }).hookSpecificOutput,
    ).toBeUndefined();
  });
});

test("G models.roles.default, W a general-purpose spawn or one with no type, T the default model is applied; a fork is left alone", () => {
  withConfig({ roles: { default: { claude_code: "haiku" } } }, () => {
    for (const subagent_type of ["general-purpose", undefined])
      expect(
        spawn("Agent", { subagent_type }).hookSpecificOutput?.updatedInput?.model,
        String(subagent_type),
      ).toBe("haiku");
    expect(spawn("Agent", { subagent_type: "fork" }).hookSpecificOutput).toBeUndefined();
  });
});

test("G a general-purpose spawn with a ROLE: decider line, W PreToolUse runs, T it gets the decider's built-in model and effort", () => {
  const updated = spawn("Agent", {
    subagent_type: "general-purpose",
    prompt: "ROLE: decider\nPick one.",
  }).hookSpecificOutput?.updatedInput;
  expect(updated).toMatchObject({ model: "fable", effort: "high" });
});
