// #310: an implementer subagent runs without host worktree isolation. The
// lead makes its worktree with `workit fanout worktree create`, and Workit's
// own pre-tool hooks keep the implementer in it on every hook-process host
// that names the subagent on its tool events (Claude Code, Codex).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  rmSync(`${root}-link`, { force: true });
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
// Paths in a command use forward slashes: a POSIX shell drops an unquoted `\`
// (Windows paths), and Git Bash takes `C:/…`.
const posix = (command: string) => command.replaceAll("\\", "/");
const bash = (command: string, agent?: { id?: string; type?: string | null }) =>
  claude("Bash", { command: posix(command) }, agent);

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

  // A path reached through a symlink (macOS /var -> /private/var) is named as spelled.
  const linked = `${root}-link`;
  symlinkSync(root, linked, "junction");
  for (const outside of [
    path.join(lead, "src", "core.ts"),
    path.join(wtB, "b.ts"),
    path.join(linked, "app", "src", "core.ts"),
  ]) {
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
  git(lead, "worktree", "add", "-q", "--detach", isolated);
  const payload = fixture("claude-code", "pre-tool-use-write", isolated, {
    tool_name: "Write",
    tool_input: { file_path: path.join(lead, "src", "core.ts"), content: "x" },
    agent_id: "iso-1",
    agent_type: "workit:implementer",
  });
  expect(
    (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput
      ?.permissionDecision,
  ).toBeUndefined();
});

