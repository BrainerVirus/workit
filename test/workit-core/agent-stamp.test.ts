// #883: a subagent's `workit` calls carry its agent id to the CLI without the
// hook changing the command (a changed command loses its allow rule, and
// Claude Code's auto mode refuses it): the pre-tool hook stamps each call,
// the CLI claims the stamp its session and argv name.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claimAgentStamp, noteAgentStamps } from "@/packages/workit-core/src/agent-stamp";
import { PLUGIN_DIR, runHook } from "@/test/workit-claude-code/plugin-helpers";
import {
  CLAUDE_CODE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
  CURSOR_DESCRIPTOR,
  handleHook,
  OPENCODE_DESCRIPTOR,
  type HookInput,
} from "@/packages/workit-core/src/hooks/index";
import type { HostDescriptor } from "@/packages/workit-core/src/hooks/descriptor";
import { readLedger, recordVerdict } from "@/packages/workit-core/src/ledger";

const BUN = process.execPath;
const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
const repo = () => {
  const root = temp("workit-stamp-repo-");
  git(root, "init", "-q", "-b", "feature/x");
  return root;
};

const shellPre = (
  command: string,
  who: { session: string; agent?: string | null },
  descriptor: HostDescriptor = CLAUDE_CODE_DESCRIPTOR,
  host: HookInput["host"] = "claude_code",
  cwd = repo(),
) =>
  handleHook(
    {
      host,
      cwd,
      session: {
        id: who.session,
        agentId: who.agent ?? null,
        agentType: who.agent ? "workit:verifier" : null,
        parentId: who.agent ? who.session : null,
      },
      permissionMode: "default",
      transcriptPath: null,
      event: { kind: "shell.pre", command, toolUseId: null, toolInput: { command } },
    },
    { descriptor, addendum: null },
  );

/** The CLI's view: the lead's session in its env, `argv` after `workit`. */
const claim = (session: string, argv: string[]) =>
  claimAgentStamp({ ...process.env, WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: session }, argv);
const newSession = () => `s-${crypto.randomUUID()}`;

test("Given a subagent's `workit check`, When the hook passes it, Then the command is unchanged and the CLI with that argv claims the agent once", () => {
  const session = newSession();
  const decision = shellPre("workit check --cwd /w test", { session, agent: "a1" });
  expect(decision.kind === "rewrite" || decision.kind === "update-input").toBe(false);
  expect(claim(session, ["check", "--cwd", "/w", "test"])).toEqual({ agentId: "a1" });
  expect(claim(session, ["check", "--cwd", "/w", "test"])).toBeNull();
});

test("Given a stamped call, Then another argv or another session claims nothing", () => {
  const session = newSession();
  shellPre("workit check lint", { session, agent: "a1" });
  expect(claim(session, ["check", "test"])).toBeNull();
  expect(claim(newSession(), ["check", "lint"])).toBeNull();
  expect(claim(session, ["check", "lint"])).toEqual({ agentId: "a1" });
});

test("Given the lead's own call, Then its CLI claims the lead's stamp (no agent id), which a call with no stamp does not", () => {
  const session = newSession();
  shellPre("workit check lint", { session });
  expect(claim(session, ["check", "lint"])).toEqual({ agentId: null });
  expect(claim(session, ["check", "lint"])).toBeNull();
});

test("Given the lead and a subagent run one argv at once, Then neither claims an agent id (never a wrong one)", () => {
  const session = newSession();
  shellPre("workit check lint", { session, agent: "a1" });
  shellPre("workit check lint", { session });
  expect(claim(session, ["check", "lint"])).toBeNull();
  expect(claim(session, ["check", "lint"])).toBeNull();
});

