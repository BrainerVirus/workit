// #790: a verifier's unquoted heredoc ran `sed -i` over files in $HOME
// (incident 2026-11-10, ledger mwbalrwk). A verifier or reviewer subagent now
// writes only in a scratch dir, `.workit-scratch/` at a checkout root; every
// other write target is denied naming it. These tests only dispatch the hook:
// no command below is ever run.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { markerFile, type LiveMarker } from "@/packages/workit-core/src/core/live-session";
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
// The scratch dir as the hook names it: its real path (macOS /private/var, Windows long names).
let named: string;
let other: string;
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
  named = path.join(realpathSync.native(lead), ".workit-scratch");
  other = path.join(root, "other");
  mkdirSync(path.join(other, ".workit-scratch"), { recursive: true });
  git(other, "init", "-q", "-b", "main");
});

afterAll(() => {
  if (stateBefore === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = stateBefore;
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});

type Specific = {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
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
      `workit scratch confinement: verifier ver-out may write only in its scratch dir ${named}`,
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
    expect(out?.permissionDecisionReason, command).toContain(`scratch dir ${named}`);
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
      `workit scratch confinement: reviewer rev-1 may write only in its scratch dir ${named}`,
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
  expect(denied?.permissionDecisionReason).toContain(`scratch dir ${named}`);
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
    ...[
      "mkfifo /tmp/zz",
      "eval true",
      "source <(echo x)",
      ". /dev/stdin <<'EOF'\nx\nEOF",
      "wget -O /tmp/f http://x",
      "tar xf a.tar -C /tmp",
      "unzip a.zip -d /tmp",
    ].map((command) => ["Bash", { command }] as const),
  ] as const) {
    const label = `${tool} ${JSON.stringify(input)}`;
    const denied = pre(tool, input, true).hookSpecificOutput;
    expect(denied?.permissionDecision, label).toBe("deny");
    expect(denied?.permissionDecisionReason, label).toContain(
      `workit scratch confinement: verifier ver-launch may write only in its scratch dir ${path.join(realpathSync.native(cwd), ".workit-scratch")}`,
    );
    expect(pre(tool, input, false), label).toEqual({});
  }
});

const denies = (commands: readonly string[], text: string, agent: Agent = { id: "ver-x" }) => {
  for (const command of commands) {
    const out = bash(command, agent);
    expect(out?.permissionDecision, command).toBe("deny");
    expect(out?.permissionDecisionReason, command).toContain(text);
  }
};
const allows = (commands: readonly string[], agent: Agent = { id: "ver-x" }) => {
  for (const command of commands)
    expect(bash(command, agent)?.permissionDecision, command).toBeUndefined();
};

test("Given a judge, When a shell or interpreter runs a script fed by a pipe, stdin, a process substitution or eval, Then it is denied, saying to write the case to a scratch file and dispatch it from a test", () => {
  const fed = [
    "echo 'touch ~/x' | bash",
    "printf 'touch ~/x' | sh -s",
    "echo 'touch ~/x' | bash -s --",
    "echo 'touch ~/x' | env bash",
    "(echo 'touch ~/x') | sudo -u me bash",
    `echo "open('/tmp/f','w')" | python3 -`,
    "python3 <<'EOF'\nopen('/tmp/f','w')\nEOF",
    "node <<'EOF'\nrequire('fs').writeFileSync('/tmp/f','x')\nEOF",
    "bash /dev/stdin <<'EOF'\ntouch ~/x\nEOF",
    ". /dev/stdin <<'EOF'\ntouch ~/x\nEOF",
    "source <(echo 'touch ~/x')",
    ". <(echo 'touch ~/x')",
    "bash <(echo 'touch ~/x')",
    `eval "echo x > ~/f"`,
    "builtin eval true",
    "echo $(echo 'touch ~/x' | bash)",
    `bash -c "echo 'touch ~/x' | sh"`,
    `bash -ec "echo 'touch ~/x' | sh"`,
  ];
  denies(fed, "dispatch it from a test");
  denies(fed, "workit scratch confinement: verifier ver-x", { id: "ver-x" });
  denies(["echo 'touch ~/x' | bash"], "reviewer rev-x", {
    id: "rev-x",
    type: "workit:reviewer",
  });
  allows([
    `bash <<'EOF'\ncat ${path.join(lead, "src", "core.ts")}\nEOF`,
    `bun test ${path.join(scratch, "case.test.ts")}`,
    `python3 ${path.join(scratch, "case.py")}`,
    "node --version",
    "git log --oneline | head -5",
  ]);
});

