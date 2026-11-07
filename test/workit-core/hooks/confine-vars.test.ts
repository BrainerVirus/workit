// Retro R2 (regression of #664): implementers were denied for their own
// worktree's `W=<wt>; workit git --cwd $W commit`, for loops over files, and
// for read-only `python3 -c` / `node -e` and scratch writes, each judged as a
// write in the lead's checkout. Command shapes come from those denials, with
// synthetic paths.
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
    env: { ...process.env, WORKIT_SESSION_ID: "lead-vars" },
    stdout: (text) => void (stdout += text),
    stderr: () => undefined,
  });
  if (code !== 0) throw new Error(`workit ${argv.join(" ")}: ${stdout}`);
  return JSON.parse(stdout).data;
};

beforeAll(async () => {
  configHome = useConfigHome("wk-confine-vars-config-");
  root = mkdtempSync(path.join(os.tmpdir(), "wk-confine-vars-"));
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
      name: "vars",
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

/** A Claude Code PreToolUse Bash from implementer `id`, in the lead's cwd. */
const bash = (command: string, id: string) => {
  const payload = fixture("claude-code", "pre-tool-use-write", lead, {
    tool_name: "Bash",
    tool_input: { command: command.replaceAll("\\", "/") },
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

test("Given an implementer and W=<its worktree>, When it runs workit git --cwd $W commit or stage from the lead's checkout, Then it is allowed, bound or not", () => {
  allowed(`W=${wt}; workit git --cwd $W commit -m x -- a.ts`, "impl-vars-unbound");
  for (const command of [
    `W=${wt}; workit git --cwd $W commit -m x -- a.ts`,
    `W=${wt}; workit git --cwd "\${W}" stage -- a.ts`,
    `W=${wt} && workit --cwd=$W git commit -m x -- a.ts`,
    `W=${wt}; workit check --cwd $W --name t -- touch a.ts`,
    `W=${wt}; workit check --cwd $W --name t -- git commit -am x`,
  ])
    allowed(command, "impl-vars-bound");
});

test("Given an implementer, When a loop runs workit git or check in its worktree, or writes there by a variable set before the loop, Then it is allowed", () => {
  for (const command of [
    `for f in a.ts b.ts; do workit git --cwd ${wt} stage -- $f; done`,
    `W=${wt}; for f in a.ts b.ts; do workit git --cwd $W stage -- $f; done`,
    `W=${wt}; L=$W/.workit-scratch\nfor c in "tools:test" "lint"; do\n  workit check --cwd $W --name x -- npm run $c > $L/$c.out 2>&1\ndone`,
    `W=${wt}; for c in tools:test lint; do workit check --cwd $W --name "\${c/:/-}" -- npm run $c > $W/.workit-scratch/gate-\${c/:/-}.out 2>&1; echo "$c exit=$?"; done`,
    `W=${wt}; for f in a.ts b.ts; do touch $W/$f; done`,
    `set -e; W=${wt}; cp $W/a.ts $W/.workit-scratch/a.before && find . -name x`,
  ])
    allowed(command, "impl-vars-loop");
});

test("Given an implementer, When a variable or loop names the lead's checkout, Then it is still denied", () => {
  const id = "impl-vars-lead";
  allowed(`touch ${wt}/a.ts`, id);
  for (const command of [
    `X=${lead}; workit git --cwd $X commit -m x`,
    `X=${lead}; workit check --cwd $X --name t -- touch f`,
    `for f in a.ts; do workit git --cwd ${lead} stage -- $f; done`,
    `X=${lead}; for c in a b; do touch $X/$c; done`,
    `for d in ${wt} ${lead}; do touch $d/x; done`,
    `W=${wt}; for f in ${path.relative(wt, path.join(lead, "src", "core.ts"))}; do rm $W/$f; done`,
    `W=${wt}; for f in a; do W=${lead}; done; touch $W/x`,
    `W=${wt}; if true; then W=${lead}; fi; touch $W/x`,
    `W=${wt}; while true; do touch $W/x; W=${lead}; done`,
    `W=${wt}; cd ${lead} && eval "W=${lead}"; touch $W/x`,
  ])
    expect(denied(command, id), command).toContain("workit worktree confinement");
});

test("Given an implementer, When it runs a read-only python3 -c or node -e, or copies into a scratch dir, Then nothing is denied; inline writers are", () => {
  const id = "impl-vars-scratch";
  allowed(`touch ${wt}/a.ts`, id);
  const manifest = path.join(lead, "manifest.json");
  for (const command of [
    `python3 -c 'print(1)'`,
    `node -e '1'`,
    `cp ${wt}/a /tmp/x`,
    `node -p "require('${manifest}').version"`,
    `S=${lead}; python3 -c "\nimport json;m=json.load(open('$S/manifest.json'));print(m.keys())\n"`,
    `node -e 'const p=require(process.argv[1]);console.log(JSON.stringify(p.peer))' ${manifest}`,
    `python3 -c "import sys,json; sys.stdout.write(json.dumps(json.load(sys.stdin)))" < ${manifest}`,
    `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s);process.stdout.write(String(f.length))})'`,
    `python3 -c "print(open('${manifest}').read().replace('a','b'))"`,
    `T=$(mktemp -d /tmp/proof-XXXX); cp -a ${wt}/dist $T/pkg; node -e "const f='$T/pkg/package.json';const p=require(f);console.log(p.version)"`,
  ])
    allowed(command, id);
  const core = path.join(lead, "src", "core.ts");
  for (const command of [
    `node -e "const f='${core}';require('fs').writeFileSync(f,'x')"`,
    `python3 -c "import os; os.remove('${core}')"`,
    `python3 -c "import shutil; shutil.rmtree('${lead}/src')"`,
    `python3 -c "from pathlib import Path; Path('${core}').write_text('x')"`,
    `python3 -c "open('${core}', mode='a').close()"`,
    `node -e "require('child_process').execSync('rm ${core}')"`,
    `python3 -c "__import__('o'+'s').system('rm x')"`,
    `S=$(cat f); node -e "$S"`,
    `ruby -e 'File.delete("${core}")'`,
  ])
    expect(denied(command, id), command).toContain(`bound to the worktree ${wt}`);
});

test("Given a variable Workit cannot resolve, When the hook denies, Then the reason names the variable and the command with its path spelled out", () => {
  const id = "impl-vars-unknown";
  allowed(`touch ${wt}/a.ts`, id);
  const reason = denied(`T=$(cat dir.txt); cp -a ${wt}/dist $T/pkg`, id);
  expect(reason).toContain("$T");
  expect(reason).toContain(`cp -a ${wt}/dist <absolute path of $T>/pkg`);
  const loop = denied(`for f in $(ls); do touch ${lead}/$f; done`, id);
  expect(loop).toContain("$f");
  const unset = denied(`workit git --cwd $UNSET commit -m x`, id);
  expect(unset).toContain("$UNSET");
  expect(unset).toContain("workit git --cwd <absolute path of $UNSET> commit -m x");
});