test.each([
  ["cd /w && workit check lint", ["--cwd", "/w", "check", "lint"]],
  ["env A=1 workit check lint", ["check", "lint"]],
  ["(workit check lint)", ["check", "lint"]],
  ["workit ledger ruling x --why y <<'EOF'\nbody\nEOF", ["ledger", "ruling", "x", "--why", "y"]],
  ["echo start; workit check 'two words' | grep ok", ["check", "two words"]],
])("`%s` runs as written (or as its --cwd call) and is stamped with its argv", (command, argv) => {
  const session = newSession();
  const decision = shellPre(command, { session, agent: "a-2_b" });
  const ran = decision.kind === "rewrite" ? decision.command : command;
  expect(ran).not.toContain("WORKIT_AGENT_ID");
  expect(claim(session, argv)).toEqual({ agentId: "a-2_b" });
});

test("Given a word the shell expands or an agent id outside [A-Za-z0-9_-], Then nothing is stamped", () => {
  const session = newSession();
  shellPre("workit check $NAME", { session, agent: "a1" });
  expect(claim(session, ["check", "$NAME"])).toBeNull();
  shellPre("workit check lint", { session, agent: "a1;rm -rf ~" });
  expect(claim(session, ["check", "lint"])).toBeNull();
});

test("Given a stamp older than its lifetime, Then it is not claimed", () => {
  const session = newSession();
  shellPre("workit check lint", { session, agent: "a1" });
  const root = path.join(process.env.WORKIT_STATE_DIR!, "agent-stamps");
  const old = new Date(Date.now() - 10 * 60_000);
  for (const dir of readdirSync(root))
    for (const name of readdirSync(path.join(root, dir)))
      utimesSync(path.join(root, dir, name), old, old);
  expect(claim(session, ["check", "lint"])).toBeNull();
});

test.each([
  ["Codex (filed under the subagent's own thread)", CODEX_DESCRIPTOR, "codex_cli"],
  ["Cursor (no subagent id on tool hooks)", CURSOR_DESCRIPTOR, "cursor"],
  ["OpenCode (the child's shell carries its own session)", OPENCODE_DESCRIPTOR, "opencode"],
] as const)("%s: the lead's session claims no subagent stamp", (_name, descriptor, host) => {
  const session = newSession();
  shellPre("workit check lint", { session, agent: "a1" }, descriptor, host);
  expect(claim(session, ["check", "lint"])).toBeNull();
});

test("Given a subagent's stamped `workit check`, When the CLI runs it, Then its check row carries the agent id and the lead's next run carries none", () => {
  const root = repo();
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(root, ".workit"));
  writeFileSync(
    path.join(root, ".workit", "checks.json"),
    JSON.stringify({ checks: { ok: [BUN, "-e", "0"] } }),
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  const session = newSession();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: process.env.PATH,
    WORKIT_HOST: "claude_code",
    WORKIT_SESSION_ID: session,
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_LEASE: "",
  };
  const run = (extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(BUN, [MAIN, "check", "--json", "--cwd", root, "ok"], {
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 120_000,
    });
  shellPre(
    `workit check --json --cwd '${root}' ok`,
    { session, agent: "a1" },
    undefined,
    undefined,
    root,
  );
  expect(run().status).toBe(0);
  shellPre(`workit check --json --cwd '${root}' ok`, { session }, undefined, undefined, root);
  expect(run().status).toBe(0);
  expect(agentsOf(root)).toEqual(["a1", null]);
});

