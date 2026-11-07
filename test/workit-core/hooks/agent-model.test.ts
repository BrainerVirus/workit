import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

// #420, #654: a Claude Code subagent spawn runs on its role's model and
// effort; an explicit model wins over a built-in default, and over a
// configured one only with models.allowLeadOverride. Retro 2026-11-07 R1: a
// spawn missing them is denied once with the exact args, never rewritten
// through updatedInput (auto mode refuses a hook-rewritten spawn).

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
    permissionDecisionReason?: string;
  };
};
const MODES = ["default", "auto", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];
const spawn = (tool: string, input: Record<string, unknown>, mode = "default"): Out =>
  dispatchHook(claudeCodeAdapter, {
    ...fixture("claude-code", "pre-tool-use-bash", cwd),
    permission_mode: mode,
    tool_name: tool,
    tool_input: { description: "d", prompt: "do it", ...input },
  }).json;

/** The deny's reason; fails when the hook rewrote the spawn or let it run. */
const denied = (out: Out): string => {
  expect(out.hookSpecificOutput?.updatedInput).toBeUndefined();
  expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  return out.hookSpecificOutput?.permissionDecisionReason ?? "";
};

const withConfig = (models: unknown, run: () => void): void => {
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify({ models }));
  try {
    run();
  } finally {
    rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
  }
};

test("G permission_mode auto and a spawn missing its role model, W PreToolUse runs, T it is denied with the exact args (run_in_background kept), never rewritten, and the retry with them runs as written", () => {
  withConfig(
    {
      roles: { verifier: { claude_code: { model: "sonnet", effort: "high" } } },
    },
    () => {
      const first = spawn(
        "Agent",
        { subagent_type: "workit:verifier", run_in_background: true },
        "auto",
      );
      const reason = denied(first);
      expect(reason).toContain(
        'spawn again with exactly subagent_type: "workit:verifier", model: "sonnet", effort: "high", run_in_background: true (description and prompt as written)',
      );
      expect(reason).toContain("role verifier, models.roles in the global default");
      const retry = spawn(
        "Agent",
        {
          subagent_type: "workit:verifier",
          model: "sonnet",
          effort: "high",
          run_in_background: true,
        },
        "auto",
      );
      expect(retry.hookSpecificOutput).toBeUndefined();
    },
  );
});

test("G a spawn missing its role model, W PreToolUse runs in any permission mode, T it is the same deny (no updatedInput in any mode)", () => {
  const reasons = MODES.map((mode) => denied(spawn("Agent", { subagent_type: "Explore" }, mode)));
  expect(new Set(reasons).size).toBe(1);
  expect(reasons[0]).toContain('subagent_type: "Explore", model: "haiku"');
  expect(reasons[0]).toContain("auto mode refuses a hook-rewritten spawn");
});

test("G a spawn that already names its role's model and effort, W PreToolUse runs in every permission mode, T it runs untouched", () => {
  withConfig(
    {
      roles: { verifier: { claude_code: { model: "sonnet", effort: "high" } } },
    },
    () => {
      for (const mode of MODES)
        expect(
          spawn(
            "Agent",
            {
              subagent_type: "workit:verifier",
              model: "sonnet",
              effort: "high",
            },
            mode,
          ).hookSpecificOutput,
          mode,
        ).toBeUndefined();
    },
  );
});

test("G a workit:verifier spawn with no model, W PreToolUse runs, T the deny names sonnet, the built-in default", () => {
  const reason = denied(spawn("Agent", { subagent_type: "workit:verifier" }));
  expect(reason).toContain('subagent_type: "workit:verifier", model: "sonnet"');
  expect(reason).toContain("role verifier, built-in");
});

test("G a spawn that names model opus, W PreToolUse runs, T the model is left as is", () => {
  const out = spawn("Agent", {
    subagent_type: "workit:verifier",
    model: "opus",
  });
  expect(out.hookSpecificOutput).toBeUndefined();
});

test("G an Explore spawn, W PreToolUse runs, T it needs haiku; the legacy Task name works too", () => {
  for (const tool of ["Agent", "Task"])
    expect(denied(spawn(tool, { subagent_type: "Explore" }))).toContain('model: "haiku"');
});

test("G Plan, general-purpose and an unknown type, W PreToolUse runs, T the input is unchanged", () => {
  for (const subagent_type of ["Plan", "general-purpose", "someone:else", undefined])
    expect(spawn("Agent", { subagent_type }).hookSpecificOutput).toBeUndefined();
});

