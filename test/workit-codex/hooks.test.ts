// Codex hook parity: per-turn task context and the skill prompt nudge on
// UserPromptSubmit, and the verifier/reviewer session naming and implementer
// worktree guidance on SubagentStart, driven by agent type rather than host.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import {
  claudeCodeAdapter,
  codexAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import { fixture, startTask, tempRoot } from "@/test/workit-core/hooks/hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A Workit workspace checkout on feature/x. */
const repo = () => {
  const root = tempRoot("workit-codex-hooks-");
  roots.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("checkout", "-q", "-b", "feature/x");
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

type Out = { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
const codex = (name: string, cwd: string, overrides: Record<string, unknown> = {}) =>
  (dispatchHook(codexAdapter, fixture("codex", name, cwd, overrides), {}).json as Out)
    .hookSpecificOutput;
const turn = (cwd: string, prompt = "what changed?", extra: Record<string, unknown> = {}) =>
  codex("user-prompt-submit", cwd, { prompt, ...extra });

const progress = (root: string, taskId: string, nextAction: string) => {
  const done = new WorkitCore(new TaskStore(root), {
    root,
    caller: { host: "workit_cli", actor: "cli" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-02T00:00:00Z",
  }).task({
    schemaVersion: 1,
    action: "progress",
    taskId,
    progress: { summary: "progress", nextAction, blockers: [] },
  });
  if (!done.ok) throw new Error(done.error);
};

test("G an active task, W Codex prompts, T the task context is sent once, again only when it changes, never right after SessionStart", () => {
  const root = repo();
  // No task: the hook answers without context.
  expect(turn(root)).toEqual({ hookEventName: "UserPromptSubmit" });
  const id = startTask(root, { host: "workit_cli", actor: "cli" }, "codex per-turn task");
  expect(turn(root)?.additionalContext).toContain("codex per-turn task");
  expect(turn(root)?.additionalContext).toBeUndefined();
  progress(root, id, "write the parser test");
  expect(turn(root)?.additionalContext).toContain("write the parser test");
  expect(turn(root)?.additionalContext).toBeUndefined();
  // SessionStart (startup, compaction restore or fork) injects the context
  // itself and reseeds the digest: the context changed since the last turn,
  // yet the next turn does not resend it.
  for (const source of ["startup", "compact", "fork"]) {
    progress(root, id, `next after ${source}`);
    expect(codex("session-start", root, { source })?.additionalContext).toContain(
      `next after ${source}`,
    );
    expect(turn(root)?.additionalContext, source).toBeUndefined();
  }
  // Another Codex thread gets its own copy.
  expect(turn(root, "hi", { session_id: "codex-session-2" })?.additionalContext).toContain(
    "codex per-turn task",
  );
});

test("G a Workit workspace, W a Codex prompt asks for a skill's work, T one advisory line names the skill, once per session and never in a subagent", () => {
  const root = repo();
  const nudge = turn(root, "the parser is broken on empty input, fix the bug")?.additionalContext;
  expect(nudge).toContain("workit-debug");
  expect(
    turn(root, "the parser is broken on empty input, fix the bug")?.additionalContext,
  ).toBeUndefined();
  expect(
    turn(root, "the lexer is broken too", {
      session_id: "codex-session-3",
      agent_id: "agent-9",
      agent_type: "worker",
    })?.additionalContext,
  ).toBeUndefined();
});

test("G a Codex SubagentStart, T Workit judges get their own session and the implementer worktree guidance, by agent type", () => {
  const root = repo();
  const start = (agent_type: string) =>
    codex("subagent-start", root, { agent_type })?.additionalContext ?? "";
  for (const judge of ["workit-verifier", "workit-reviewer"]) {
    const text = start(judge);
    expect(text, judge).toContain("Its own Workit session is codex-session-1:agent-1");
    expect(text, judge).toContain("--session codex-session-1:agent-1");
  }
  const implementer = start("workit-implementer");
  expect(implementer).toContain("its own git worktree");
  // Codex does not isolate subagents itself: the lead makes the worktree.
  expect(implementer).toContain("workit fanout worktree create");
  expect(implementer).toContain("workit git branch <branch> --base <base>");
  expect(implementer).not.toContain("read-only");
  for (const other of [
    "worker",
    "explorer",
    "implementer",
    "verifier",
    "other:workit-verifier",
    // Claude's namespaced spelling is not how Codex names custom agents.
    "workit:verifier",
    "workit:implementer",
  ]) {
    const text = start(other);
    expect(text, other).toContain("read-only/agent-guided");
    expect(text, other).not.toContain("Its own Workit session");
  }
});

test("G a Claude Code SubagentStart, T only the plugin-namespaced workit:<role> agents get role guidance", () => {
  const root = repo();
  const claude = (agent_type: string) =>
    (
      dispatchHook(
        claudeCodeAdapter,
        fixture("claude-code", "subagent-start", root, { agent_type }),
      ).json as Out
    ).hookSpecificOutput?.additionalContext ?? "";
  // Claude Code's native worktree isolation keeps its own wording.
  const implementer = claude("workit:implementer");
  expect(implementer).toContain("working in its own git worktree: it may edit and commit there");
  expect(implementer).not.toContain("workit fanout worktree");
  expect(claude("workit:verifier")).toContain("Its own Workit session is");
  // Plugin agents are always namespaced: a bare workit-<role> is someone
  // else's agent and is never told it is worktree-isolated.
  for (const other of ["workit-implementer", "workit-verifier", "workit-reviewer"]) {
    const text = claude(other);
    expect(text, other).toContain("read-only/agent-guided");
    expect(text, other).not.toContain("git worktree");
    expect(text, other).not.toContain("Its own Workit session");
  }
});
