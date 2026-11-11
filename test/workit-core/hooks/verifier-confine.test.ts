// #790: a verifier's unquoted heredoc ran `sed -i` over files in $HOME
// (incident 2026-11-10, ledger mwbalrwk). A verifier or reviewer subagent now
// writes only in a scratch dir, `.workit-scratch/` at a checkout root; every
// other write target is denied naming it. These tests only dispatch the hook:
// no command below is ever run.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import {
  claudeCodeAdapter,
  codexAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { PLUGIN_DIR, runHook } from "../../workit-claude-code/plugin-helpers";
import { fixture } from "./hook-fixtures";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
let root: string;
let lead: string;
let wt: string;
let scratch: string;
const stateBefore = process.env.WORKIT_STATE_DIR;

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

beforeAll(async () => {
  configHome = useConfigHome("wk-judge-confine-config-");
  root = mkdtempSync(path.join(os.tmpdir(), "wk-judge-confine-"));
  // The hook and the launcher's runtime keep their records here, never in the real state dir.
  process.env.WORKIT_STATE_DIR = path.join(root, "state");
  lead = path.join(root, "app");
  mkdirSync(path.join(lead, "src"), { recursive: true });
  git(lead, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", path.join(root, "no-hooks")],
  ])
    git(lead, "config", key, value);
  writeFileSync(path.join(lead, "src", "core.ts"), "export const core = 1;\n");
  git(lead, "add", "-A");
  git(lead, "commit", "-qm", "chore: base");
  const plan = path.join(root, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      name: "wave",
      trunk: "main",
      slices: [
        {
          id: "a",
          branch: "feature/a",
          tier: "standard",
          reason: "parallel",
          scope: ["a.ts"],
          goal: "ship a",
          acceptance: ["Given the app, When a runs, Then it works"],
          verify: ["workit check test"],
          forbidden: ["no edits outside SCOPE"],
        },
      ],
    }),
  );
  const cli = async (argv: string[]) => {
    let stdout = "";
    const code = await main(argv, {
      cwd: lead,
      env: { ...process.env, WORKIT_SESSION_ID: "lead-judge" },
      stdout: (text) => void (stdout += text),
      stderr: () => undefined,
    });
    if (code !== 0) throw new Error(`workit ${argv.join(" ")}: ${stdout}`);
    return JSON.parse(stdout).data;
  };
  await cli(["fanout", "plan", plan, "--json"]);
  wt = (await cli(["fanout", "worktree", "create", "a", "--json"])).path;
  scratch = path.join(lead, ".workit-scratch");
});

afterAll(() => {
  if (stateBefore === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = stateBefore;
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});

type Specific = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};
type Agent = { id?: string; type?: string | null };

