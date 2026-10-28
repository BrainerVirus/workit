// #271 S2a: a verifier or reviewer starts with its exact, filled-in verdict
// command, so its first step is the verdict, not `workit ledger verdict --help`.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { main } from "@/packages/workit-cli/src/main";
import { appendObserved } from "@/packages/workit-core/src/ledger";
import { sessionClaimRefusal } from "@/packages/workit-core/src/host-session";
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
const codex = (cwd: string, agent: string, agentId = "agent-1") =>
  (
    dispatchHook(
      codexAdapter,
      fixture("codex", "subagent-start", cwd, { agent_type: agent, agent_id: agentId }),
      {},
    ).json as Out
  ).hookSpecificOutput?.additionalContext ?? "";

const LINE = /`(workit ledger verdict <verified\|failed\|blocked> [^`]*)`/u;
const lineIn = (text: string): string | null => LINE.exec(text)?.[1] ?? null;

/** The line as a verifier fills it in: a result and what it ran. */
const argvOf = (line: string): string[] =>
  line
    .replace("<verified|failed|blocked>", "verified")
    .replace("<live|unit>", "live")
    .replace('--how "<what you ran and saw>"', "")
    .split(" ")
    .filter(Boolean)
    .slice(1);

test("Given a verifier and a reviewer spawned on Claude Code, When they start, Then each context holds its exact verdict line with branch, session and --token=", () => {
  const root = repo();
  for (const [agent, id, kind] of [
    ["workit:verifier", "agent-1", "<live\\|unit>"],
    ["workit:reviewer", "agent-2", "review"],
  ] as const) {
    const line = lineIn(claude(root, agent, id));
    expect(line, agent).toMatch(
      new RegExp(
        `^workit ledger verdict <verified\\|failed\\|blocked> --kind ${kind} --branch feature/x --session claude-session-1:${id} --token=[0-9a-f]{36} --how "<what you ran and saw>"$`,
        "u",
      ),
    );
    expect(line, agent).not.toContain("--token ");
  }
});

test("Given a verifier and a reviewer spawned on Codex, When they start, Then the line carries no --session and no --token", () => {
  const root = repo();
  expect(lineIn(codex(root, "workit-verifier"))).toBe(
    'workit ledger verdict <verified|failed|blocked> --kind <live|unit> --branch feature/x --how "<what you ran and saw>"',
  );
  expect(lineIn(codex(root, "workit-reviewer", "agent-2"))).toBe(
    'workit ledger verdict <verified|failed|blocked> --kind review --branch feature/x --how "<what you ran and saw>"',
  );
  expect(codex(root, "workit-verifier", "agent-3")).not.toMatch(/--token|--session/u);
});

test("Given SubagentStart fired again for an id already issued, When the judge starts, Then it gets no command (one without the token is refused) and is told to spawn a fresh verifier", () => {
  const root = repo();
  expect(lineIn(claude(root, "workit:verifier"))).not.toBeNull();
  const replay = claude(root, "workit:verifier");
  expect(lineIn(replay)).toBeNull();
  expect(replay).not.toContain("workit ledger verdict");
  expect(replay).toContain("unbound_session");
  expect(replay).toContain("spawn a fresh verifier");
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
    kind: "live",
    actor: { session: "claude-session-1:agent-1" },
  });
});

// Contract: the line each host hands out, with its placeholders filled, passes
// the CLI's own session claim check from that host's child shell.
const fill = (line: string): string[] => argvOf(line).filter((arg) => arg !== "--how");
const flagValue = (argv: string[], name: string): string | undefined => {
  const at = argv.findIndex((arg) => arg === name);
  return at < 0 ? undefined : argv[at + 1];
};
const tokenOf = (argv: string[]): string | undefined =>
  argv.find((arg) => arg.startsWith("--token="))?.slice("--token=".length);

test("Given the line Claude Code hands a verifier, When the claim check runs from the inherited lead env, Then it passes with the token the line carries", () => {
  const root = repo();
  const argv = fill(lineIn(claude(root, "workit:verifier")) ?? "");
  const env = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "claude-session-1" };
  const session = flagValue(argv, "--session") ?? "";
  expect(sessionClaimRefusal(env, session, root, { token: tokenOf(argv), flag: true })).toBeNull();
});

test("Given the line Codex hands a verifier, When it runs from a child whose CODEX_THREAD_ID is the agent id, Then it names no session and a stray --session <lead>:<agent> is still accepted", () => {
  const root = repo();
  const argv = fill(lineIn(codex(root, "workit-verifier", "agent-1")) ?? "");
  expect(flagValue(argv, "--session")).toBeUndefined();
  expect(tokenOf(argv)).toBeUndefined();
  const env = { CODEX_THREAD_ID: "agent-1" };
  expect(sessionClaimRefusal(env, "agent-1", root)).toBeNull();
  expect(sessionClaimRefusal(env, "codex-session-1:agent-1", root, { flag: true })).toBeNull();
});

test("Given the OpenCode and Pi child shells, When a --session naming their own derived session is claimed, Then it is accepted as a no-op", () => {
  const root = repo();
  expect(
    sessionClaimRefusal({ OPENCODE_SESSION_ID: "child-9" }, "lead-O:child-9", root, { flag: true }),
  ).toBeNull();
  expect(
    sessionClaimRefusal({ PI_SESSION_ID: "w-1" }, "lead-P:w-1", root, { flag: true }),
  ).toBeNull();
});
