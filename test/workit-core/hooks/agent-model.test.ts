import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

// #420, #654, D1: a Workit agent's file carries its model and effort; a spawn
// whose configured role differs from it gets the role's values through
// PreToolUse updatedInput, and a model the spawn names wins. Under auto mode,
// which refuses a hook-rewritten spawn, it runs as written with one context
// line; only models.enforce strict denies it once with the exact args.

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
const spawn = (tool: string, input: Record<string, unknown>, mode = "default"): Out =>
  dispatchHook(claudeCodeAdapter, {
    ...fixture("claude-code", "pre-tool-use-bash", cwd),
    permission_mode: mode,
    tool_name: tool,
    tool_input: { description: "d", prompt: "do it", ...input },
  }).json;

test("G no models config, W a bare spawn of each Workit agent runs in every mode, T it runs as written: its agent file carries the model", () => {
  for (const mode of ["default", "auto"])
    for (const subagent_type of [
      "workit:verifier",
      "workit:reviewer",
      "workit:decider",
      "workit:babysitter",
      "Explore",
    ])
      expect(
        spawn("Agent", { subagent_type }, mode).hookSpecificOutput,
        subagent_type,
      ).toBeUndefined();
});

test("G a configured verifier model, W a bare workit:verifier spawn runs outside auto mode, T updatedInput carries it and the input is otherwise kept", () => {
  withConfig({ roles: { verifier: "opus" } }, () => {
    const out = spawn("Agent", { subagent_type: "workit:verifier" });
    expect(out.hookSpecificOutput?.updatedInput).toEqual({
      description: "d",
      prompt: "do it",
      subagent_type: "workit:verifier",
      model: "opus",
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput?.additionalContext).toContain("role verifier");
  });
});

test("G a spawn that names model opus, W PreToolUse runs, T the model is left as is", () => {
  const out = spawn("Agent", {
    subagent_type: "workit:verifier",
    model: "opus",
  });
  expect(out.hookSpecificOutput?.updatedInput).toBeUndefined();
});

test("G models.roles.explore haiku, W an Explore spawn names no model, T it gets haiku; the legacy Task name works too", () => {
  withConfig({ roles: { explore: "haiku" } }, () => {
    for (const tool of ["Agent", "Task"])
      expect(
        spawn(tool, { subagent_type: "Explore" }).hookSpecificOutput?.updatedInput?.model,
      ).toBe("haiku");
  });
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
  // The standard tier is the agent file's own model: nothing to fill.
  expect(
    spawn("Agent", {
      subagent_type: "workit:implementer",
      prompt: "WORKTREE: /w/x",
    }).hookSpecificOutput,
  ).toBeUndefined();
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
        verifier: {
          claude_code: { model: "claude-sonnet-5-5", effort: "high" },
        },
        reviewer: { claude_code: { model: "haiku", effort: "high" } },
        explore: "anthropic/claude-opus-5",
      },
    },
    () => {
      const verifier = spawn("Agent", { subagent_type: "workit:verifier" }).hookSpecificOutput
        ?.updatedInput;
      // sonnet is the agent file's own model: only the effort is filled.
      expect(verifier).toMatchObject({ effort: "high" });
      expect(verifier?.model).toBeUndefined();
      expect(
        spawn("Agent", { subagent_type: "Explore" }).hookSpecificOutput?.updatedInput?.model,
      ).toBe("opus");
      // an explicit effort stays
      const reviewer = spawn("Agent", {
        subagent_type: "workit:reviewer",
        effort: "low",
      }).hookSpecificOutput?.updatedInput;
      expect(reviewer).toMatchObject({ model: "haiku", effort: "low" });
    },
  );
});

test("G a configured model the Agent tool cannot take, W PreToolUse runs, T the spawn runs as written and a note names the value and the fix", () => {
  withConfig({ roles: { verifier: "gpt-5" } }, () => {
    const out = spawn("Agent", {
      subagent_type: "workit:verifier",
    }).hookSpecificOutput;
    expect(out?.updatedInput).toBeUndefined();
    expect(out?.additionalContext).toContain("could not apply gpt-5");
    expect(out?.additionalContext).toContain("workit models show --role verifier");
  });
});