test("Given a judge, When it runs a workit verb outside its own job, Then it is denied; its own verbs stay allowed", () => {
  denies(
    [
      `workit changelog apply --cwd ${lead}`,
      "workit gc --worktrees --apply",
      "workit fanout worktree create a",
      "workit fanout worktree remove a",
      "workit fanout plan plan.json",
      "workit git push",
      "workit git commit -m x",
      `workit --cwd ${wt} git branch x`,
      "workit git stage a.ts",
      "workit grant add x",
      "workit pr create",
      "workit pr merge 1",
      "workit pr edit 1",
      "workit pr reply 1 x",
      "workit issue create x",
      "workit issue comment 1 x",
      "workit test-audit --mutate --diff",
      "workit some-future-verb",
      "bash -c 'workit gc --apply'",
      "echo $(workit pr create)",
    ],
    "a judge runs only",
  );
  allows([
    "workit check lint",
    `workit check --cwd ${wt} --name t -- bun test a.test.ts`,
    "workit ledger list --branch feature/a",
    "workit ledger check",
    "workit ledger ruling x --why y --cost-if-wrong z",
    "workit ledger finding add x --severity minor",
    "workit --json pr status",
    "workit pr status 796",
    "workit ci wait",
    "workit ci logs",
    "workit help",
    "workit fanout status",
    "workit fanout brief a --fanout wave",
    "workit dir",
    "workit test-audit --diff",
    "workit --version",
  ]);
});

test("Given a judge, When it runs writers that name their output elsewhere (mkfifo, wget, tar, unzip, git init/config/branch/fetch/gc/clone and git output files), Then each is denied outside scratch and allowed inside it", () => {
  denies(
    [
      "mkfifo /tmp/zz",
      "wget -O /tmp/f http://x",
      "wget --output-document=/tmp/f http://x",
      "wget http://x",
      "tar xf a.tar -C /tmp",
      "tar -xf a.tar",
      "tar czf /tmp/a.tgz src",
      "unzip a.zip -d /tmp",
      "unzip a.zip",
      "git init /tmp/zzz",
      "git config user.name x",
      "git config --global user.name x",
      "git branch -D x",
      "git branch topic",
      "git fetch",
      "git gc",
      `git clone ${lead} /tmp/c`,
      "git format-patch -o /tmp/d HEAD~1",
      "git archive -o /tmp/a.tar HEAD",
      "git bundle create /tmp/b HEAD",
      "git diff --output=/tmp/f",
      `git -C ${lead} log --output /tmp/f`,
      "bash -ce 'touch ~/x'",
    ],
    `scratch dir ${named}`,
  );
  allows([
    `mkfifo ${path.join(scratch, "p")}`,
    `wget -O ${path.join(scratch, "f")} http://x`,
    `tar xf a.tar -C ${scratch}`,
    "tar tf a.tar",
    "unzip -l a.zip",
    `git init ${path.join(scratch, "r")}`,
    `git clone ${lead} ${path.join(scratch, "c")}`,
    "git config --get user.name",
    "git branch --show-current",
    "git branch -a --contains HEAD",
    "git format-patch --stdout HEAD~1",
    `git diff --output=${path.join(scratch, "d.diff")}`,
  ]);
});

test("Given a bound implementer, When it runs those writers against the lead's checkout, Then the shared list denies them too; in its own worktree they pass", () => {
  const agent = { id: "impl-writers", type: "workit:implementer" };
  expect(write(path.join(wt, "a.ts"), agent)?.permissionDecision).toBeUndefined();
  for (const command of [
    `git -C ${lead} fetch`,
    `wget -O ${path.join(lead, "x")} http://x`,
    `tar xf a.tar -C ${path.join(lead, "src")}`,
    `mkfifo ${path.join(lead, "p")}`,
  ])
    expect(bash(command, agent)?.permissionDecision, command).toBe("deny");
  for (const command of [`git -C ${wt} fetch`, `wget -O ${path.join(wt, "x")} http://x`])
    expect(bash(command, agent)?.permissionDecision, command).toBeUndefined();
});

