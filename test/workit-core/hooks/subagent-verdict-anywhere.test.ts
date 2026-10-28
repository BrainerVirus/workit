// #505: a Claude Code verifier spawned from a checkout outside the repo's
// usual layout (a git worktree under the session scratchpad,
// /tmp/claude-*/…/scratchpad) still gets its issued session and records an
// accepted, non-author verdict.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { appendObserved } from "@/packages/workit-core/src/ledger";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { fixture, tempRoot } from "./hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let state: string | undefined;
beforeEach(() => {
  state = process.env.WORKFLOW_TOOLKIT_STATE;
  const dir = tempRoot("workit-anywhere-state-");
  roots.push(dir);
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

/** A repo on main, and a worktree of feature/x under an unrelated scratchpad dir. */
const scratchpadWorktree = () => {
  const repo = tempRoot("workit-anywhere-repo-");
  const scratch = tempRoot("claude-1000-");
  roots.push(repo, scratch);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  const pad = path.join(scratch, "-home-u-project", "session-1", "scratchpad");
  mkdirSync(pad, { recursive: true });
  const worktree = path.join(pad, "pr-9");
  git(repo, "worktree", "add", "-q", "-b", "feature/x", worktree, "main");
  git(worktree, "commit", "-q", "--allow-empty", "-m", "feature work");
  return { repo, worktree };
};

type Out = { hookSpecificOutput?: { additionalContext?: string } };
const start = (cwd: string, agentId: string) =>
  (
    dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "subagent-start", cwd, {
        agent_type: "workit:verifier",
        agent_id: agentId,
      }),
      {},
    ).json as Out
  ).hookSpecificOutput?.additionalContext ?? "";

const LEAD_ENV = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "claude-session-1" };
const LINE = /`(workit ledger verdict <verified\|failed\|blocked> [^`]*)`/u;

const verdict = async (cwd: string, line: string, env: NodeJS.ProcessEnv = LEAD_ENV) => {
  const argv = line
    .replace("<verified|failed|blocked>", "verified")
    .replace("<live|unit>", "unit")
    .replace("--branch <branch>", "--branch feature/x")
    .replace('--how "<what you ran and saw>"', "")
    .split(" ")
    .filter(Boolean)
    .slice(1);
  let stdout = "";
  let stderr = "";
  const code = await main([...argv, "--how", "ran the suite", "--json"], {
    cwd,
    env: { ...process.env, ...env },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
};

for (const where of ["lead in the repo", "lead in the scratchpad worktree"] as const)
  test(`Given a verifier spawned with the ${where}, When it records the verdict line from a scratchpad worktree, Then the verdict is non-author and session-bound`, async () => {
    const { repo, worktree } = scratchpadWorktree();
    appendObserved(worktree, {
      type: "commit.recorded",
      session: "claude-session-1",
      actor: { host: "cli", session: "claude-session-1", agentId: null },
      branch: "feature/x",
    });
    const context = start(where === "lead in the repo" ? repo : worktree, "agent-9");
    const line = LINE.exec(context)?.[1] ?? null;
    expect(line, context).not.toBeNull();
    expect(line).toContain("--session claude-session-1:agent-9");
    const { code, stdout, stderr } = await verdict(worktree, line ?? "");
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout).data).toMatchObject({
      self: false,
      sessionBound: true,
      actor: { session: "claude-session-1:agent-9" },
    });
  });

// The reported failure: the verifier had no line to run and WORKIT_SESSION_ID
// was unset in its shell. Before #505 that stored a (self: no session) row no
// gate accepts; now it is refused, naming the missing SubagentStart binding.
test("Given a verifier in a scratchpad worktree with no session in its shell and no hook line, When it records a verdict without --self, Then it is refused, not stored as self/no_session", async () => {
  const { worktree } = scratchpadWorktree();
  const bare =
    "workit ledger verdict <verified|failed|blocked> --kind <live|unit> --branch feature/x";
  const { code, stdout } = await verdict(worktree, bare, { WORKIT_SESSION_ID: "" });
  expect(code, stdout).toBe(3);
  const out = JSON.parse(stdout);
  expect(out).toMatchObject({ ok: false, code: "blocked" });
  expect(out.error).toContain("no_session");
  expect(out.unblock).toContain("SubagentStart");
});