const checkRepo = () => {
  const root = repo();
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(root, ".workit"));
  writeFileSync(
    path.join(root, ".workit", "checks.json"),
    JSON.stringify({ checks: { ok: [BUN, "-e", "0"] } }),
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
};
const agentsOf = (root: string) => {
  const ledger = readLedger(root);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows
    .filter((row) => row.type === "check")
    .map((row) => row.actor.agentId ?? null);
};
/** Where each check row's agent id came from (#972), in ledger order. */
const provenanceOf = (root: string) => {
  const ledger = readLedger(root);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === "check").map((row) => row.agentFrom);
};
const spawnCheck = (root: string, env: NodeJS.ProcessEnv) => {
  const base: NodeJS.ProcessEnv = { ...process.env, WORKIT_WORKSPACE_ROOT: "", WORKIT_LEASE: "" };
  // The suite may itself run under a host: each case names the host it means.
  for (const name of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "WORKIT_SESSION_ID",
    "WORKIT_HOST",
    "WORKIT_AGENT_ID",
    "CODEX_THREAD_ID",
    "OPENCODE_SESSION_ID",
    "PI_SESSION_ID",
  ])
    delete base[name];
  return spawnSync(BUN, [MAIN, "check", "--json", "--cwd", root, "ok"], {
    env: { ...base, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
};
const runCheck = (root: string, env: NodeJS.ProcessEnv) => spawnCheck(root, env).status;

test("Given an agent shell that exports its own WORKIT_AGENT_ID, When workit runs under a host, Then only a claimed stamp names the agent: alone it is ignored, with a stamp the stamp wins", () => {
  const root = checkRepo();
  const session = newSession();
  const claude = {
    WORKIT_HOST: "claude_code",
    WORKIT_SESSION_ID: session,
    WORKIT_AGENT_ID: "forged",
  };
  expect(runCheck(root, claude)).toBe(0);
  shellPre(
    `workit check --json --cwd '${root}' ok`,
    { session, agent: "a1" },
    undefined,
    undefined,
    root,
  );
  expect(runCheck(root, claude)).toBe(0);
  // Codex's own thread variable is a host too; no host at all (CI, a terminal) keeps the variable.
  expect(runCheck(root, { CODEX_THREAD_ID: newSession(), WORKIT_AGENT_ID: "forged" })).toBe(0);
  expect(runCheck(root, { WORKIT_SESSION_ID: session, WORKIT_AGENT_ID: "ci-run" })).toBe(0);
  expect(agentsOf(root)).toEqual([null, "a1", null, "ci-run"]);
  expect(provenanceOf(root)).toEqual(["none", "stamp", "none", "env"]);
});

test("Given the lead's own stamped call, Then its row is stamp-bound with no agent id", () => {
  const root = checkRepo();
  const session = newSession();
  shellPre(`workit check --json --cwd '${root}' ok`, { session }, undefined, undefined, root);
  expect(runCheck(root, { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: session })).toBe(0);
  expect(agentsOf(root)).toEqual([null]);
  expect(provenanceOf(root)).toEqual(["stamp"]);
});

test("Given a run under Claude Code or Codex that no stamp named, Then it says the run is bound to no agent and names the plain call; a stamped run, an OpenCode child and a plain terminal do not", () => {
  const root = checkRepo();
  const session = newSession();
  const note = "bound to no agent";
  const claude = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: session };
  const unstamped = spawnCheck(root, claude);
  expect(unstamped.status).toBe(0);
  expect(unstamped.stderr).toContain(note);
  expect(unstamped.stderr).toContain("rerun it as a plain `workit check ok`");
  expect(spawnCheck(root, { CODEX_THREAD_ID: newSession() }).stderr).toContain(note);
  shellPre(`workit check --json --cwd '${root}' ok`, { session }, undefined, undefined, root);
  expect(spawnCheck(root, claude).stderr).not.toContain(note);
  const child = `${newSession()}:ses_child`;
  const opencode = {
    OPENCODE_SESSION_ID: "ses_child",
    WORKIT_HOST: "opencode",
    WORKIT_SESSION_ID: child,
  };
  expect(spawnCheck(root, opencode).stderr).not.toContain(note);
  expect(spawnCheck(root, { WORKIT_SESSION_ID: session }).stderr).not.toContain(note);
  expect(provenanceOf(root)).toEqual(["none", "none", "stamp", "none", "env"]);
});

test("Given a Claude Code shell whose WORKIT_HOST was cleared, When it exports a forged WORKIT_AGENT_ID, Then the host's own variables still read as a host and the id is ignored", () => {
  const root = checkRepo();
  const forged = { WORKIT_SESSION_ID: newSession(), WORKIT_AGENT_ID: "forged" };
  expect(runCheck(root, { ...forged, CLAUDECODE: "1", WORKIT_HOST: "" })).toBe(0);
  expect(runCheck(root, { ...forged, CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(0);
  expect(agentsOf(root)).toEqual([null, null]);
});

test("Given an OpenCode child whose shell carries <lead>:<child>, When it runs a check with an exported WORKIT_AGENT_ID, Then its row keeps its own session and no forged agent", () => {
  const root = checkRepo();
  const child = `${newSession()}:ses_child`;
  expect(
    runCheck(root, {
      OPENCODE_SESSION_ID: "ses_child",
      WORKIT_HOST: "opencode",
      WORKIT_SESSION_ID: child,
      WORKIT_AGENT_ID: "forged",
    }),
  ).toBe(0);
  const ledger = readLedger(root);
  if (!ledger.ok) throw new Error(ledger.error);
  const row = ledger.value.rows.find((one) => one.type === "check");
  expect([row?.actor.session, row?.actor.agentId ?? null]).toEqual([child, null]);
});

test("Given a verifier's stamp waiting at a permission prompt, When the lead's identical call passes Claude Code's launcher, Then the lead's call is stamped too and neither claims the other's id", () => {
  const session = newSession();
  const root = repo();
  noteAgentStamps(process.env, session, "v1", "workit check lint", { toolUseId: "toolu_v" });
  const pre = runHook(PLUGIN_DIR, {
    hook_event_name: "PreToolUse",
    session_id: session,
    transcript_path: "/tmp/x.jsonl",
    cwd: root,
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command: "workit check lint", description: "d" },
    tool_use_id: "toolu_lead",
  });
  expect(pre.status, pre.stderr).toBe(0);
  expect(claim(session, ["check", "lint"])).toBeNull();
  expect(claim(session, ["check", "lint"])).toBeNull();
});

test("Given no subagent stamp pending, When the lead's `workit` call passes Claude Code's launcher, Then it stays on the fast path and writes no stamp", () => {
  const session = newSession();
  const pre = runHook(
    PLUGIN_DIR,
    {
      hook_event_name: "PreToolUse",
      session_id: session,
      transcript_path: "/tmp/x.jsonl",
      cwd: repo(),
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command: "workit check lint", description: "d" },
      tool_use_id: "toolu_lead2",
    },
    { WORKIT_CLAUDE_RUNTIME: "source", WORKIT_BUN: path.join(repo(), "no-bun") },
  );
  expect(pre.stderr).not.toContain("hook unavailable");
});

// #994: a Codex subagent's shell carries its own thread in CODEX_THREAD_ID, and
// its hook payload carries that thread as agent_id beside the lead's session_id.
// Each thread is its own session: the hook files a call's stamp under the
// calling thread with no agent id, and the CLI claims it under CODEX_THREAD_ID.

const codexPre = (
  command: string,
  who: { session: string; agent?: string | null },
  cwd = repo(),
  toolUseId: string | null = null,
) =>
  handleHook(
    {
      host: "codex_cli",
      cwd,
      session: {
        id: who.session,
        agentId: who.agent ?? null,
        agentType: who.agent ? "default" : null,
        parentId: who.agent ? who.session : null,
      },
      permissionMode: "default",
      transcriptPath: null,
      event: { kind: "shell.pre", command, toolUseId, toolInput: { command } },
    },
    { descriptor: CODEX_DESCRIPTOR, addendum: null },
  );
/** A Codex shell's env: only its own thread names the session. */
const codexEnv = (thread: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_THREAD_ID: thread,
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_LEASE: "",
  };
  for (const name of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "WORKIT_SESSION_ID",
    "WORKIT_HOST",
    "WORKIT_AGENT_ID",
    "OPENCODE_SESSION_ID",
    "PI_SESSION_ID",
  ])
    delete env[name];
  return env;
};
const codexClaim = (thread: string, argv: string[]) => claimAgentStamp(codexEnv(thread), argv);
const LINT = ["check", "lint"];