test("Given a judge, When it writes in another repository's .workit-scratch, Then it is denied: only the judged checkout's scratch counts", () => {
  denies(
    [
      `echo x > ${path.join(other, ".workit-scratch", "x")}`,
      `cd ${other} && echo x > .workit-scratch/x`,
    ],
    `scratch dir ${named}`,
  );
  const out = write(path.join(other, ".workit-scratch", "x"), { id: "ver-x" });
  expect(out?.permissionDecision).toBe("deny");
  allows([`echo x > ${path.join(wt, ".workit-scratch", "x")}`]);
});

test("Given a judge, When an unquoted heredoc holds $((…)) arithmetic, Then it is allowed; a command substitution inside it is still denied", () => {
  allows([`cat > ${path.join(scratch, "x")} <<EOF\n$((1+1)) $(( 2 * 3 ))\nEOF`]);
  denies(
    [`cat > ${path.join(scratch, "x")} <<EOF\n$(( $(touch ~/q) + 1 ))\nEOF`],
    "quote the delimiter",
  );
});

test("Given a judge, When a help or version flag sits deeper in a workit call outside its job, Then it is still denied; only one right after workit or the verb asks for help", () => {
  denies(
    [
      "workit gc --worktrees --apply --note -h",
      "workit pr create --body '--help'",
      "workit pr merge 1 --help",
      "workit git push -h origin",
      "workit gc --apply --version",
    ],
    "a judge runs only",
  );
  allows(["workit --help", "workit -h", "workit --version", "workit gc --help", "workit pr -h"]);
});

test("Given a judge, When it runs test-audit with any --mutate form, Then it is denied", () => {
  denies(
    [
      "workit test-audit --mutate=1 --diff",
      "workit test-audit --diff --mutate=true",
      "workit test-audit --mutate",
    ],
    "a judge runs only",
  );
  allows(["workit test-audit --diff"]);
});

test("Given a judge, When a wrapper, compound command, alias, function or another entry to the workit CLI runs a verb outside its job, Then it is denied; the same wrappers around its own verbs pass", () => {
  denies(
    [
      "time workit gc --apply",
      "nohup workit gc --apply",
      "! workit gc --apply",
      "command workit gc --apply",
      "exec workit gc --apply",
      "env FOO=1 workit gc --apply",
      "{ workit gc --apply; }",
      "if true; then workit gc --apply; fi",
      "while true; do workit gc --apply; done",
      "( workit gc --apply )",
      "echo x | xargs workit gc --apply",
      "find . -name x -exec workit gc --apply {} ';'",
      "alias w='workit gc --apply'; w",
      "alias w=workit; w gc --apply",
      'alias w="workit"; w gc --apply',
      "alias w=workit && w gc --apply",
      "alias n=npx; n @workit-dev/cli gc --apply",
      'f() { workit "$@"; }; f gc --apply',
      "f() { workit gc --apply; }; f",
      "function f { workit gc --apply; }; f",
      "npm exec @workit-dev/cli -- gc --apply",
      "npm exec --package=@workit-dev/cli -- workit gc --apply",
      "npx --package @workit-dev/cli workit gc --apply",
      "bunx @workit-dev/cli@latest gc --apply",
      "pnpm dlx @workit-dev/cli gc --apply",
      "bun run workit gc --apply",
      "node node_modules/@workit-dev/cli/dist/index.js gc --apply",
      "bun packages/workit-cli/src/index.tsx gc --apply",
      "bun ./packages/workit-cli/src/main.ts gc --apply",
      "/home/me/.local/bin/workit gc --apply",
    ],
    "a judge runs only",
  );
  allows([
    "time workit check lint",
    "nohup workit ledger list",
    "if true; then workit ledger list; fi",
    "npx --package @workit-dev/cli workit check lint",
    "npm exec @workit-dev/cli -- ledger list",
    "bun run workit ledger list",
    "bun packages/workit-cli/src/index.tsx ledger list",
    "grep -rn workit packages/workit-cli/src/main.ts",
    "bun test test/workit-cli/main.test.ts test/workit-core/hooks/a.test.ts",
    "alias ll='ls -l'; ll src",
    "alias w=workit; w ledger list",
  ]);
});

