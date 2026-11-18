// Decision D3 (first try, 2026-11-18) and #880: judges and implementers run
// the safe forms agents write first (a literal assignment before git, a `for`
// over literal words, `git status`, read-only inline scripts), and every other
// refusal is two lines: what was refused, then the exact `Retry as:` call or
// why there is none. These tests only dispatch the hook: no command is run.
import "@/test/shared/state-isolation";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigDir } from "@/packages/workit-core/src/core/config";
import { main } from "@/packages/workit-cli/src/main";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
let root: string;
let lead: string;
let wt: string;
const stateBefore = process.env.WORKIT_STATE_DIR;

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const repo = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", path.join(root, "no-hooks")],
  ])
    git(dir, "config", key, value);
  writeFileSync(path.join(dir, "package.json"), '{ "name": "app", "version": "1.0.0" }\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "chore: base");
};

beforeAll(async () => {
  configHome = useConfigHome("wk-confine-ft-config-");
  root = mkdtempSync(path.join(os.tmpdir(), "wk-confine-ft-"));
  process.env.WORKIT_STATE_DIR = path.join(root, "state");
  lead = path.join(root, "app");
  repo(lead);
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
      env: { ...process.env, WORKIT_SESSION_ID: "lead-ft" },
      stdout: (text) => void (stdout += text),
      stderr: () => undefined,
    });
    if (code !== 0) throw new Error(`workit ${argv.join(" ")}: ${stdout}`);
    return JSON.parse(stdout).data;
  };
  await cli(["fanout", "plan", plan, "--json"]);
  wt = (await cli(["fanout", "worktree", "create", "a", "--json"])).path;
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
const bash = (command: string, type: string, id: string, cwd = lead) => {
  const payload = fixture("claude-code", "pre-tool-use-write", cwd, {
    tool_name: "Bash",
    tool_input: { command },
  });
  if (id) {
    payload.agent_id = id;
    payload.agent_type = type;
  }
  return (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput;
};
const verifier = (command: string) => bash(command, "workit:verifier", "ver-ft");
const implementer = (command: string) => bash(command, "workit:implementer", "impl-ft", wt);

const verdict = (out: Specific["hookSpecificOutput"]) => out?.permissionDecision ?? "allow";
const allowed = (run: (command: string) => Specific["hookSpecificOutput"], commands: string[]) => {
  for (const command of commands) expect(verdict(run(command)), command).toBe("allow");
};
/** Each command is denied, in two lines: what was refused, then `Retry as:` or `Why:`. */
const denied = (run: (command: string) => Specific["hookSpecificOutput"], commands: string[]) => {
  for (const command of commands) {
    const out = run(command);
    expect(verdict(out), command).toBe("deny");
    const lines = out?.permissionDecisionReason?.split("\n") ?? [];
    expect(lines[0], command).toMatch(/^workit (?:scratch|worktree) confinement: /);
    expect(lines[1], command).toMatch(/^(?:Retry as|Why): /);
  }
};

test("Given a verifier, When it sets literal paths in a statement before git (W=<checkout>; git -C $W …), Then it runs; an exported, git-read or computed name is denied", () => {
  allowed(verifier, [
    `W=${lead}; git -C $W rev-parse HEAD; git -C $W status --short`,
    `W=${lead} && B='${wt}'; git -C $W log -1; git -C "\${B}" diff --stat`,
    `W=${lead}\ngit -C $W log --oneline -3`,
    `git -C ${lead} status --short`,
  ]);
  denied(verifier, [
    "PATH=/x; git status",
    "W=$(cat f); git -C $W log",
    `GIT_DIR=${lead}/.git; git log`,
    `W=${lead}; W=/tmp; git -C $W log`,
    `W=${lead} git -C ${lead} log`,
  ]);
});

test("Given a verifier, When a literal assignment's name is single-quoted, escaped or read by a script, Then Workit does not spell it in and the write is judged as the shell runs it", () => {
  const scratch = path.join(lead, ".workit-scratch");
  denied(verifier, [
    `W=${scratch}; echo a > '$W'`,
    `W=${scratch}; echo a > \\$W`,
    `W=${scratch}; bash <<'EOF'\necho a > $W/x\nEOF`,
    `W=${scratch}; for W in /tmp; do echo a > $W/x; done`,
    // A quote in the value would unbalance the spelled-in command: never substituted.
    `W='"'; echo "$W" > ${lead}/x`,
  ]);
  allowed(verifier, [`W=${scratch}; mkdir -p $W && echo a > "$W/x"`]);
});

test("Given a verifier, When it redirects outside its scratch dir, Then line 2 is the same command written into the scratch dir", () => {
  const scratch = path.join(realpathSync.native(lead), ".workit-scratch");
  const out = verifier(`workit check --cwd ${lead} lint > /tmp/x.log 2>&1`);
  expect(verdict(out)).toBe("deny");
  expect(out?.permissionDecisionReason?.split("\n")[1]).toBe(
    `Retry as: workit check --cwd ${lead} lint > ${scratch}/x.log 2>&1`,
  );
  expect(verifier(`git -C ${lead} log | tee -a /tmp/y.txt`)?.permissionDecisionReason).toContain(
    `\nRetry as: git -C ${lead} log | tee -a ${scratch}/y.txt`,
  );
  expect(verdict(verifier(`git -C ${lead} log > ${scratch}/x.log 2>&1`))).toBe("allow");
});

test("Given a verifier, When it commits, checks out a file or writes outside scratch, Then each is still denied", () => {
  denied(verifier, [
    `git -C ${lead} commit -m x`,
    `git -C ${lead} checkout -- package.json`,
    `echo x > ${lead}/package.json`,
    `W=${lead}; git -C $W commit -m x`,
    `W=${lead}; echo x > $W/package.json`,
    `for f in a b; do echo x > ${lead}/$f; done`,
  ]);
});

test("Given a verifier, When it runs git remote get-url, range-diff, worktree list or a for over literal words, Then each runs; a loop past 16 words or with a computed list is denied", () => {
  allowed(verifier, [
    `git -C ${lead} remote get-url origin`,
    `git -C ${lead} remote -v`,
    `git -C ${lead} range-diff main...HEAD`,
    `git -C ${lead} worktree list`,
    `for f in package.json a.ts; do git -C ${lead} log -1 -- $f; done`,
  ]);
  const many = Array.from({ length: 17 }, (_, index) => `f${index}`).join(" ");
  denied(verifier, [
    `for f in ${many}; do git -C ${lead} log -1 -- $f; done`,
    `for f in $(ls); do git -C ${lead} log -1 -- $f; done`,
    `git -C ${lead} remote add x /tmp/x`,
  ]);
});

test("Given each read-only one-liner #880 lists, When a judge runs it, Then it runs; a write hidden in an interpolation, a joined backslash-newline or a string is denied", () => {
  allowed(verifier, [
    `python3 -c "x=1; print(f'x={x}')"`,
    "python3 - <<'EOF'\n# the candidate's version\nimport json\nprint(json.load(open('package.json'))['version'])\nEOF",
    "node -e 'const p = require(\"./package.json\"); console.log(`${p.name}@${p.version}`)'",
    `python3 -c "a = [1, 2]; print(len(a) / 2, 'half')"`,
    `python3 -c "from pathlib import Path; p = 'package.json'; print(Path(p).read_text().replace('a','b'))"`,
    `python3 -c "print((5).to_bytes(2,'big'))"`,
    `node -e "console.log(new Map().delete(1))"`,
    "node - <<'EOF'\n// prints the version\nconsole.log(require('./package.json').version)\nEOF",
  ]);
  denied(verifier, [
    "python3 - <<EOF\nimport os\nos.sys\\\ntem('id')\nEOF",
    `python3 -c "print(f'{open(p, m)}')"`,
    'node -e \'console.log(`${require("fs").rmSync("x")}`)\'',
    `python3 -c "print('\`'); open('x','w'); print('\`')"`,
    `python3 -c "from pathlib import Path; Path('a').replace('b')"`,
    `python3 -c "import operator; operator.methodcaller('unlink')(p)"`,
    `node -e "Reflect.apply(fs.rmSync, fs, ['x'])"`,
    `node --print "require('fs').writeFileSync('x','y')"`,
    "python3 -m pip install --target /tmp/x foo",
    `export NODE_OPTIONS=--require=/tmp/e.js; node -e "1"`,
  ]);
});

test("Given an implementer bound to its worktree, When it sets W=$(pwd) and edits through it, Then it runs; an interpreter run in the lead's checkout is denied with a retry from its worktree", () => {
  expect(verdict(implementer(`touch ${wt}/a.ts`))).toBe("allow");
  allowed(implementer, [`W=$(pwd); sed -i 's/a/b/' $W/src/x.ts`]);
  const command = `cd ${lead} && python3 -c "open('x','w')"`;
  const out = implementer(command);
  expect(verdict(out)).toBe("deny");
  const retry = `cd ${wt} && python3 -c "open('x','w')"`;
  expect(out?.permissionDecisionReason?.split("\n")[1]).toBe(`Retry as: ${retry}`);
  expect(verdict(implementer(retry))).toBe("allow");
});

test("Given the lead, When a python heredoc writes a plan JSON whose string value names the Workit config dir, Then it runs; a script that opens workspaces.json there for writing is refused", () => {
  const asLead = (command: string) => bash(command, "", "");
  const config = resolveConfigDir();
  expect(
    verdict(
      asLead(
        `python3 - <<'EOF'\nimport json\nplan = {"name": "x", "notes": "grants live in ${config} and stay"}\nwith open('.git/workit/plans/x.json', 'w') as f:\n    json.dump(plan, f)\nEOF`,
      ),
    ),
  ).toBe("allow");
  for (const command of [
    `python3 - <<'EOF'\nwith open('${config}/workspaces.json', 'w') as f:\n    f.write('{}')\nEOF`,
    `python3 - <<'EOF'\nimport os\nd = "${config}"\nopen(os.path.join(d, "workspaces.json"), "w").write("{}")\nEOF`,
  ])
    expect(verdict(asLead(command)), command).toBe("deny");
});
