// #271 S2a: a verifier or reviewer starts with its exact, filled-in verdict
// command, so its first step is the verdict, not `workit ledger verdict --help`.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { main } from "@/packages/workit-cli/src/main";
import { appendObserved } from "@/packages/workit-core/src/ledger";
import {
  claudeCodeAdapter,
  codexAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import { fixture, tempRoot, withProtectedMain } from "./hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let state: string | undefined;
beforeEach(() => {
  state = process.env.WORKFLOW_TOOLKIT_STATE;
  const dir = tempRoot("workit-verdict-line-state-");
  roots.push(dir);
  // Issued ids are per user: each test gets its own registry.
  process.env.WORKFLOW_TOOLKIT_STATE = dir;
});
afterEach(() => {
  if (state === undefined) delete process.env.WORKFLOW_TOOLKIT_STATE;
  else process.env.WORKFLOW_TOOLKIT_STATE = state;
});

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });

/** A checkout with one commit on main and one on feature/x (checked out). */
const repo = () => {
  const root = tempRoot("workit-verdict-line-");
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "base");
  git(root, "checkout", "-q", "-b", "feature/x");
  git(root, "commit", "-q", "--allow-empty", "-m", "feature work");
  return root;
};

type Out = { hookSpecificOutput?: { additionalContext?: string } };
const claude = (cwd: string, agent: string, agentId = "agent-1") =>
  (
    dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "subagent-start", cwd, { agent_type: agent, agent_id: agentId }),
      {},
    ).json as Out
  ).hookSpecificOutput?.additionalContext ?? "";
const codex = (cwd: string, agent: string) =>
  (
    dispatchHook(codexAdapter, fixture("codex", "subagent-start", cwd, { agent_type: agent }), {})
      .json as Out
  ).hookSpecificOutput?.additionalContext ?? "";

const LINE = /`(workit ledger verdict <verified\|failed\|blocked> [^`]*)`/u;
const lineIn = (text: string): string | null => LINE.exec(text)?.[1] ?? null;

/** The line as a verifier fills it in: a result and what it ran. */
const argvOf = (line: string): string[] =>
  line
    .replace("<verified|failed|blocked>", "verified")
    .replace('--how "<what you ran and saw>"', "")
    .split(" ")
    .filter(Boolean)
    .slice(1);

test("Given a verifier and a reviewer spawned on Claude Code, When they start, Then each context holds its exact verdict line with branch, session and --token=", () => {
  const root = repo();
  for (const [agent, id] of [
    ["workit:verifier", "agent-1"],
    ["workit:reviewer", "agent-2"],
  ] as const) {
    const line = lineIn(claude(root, agent, id));
    expect(line, agent).toMatch(
      new RegExp(
        `^workit ledger verdict <verified\\|failed\\|blocked> --branch feature/x --session claude-session-1:${id} --token=[0-9a-f]{36} --how "<what you ran and saw>"$`,
        "u",
      ),
    );
    expect(line, agent).not.toContain("--token ");
  }
});

test("Given a verifier and a reviewer spawned on Codex, When they start, Then the same line is injected through SubagentStart", () => {
  const root = repo();
  for (const agent of ["workit-verifier", "workit-reviewer"]) {
    const line = lineIn(codex(root, agent));
    if (agent === "workit-verifier")
      expect(line).toMatch(
        /^workit ledger verdict <verified\|failed\|blocked> --branch feature\/x --session codex-session-1:agent-1 --token=[0-9a-f]{36} --how /u,
      );
    // The id is issued once: a second judge under the same agent id gets no token.
    else expect(line).toContain("--session codex-session-1:agent-1 --how");
  }
});

test("Given an implementer or an unrelated agent, When it starts, Then no verdict line is injected", () => {
  const root = repo();
  for (const agent of ["workit:implementer", "Explore", "implementer", "workit-verifier"])
    expect(lineIn(claude(root, agent)), agent).toBeNull();
  expect(lineIn(codex(root, "workit-implementer"))).toBeNull();
});

test("Given a judge started on a protected or detached checkout, When it starts, Then the branch is a placeholder it must fill, never the lead's main", async () => {
  await withProtectedMain(() => {
    const root = repo();
    git(root, "checkout", "-q", "main");
    expect(lineIn(claude(root, "workit:verifier", "agent-1"))).toContain("--branch <branch> ");
    git(root, "checkout", "-q", "--detach", "feature/x");
    expect(lineIn(claude(root, "workit:verifier", "agent-2"))).toContain("--branch <branch> ");
  });
});

test("Given the verdict line a Claude Code verifier received, When it runs it as printed, Then the ledger records an independent, token-bound verdict on that branch", async () => {
  const root = repo();
  appendObserved(root, {
    type: "commit.recorded",
    session: "claude-session-1",
    actor: { host: "cli", session: "claude-session-1", agentId: null },
    branch: "feature/x",
  });
  const line = lineIn(claude(root, "workit:verifier"));
  expect(line).not.toBeNull();
  let stdout = "";
  const code = await main([...argvOf(line ?? ""), "--how", "ran the suite", "--json"], {
    cwd: root,
    env: { ...process.env, WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "claude-session-1" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  expect(code, stdout).toBe(0);
  expect(JSON.parse(stdout).data).toMatchObject({
    branch: "feature/x",
    self: false,
    sessionBound: true,
    actor: { session: "claude-session-1:agent-1" },
  });
});