/** A Claude Code PreToolUse from subagent `agent` (default: a Workit verifier), in the lead's cwd. */
const claude = (tool: string, toolInput: Record<string, unknown>, agent: Agent = {}) => {
  const payload = fixture("claude-code", "pre-tool-use-write", lead, {
    tool_name: tool,
    tool_input: toolInput,
  });
  if (agent.type !== null) {
    payload.agent_id = agent.id ?? "ver-1";
    payload.agent_type = agent.type ?? "workit:verifier";
  }
  return (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput;
};
const posix = (command: string) => command.replaceAll("\\", "/");
const bash = (command: string, agent?: Agent) => claude("Bash", { command: posix(command) }, agent);
const write = (file: string, agent?: Agent) =>
  claude("Write", { file_path: file, content: "x" }, agent);
const edit = (file: string, agent?: Agent) =>
  claude("Edit", { file_path: file, old_string: "a", new_string: "b" }, agent);

const outside = (agent: Agent) => [
  () => bash("cd ~ && touch x", agent),
  () => bash("sed -i s/a/b/ ~/f", agent),
  () => bash("echo > /tmp/other/x", agent),
  () => bash(`cp ${path.join(lead, "src", "core.ts")} ~/core.ts`, agent),
  () => bash(`git -C ${wt} stash`, agent),
  () => bash(`printf x > ${path.join(lead, "src", "core.ts")}`, agent),
  () => write(path.join(os.homedir(), "notes.txt"), agent),
  () => write(path.join(lead, "src", "core.ts"), agent),
  () => edit(path.join(wt, "a.ts"), agent),
];

const inside = (agent: Agent) => [
  () => write(path.join(scratch, "case.sh"), agent),
  () => write(path.join(wt, ".workit-scratch", "case.sh"), agent),
  () => bash(`mkdir -p ${scratch}`, agent),
  () =>
    bash(
      `cat > ${path.join(scratch, "case.sh")} <<'EOF'\nsed -i s/a/b/ ~/f\necho $(rm -rf ~/y)\nEOF`,
      agent,
    ),
  () => bash("workit ledger verdict verified --kind unit --branch feature/a --how 'ran x'", agent),
  () => bash("workit ledger finding add 'x > y' --severity minor", agent),
  () => bash(`workit check --cwd ${wt} test`, agent),
  () => bash(`git -C ${wt} rev-parse HEAD && git -C ${wt} status --short`, agent),
  () => bash("git diff $(git merge-base main HEAD) --stat", agent),
  () => bash("grep -rn core src 2>/dev/null | head", agent),
];

test("Given a verifier, When it writes outside its scratch dir (a cd to ~ then touch, sed -i on ~, a redirect to /tmp, an Edit or Write in the lead's checkout, the candidate or home), Then the hook denies naming its scratch dir", () => {
  for (const call of outside({ id: "ver-out" })) {
    const out = call();
    expect(out?.permissionDecision, call.toString()).toBe("deny");
    expect(out?.permissionDecisionReason, call.toString()).toContain(
      `workit scratch confinement: verifier ver-out may write only in its scratch dir ${scratch}`,
    );
  }
});

test("Given a verifier, When it writes in its scratch dir, records a verdict or finding, or runs read-only commands and workit check, Then each is allowed", () => {
  for (const call of inside({ id: "ver-in" }))
    expect(call()?.permissionDecision, call.toString()).toBeUndefined();
});

test("Given a verifier, When an unquoted heredoc body runs a command substitution, or a shell reads a script on stdin that writes outside, Then it is denied even when the file lands in scratch", () => {
  const agent = { id: "ver-heredoc" };
  const heredoc = bash(
    `cat > ${path.join(scratch, "case.sh")} <<EOF\nsed -i s/a/b/ $(sed -i s/a/b/ ~/f)\nEOF`,
    agent,
  );
  expect(heredoc?.permissionDecision).toBe("deny");
  expect(heredoc?.permissionDecisionReason).toContain("quote the delimiter (<<'EOF')");
  const backtick = bash(`cat > ${path.join(scratch, "x")} <<END\n\`touch ~/q\`\nEND`, agent);
  expect(backtick?.permissionDecision).toBe("deny");
  for (const command of ["bash <<'EOF'\ntouch ~/x\nEOF", "sh -e <<< 'rm ~/x'"]) {
    const out = bash(command, agent);
    expect(out?.permissionDecision, command).toBe("deny");
    expect(out?.permissionDecisionReason, command).toContain(`scratch dir ${scratch}`);
  }
  expect(
    bash(`bash <<'EOF'\ncat ${path.join(lead, "src", "core.ts")}\nEOF`, agent)?.permissionDecision,
  ).toBeUndefined();
});

test("Given a reviewer, Then the same rules hold: outside its scratch dir denied, inside and read-only allowed", () => {
  const agent = { id: "rev-1", type: "workit:reviewer" };
  for (const call of outside(agent)) {
    const out = call();
    expect(out?.permissionDecision, call.toString()).toBe("deny");
    expect(out?.permissionDecisionReason, call.toString()).toContain(
      `workit scratch confinement: reviewer rev-1 may write only in its scratch dir ${scratch}`,
    );
  }
  for (const call of inside(agent))
    expect(call()?.permissionDecision, call.toString()).toBeUndefined();
});

test("Given a Codex workit-verifier, When it patches the lead's checkout or runs sed -i on home, Then it is denied naming its scratch dir; a patch in scratch passes", () => {
  const codex = (event: string, input: Record<string, unknown>) =>
    (
      dispatchHook(
        codexAdapter,
        fixture("codex", event, lead, {
          agent_id: "codex-ver",
          agent_type: "workit-verifier",
          tool_input: input,
        }),
        {},
      ).json as Specific
    ).hookSpecificOutput;
  const patch = (file: string) => ({
    command: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch\n`,
  });
  const denied = codex("pre-tool-use-apply-patch", patch(path.join(lead, "src", "x.ts")));
  expect(denied?.permissionDecision).toBe("deny");
  expect(denied?.permissionDecisionReason).toContain(`scratch dir ${scratch}`);
  expect(
    codex("pre-tool-use-apply-patch", patch(path.join(scratch, "x.ts")))?.permissionDecision,
  ).toBeUndefined();
});

test("Given the lead or an implementer, When they write outside a scratch dir or use an unquoted heredoc, Then scratch confinement does not apply", () => {
  const command = "echo > /tmp/other/x";
  const heredoc = `cat > ${path.join(wt, "a.ts")} <<EOF\n$(date)\nEOF`;
  for (const agent of [{ type: null }, { id: "impl-1", type: "workit:implementer" }]) {
    expect(bash(command, agent)?.permissionDecisionReason ?? "").not.toContain("scratch");
    expect(write(path.join(wt, "a.ts"), agent)?.permissionDecision).toBeUndefined();
    expect(bash(heredoc, agent)?.permissionDecision, JSON.stringify(agent)).toBeUndefined();
  }
});

test("Given a Claude Code verifier in a checkout without tasks, When it edits or shell-writes outside its scratch dir, Then the launcher does not answer on its fast path and the hook denies it; the lead stays on the fast path", () => {
  const cwd = mkdtempSync(path.join(root, "plain-"));
  git(cwd, "init", "-q", "-b", "main");
  const pre = (tool_name: string, tool_input: Record<string, unknown>, judge: boolean) =>
    runHook(
      PLUGIN_DIR,
      fixture("claude-code", "pre-tool-use-write", cwd, {
        tool_name,
        tool_input,
        ...(judge ? { agent_id: "ver-launch", agent_type: "workit:verifier" } : {}),
      }),
    ).json as Specific;
  for (const [tool, input] of [
    ["Write", { file_path: path.join(cwd, "a.ts"), content: "x" }],
    ["Bash", { command: "echo x > /tmp/other/x" }],
    ["Bash", { command: `chmod 600 ${posix(path.join(cwd, "a.ts"))}` }],
  ] as const) {
    const label = `${tool} ${JSON.stringify(input)}`;
    const denied = pre(tool, input, true).hookSpecificOutput;
    expect(denied?.permissionDecision, label).toBe("deny");
    expect(denied?.permissionDecisionReason, label).toContain(
      `workit scratch confinement: verifier ver-launch may write only in its scratch dir ${path.join(cwd, ".workit-scratch")}`,
    );
    expect(pre(tool, input, false), label).toEqual({});
  }
});
