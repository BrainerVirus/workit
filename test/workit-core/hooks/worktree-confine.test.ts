// #310: an implementer subagent runs without host worktree isolation. The
// lead makes its worktree with `workit fanout worktree create`, and Workit's
// own pre-tool hooks keep the implementer in it on every hook-process host
// that names the subagent on its tool events (Claude Code, Codex).
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
import { readLedger } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
let root: string;
let lead: string;
let wtA: string;
let wtB: string;

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const cli = async (cwd: string, argv: string[]) => {
  let stdout = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "lead-1" },
    stdout: (text) => void (stdout += text),
    stderr: () => undefined,
  });
  if (code !== 0) throw new Error(`workit ${argv.join(" ")}: ${stdout}`);
  return JSON.parse(stdout).data;
};

const slice = (id: string) => ({
  id,
  branch: `feature/${id}`,
  tier: "standard",
  reason: "parallel",
  scope: [`${id}.ts`],
  goal: `ship ${id}`,
  acceptance: [`Given the app, When ${id} runs, Then it works`],
  verify: ["workit check test"],
  forbidden: ["no edits outside SCOPE"],
});

beforeAll(async () => {
  configHome = useConfigHome("wk-confine-config-");
  root = mkdtempSync(path.join(os.tmpdir(), "wk-confine-"));
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
    JSON.stringify({ name: "wave", trunk: "main", slices: [slice("a"), slice("b")] }),
  );
  await cli(lead, ["fanout", "plan", plan, "--json"]);
  wtA = (await cli(lead, ["fanout", "worktree", "create", "a", "--json"])).path;
  wtB = (await cli(lead, ["fanout", "worktree", "create", "b", "--json"])).path;
});

afterAll(() => {
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});

type Specific = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};