test("G an implementer brief with TIER: hard, W PreToolUse runs, T it needs opus; no tier line means standard", () => {
  expect(
    denied(
      spawn("Agent", {
        subagent_type: "workit:implementer",
        prompt: "GOAL: x\nTIER: hard\nWORKTREE: /w/x\n",
      }),
    ),
  ).toContain('model: "opus"');
  expect(
    denied(
      spawn("Agent", {
        subagent_type: "workit:implementer",
        prompt: "WORKTREE: /w/x",
      }),
    ),
  ).toContain('model: "sonnet"');
});

test("G a configured verifier effort and a full Claude model id, W PreToolUse runs, T the id is named as its alias with the effort", () => {
  withConfig(
    {
      roles: {
        verifier: {
          claude_code: { model: "claude-sonnet-5-5", effort: "high" },
        },
        reviewer: { claude_code: { model: "haiku", effort: "high" } },
        explore: "anthropic/claude-opus-5",
      },
    },
    () => {
      expect(denied(spawn("Agent", { subagent_type: "workit:verifier" }))).toContain(
        'model: "sonnet", effort: "high"',
      );
      expect(denied(spawn("Agent", { subagent_type: "Explore" }))).toContain('model: "opus"');
      // an explicit effort stays
      expect(denied(spawn("Agent", { subagent_type: "workit:reviewer", effort: "low" }))).toContain(
        'model: "haiku", effort: "low"',
      );
    },
  );
});

test("G a configured model the Agent tool cannot take, W PreToolUse runs, T the spawn runs as written and a note names the value and the fix", () => {
  withConfig({ roles: { verifier: "gpt-5" } }, () => {
    const out = spawn("Agent", {
      subagent_type: "workit:verifier",
    }).hookSpecificOutput;
    expect(out?.updatedInput).toBeUndefined();
    expect(out?.permissionDecision).toBeUndefined();
    expect(out?.additionalContext).toContain("could not apply gpt-5");
    expect(out?.additionalContext).toContain("workit models show --role verifier");
  });
});

test("G a configured verifier model, W the lead names another model, T the deny names the configured one and allowLeadOverride; allowLeadOverride true keeps the lead's", () => {
  withConfig({ roles: { verifier: "haiku" } }, () => {
    const reason = denied(spawn("Agent", { subagent_type: "workit:verifier", model: "opus" }));
    expect(reason).toContain('model: "haiku"');
    expect(reason).toContain("replaces model opus");
    expect(reason).toContain('"allowLeadOverride": true');
  });
  withConfig({ roles: { verifier: "haiku" }, allowLeadOverride: true }, () => {
    expect(
      spawn("Agent", { subagent_type: "workit:verifier", model: "opus" }).hookSpecificOutput,
    ).toBeUndefined();
  });
});

test("G models.roles.default, W a general-purpose spawn or one with no type, T the default model is named; a fork is left alone", () => {
  withConfig({ roles: { default: { claude_code: "haiku" } } }, () => {
    for (const subagent_type of ["general-purpose", undefined])
      expect(denied(spawn("Agent", { subagent_type })), String(subagent_type)).toContain(
        'model: "haiku"',
      );
    expect(spawn("Agent", { subagent_type: "fork" }).hookSpecificOutput).toBeUndefined();
  });
});

test("G a general-purpose spawn with a ROLE: decider line, W PreToolUse runs, T it needs the decider's built-in model and effort", () => {
  expect(
    denied(
      spawn("Agent", {
        subagent_type: "general-purpose",
        prompt: "ROLE: decider\nPick one.",
      }),
    ),
  ).toContain('subagent_type: "general-purpose", model: "fable", effort: "high"');
});

test("G a spawn with the right model but no effort, W PreToolUse runs, T the deny names only the missing effort and keeps every other arg", () => {
  withConfig(
    {
      roles: { verifier: { claude_code: { model: "sonnet", effort: "high" } } },
    },
    () => {
      const reason = denied(
        spawn("Agent", {
          subagent_type: "workit:verifier",
          model: "sonnet",
          run_in_background: false,
          name: "v1",
        }),
      );
      expect(reason).toContain(
        'exactly subagent_type: "workit:verifier", model: "sonnet", effort: "high", run_in_background: false, name: "v1" (',
      );
      expect(reason).toContain("It needs effort high");
    },
  );
});
