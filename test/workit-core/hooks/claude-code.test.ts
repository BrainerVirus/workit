import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  claudeCodeAdapter,
  codexAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import { fixture, startTask, tempRoot, withProtectedMain } from "./hook-fixtures";

const RUN = path.resolve(import.meta.dir, "../../../packages/workit-core/src/hooks/run.ts");
const FIXTURES = path.resolve(import.meta.dir, "../../fixtures/hooks/claude-code");

test("given a protected main, a piped Claude PreToolUse branch creation is denied with protected_ref", async () => {
  await withProtectedMain((configDir) => {
    const root = tempRoot();
    try {
      const child = spawnSync(process.execPath, ["run", RUN, "claude_code"], {
        input: JSON.stringify({
          ...fixture("claude-code", "pre-tool-use-bash", root),
          tool_name: "Bash",
          tool_input: { command: "git checkout -b main" },
        }),
        encoding: "utf8",
        env: { ...process.env, WORKFLOW_TOOLKIT_CONFIG_DIR: configDir },
      });
      expect(child.status).toBe(0);
      const output = JSON.parse(child.stdout) as {
        hookSpecificOutput: {
          hookEventName: string;
          permissionDecision: string;
          permissionDecisionReason: string;
        };
      };
      expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("protected_ref");
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
        "choose a non-protected branch",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("Claude PowerShell commands get the same branch policy as Bash", async () => {
  await withProtectedMain(() => {
    const root = tempRoot();
    try {
      const shell = (tool_name: string, command: string) =>
        JSON.stringify(
          dispatchHook(
            claudeCodeAdapter,
            fixture("claude-code", "pre-tool-use-bash", root, {
              tool_name,
              tool_input: { command },
            }),
            {},
          ).json,
        );
      expect(shell("PowerShell", "git checkout -b main")).toContain('"permissionDecision":"deny"');
      expect(shell("PowerShell", "git checkout -b feature/ok")).toBe("{}");
      expect(shell("Bash", "git checkout -b main")).toContain('"permissionDecision":"deny"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("permissionDecision hosts never receive allow, for any fixture or command", async () => {
  await withProtectedMain(() => {
    const root = tempRoot();
    try {
      startTask(root, { host: "claude_code", actor: "claude-session-1" });
      const outputs = readdirSync(FIXTURES).map((name) =>
        JSON.stringify(
          dispatchHook(claudeCodeAdapter, fixture("claude-code", name.slice(0, -5), root), {}).json,
        ),
      );
      for (const command of ["git checkout -b main", "git switch -c feature/ok", "ls"]) {
        const tool_input = { command };
        outputs.push(
          JSON.stringify(
            dispatchHook(
              claudeCodeAdapter,
              fixture("claude-code", "pre-tool-use-bash", root, { tool_input }),
              {},
            ).json,
          ),
          JSON.stringify(
            dispatchHook(
              codexAdapter,
              fixture("codex", "pre-tool-use-bash", root, { tool_input }),
              {},
            ).json,
          ),
        );
      }
      expect(outputs.some((text) => text.includes('"deny"'))).toBe(true);
      for (const text of outputs) expect(text).not.toContain('"allow"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("given SessionStart source compact, additionalContext restores the task context", () => {
  const root = tempRoot();
  try {
    startTask(root, { host: "claude_code", actor: "claude-session-1" }, "restore after compaction");
    const result = dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "session-start-compact", root),
      {},
    );
    const output = (
      result.json as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    ).hookSpecificOutput;
    expect(output.hookEventName).toBe("SessionStart");
    expect(output.additionalContext).toContain("<workit-contract>");
    expect(output.additionalContext).toContain("<workit-task-context>");
    expect(output.additionalContext).toContain("restore after compaction");
    // Codex binds the workspace's single active task the same way.
    const codex = dispatchHook(codexAdapter, fixture("codex", "session-start", root), {});
    expect(JSON.stringify(codex.json)).toContain("<workit-task-context>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude renders context, per-turn context, and silent events in its native shapes", () => {
  const root = tempRoot();
  try {
    const render = (name: string, overrides: Record<string, unknown> = {}) =>
      dispatchHook(claudeCodeAdapter, fixture("claude-code", name, root, overrides), {}).json;
    // No task bound: the per-turn hook stays silent.
    expect(render("user-prompt-submit")).toEqual({});
    startTask(root, { host: "claude_code", actor: "claude-session-1" }, "per-turn task");
    const turn = (
      render("user-prompt-submit") as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      }
    ).hookSpecificOutput;
    expect(turn.hookEventName).toBe("UserPromptSubmit");
    expect(turn.additionalContext).toStartWith("<workit-task-context>");
    expect(turn.additionalContext).toContain("per-turn task");
    expect(render("subagent-start")).toEqual({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext:
          "Workit observed Claude Code subagent agent-1 (reviewer) as read-only/agent-guided; writer delegation is unavailable.",
      },
    });
    // PreCompact cannot inject context; its notice rides the common systemMessage field.
    expect(render("pre-compact")).toEqual({
      systemMessage:
        "Workit context may be stale after compaction; re-run inspection or resume before acting.",
    });
    // Stop, SubagentStop and PostToolUse are no-ops until S9/S15.
    for (const name of ["stop", "subagent-stop", "post-tool-use-bash", "pre-tool-use-write"])
      expect(render(name), name).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude SubagentStart keys its text on agent_type: only the worktree implementer may write", () => {
  const root = tempRoot();
  try {
    const text = (agent_type: string) =>
      JSON.stringify(
        dispatchHook(
          claudeCodeAdapter,
          fixture("claude-code", "subagent-start", root, { agent_type }),
          {},
        ).json,
      );
    expect(text("workit:implementer")).toContain("working in its own git worktree");
    expect(text("workit:implementer")).not.toContain("read-only");
    expect(text("workit:reviewer")).toContain("read-only/agent-guided");
    expect(text("general-purpose")).toContain("read-only/agent-guided");
    // Other hosts keep their text whatever the agent type is called.
    const codex = JSON.stringify(
      dispatchHook(
        codexAdapter,
        fixture("codex", "subagent-start", root, { agent_type: "implementer" }),
        {},
      ).json,
    );
    expect(codex).toContain("read-only/agent-guided");
    expect(codex).not.toContain("worktree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
