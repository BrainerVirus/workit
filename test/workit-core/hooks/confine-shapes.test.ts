// #772 (follow-up of #664): implementer confinement refused commands whose
// paths it could resolve. Shapes from the denials in retro 2026-11-10 A6, with
// synthetic paths: `$PWD` after a literal `cd`, a `for` over words built from
// a resolved variable or `$PWD`, an inline script looping over files, a
// read-only `curl | python3 -c` run from the lead's checkout, and a command
// substitution, which stays refused with a retry that spells it out.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
let root: string;
let lead: string;
let wt: string;

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const cli = async (cwd: string, argv: string[]) => {
  let stdout = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "lead-shapes" },
    stdout: (text) => void (stdout += text),
    stderr: () => undefined,
  });
  if (code !== 0) throw new Error(`workit ${argv.join(" ")}: ${stdout}`);
  return JSON.parse(stdout).data;
};

beforeAll(async () => {
  configHome = useConfigHome("wk-confine-shapes-config-");
  root = mkdtempSync(path.join(os.tmpdir(), "wk-confine-shapes-"));
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
      name: "shapes",
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
  await cli(lead, ["fanout", "plan", plan, "--json"]);
  wt = (await cli(lead, ["fanout", "worktree", "create", "a", "--json"])).path;
});

afterAll(() => {
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});

type Specific = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};

// A POSIX shell drops an unquoted `\` (Windows paths); Git Bash takes `C:/…`.
const posix = (command: string) => command.replaceAll("\\", "/");

/** A Claude Code PreToolUse Bash from implementer `id`, in the lead's cwd (as the host sends it). */
const bash = (command: string, id: string) => {
  const payload = fixture("claude-code", "pre-tool-use-write", lead, {
    tool_name: "Bash",
    tool_input: { command: posix(command) },
    agent_id: id,
    agent_type: "workit:implementer",
  });
  return (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput;
};

const allowed = (command: string, id: string) =>
  expect(bash(command, id)?.permissionDecisionReason, command).toBeUndefined();

const denied = (command: string, id: string): string => {
  const out = bash(command, id);
  expect(out?.permissionDecision, command).toBe("deny");
  return out?.permissionDecisionReason ?? "";
};

test("Given an implementer, When it runs workit git --cwd $PWD after a literal cd into its worktree, Then it is allowed; after a cd to the lead's checkout, or with no cd, it is denied", () => {
  const id = "impl-shapes-pwd";
  allowed(`cd ${wt} && workit git --cwd $PWD commit -m x -- a.ts`, id);
  for (const command of [
    `cd ${wt}; workit git --cwd $PWD commit -m x -- a.ts 2>&1 | tail -3`,
    `cd ${wt}; W=$PWD; workit git --cwd $W commit -m x -- a.ts`,
    `cd ${wt} && workit git --cwd "\${PWD}" stage -- a.ts`,
    `cd ${wt} && touch $PWD/a.ts`,
    `cd ${path.join(wt, "src")} && cd .. && workit git --cwd $PWD commit -m x -- a.ts`,
  ])
    allowed(command, id);
  expect(denied(`cd ${lead} && workit git --cwd $PWD commit -m x -- a.ts`, id)).toContain(
    `bound to the worktree ${wt}, and ${lead} is outside it`,
  );
  for (const command of [
    `workit git --cwd $PWD commit -m x -- a.ts`,
    `if true; then cd ${wt}; fi; workit git --cwd $PWD commit -m x`,
    `PWD=${wt}; cd ${lead}; touch $PWD/x`,
    `cd ${wt} && workit check --cwd ${lead} --name t -- touch $PWD/x`,
  ])
    expect(denied(command, id), command).toContain("workit worktree confinement");
});

test("Given an implementer, When a for loop runs over literal paths, words built from a resolved variable or $PWD, or relative words after a literal cd, Then it is allowed; one word outside its worktree is denied", () => {
  const id = "impl-shapes-for";
  allowed(`touch ${wt}/a.ts`, id);
  for (const command of [
    `for f in ${wt}/a.ts ${wt}/b.ts; do sed -i 's/a/b/' $f; done`,
    `W=${wt}; for f in $W/a.ts $W/b.ts; do sed -i 's/a/b/' $f; done`,
    `cd ${wt} && for f in $PWD/a.ts $PWD/b.ts; do sed -i 's/a/b/' "$f"; done`,
    `cd ${wt} && for f in a.ts b.ts; do perl -pi -e 's/a/b/' $f; done; perl -0pi -e 's/x/y/' a.ts`,
  ])
    allowed(command, id);
  const core = path.join(lead, "src", "core.ts");
  for (const command of [
    `for f in ${wt}/a.ts ${core}; do sed -i 's/a/b/' $f; done`,
    `W=${wt}; X=${lead}; for f in $W/a.ts $X/src/core.ts; do sed -i 's/a/b/' $f; done`,
    `cd ${wt} && for f in a.ts ${path.relative(wt, core)}; do perl -pi -e 's/a/b/' $f; done`,
    `cd ${lead} && for d in a b; do for f in $PWD/$d; do touch $f; done; done`,
  ])
    expect(denied(command, id), command).toContain("workit worktree confinement");
});

test("Given an implementer, When it reads with curl and docker exec, Then neither is judged a write; an inline script it pipes into from the lead's checkout is denied naming that script, and passes from its worktree", () => {
  const id = "impl-shapes-curl";
  allowed(`touch ${wt}/a.ts`, id);
  const shape = `curl -s localhost:1/x | python3 -c "\nimport json,sys\nprint(json.load(sys.stdin))"\ndocker exec db psql -c "select 1" -c "select 2"`;
  for (const command of [
    `curl -s localhost:1/x`,
    `curl -sSL -H 'Accept: application/json' localhost:1/x -o /dev/null`,
    `docker exec db psql -c "select 1"`,
    `cd ${wt} && ${shape}`,
  ])
    allowed(command, id);
  const reason = denied(shape, id);
  expect(reason).toContain(`\`python3\` runs in ${lead}, outside it`);
  expect(reason).toContain(`Run \`python3\` from your worktree: \`cd ${wt} && …\``);
  for (const command of [
    `curl -s -o ${lead}/src/core.ts localhost:1/x`,
    `curl -sSLo ${lead}/src/core.ts localhost:1/x`,
    `curl --output=${lead}/src/core.ts localhost:1/x`,
    `curl -O localhost:1/core.ts`,
  ])
    expect(denied(command, id), command).toContain("workit worktree confinement");
  allowed(`cd ${wt} && curl -sO localhost:1/a.ts`, id);
});

test("Given an implementer, When a write takes its paths from a command substitution, Then it is denied naming the substitution, with the command to run first and the retry spelled out", () => {
  const id = "impl-shapes-sub";
  allowed(`touch ${wt}/a.ts`, id);
  const reason = denied(`cd ${wt} && F=$(grep -rl x .) && perl -pi -e 's/x/y/' $F`, id);
  expect(reason).toContain("$F (set by `$(grep -rl x .)`)");
  expect(reason).toContain(
    posix(
      `Run \`grep -rl x .\` first, then retry as: \`cd ${wt} && perl -pi -e 's/x/y/' <absolute path of $F>\``,
    ),
  );
  const inline = denied(`cd ${wt} && sed -i s/x/y/ $(grep -rl x .)`, id);
  expect(inline).toContain("built from $(grep -rl x .), which");
  expect(inline).toContain("Run `grep -rl x .` first");
});
