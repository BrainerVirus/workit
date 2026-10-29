// `workit git stage|unstage` change a checkout's index like `workit git
// commit` does, so the write gate counts them as mutations of the directory
// they run in (`--cwd`): a confined implementer cannot reach another
// checkout's index through them, and its own worktree stays allowed.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { shellMutationTargets } from "@/packages/workit-core/src/hooks/write-gate";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
let root: string;
let lead: string;
let wt: string;

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
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

beforeAll(async () => {
  configHome = useConfigHome("wk-gate-stage-config-");
  root = mkdtempSync(path.join(os.tmpdir(), "wk-gate-stage-"));
  lead = path.join(root, "app");
  mkdirSync(lead, { recursive: true });
  git(lead, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", path.join(root, "no-hooks")],
  ])
    git(lead, "config", key, value);
  writeFileSync(path.join(lead, "f.ts"), "export const f = 1;\n");
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
          scope: ["f.ts"],
          goal: "ship a",
          acceptance: ["Given the app, When a runs, Then it works"],
          verify: ["workit check test"],
          forbidden: ["no edits outside SCOPE"],
        },
      ],
    }),
  );
  await cli(lead, ["fanout", "plan", plan, "--json"]);
  wt = (await cli(lead, ["fanout", "worktree", "create", "a", "--json"])).path;
});

afterAll(() => {
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});

const posix = (text: string) => text.replaceAll("\\", "/");

/** A Claude Code Bash PreToolUse from implementer `impl-stage`, in the lead's cwd. */
const bash = (command: string) => {
  const payload = fixture("claude-code", "pre-tool-use-write", lead, {
    tool_name: "Bash",
    tool_input: { command: posix(command) },
  });
  payload.agent_id = "impl-stage";
  payload.agent_type = "workit:implementer";
  const out = dispatchHook(claudeCodeAdapter, payload, {}).json as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return out.hookSpecificOutput;
};

test("Given workit git stage|unstage --cwd <dir>, Then the write gate names <dir> as mutated; --help is inert", () => {
  // A POSIX shell drops an unquoted `\` (Windows paths): spell them with `/`.
  const at = posix(lead);
  for (const command of [
    `workit git --cwd ${at} stage -- f.ts`,
    `workit git stage --cwd ${at} --patch hunk.patch`,
    `workit --cwd ${at} git unstage -- f.ts`,
  ])
    expect(shellMutationTargets(root, command, "posix"), command).toContain(
      path.join(lead, ".workit-live-target"),
    );
  expect(shellMutationTargets(root, `workit git --cwd ${at} stage --help`, "posix")).toEqual([]);
});

test("Given an implementer bound to its worktree, When it runs workit git stage|unstage, Then its worktree is allowed and another checkout is denied", () => {
  // The first change binds the implementer to its worktree.
  for (const command of [
    `workit git --cwd ${wt} stage -- f.ts`,
    `workit git --cwd ${wt} stage --patch -`,
    `workit git --cwd ${wt} unstage -- f.ts`,
  ])
    expect(bash(command)?.permissionDecision, command).toBeUndefined();
  for (const command of [
    `workit git --cwd ${lead} stage -- f.ts`,
    `workit git stage --cwd ${lead} --patch -`,
    `workit --cwd ${lead} git unstage -- f.ts`,
  ]) {
    const denied = bash(command);
    expect(denied?.permissionDecision, command).toBe("deny");
    expect(denied?.permissionDecisionReason, command).toContain(`bound to the worktree ${wt}`);
  }
});
