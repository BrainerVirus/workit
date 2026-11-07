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
import { shellMutationTargets } from "@/packages/workit-core/src/hooks/write-gate";
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

// Paths in a command use forward slashes: a POSIX shell drops an unquoted `\`
// (Windows paths), and Git Bash takes `C:/…`.
const posix = (command: string) => command.replaceAll("\\", "/");

/** A Claude Code PreToolUse Bash from implementer `id`, in the lead's cwd. */
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
    `for f in a; do python3 -c "open('${lead}/src/core.ts','w')"; done`,
    `for f in a; do cd ${lead}; touch $f; done`,
    `if true; then cd ${wt}; fi; touch x`,
    `perl -Mstrict -e 'unlink "${lead}/src/core.ts"'`,
  ])
    expect(denied(command, id), command).toContain("workit worktree confinement");
});

test("Given an implementer, When an inline python3 -c or node -e runs in its worktree or a temp dir and names only paths there, or it copies into a scratch dir, Then nothing is denied", () => {
  const id = "impl-vars-scratch";
  allowed(`touch ${wt}/a.ts`, id);
  const scratch = path.join(wt, ".workit-scratch");
  for (const command of [
    `cd ${wt} && python3 -c 'print(1)'`,
    `cd ${wt} && node -e '1'`,
    `cd ${os.tmpdir()} && node -e '1'`,
    `cp ${wt}/a /tmp/x`,
    `cd ${wt} && python3 -c 'import json;m=json.load(open("${scratch}/manifest.json"));print(m["$schema"])'`,
    `W=${wt}; cd $W && node -e 'const p=require(process.argv[1]);console.log(p.peer)' $W/package.json`,
    `workit check --cwd ${wt} --name v -- node -p "require('./package.json').version"`,
    `cd ${wt} && node -e "require('fs').writeFileSync('/tmp/out.json','x')"`,
    `T=$(mktemp -d /tmp/proof-XXXX); cp -a ${wt}/dist $T/pkg; cd $T && node -e "const f='$T/pkg/package.json';require('fs').writeFileSync(f,'x')"`,
  ])
    allowed(command, id);
  // An escaped `\$` is literal text, not a variable (the hook helper above turns `\` into `/`).
  expect(
    shellMutationTargets(wt, `python3 -c "import json;print(m['\\$schema'])"`, "posix", true),
  ).toEqual([path.join(wt, ".workit-live-target")]);
});

test("Given an implementer, When an inline script runs in the lead's checkout or names a path in it, Then it is denied, however the write is spelled", () => {
  const id = "impl-vars-inline";
  allowed(`touch ${wt}/a.ts`, id);
  const C = path.join(lead, "src", "core.ts");
  const L = lead;
  const fromLead = [
    `python3 -c 'print(1)'`,
    `node -e '1'`,
    `node -p "require('./package.json').version"`,
    `S=$(cat f); node -e "$S"`,
  ];
  const inWorktree = [
    `python3 -c "import os; os.replace('${C}','/tmp/q')"`,
    `python3 -c "import sqlite3; sqlite3.connect('${L}/x.db').execute('create table t(a)')"`,
    `python3 -c "import fileinput; [l for l in fileinput.input('${C}',inplace=True)]"`,
    `python3 -c "import tempfile; tempfile.mkstemp(dir='${L}')"`,
    `python3 -c "m='w'; open('${C}',m)"`,
    `python3 -c "open('${C}','w'.lower())"`,
    `python3 -c "open('${C}', *['w'])"`,
    `python3 -c "import os; os.open('${C}', 66)"`,
    `python3 -c 'import sys;open(sys.argv[1],sys.argv[2])' ${C} a`,
    `python3 -c "open('${path.relative(wt, C)}','w')"`,
    `node -e "require('fs').openSync('${C}',2)"`,
    `node -e "require('${L}/evil')"`,
    `node --require ${L}/evil.js -e 1`,
    `node -r ${path.relative(wt, path.join(L, "evil.js"))} -e 1`,
    `NODE_OPTIONS="--require ${L}/evil.js" node -e 1`,
    `node -e "new Function('return process')().mainModule.require('fs').writeFileSync('${C}','x')"`,
    `node -e "process.chdir('${L}'); require('fs')['write'+'FileSync']('x','x')"`,
    `X=${L} node -e 'require("fs").appendFileSync(process.env.X+"/f","x")'`,
    `X=${L}; python3 -c "open('$X/f','w')"`,
    `ruby -e 'File.delete("${C}")'`,
    `perl -Mstrict -e 'unlink "${C}"'`,
  ];
  for (const command of fromLead)
    expect(denied(command, id), command).toContain("workit worktree confinement");
  for (const command of inWorktree.map((script) => `cd ${wt} && ${script}`))
    expect(denied(command, id), command).toContain("workit worktree confinement");
  expect(denied(`cd ${wt} && node -e "$CODE"`, id)).toContain("$CODE");
});

test("Given a variable Workit cannot resolve, When the hook denies, Then the reason names the variable and the command with its path spelled out", () => {
  const id = "impl-vars-unknown";
  allowed(`touch ${wt}/a.ts`, id);
  const reason = denied(`T=$(cat dir.txt); cp -a ${wt}/dist $T/pkg`, id);
  expect(reason).toContain("$T");
  expect(reason).toContain(posix(`cp -a ${wt}/dist <absolute path of $T>/pkg`));
  const loop = denied(`for f in $(ls); do touch ${lead}/$f; done`, id);
  expect(loop).toContain("$f");
  const unset = denied(`workit git --cwd $UNSET commit -m x`, id);
  expect(unset).toContain("$UNSET");
  expect(unset).toContain("workit git --cwd <absolute path of $UNSET> commit -m x");
});