test("Given another host's live session owns the lead checkout (no pid to compare, as on Windows), When a Claude Code or Codex judge writes in its scratch dir, Then the live-session guard neither denies it nor claims the checkout for the judge", () => {
  const top = realpathSync.native(lead);
  const file = markerFile(top);
  const marker: LiveMarker = {
    version: 1,
    session: "other-lead",
    leads: ["other-lead"],
    host: "cursor",
    pid: null,
    pidStart: null,
    machine: "other-machine",
    checkout: top,
    heartbeatAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(marker));
  try {
    // The guard is on: the lead itself is refused.
    expect(write(path.join(lead, "src", "core.ts"), { type: null })?.permissionDecision).toBe(
      "deny",
    );
    expect(write(path.join(scratch, "case.ts"))?.permissionDecision).toBeUndefined();
    expect(bash(`echo x > ${path.join(scratch, "out.txt")}`)?.permissionDecision).toBeUndefined();
    const patch = (
      dispatchHook(
        codexAdapter,
        fixture("codex", "pre-tool-use-apply-patch", lead, {
          agent_id: "codex-ver",
          agent_type: "workit-verifier",
          tool_input: {
            command: `*** Begin Patch\n*** Add File: ${path.join(scratch, "x.ts")}\n+x\n*** End Patch\n`,
          },
        }),
        {},
      ).json as Specific
    ).hookSpecificOutput;
    expect(patch?.permissionDecision).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8")).session).toBe("other-lead");
  } finally {
    rmSync(file, { force: true });
  }
});

test("Given a verifier or reviewer, When it writes a probe in the candidate worktree's .workit-scratch (from the lead's cwd or the candidate's), Then it is allowed; elsewhere in the candidate it is still denied", () => {
  const probe = path.join(wt, ".workit-scratch", "x.test.ts");
  for (const type of ["workit:verifier", "workit:reviewer"])
    for (const cwd of [lead, wt]) {
      const agent = { id: `judge-${cwd === wt ? "wt" : "lead"}`, type };
      const at = (tool: string, toolInput: Record<string, unknown>) => {
        const payload = fixture("claude-code", "pre-tool-use-write", cwd, {
          tool_name: tool,
          tool_input: toolInput,
        });
        payload.agent_id = agent.id;
        payload.agent_type = type;
        return (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput;
      };
      for (const [tool, toolInput] of [
        ["Write", { file_path: probe, content: "x" }],
        ["Bash", { command: posix(`mkdir -p ${path.dirname(probe)}`) }],
        [
          "Bash",
          {
            command: posix(`cat > ${probe} <<'EOF'\nimport { test } from "bun:test";\nEOF`),
          },
        ],
        [
          "Bash",
          {
            command: posix(`workit check --cwd ${wt} --name probe -- bun test ${probe}`),
          },
        ],
        ["Bash", { command: posix(`bun test ${probe}`) }],
        ["Bash", { command: posix(`touch ${probe}`) }],
        ["Bash", { command: posix(`printf x > ${probe}`) }],
        ["Bash", { command: posix(`cd ${wt} && bun test .workit-scratch/x.test.ts`) }],
        ["Edit", { file_path: probe, old_string: "a", new_string: "b" }],
      ] as const)
        expect(
          at(tool, toolInput)?.permissionDecision,
          `${type} ${cwd} ${JSON.stringify(toolInput)}`,
        ).toBeUndefined();
      for (const target of [path.join(wt, "a.ts"), path.join(wt, "src", "x.test.ts")]) {
        const out = at("Write", { file_path: target, content: "x" });
        expect(out?.permissionDecision, target).toBe("deny");
        // From the lead's cwd the deny names the candidate's scratch dir too.
        if (cwd === lead)
          expect(out?.permissionDecisionReason).toContain(
            `${named} or ${path.join(realpathSync.native(wt), ".workit-scratch")}`,
          );
      }
    }
});