test("G a configured verifier model, W the lead names another model, T the lead's model wins; under enforce strict the configured one wins with a note unless allowLeadOverride", () => {
  withConfig({ roles: { verifier: "haiku" } }, () => {
    expect(
      spawn("Agent", { subagent_type: "workit:verifier", model: "opus" }).hookSpecificOutput,
    ).toBeUndefined();
  });
  withConfig({ enforce: "strict", roles: { verifier: "haiku" } }, () => {
    const out = spawn("Agent", {
      subagent_type: "workit:verifier",
      model: "opus",
    }).hookSpecificOutput;
    expect(out?.updatedInput?.model).toBe("haiku");
    expect(out?.additionalContext).toContain("replaced model opus with haiku");
    expect(out?.additionalContext).toContain('set models.enforce "advise"');
  });
  withConfig({ enforce: "strict", roles: { verifier: "haiku" }, allowLeadOverride: true }, () => {
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

test("G a spawn that already passes its role's model and effort, W PreToolUse runs, T it runs as written with no updatedInput (W2.21)", () => {
  withConfig(
    {
      roles: { verifier: { claude_code: { model: "sonnet", effort: "high" } } },
    },
    () => {
      const out = spawn("Agent", {
        subagent_type: "workit:verifier",
        model: "sonnet",
        effort: "high",
      }).hookSpecificOutput;
      expect(out?.updatedInput).toBeUndefined();
      expect(out?.permissionDecision).toBeUndefined();
    },
  );
});

test("G a spawn with no model or another model under enforce strict, W PreToolUse rewrites it, T the note names the exact model and effort to pass next time (W2.21)", () => {
  withConfig(
    {
      enforce: "strict",
      roles: { verifier: { claude_code: { model: "sonnet", effort: "high" } } },
    },
    () => {
      const filled = spawn("Agent", {
        subagent_type: "workit:verifier",
      }).hookSpecificOutput;
      expect(filled?.updatedInput).toMatchObject({ effort: "high" });
      expect(filled?.additionalContext).toContain("Next time pass effort: high");
      const replaced = spawn("Agent", {
        subagent_type: "workit:verifier",
        model: "opus",
      }).hookSpecificOutput;
      expect(replaced?.updatedInput).toMatchObject({
        model: "sonnet",
        effort: "high",
      });
      expect(replaced?.additionalContext).toContain("Next time pass model: sonnet, effort: high");
      const effortOnly = spawn("Agent", {
        subagent_type: "workit:verifier",
        model: "sonnet",
      }).hookSpecificOutput;
      expect(effortOnly?.updatedInput).toMatchObject({
        model: "sonnet",
        effort: "high",
      });
      expect(effortOnly?.additionalContext).toContain("Next time pass model: sonnet, effort: high");
    },
  );
});

// ---------------------------------------------------------------------------
// auto mode (retro 2026-11-07 R1: 15 refusals of hook-rewritten spawns)

const MODES = ["default", "auto", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];

/** The deny's reason; fails when the hook rewrote the spawn or let it run. */
const denied = (out: Out): string => {
  expect(out.hookSpecificOutput?.updatedInput).toBeUndefined();
  expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  return out.hookSpecificOutput?.permissionDecisionReason ?? "";
};

test("G enforce strict, auto mode and a spawn missing its role model, W PreToolUse runs, T it is denied in two lines with the exact args (run_in_background kept), never rewritten, and the retry with them runs as written", () => {
  withConfig(
    { enforce: "strict", roles: { verifier: { claude_code: { model: "opus", effort: "high" } } } },
    () => {
      const reason = denied(
        spawn("Agent", { subagent_type: "workit:verifier", run_in_background: true }, "auto"),
      );
      const [first, second] = reason.split("\n");
      expect(first).toStartWith("workit spawn args: It needs model opus and effort high (");
      expect(first).toContain("role verifier, models.roles in the global default");
      expect(second).toBe(
        'Retry as: Agent subagent_type: "workit:verifier", model: "opus", effort: "high", run_in_background: true (description and prompt as written).',
      );
      expect(reason).toContain("auto mode refuses a hook-rewritten spawn");
      const retry = spawn(
        "Agent",
        {
          subagent_type: "workit:verifier",
          model: "opus",
          effort: "high",
          run_in_background: true,
        },
        "auto",
      );
      expect(retry.hookSpecificOutput).toBeUndefined();
    },
  );
});

test("G a configured verifier model and auto mode, W a bare workit:verifier spawn runs, T it runs as written and one context line names the model that ran and the configured one", () => {
  withConfig({ roles: { verifier: "opus" } }, () => {
    const out = spawn("Agent", { subagent_type: "workit:verifier" }, "auto").hookSpecificOutput;
    expect(out?.permissionDecision).toBeUndefined();
    expect(out?.updatedInput).toBeUndefined();
    expect(out?.additionalContext).toBe(
      'Workit: this workit:verifier spawn runs on sonnet; role verifier, models.roles in the global default sets model opus. To use it, pass model: "opus" on the spawn.',
    );
  });
});

test("G models.roles.explore haiku and auto mode, W an Explore spawn names model sonnet, T it runs on sonnet with no deny and no note", () => {
  withConfig({ roles: { explore: "haiku" } }, () => {
    expect(
      spawn("Agent", { subagent_type: "Explore", model: "sonnet" }, "auto").hookSpecificOutput,
    ).toBeUndefined();
  });
});

test("G no models config and auto mode, W a bare workit:decider spawn runs, T it runs as written (its agent file is fable, effort high)", () => {
  expect(
    spawn("Agent", { subagent_type: "workit:decider" }, "auto").hookSpecificOutput,
  ).toBeUndefined();
});

test("G a configured role, W a spawn missing it runs in each permission mode, T it is filled outside auto mode and advised under auto; enforce strict denies under auto", () => {
  withConfig({ roles: { explore: "haiku" } }, () => {
    for (const mode of MODES) {
      const out = spawn("Agent", { subagent_type: "Explore" }, mode).hookSpecificOutput;
      expect(out?.permissionDecision, mode).toBeUndefined();
      if (mode === "auto") expect(out?.additionalContext).toContain('pass model: "haiku"');
      else expect(out?.updatedInput?.model, mode).toBe("haiku");
    }
  });
  withConfig({ enforce: "strict", roles: { explore: "haiku" } }, () => {
    expect(denied(spawn("Agent", { subagent_type: "Explore" }, "auto"))).toContain(
      'model: "haiku"',
    );
  });
});

test("G a spawn that already names its role's model and effort, W PreToolUse runs in every permission mode, T it runs untouched", () => {
  withConfig({ roles: { verifier: { claude_code: { model: "sonnet", effort: "high" } } } }, () => {
    for (const mode of MODES)
      expect(
        spawn("Agent", { subagent_type: "workit:verifier", model: "sonnet", effort: "high" }, mode)
          .hookSpecificOutput,
        mode,
      ).toBeUndefined();
  });
});

test("G enforce strict and auto mode, W a spawn names another model than its configured role's, or the right model but no effort, T the deny names the configured values and keeps every other arg", () => {
  withConfig(
    { enforce: "strict", roles: { verifier: { claude_code: { model: "haiku", effort: "high" } } } },
    () => {
      const replaced = denied(
        spawn("Agent", { subagent_type: "workit:verifier", model: "opus" }, "auto"),
      );
      expect(replaced).toContain('model: "haiku", effort: "high"');
      expect(replaced).toContain(", not opus.");
      const effortOnly = denied(
        spawn(
          "Agent",
          {
            subagent_type: "workit:verifier",
            model: "haiku",
            run_in_background: false,
            name: "v1",
          },
          "auto",
        ),
      );
      expect(effortOnly).toContain(
        'Retry as: Agent subagent_type: "workit:verifier", model: "haiku", effort: "high", run_in_background: false, name: "v1" (',
      );
      expect(effortOnly).toContain("It needs effort high");
    },
  );
});

test("G auto mode and a general-purpose spawn with a ROLE: decider line, W PreToolUse runs, T it runs and the note names the decider's built-in model and effort; enforce strict denies it", () => {
  const input = { subagent_type: "general-purpose", prompt: "ROLE: decider\nPick one." };
  expect(spawn("Agent", input, "auto").hookSpecificOutput?.additionalContext).toContain(
    'pass model: "fable", effort: "high"',
  );
  withConfig({ enforce: "strict" }, () => {
    expect(denied(spawn("Agent", input, "auto"))).toContain(
      'subagent_type: "general-purpose", model: "fable", effort: "high"',
    );
  });
});