/** A Claude Code PreToolUse from subagent `agent` (default: a Workit implementer), in the lead's cwd. */
const claude = (
  tool: string,
  toolInput: Record<string, unknown>,
  agent: { id?: string; type?: string | null } = {},
) => {
  const payload = fixture("claude-code", "pre-tool-use-write", lead, {
    tool_name: tool,
    tool_input: toolInput,
  });
  if (agent.type !== null) {
    payload.agent_id = agent.id ?? "impl-1";
    payload.agent_type = agent.type ?? "workit:implementer";
  }
  return (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput;
};
const write = (file: string, agent?: { id?: string; type?: string | null }) =>
  claude("Write", { file_path: file, content: "x" }, agent);
const bash = (command: string, agent?: { id?: string; type?: string | null }) =>
  claude("Bash", { command }, agent);

test("Given an implementer that has not touched a Workit worktree, When it writes in the lead's checkout, Then it is denied as unbound; a file outside any repository is left to host policy", () => {
  const denied = write(path.join(lead, "src", "core.ts"), { id: "impl-unbound" });
  expect(denied?.permissionDecision).toBe("deny");
  expect(denied?.permissionDecisionReason).toContain(
    "workit worktree confinement: implementer impl-unbound is not working in a Workit worktree yet",
  );
  expect(denied?.permissionDecisionReason).toContain("workit fanout worktree create <slice>");
  expect(write(path.join(root, "notes.txt"), { id: "impl-unbound" })?.permissionDecision).toBe(
    undefined,
  );
});

test("Given an implementer bound to worktree W by its first edit there, When it edits outside W, Then the hook denies naming W; inside W it is allowed", () => {
  expect(write(path.join(wtA, "a.ts"), { id: "impl-edit" })?.permissionDecision).toBeUndefined();
  const rows = readLedger(lead);
  expect(rows.ok && rows.value.rows.filter((row) => row.type === "worktree.bound")).toEqual([
    expect.objectContaining({
      worktree: wtA,
      actor: expect.objectContaining({ agentId: "impl-edit" }),
    }),
  ]);

  for (const outside of [path.join(lead, "src", "core.ts"), path.join(wtB, "b.ts")]) {
    const denied = write(outside, { id: "impl-edit" });
    expect(denied?.permissionDecision, outside).toBe("deny");
    expect(denied?.permissionDecisionReason, outside).toContain(
      `implementer impl-edit is bound to the worktree ${wtA}, and ${outside} is outside it`,
    );
    expect(denied?.permissionDecisionReason, outside).toContain(`workit --cwd ${wtA} git commit`);
  }
  expect(
    claude(
      "MultiEdit",
      { file_path: path.join(wtA, "src", "core.ts"), edits: [] },
      { id: "impl-edit" },
    )?.permissionDecision,
  ).toBeUndefined();
  expect(
    claude(
      "Edit",
      { file_path: path.join(lead, "src", "core.ts"), old_string: "1", new_string: "2" },
      { id: "impl-edit" },
    )?.permissionDecision,
  ).toBe("deny");
});

test("Given an implementer bound to W, When it runs git and shell writes, Then raw git or a write in another checkout is denied naming W, while workit --cwd W git|check and git -C W pass", () => {
  expect(
    bash(`workit --cwd ${wtA} git branch feature/a --base main`, { id: "impl-shell" })
      ?.permissionDecision,
  ).toBeUndefined();
  for (const command of [
    `workit --cwd ${wtA} git commit -m "feat: a" -- a.ts`,
    `workit --cwd ${wtA} check test`,
    `git -C ${wtA} add a.ts`,
    `echo x > ${path.join(wtA, "a.ts")}`,
    "git status",
    "ls src",
  ])
    expect(bash(command, { id: "impl-shell" })?.permissionDecision, command).toBeUndefined();
  for (const command of [
    'git commit -m "feat: a"',
    `git -C ${wtB} commit -m x`,
    `cd ${lead} && git add -A`,
    `workit --cwd ${lead} git commit -m "feat: a" -- src/core.ts`,
    `echo x > ${path.join(lead, "src", "core.ts")}`,
  ]) {
    const denied = bash(command, { id: "impl-shell" });
    expect(denied?.permissionDecision, command).toBe("deny");
    expect(denied?.permissionDecisionReason, command).toContain(`bound to the worktree ${wtA}`);
  }
});

test("Given the lead, a judge, or an implementer Claude Code isolated itself, When they edit the lead's checkout, Then confinement does not apply", () => {
  const file = path.join(lead, "src", "core.ts");
  expect(write(file, { type: null })?.permissionDecision).toBeUndefined();
  expect(write(file, { id: "rev-1", type: "workit:reviewer" })?.permissionDecision).toBeUndefined();
  expect(write(file, { id: "x-1", type: "implementer" })?.permissionDecision).toBeUndefined();
  const isolated = path.join(lead, ".claude", "worktrees", "agent-iso-1");
  mkdirSync(isolated, { recursive: true });
  const payload = fixture("claude-code", "pre-tool-use-write", isolated, {
    tool_name: "Write",
    tool_input: { file_path: path.join(isolated, "a.ts"), content: "x" },
    agent_id: "iso-1",
    agent_type: "workit:implementer",
  });
  expect(
    (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput
      ?.permissionDecision,
  ).toBeUndefined();
});

test("Given a Codex workit-implementer subagent, When it patches the lead's checkout and then its worktree, Then the same confinement applies", () => {
  const codex = (patchPath: string, id: string) =>
    (
      dispatchHook(
        codexAdapter,
        fixture("codex", "pre-tool-use-apply-patch", lead, {
          agent_id: id,
          agent_type: "workit-implementer",
          tool_input: {
            command: `*** Begin Patch\n*** Add File: ${patchPath}\n+x\n*** End Patch\n`,
          },
        }),
        {},
      ).json as Specific
    ).hookSpecificOutput;
  expect(codex(path.join(lead, "src", "x.ts"), "codex-impl")?.permissionDecision).toBe("deny");
  expect(codex(path.join(wtA, "x.ts"), "codex-impl")?.permissionDecision).toBeUndefined();
  const denied = codex(path.join(lead, "src", "x.ts"), "codex-impl");
  expect(denied?.permissionDecisionReason).toContain(`bound to the worktree ${wtA}`);
});