test("Given an implementer whose cwd only looks like Claude Code's isolation (a mkdir'd .claude/worktrees/agent-<id>, not a linked worktree), When it writes the lead's checkout, Then confinement still applies", () => {
  const fake = path.join(root, ".claude", "worktrees", "agent-fake-1");
  mkdirSync(fake, { recursive: true });
  for (const [tool, toolInput] of [
    ["Write", { file_path: path.join(lead, "src", "core.ts"), content: "x" }],
    ["Bash", { command: posix(`git -C ${lead} commit -am x`) }],
  ] as const) {
    const payload = fixture("claude-code", "pre-tool-use-write", fake, {
      tool_name: tool,
      tool_input: toolInput,
      agent_id: "fake-1",
      agent_type: "workit:implementer",
    });
    const out = (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput;
    expect(out?.permissionDecision, tool).toBe("deny");
    expect(out?.permissionDecisionReason, tool).toContain("workit worktree confinement");
  }
});

test("Given an implementer whose hook cwd is outside every repository, When it writes W and then a sibling worktree, Then the binding holds and the second write is denied", () => {
  const outside = (file: string) =>
    (
      dispatchHook(
        claudeCodeAdapter,
        fixture("claude-code", "pre-tool-use-write", os.tmpdir(), {
          tool_name: "Write",
          tool_input: { file_path: file, content: "x" },
          agent_id: "impl-tmp",
          agent_type: "workit:implementer",
        }),
        {},
      ).json as Specific
    ).hookSpecificOutput;
  expect(outside(path.join(wtA, "a.ts"))?.permissionDecision).toBeUndefined();
  const denied = outside(path.join(wtB, "b.ts"));
  expect(denied?.permissionDecision).toBe("deny");
  expect(denied?.permissionDecisionReason).toContain(`bound to the worktree ${wtA}`);
});

test("Given a bound implementer, When it changes worktrees, refs, config or the fan-out plan (the lead's), Then each is denied, while the read forms pass and the lead and a reviewer are not confined", () => {
  const id = { id: "impl-lead-owned" };
  expect(write(path.join(wtA, "a.ts"), id)?.permissionDecision).toBeUndefined();
  const leadOwned = [
    `git worktree remove --force ${wtB}`,
    `git -C ${wtA} worktree add ${path.join(root, "c")}`,
    "git worktree prune",
    "git branch -D feature/b",
    `git -C ${wtA} branch -m feature/z`,
    "git update-ref -d refs/heads/feature/b",
    "git symbolic-ref HEAD refs/heads/feature/b",
    "git tag -d v1",
    "git push origin :feature/b",
    "git push --delete origin feature/b",
    `git -C ${wtA} config user.name x`,
    "git config --unset user.name",
    "git config set user.name x",
    "git stash drop",
    "git remote add up https://example.com/x.git",
    `workit check -- git worktree remove ${wtB}`,
    `bash -c "git branch -D feature/b"`,
    "workit fanout plan plan.json",
    "workit fanout worktree create c --json",
    "workit fanout worktree release b --force --json",
    `workit --cwd ${wtA} fanout worktree release b --force`,
    "workit check -- workit fanout plan plan.json",
  ];
  for (const command of leadOwned) {
    const denied = bash(command, id);
    expect(denied?.permissionDecision, command).toBe("deny");
    expect(denied?.permissionDecisionReason, command).toContain("belong to the lead");
  }
  for (const command of [
    "git worktree list",
    "git branch --list",
    "git config user.name",
    "git config --get user.name",
    "git symbolic-ref HEAD",
    `git -C ${wtA} stash list`,
    "workit fanout status --json",
  ])
    expect(bash(command, id)?.permissionDecision, command).toBeUndefined();
  for (const agent of [{ type: null }, { id: "rev-2", type: "workit:reviewer" }])
    for (const command of leadOwned)
      expect(bash(command, agent)?.permissionDecisionReason ?? "", command).not.toContain(
        "worktree confinement",
      );
});

test("Given a bound implementer, When it runs writers the edit analysis cannot see in the lead's checkout, Then each is denied; run inside W (or on W's files) they pass", () => {
  const id = { id: "impl-opaque" };
  expect(write(path.join(wtA, "a.ts"), id)?.permissionDecision).toBeUndefined();
  const core = path.join(lead, "src", "core.ts");
  for (const command of [
    `bash -c 'echo x > ${core}'`,
    `sh -c "rm ${core}"`,
    `workit check -- bash -c 'echo x > ${core}'`,
    `echo $(rm ${core})`,
    `unlink ${core}`,
    `chmod 000 ${core}`,
    `rsync /etc/hosts ${core}`,
    `find ${lead}/src -delete`,
    `find ${lead}/src -name '*.ts' -exec rm {} +`,
    `xargs rm <<< ${core}`,
    `xargs -0 -n 1 sed -i s/x/y/ <<< ${core}`,
    `awk -i inplace 1 ${core}`,
    `python3 -c "open('${core}','w')"`,
    `node -e "require('fs').rmSync('${core}')"`,
    `perl -e 'unlink "${core}"'`,
    `workit check -- python3 -c "open('${core}','w')"`,
  ]) {
    const denied = bash(command, id);
    expect(denied?.permissionDecision, command).toBe("deny");
    expect(denied?.permissionDecisionReason, command).toContain(`bound to the worktree ${wtA}`);
  }
  const own = path.join(wtA, "a.ts");
  for (const command of [
    `bash -c 'echo x > ${own}'`,
    `chmod +x ${own}`,
    `find ${wtA} -name '*.tmp' -delete`,
    `awk -i inplace 1 ${own}`,
    `cd ${wtA} && python3 -c "print(1)"`,
    `rsync -a /etc/hosts ${own}`,
    `find ${lead}/src -name '*.ts'`,
    `xargs grep x <<< ${core}`,
    "python3 -V",
  ])
    expect(bash(command, id)?.permissionDecision, command).toBeUndefined();
  // The lead's own shell analysis is unchanged: no confinement, no new denials.
  expect(bash(`python3 -c "open('${core}','w')"`, { type: null })?.permissionDecision).toBe(
    undefined,
  );
});

test("Given a bound implementer, When it links into W a path outside W (symlink or hard link), Then it is denied, so no later write reaches the lead through it", () => {
  const id = { id: "impl-link" };
  expect(write(path.join(wtA, "a.ts"), id)?.permissionDecision).toBeUndefined();
  for (const command of [
    `ln -s ${lead}/src ${wtA}/esc && echo x > ${wtA}/esc/core.ts`,
    `ln ${lead}/src/core.ts ${wtA}/hard.ts`,
    `ln -s ../../app/src ${wtA}/esc2`,
    `ln -s -t ${wtA} ${lead}/src`,
  ]) {
    const denied = bash(command, id);
    expect(denied?.permissionDecision, command).toBe("deny");
    expect(denied?.permissionDecisionReason, command).toContain("is outside it");
  }
  for (const command of [`ln -s a.ts ${wtA}/b.ts`, `ln -s /etc/hosts ${wtA}/hosts`])
    expect(bash(command, id)?.permissionDecision, command).toBeUndefined();
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
  // W is wtB here: the Claude Code tests above hold wtA's live-session marker,
  // and on Windows (no owner pid) a Codex session there would be another live
  // session to the live-session guard.
  expect(codex(path.join(lead, "src", "x.ts"), "codex-impl")?.permissionDecision).toBe("deny");
  expect(codex(path.join(wtB, "x.ts"), "codex-impl")?.permissionDecision).toBeUndefined();
  const denied = codex(path.join(lead, "src", "x.ts"), "codex-impl");
  expect(denied?.permissionDecisionReason).toContain(`bound to the worktree ${wtB}`);
});