test("Given a Codex subagent's `workit check`, When the hook passes it, Then its own thread claims it with no agent id and the lead's thread claims nothing", () => {
  const lead = newSession();
  const thread = newSession();
  codexPre("workit check lint", { session: lead, agent: thread });
  expect(codexClaim(lead, LINT)).toBeNull();
  expect(codexClaim(thread, LINT)).toEqual({ agentId: null });
  expect(codexClaim(thread, LINT)).toBeNull();
});

test("Given a Codex lead's `workit check`, Then the lead's thread claims it with no agent id and a subagent's thread does not", () => {
  const lead = newSession();
  codexPre("workit check lint", { session: lead });
  expect(codexClaim(newSession(), LINT)).toBeNull();
  expect(codexClaim(lead, LINT)).toEqual({ agentId: null });
});

test("Given a Codex lead and subagent run one argv at once, Then each thread claims its own stamp (no ambiguity)", () => {
  const lead = newSession();
  const thread = newSession();
  codexPre("workit check lint", { session: lead, agent: thread });
  codexPre("workit check lint", { session: lead });
  expect(codexClaim(thread, LINT)).toEqual({ agentId: null });
  expect(codexClaim(lead, LINT)).toEqual({ agentId: null });
});

/** A feature branch off main whose configured check `ok` passes. */
const featureCheckRepo = () => {
  const root = temp("workit-stamp-feature-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(root, ".workit"));
  writeFileSync(
    path.join(root, ".workit", "checks.json"),
    JSON.stringify({ checks: { ok: [BUN, "-e", "0"] } }),
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  git(root, "checkout", "-qb", "feature/x");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "app.ts"), "export const answer = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "feature work");
  return root;
};
/** Each check row as [session, agent id, where the agent id came from]. */
const rowsOf = (root: string) => {
  const ledger = readLedger(root);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows
    .filter((row) => row.type === "check")
    .map((row) => [row.actor.session, row.actor.agentId ?? null, row.agentFrom]);
};
/** One Codex `workit check ok`: the hook sees the thread's call, then the CLI runs in its shell. */
const codexCheck = (root: string, who: { session: string; agent?: string | null }) => {
  codexPre(`workit check --json --cwd '${root}' ok`, who, root);
  const run = spawnCheck(root, codexEnv(who.agent ?? who.session));
  expect(run.status, run.stderr).toBe(0);
};
const codexVerdict = (root: string, thread: string) =>
  recordVerdict(
    { cwd: root, actor: { host: "codex_cli", session: thread, agentId: null } },
    { result: "verified", how: "ran the checks" },
  );
const headOf = (root: string) => git(root, "rev-parse", "HEAD").stdout.trim();

test("Given a Codex lead and subagent each run a check through the CLI, Then each row is stamp-bound to its own thread with no agent id", () => {
  const root = featureCheckRepo();
  const lead = newSession();
  const thread = newSession();
  codexCheck(root, { session: lead, agent: thread });
  codexCheck(root, { session: lead });
  expect(rowsOf(root)).toEqual([
    [thread, null, "stamp"],
    [lead, null, "stamp"],
  ]);
});

test("Given Codex threads' checks on one head and a code change since, Then each thread's verdict is held to and cleared by only its own runs", () => {
  const root = featureCheckRepo();
  const lead = newSession();
  const thread = newSession();
  const tested = headOf(root);
  codexCheck(root, { session: lead, agent: thread });
  codexCheck(root, { session: lead });
  writeFileSync(path.join(root, "src", "app.ts"), "export const answer = 2;\n");
  git(root, "commit", "-qam", "code change");
  const moved = headOf(root);
  const held = codexVerdict(root, thread);
  expect(held.ok ? "recorded" : held.error).toContain("head_moved");
  expect(held.ok ? "" : held.error).toContain(tested.slice(0, 12));
  // The subagent's fresh run clears its own verdict; the lead's stale run does not hold it.
  codexCheck(root, { session: lead, agent: thread });
  const recorded = codexVerdict(root, thread);
  expect(recorded.ok ? recorded.value.head : recorded.error).toBe(moved);
  // The subagent's fresh run does not clear the lead's.
  const forLead = codexVerdict(root, lead);
  expect(forLead.ok ? "recorded" : forLead.error).toContain("head_moved");
});

test("Given a Codex subagent shell that forges the lead's CODEX_THREAD_ID, When no lead stamp waits, Then its row is bound to no agent", () => {
  const root = featureCheckRepo();
  const lead = newSession();
  codexPre(`workit check --json --cwd '${root}' ok`, { session: lead, agent: newSession() }, root);
  expect(spawnCheck(root, codexEnv(lead)).status).toBe(0);
  expect(rowsOf(root)).toEqual([[lead, null, "none"]]);
});

/** A Codex subagent's post-tool hook: the lead's thread as session, its own thread as agent id. */
const shellPost = (command: string, lead: string, thread: string, toolUseId: string) =>
  handleHook(
    {
      host: "codex_cli",
      cwd: repo(),
      session: { id: lead, agentId: thread, agentType: "default", parentId: lead },
      permissionMode: "default",
      transcriptPath: null,
      event: { kind: "shell.post", command, stdout: "", exitCode: 0, toolUseId },
    },
    { descriptor: CODEX_DESCRIPTOR, addendum: null },
  );
const note = (session: string, command: string, toolUseId: string) =>
  noteAgentStamps(process.env, session, "a1", command, { toolUseId });

test("Given a Codex subagent's finished call whose `workit` never ran, When its post-tool hook fires, Then its unclaimed stamp under its own thread goes and another call's stays", () => {
  const lead = newSession();
  const thread = newSession();
  const who = { session: lead, agent: thread };
  codexPre("false && workit check lint", who, repo(), "toolu_done");
  codexPre("workit check test", who, repo(), "toolu_other");
  shellPost("false && workit check lint", lead, thread, "toolu_done");
  expect(codexClaim(thread, ["check", "lint"])).toBeNull();
  expect(codexClaim(thread, ["check", "test"])).toEqual({ agentId: null });
});

test("Given a Codex subagent's call that backgrounds its `workit` with `&`, When its post-tool hook fires, Then the stamp stays for the call to claim", () => {
  const lead = newSession();
  const thread = newSession();
  const command = "workit check lint > out.txt 2>&1 &";
  codexPre(command, { session: lead, agent: thread }, repo(), "toolu_bg");
  shellPost(command, lead, thread, "toolu_bg");
  expect(codexClaim(thread, ["check", "lint"])).toEqual({ agentId: null });
});

test("Given Claude Code's launcher, When PostToolUse reports a finished `workit` call, Then it drops that call's stamp on its fast path; a run_in_background call keeps it", () => {
  const session = newSession();
  const post = (toolUseId: string, background: boolean) =>
    runHook(PLUGIN_DIR, {
      hook_event_name: "PostToolUse",
      session_id: session,
      transcript_path: "/tmp/x.jsonl",
      cwd: repo(),
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command: "workit check lint", run_in_background: background },
      tool_response: { stdout: "", stderr: "", interrupted: false },
      tool_use_id: toolUseId,
      agent_id: "a1",
      agent_type: "general-purpose",
    });
  note(session, "workit check lint", "toolu_fg");
  expect(post("toolu_fg", false).status).toBe(0);
  expect(claim(session, ["check", "lint"])).toBeNull();
  note(session, "workit check lint", "toolu_bg2");
  expect(post("toolu_bg2", true).status).toBe(0);
  expect(claim(session, ["check", "lint"])).toEqual({ agentId: "a1" });
});
