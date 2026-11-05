// One git rule per worktree kind (#292): an implementer in a Workit worktree
// (`workit fanout worktree create`, the default) runs `workit git --cwd`; one
// Claude Code isolated in `.claude/worktrees/agent-<id>` runs plain git, since
// that isolation refuses a git wrapper. The SubagentStart hook, the
// implementer agent and every workit-implement copy must say the same.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { fixture, tempRoot } from "@/test/workit-core/hooks/hook-fixtures";

const repoRoot = path.resolve(import.meta.dir, "../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
let state: string | undefined;
beforeEach(() => {
  state = process.env.WORKIT_STATE_DIR;
  const dir = tempRoot("workit-git-contract-state-");
  roots.push(dir);
  process.env.WORKIT_STATE_DIR = dir;
});
afterEach(() => {
  if (state === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = state;
});

const repo = () => {
  const root = tempRoot("workit-git-contract-");
  roots.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("checkout", "-q", "-b", "feature/x");
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

type Out = { hookSpecificOutput?: { additionalContext?: string } };
const implementerStart = (cwd: string): string =>
  (
    dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "subagent-start", cwd, { agent_type: "workit:implementer" }),
    ).json as Out
  ).hookSpecificOutput?.additionalContext ?? "";

test("Given an implementer in a Workit worktree and one in a Claude Code host-isolated worktree, Then the hook, the implementer agent and every workit-implement copy state the same git rule per kind", () => {
  const root = repo();
  const workitTree = implementerStart(root);
  expect(workitTree).toContain('`workit git --cwd <worktree> commit -m "<message>" -- <paths>`');
  expect(workitTree).not.toContain("Run git as plain");
  const isolated = path.join(root, ".claude", "worktrees", "agent-agent-1");
  spawnSync("git", ["worktree", "add", "-q", "--detach", isolated], { cwd: root });
  const hostIsolated = implementerStart(isolated);
  expect(hostIsolated).toContain("Run git as plain");
  expect(hostIsolated).toContain("never `workit git …`");

  // The agent names both kinds and quotes the hook's isolated-worktree text.
  const agent = read("packages/workit-claude-code/agents/implementer.md");
  expect(agent).toContain("In a Workit worktree (the default)");
  expect(agent).toContain("`workit git --cwd <worktree> commit");
  expect(agent).toContain("Claude Code host-isolated worktree (`.claude/worktrees/agent-<id>`");
  expect(agent).toContain('says "Run git as plain"');
  expect(agent).toContain("never `workit git …`");

  // Every committed workit-implement copy carries the same host note.
  for (const skill of [
    "packages/workit-core/skills/workit-implement/SKILL.md",
    "packages/workit-cursor/skills/workit-implement/SKILL.md",
  ]) {
    const text = read(skill);
    expect(text, skill).toContain(
      "a Workit worktree (`workit fanout worktree create`) takes `workit git --cwd <worktree> …`",
    );
    expect(text, skill).toContain(
      "a Claude Code host-isolated one (`.claude/worktrees/agent-<id>`) takes plain git",
    );
  }
});

test("Given the implementer definitions on Claude Code and Codex, Then each adds Co-Authored-By with `workit git commit --trailer`, and Codex drops the Claude-only isolated-worktree rule", () => {
  const trailer = '`workit git commit --trailer "Co-Authored-By: <name> <email>" -- <paths>`';
  expect(read("packages/workit-claude-code/agents/implementer.md")).toContain(trailer);
  const codex = read("packages/workit-codex/agents/workit-implementer.toml");
  expect(codex).toContain(trailer);
  expect(codex).not.toContain("host-isolated");
});
