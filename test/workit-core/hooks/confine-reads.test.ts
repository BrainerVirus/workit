// Retro 2026-11-17 C1+C2: judges (verifiers, reviewers) and implementers were
// refused read-only work: an inline script that only reads, a plain fetch,
// the host's session scratchpad, a read-only workit verb, a Workit worktree of
// another repository. Each now passes, while every write outside a scratch dir
// stays refused. These tests only dispatch the hook: no command below is run.
import "@/test/shared/state-isolation";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { FANOUT_TOKEN_FILE } from "@/packages/workit-core/src/hooks/worktree-confine";
import { shellMutationTargets } from "@/packages/workit-core/src/hooks/write-gate";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
let root: string;
let lead: string;
let wt: string;
let away: string;
const stateBefore = process.env.WORKIT_STATE_DIR;
/** The fixture's host session id: a temp dir named for it is that session's scratchpad. */
const SESSION = "claude-session-1";

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
  configHome = useConfigHome("wk-confine-reads-config-");
  root = mkdtempSync(path.join(os.tmpdir(), "wk-confine-reads-"));
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
      env: { ...process.env, WORKIT_SESSION_ID: "lead-reads" },
      stdout: (text) => void (stdout += text),
      stderr: () => undefined,
    });
    if (code !== 0) throw new Error(`workit ${argv.join(" ")}: ${stdout}`);
    return JSON.parse(stdout).data;
  };
  await cli(["fanout", "plan", plan, "--json"]);
  wt = (await cli(["fanout", "worktree", "create", "a", "--json"])).path;
  // A Workit worktree of another repository: its admin dir holds the fanout token.
  const otherRepo = path.join(root, "other");
  repo(otherRepo);
  away = path.join(root, "other-wt");
  git(otherRepo, "worktree", "add", "-q", "-b", "feature/b", away);
  writeFileSync(path.join(git(away, "rev-parse", "--absolute-git-dir"), FANOUT_TOKEN_FILE), "t");
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

/** A Claude Code PreToolUse Bash call from a subagent of `type` in `cwd`. */
const bash = (command: string, type: string, id: string, cwd = lead) => {
  const payload = fixture("claude-code", "pre-tool-use-write", cwd, {
    tool_name: "Bash",
    // Windows paths go with forward slashes; a backslash case runs only on POSIX.
    tool_input: { command: process.platform === "win32" ? command.replaceAll("\\", "/") : command },
  });
  payload.agent_id = id;
  payload.agent_type = type;
  return (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput;
};
const verifier = (command: string) => bash(command, "workit:verifier", "ver-reads");
const implementer = (command: string) => bash(command, "workit:implementer", "impl-reads", wt);

const allowed = (run: (command: string) => Specific["hookSpecificOutput"], commands: string[]) => {
  for (const command of commands) expect(run(command)?.permissionDecision, command).toBeUndefined();
};
const denied = (
  run: (command: string) => Specific["hookSpecificOutput"],
  commands: string[],
  reason: string,
) => {
  for (const command of commands) {
    const out = run(command);
    expect(out?.permissionDecision, command).toBe("deny");
    expect(out?.permissionDecisionReason, command).toContain(reason);
  }
};

test("Given a verifier, When it runs node -e, python3 -c or a quoted heredoc to python3 - or node - that only reads the candidate, Then the hook allows it", () => {
  allowed(verifier, [
    `node -e "console.log(require('./package.json').version)"`,
    `cd ${wt} && node -e "console.log(require('./package.json').version)"`,
    `node -p "require('${wt}/package.json').name"`,
    `python3 -c "import json; print(json.load(open('${wt}/package.json'))['name'])"`,
    `git -C ${wt} show HEAD:package.json | python3 -c "import sys, json; print(json.load(sys.stdin)['name'])"`,
    "python3 - <<'EOF'\nimport json\nwith open('package.json', encoding='utf-8') as f:\n    print(json.load(f)['version'])\nEOF",
    "node - <<'EOF'\nconst fs = require('node:fs');\nprocess.stdout.write(fs.readFileSync('package.json', 'utf8'));\nEOF",
    `node -e "console.log(JSON.stringify(require('node:path').parse('${wt}/a.ts')))"`,
  ]);
});

test("Given a judge or an implementer, When an inline script writes, deletes or runs a command, Then it is denied outside the dirs it may write", () => {
  const writers = [
    `node -e "require('fs').writeFileSync('x.txt', 'a')"`,
    `node -e "const { writeFileSync: w } = require('fs'); w('x.txt', 'a')"`,
    `python3 -c "open('x.txt', 'w').write('a')"`,
    `python3 -c "open('x.txt', mode='a')"`,
    `python3 -c "import os; os.remove('package.json')"`,
    `python3 -c "import subprocess; subprocess.run(['ls'])"`,
    `node -e "require('child_process').execSync('ls')"`,
    `python3 -c "from pathlib import Path; Path('x').write_text('a')"`,
    `python3 -c "from pathlib import Path; Path('x').open('w')"`,
    `node -e "require('fs')['write' + 'FileSync']('x', 'a')"`,
    `node -e "require('${lead}/tool.js')"`,
    // A Windows drive-letter path is a path, not a package name (CI windows: the lead lives on C:).
    `node -e "require('C:/tools/evil.js')"`,
    "python3 - <<'EOF'\nimport shutil\nshutil.rmtree('src')\nEOF",
    "node - <<'EOF'\nrequire('fs').rmSync('src', { recursive: true })\nEOF",
    // An unquoted heredoc expands `$X` into the script: its text is unknown.
    "python3 - <<EOF\n$X\nEOF",
    `X='import os; os.system("id")'; python3 - <<<"$X"`,
  ];
  denied(verifier, writers, "workit scratch confinement: verifier ver-reads");
  denied(
    implementer,
    writers.map((command) => `cd ${lead} && ${command}`),
    "workit worktree confinement: implementer impl-reads",
  );
  // In its own worktree the implementer's writes are its own.
  allowed(implementer, [`node -e "require('fs').writeFileSync('x.txt', 'a')"`]);
});

test("Given a verifier, When it fetches plainly from a remote the lead configured, Then it is allowed; a refspec, a prune, a force, a path or a fetch inside a scratch repo is denied naming the scratch dir", () => {
  allowed(verifier, [
    `git -C ${wt} fetch -q origin`,
    `git -C ${wt} fetch origin main`,
    "git fetch -q origin && git log --oneline -1",
    `git -C ${away} fetch --quiet origin`,
  ]);
  const scratchRepo = path.join(wt, ".workit-scratch", "r");
  git(wt, "init", "-q", "-b", "main", scratchRepo);
  denied(
    verifier,
    [
      `git -C ${wt} fetch origin main:main`,
      `git -C ${wt} fetch origin +refs/heads/main:refs/remotes/origin/main`,
      `git -C ${wt} fetch --prune origin`,
      `git -C ${wt} fetch -f origin main`,
      `git -C ${wt} fetch --upload-pack=/tmp/x origin`,
      `git -C ${wt} -c core.sshCommand=x fetch origin`,
      `git -C ${wt} fetch /tmp/elsewhere`,
      `git -C ${scratchRepo} fetch far`,
      `git -C ${wt} push origin feature/a`,
    ],
    `may write only in its scratch dir ${path.join(git(lead, "rev-parse", "--show-toplevel"), ".workit-scratch")}`,
  );
});

test("Given a verifier, When it writes into its own session scratchpad, a Workit worktree's scratch of another repository or /dev/null, Then it is allowed; /tmp at large, another session's dir, the candidate and the lead's checkout stay denied", () => {
  // Claude Code's layout: <tmp>/claude-<uid>/<project>/<session id>/scratchpad. Nothing is written.
  const host = path.join(os.tmpdir(), `claude-${process.pid}`);
  const pad = path.join(host, "-proj", SESSION, "scratchpad");
  allowed(verifier, [
    `mkdir -p ${pad} && git -C ${wt} diff main > ${path.join(pad, "d.patch")}`,
    `echo x > ${path.join(away, ".workit-scratch", "probe.txt")}`,
    `git -C ${wt} log | tee /dev/null`,
  ]);
  denied(
    verifier,
    [
      `echo x > ${path.join(root, "other-session", "scratchpad", "a.txt")}`,
      `echo x > ${path.join(host, "-proj", "other-session", "a.txt")}`,
      `echo x > ${path.join(root, "x", SESSION, "a.txt")}`,
      `echo x > ${path.join(os.tmpdir(), SESSION, "a.txt")}`,
      `echo x > ${path.join(root, `${SESSION}-not`, "a.txt")}`,
      `echo x > ${path.join(wt, "a.ts")}`,
      `echo x > ${path.join(lead, "package.json")}`,
      `echo x > ${path.join(os.homedir(), "notes.txt")}`,
      `echo x > ${path.join(away, "a.ts")}`,
      "echo x > $TMPDIR/a.txt",
    ],
    "may write only in its scratch dir",
  );
});

test("Given a verifier, When it runs read-only workit verbs, Then they pass; a mutating verb or option is still denied", () => {
  allowed(verifier, [
    "workit grant show",
    "workit ledger show",
    "workit lease status",
    "workit task show",
    "workit task list",
    "workit doctor --json",
    `workit ledger verdict verified --cwd ${wt} --kind unit --branch feature/a --how x`,
  ]);
  denied(
    verifier,
    [
      "workit doctor --json --fix",
      "workit doctor --fix",
      "workit doctor --json --fix-lock --force --yes",
      "workit doctor --json --repair",
      "workit test-audit --mutate-all",
      "workit task done x",
      "workit test-audit --mutate",
      `workit git --cwd ${wt} status`,
    ],
    "is not a judge's job",
  );
  // A user-only verb is asked of the user before confinement judges it: never allowed outright.
  for (const command of ["workit grant set x", "workit approve x", "workit ledger void x"])
    expect(verifier(command)?.permissionDecision, command).toBeDefined();
});

test("Given an implementer in its worktree, When it sets W=$(pwd) and loops over a glob to read, Then it is allowed; a write through $(pwd) lands in its worktree, and a variable Workit cannot resolve is still denied", () => {
  allowed(implementer, [
    `W=$(pwd); for f in *.ts; do grep x "$f"; done`,
    `W=$(pwd); echo a > $W/notes.txt`,
    `find . -name '*.ts' | while read f; do grep -c x "$f"; done`,
  ]);
  denied(implementer, [`cd ${lead}; W=$(pwd); echo a > $W/x`], "is bound to the worktree");
  denied(
    implementer,
    [
      "echo a > $X/x",
      `for f in *.ts; do sed -i s/a/b/ "$f"; done`,
      `find . -name '*.ts' | while read f; do sed -i s/a/b/ "$f"; done`,
    ],
    "which Workit cannot resolve",
  );
});

test("Given a judge or an implementer, When review round 1's bypasses run (verdict mwla51qs), Then each is denied", () => {
  const bypasses = [
    `printf "require('fs').writeFileSync('package.json','x')" | xargs -0 -I{} node -e {}`,
    `echo "open('package.json','w')" | xargs -0 python3 -c`,
    `find . -name x -exec node -e {} \\;`,
    `node -e "new Function('return process')().exit()"`,
    `node -e "require('vm').runInThisContext('1')"`,
    `python3 -c "import os; os.posix_spawn('/bin/true', ['x'], {})"`,
    `node -e "const fs=require('fs'); const s=fs.readFileSync('package.json','utf8').replace(/'/g,''); fs.writeFileSync('package.json',s)"`,
    `node -e "console.log(\`\${require('fs').rmSync('x')}\`)"`,
    `node -e "console.log('\\x41')"`,
    `python3 -c "print(f'{open(\\"x\\", \\"w\\")}')"`,
    `python3 -c "print(rf'{ {1: 2}[1] }')"`,
    `python3 -c "import io; io.FileIO('x', 'w')"`,
    `python3 -c "from pathlib import Path; Path('a').replace('b')"`,
    `python3 -c "import zipfile; zipfile.ZipFile('x.zip', 'w')"`,
    `python3 -c "import tarfile; tarfile.open('x.tar', mode)"`,
    `python3 -c "import shelve; shelve.open('db')"`,
    `python3 -c "import logging; logging.basicConfig(filename='x.log')"`,
    `python3 -c "import logging; logging.FileHandler('x.log')"`,
    `python3 -c "import pandas as pd; pd.DataFrame().to_csv('x.csv')"`,
    `python3 -c "import matplotlib.pyplot as p; p.savefig('x.png')"`,
    `bun -e "await Bun.file('x').delete()"`,
    `node -e "require('fs').utimesSync('x', 1, 1)"`,
    `node -e "require('fs').lchmodSync('x', 0o777)"`,
    `python3 -c "import os; os.mkfifo('p')"`,
    "python3 - <<\\\nEOF\n$X\nEOF",
  ];
  const posix = (list: string[]) =>
    process.platform === "win32" ? list.filter((command) => !command.includes("\\")) : list;
  denied(verifier, posix(bypasses), "workit scratch confinement: verifier ver-reads");
  denied(
    implementer,
    posix(bypasses).map((command) => `cd ${lead} && ${command}`),
    "workit worktree confinement: implementer impl-reads",
  );
  // A backslash-newline in the delimiter leaves an unquoted heredoc that runs `$(…)`.
  denied(
    verifier,
    posix([`cat > ${path.join(wt, ".workit-scratch", "x")} <<\\\nEOF\n$(touch ~/q)\nEOF`]),
    "quote the delimiter",
  );
  // A judge's refusal names the verbs that exist.
  const refused = verifier("workit fanout check --offline");
  expect(refused?.permissionDecision).toBe("deny");
  expect(refused?.permissionDecisionReason).toContain("workit finding record");
  expect(refused?.permissionDecisionReason).not.toContain("ledger finding");
});

// #880: read-only one-liners the fail-closed rules still refused, and the escapes around them.
test("Given a verifier or an implementer, When an inline script only reads through an f-string, a template literal, a comment, a division, a string's .replace, .to_bytes or a Map's .delete, Then the hook allows it", () => {
  const reads = [
    `python3 -c "x=1; print(f'x={x}')"`,
    `python3 -c "import json; d=json.load(open('package.json')); print(f\\"{d['name']}@{d['version']}\\")"`,
    "python3 - <<'EOF'\nimport json\n# the candidate's version\nprint(json.load(open('package.json'))['version'])\nEOF",
    "node -e 'const p=require(\"./package.json\"); console.log(`${p.name}@${p.version}`)'",
    "node - <<'EOF'\n// the candidate's version\n/* it's read-only */\nconsole.log(require('./package.json').version)\nEOF",
    `python3 -c "a=[1,2]; print(len(a) / 2, 'half')"`,
    `node -e "console.log(4 / 2, 'x')"`,
    `python3 -c "from pathlib import Path; p='package.json'; print(Path(p).read_text().replace('a','b'))"`,
    `python3 -c "print((5).to_bytes(2,'big'))"`,
    `node -e "console.log(new Map().delete(1))"`,
    `node --print="require('./package.json').name"`,
  ].filter((command) => process.platform !== "win32" || !command.includes("\\"));
  allowed(verifier, reads);
  allowed(
    implementer,
    reads.map((command) => `cd ${lead} && ${command}`),
  );
});

test("Given a verifier or an implementer, When an inline script hides a write in an f-string, a template literal, a comment, a regex literal, a reflective call, a joined line, an option or a loader, Then it is denied", () => {
  const writers = [
    `python3 -c "print(f'{open(\\"x\\",\\"w\\").write(\\"a\\")}')"`,
    'node -e \'console.log(`${require("fs").writeFileSync("x","a")}`)\'',
    // A template literal spans lines, so a quote in it pairs with nothing.
    'node - <<\'EOF\'\nconst a = `\n\'`; require("fs").writeFileSync("x","a"); const b = `\'\n`\nEOF',
    // In Node a `#` line is code (a private field), and a comment's backtick opens nothing.
    'node - <<\'EOF\'\nclass A{\n#a = `\n`; static{ require("fs").writeFileSync("x","a") } #b = `\n#`}\nEOF',
    "node - <<'EOF'\n// `\nrequire('fs').writeFileSync('x','a')\n// `\nEOF",
    // A triple-quoted string fails closed.
    'python3 - <<\'EOF\'\ns = """"\n"""; open("x","w").write("a"); t = """\n""" #"\nEOF',
    // A regex literal holding a quote or a backtick, wherever one may start.
    `node -e "!/'/.test(''); require('fs').writeFileSync('x','a'); !/'/.test('')"`,
    `node -e "if (1) /'/.test(''), require('fs').writeFileSync('x','a'); if (1) /'/"`,
    `node -e "function f(){ return /'/.test('') && require('fs').writeFileSync('x','a') || /'/ }; f()"`,
    'node - <<\'EOF\'\nconst r = /`/;\nrequire("fs").writeFileSync("x","a");\nconst q = /`/;\nEOF',
    "node -e \"const r = /[/*]/; const t = `*/`; require('fs').writeFileSync('x','a'); /* ` */\"",
    // A read's literal cannot reach past a string.
    `node -e "const t = 'open(' + process.getBuiltinModule(/fs/.source).writeFileSync(/x/.source, /a/.source) + ')'"`,
    `python3 -c "from pathlib import Path; p = Path('a'); p.replace('b,c')"`,
    `node -e "Reflect.get(require('fs'), 'write'+'FileSync')('x','a')"`,
    `node -e "Object.getOwnPropertyDescriptor(require('fs'), 'write'+'FileSync').value('x','a')"`,
    `python3 -c "import operator, os; operator.methodcaller('sys'+'tem', 'id')(os)"`,
    `python3 -c "import operator, os; operator.attrgetter('sys'+'tem')(os)('id')"`,
    // An unquoted heredoc joins a backslash-newline before python3 reads it.
    "python3 - <<EOF\nimport os; os.sys\\\ntem('id')\nEOF",
    `node --print="require('fs').writeFileSync('x','a')"`,
    `node --eval="require('fs').writeFileSync('x','a')"`,
    "python3 -mpip install --target src x",
    "python3 -Im pip install --target src x",
    "export NODE_OPTIONS='--require ./evil.js'; node -e 1",
    "NODE_OPTIONS+=' -r ./evil.js' node -e 1",
    "node --env-file=.env -e 1",
    // `NAME+=value` before a command is an assignment, not the command.
    "A+=1 rm -rf src",
  ];
  const posix = (list: string[]) =>
    process.platform === "win32" ? list.filter((command) => !command.includes("\\")) : list;
  denied(verifier, posix(writers), "workit scratch confinement: verifier ver-reads");
  denied(
    implementer,
    posix(writers).map((command) => `cd ${lead} && ${command}`),
    "workit worktree confinement: implementer impl-reads",
  );
});

// #880 follow-ups (coordinator, round 2): a shell fed a heredoc, env's assignment words, a call on
// a returned value, and a commit in the lead's checkout.
test("Given an implementer outside its worktree or a verifier, When a shell reads a heredoc that writes, env sets an odd name, a returned value is called or git commits, Then it is denied; the read-only forms run", () => {
  const writers = [
    "bash <<'EOF'\nrm -rf src\nEOF",
    "sh <<EOF\ntouch src/x\nEOF",
    "bash -s <<'EOF'\nrm -rf src\nEOF",
    "zsh <<'EOF'\necho a > src/x\nEOF",
    "python3 - <<EOF\nopen('x','w').write('a')\nEOF",
    "python3 <<'EOF'\nopen('x','w').write('a')\nEOF",
    "node <<'EOF'\nrequire('fs').writeFileSync('x','a')\nEOF",
    "env 'A b=1' rm -rf src",
    "env -i 'A b=1' X=2 rm -rf src",
    "env -u HOME rm -rf src",
    "env -S 'rm -rf src'",
    `node -e "Object.values(require('fs')).find(f => f.name.startsWith('write'+'File'))('x','a')"`,
    `node -e "(0, Object.values(require('fs')).find(f => f.name > 'w'))('x','a')"`,
    "git commit -m x",
    "A+=1 git commit -m x",
  ];
  denied(verifier, writers, "workit scratch confinement: verifier ver-reads");
  denied(
    implementer,
    writers.map((command) => `cd ${lead} && ${command}`),
    "workit worktree confinement: implementer impl-reads",
  );
  const reads = [
    "bash <<'EOF'\nls src\nEOF",
    "env 'A b=1' ls src",
    "env -i ls src",
    `node -e "console.log((() => 1)())"`,
    `node -e "(async () => { console.log(require('./package.json').name) })()"`,
    `python3 -c "print((lambda: 1)())"`,
  ];
  allowed(verifier, reads);
  allowed(
    implementer,
    reads.map((command) => `cd ${lead} && ${command}`),
  );
  // In its own worktree the implementer's writes are its own.
  allowed(implementer, ["bash <<'EOF'\ntouch x\nEOF", "env 'A b=1' touch x"]);
});

// #956 verification mwwyoapt: a path rename through `.replace` with a trailing comma or keyword,
// a later inline-code argument or loader option, env's other option spellings, eval, process
// substitutions, `source /dev/stdin`, the common wrappers and json.tool with an output file.
test("Given verification mwwyoapt's forms, When a judge or an implementer outside its worktree runs them, Then each write is denied and the read-only forms run", () => {
  const writers = [
    `python3 -c "from pathlib import Path; Path('a').replace('b',)"`,
    `python3 -c "from pathlib import Path; Path('a').replace(target='b', )"`,
    `python3 -c "from pathlib import Path; Path('a').replace(*['b'], *[])"`,
    `node --eval="1" --eval="require('fs').writeFileSync('x','a')"`,
    `node -e 1 -e "require('fs').writeFileSync('x','a')"`,
    `node -p 1 -e "require('fs').writeFileSync('x','a')"`,
    `python3 -c "print(1)" -c "open('x','w')"`,
    "node -e 1 -r ./f.js",
    "node -e 1 --require ./f.js",
    "node -e 1 --import=./f.mjs",
    `env -S"rm -rf src"`,
    "env --split-string='rm -rf src'",
    "env --split-string 'rm -rf src'",
    "env -iS 'rm -rf src'",
    "env -iu X rm -rf src",
    "eval 'rm -rf src'",
    "bash <(echo 'rm -rf src')",
    "source <(echo 'rm -rf src')",
    ". <(echo 'rm -rf src')",
    ". /dev/stdin <<'EOF'\nrm -rf src\nEOF",
    "source /dev/stdin <<'EOF'\nrm -rf src\nEOF",
    "bash /dev/stdin <<'EOF'\nrm -rf src\nEOF",
    "timeout 5 rm -rf src",
    "nice -n 5 rm -rf src",
    "setsid rm -rf src",
    "stdbuf -o0 rm -rf src",
    "flock /tmp/l rm -rf src",
    "flock /tmp/l -c 'rm -rf src'",
    "ionice -c3 rm -rf src",
    "nohup rm -rf src",
    "! rm -rf src",
    `timeout 5 python3 -c "open('x','w')"`,
    "python3 -m json.tool package.json out.json",
  ];
  denied(verifier, writers, "workit scratch confinement: verifier ver-reads");
  denied(
    implementer,
    writers.map((command) => `cd ${lead} && ${command}`),
    "workit worktree confinement: implementer impl-reads",
  );
  const reads = [
    `python3 -c "print('a'.replace('a','b'))"`,
    `python3 -c "print('aa'.replace('a','b', count=1))"`,
    `node -e "console.log('a'.replace(/a/g, m => m + 'b'))"`,
    `node -e "console.log(1)" package.json`,
    "python3 -m json.tool package.json",
    "python3 -m json.tool --indent 4 package.json",
    "timeout 5 ls src",
  ];
  allowed(verifier, reads);
  allowed(
    implementer,
    reads.map((command) => `cd ${lead} && ${command}`),
  );
  allowed(implementer, ["eval 'touch x'", "timeout 5 touch x"]);
});

// #956 round 3 (verification mwwyoapt): inline code imports only the modules Workit reads, by a
// literal name, and uses a module it binds only as `name.member` (members listed for os, sys, fs).
test("Given verification mwwyoapt's sinks and module escapes, When a judge or an implementer outside its worktree imports past the tables or uses a module whole, Then each is denied", () => {
  const writers = [
    `python3 -c "import timeit; timeit.timeit('open(1)')"`,
    `python3 -c "import cProfile; cProfile.run('print(1)')"`,
    `python3 -c "import pickle; pickle.loads(b'x')"`,
    `python3 -c "import runpy; runpy.run_path('x.py')"`,
    `node -e "import('data:text/javascript,1')"`,
    `python3 -c "import ctypes; ctypes.CDLL(None).creat(b'x', 420)"`,
    `python3 -c "import bz2; bz2.open('x', 'wb')"`,
    `python3 -c "import gzip; gzip.GzipFile('x', 'wb')"`,
    `python3 -c "import urllib.request as u; u.urlretrieve('http://x', 'y')"`,
    `python3 -c "from urllib.request import urlretrieve"`,
    `python3 -c "import numpy as np; np.savetxt('x', [1])"`,
    `python3 -c "import numpy as np; np.zeros(1).tofile('x')"`,
    `python3 -c "import mailbox; mailbox.mbox('x')"`,
    `python3 -c "import importlib; importlib.import_module('os')"`,
    `python3 -c "x = __import__('os')"`,
    `python3 -c "import os; os.setxattr('x','user.a',b'1')"`,
    `python3 -c "import os; m = os; m.remove('x')"`,
    `python3 -c "import sys; sys.modules['os'].remove('x')"`,
    `python3 -c "from os import remove"`,
    `python3 -c "from os import *"`,
    `python3 -c "from json import *"`,
    `python3 -c "from . import x"`,
    `node -e "Object.entries(require('fs')).filter(([k]) => k > 'w').forEach(([, f]) => f('x', 'a'))"`,
    `node -e "const fs = require('fs'); Object.entries(fs).forEach(([k, f]) => k)"`,
    `node -e "const o = {}; o.f = require('fs'); Object.values(o.f)"`,
    `node -e "const { writeFileSync } = require('fs')"`,
    `node -e "const { promises: { writeFile } } = require('fs')"`,
    `node -e "require('fs').fsyncSync(1)"`,
    `node -e "import('fs').then(m => m.writeFileSync('x','a'))"`,
    `node -e "require('child_process')"`,
    `node -e "require('./tool.js')"`,
    `node -e "const r = require; r('fs')"`,
    `node -e "const m = 'fs'; require(m)"`,
    `bun -e "import { writeFileSync } from 'fs'; writeFileSync('x','a')"`,
    `bun -e "import * as fs from 'fs'; Object.values(fs)"`,
    `bun -e "import 'node:vm'"`,
  ];
  denied(verifier, writers, "workit scratch confinement: verifier ver-reads");
  denied(
    implementer,
    writers.map((command) => `cd ${lead} && ${command}`),
    "workit worktree confinement: implementer impl-reads",
  );
  allowed(implementer, writers.slice(0, 3));
});

// Round 3, group 2: a builtin that reaches code or modules by name (Python's dunders and
// reflective builtins, Node's constructors and globals, every builtin module `node -e` has as a
// global) and `process` or `Bun` past their read members.
test("Given an ambient global that reaches code or modules by name, When a judge or an implementer outside its worktree uses it, Then it is denied", () => {
  const writers = [
    `python3 -c "import glob; glob.os.setxattr('x','user.a',b'1')"`,
    `python3 -c "import pathlib; pathlib.os.system('id')"`,
    `python3 -c "print(globals())"`,
    `python3 -c "print(vars())"`,
    `python3 -c "__builtins__.open('x','w')"`,
    `python3 -c "print(().__class__.__base__.__subclasses__())"`,
    `python3 -c "compile('1','x','exec')"`,
    `python3 -c "setattr(1, 'a', 2)"`,
    `python3 -c "breakpoint()"`,
    `node -e "child_process.execSync('id')"`,
    `node -e "vm.runInThisContext('1')"`,
    `node -e "fs.writeFileSync('x','a')"`,
    `node -e "const f = fs; f.readFileSync"`,
    `node -e "worker_threads.isMainThread"`,
    `node -e "process.binding('fs')"`,
    `node -e "process.getBuiltinModule('fs')"`,
    `node -e "process.mainModule"`,
    `node -e "process.dlopen(module, 'x')"`,
    `node -e "globalThis.process.exit()"`,
    `node -e "global.process"`,
    `node -e "module.require('fs')"`,
    `node -e "[].constructor.constructor('return 1')"`,
    `node -e "new Function('return 1')"`,
    `node -e "new Worker('x', { eval: true })"`,
    `node -e "WebAssembly.compile"`,
    `node -e "console.log(__proto__)"`,
    `bun -e "Bun.write('x', 'a')"`,
    `bun -e "Bun.spawnSync(['id'])"`,
    `bun -e "Bun.openInEditor('x')"`,
  ];
  denied(verifier, writers, "workit scratch confinement: verifier ver-reads");
  denied(
    implementer,
    writers.map((command) => `cd ${lead} && ${command}`),
    "workit worktree confinement: implementer impl-reads",
  );
});

test("Given inline code that imports past the tables, When a judge is refused, Then line 1 names the import and line 2 retries from scratch, or names the read-only ways when the script reads a relative path", () => {
  const scratch = path.join(git(lead, "rev-parse", "--show-toplevel"), ".workit-scratch");
  const plain = `python3 -c "import timeit; print(timeit.timeit('1', number=1))"`;
  const [what, retry] = verifier(plain)?.permissionDecisionReason?.split("\n") ?? [];
  expect(what).toContain(
    "`import timeit` is outside the modules Workit reads in inline code (json, re, pathlib, os.path, fs reads…)",
  );
  expect(retry).toBe(`Retry as: cd ${scratch} && ${plain}`);
  const reads = verifier(
    `node -e "const http = require('http'); console.log(require('./package.json'))"`,
  )?.permissionDecisionReason?.split("\n");
  expect(reads?.[0]).toContain(
    "`const http = require('http')` is outside the modules Workit reads",
  );
  expect(reads?.[1]).toBe(
    `Why: read with cat, jq, grep or the Read tool, or keep to json/re/pathlib/fs reads; a script that needs more goes in a file in ${scratch}.`,
  );
});

/** The modules a `python3` here names as its standard library, or [] with no Python 3.10+. */
const pythonModules = (): string[] => {
  for (const python of ["python3", "python"]) {
    const result = spawnSync(
      python,
      ["-c", "import sys; print(' '.join(sorted(sys.stdlib_module_names)))"],
      {
        encoding: "utf8",
      },
    );
    if (result.status === 0) return result.stdout.trim().split(/\s+/);
  }
  return [];
};

test("Given every module in Python's sys.stdlib_module_names and Node's builtinModules, When inline code imports one outside the tables, Then it is a writer; one inside runs", () => {
  const cwd = realpathSync(lead);
  const writes = (command: string, runner: string) =>
    shellMutationTargets(cwd, command, "posix", true).includes(
      path.join(cwd, `.workit-runs-${runner}`),
    );
  const python = new Set(
    "json re math collections itertools functools datetime time hashlib base64 glob fnmatch csv io string textwrap statistics difflib shlex pprint typing ast tomllib configparser pathlib os sys".split(
      " ",
    ),
  );
  const names = pythonModules();
  const refused = names.filter((name) => {
    const writer = writes(`python3 -c "import ${name}"`, "python3");
    expect(writer, name).toBe(!python.has(name));
    return writer;
  }).length;
  const node = new Set(
    "path os url util crypto assert zlib querystring readline buffer fs fs/promises".split(" "),
  );
  const builtins = builtinModules.filter((module) => !module.includes(":"));
  const refusedNode = builtins.filter((name) =>
    [name, `node:${name}`]
      .map((spelled) => {
        const writer = writes(`node -e "require('${spelled}')"`, "node");
        // `fs` taken whole reaches every member: only a member or a binding is read.
        expect(writer, spelled).toBe(!node.has(name) || name.startsWith("fs"));
        return writer && !node.has(name);
      })
      .every(Boolean),
  ).length;
  // `node -e` has each builtin module as a global: one outside the tables is refused there too.
  for (const name of builtins.filter(
    (module) => /^[a-z_]\w*$/.test(module) && module !== "console",
  ))
    expect(writes(`node -e "${name}.x()"`, "node"), name).toBe(!node.has(name) || name === "fs");
  console.log(
    `property: Python ${refused} of ${names.length} refused; Node ${refusedNode} of ${builtins.length} refused`,
  );
  expect(refused).toBeGreaterThan(names.length - python.size - 1);
  expect(refusedNode).toBe(builtins.filter((name) => !node.has(name)).length);
});

// Round 3, group 3: a transparent wrapper's command is read past its options and its one operand
// (a judge's too); an opaque one (a lock file first, a remote host, a recording) is a writer where
// it runs.
test("Given a transparent or an opaque wrapper, When a judge or an implementer outside its worktree runs a write through it, Then it is denied; a read through a transparent one runs", () => {
  const writers = [
    "chrt -f 1 rm -rf src",
    "taskset 0x3 rm -rf src",
    "taskset ff rm -rf src",
    "taskset -c 0-2 rm -rf src",
    "timeout --signal KILL 5 rm -rf src",
    "timeout inf rm -rf src",
    "setsid -f rm -rf src",
    "timeout 5 eval 'rm -rf src'",
    "nice -n 5 bash -c 'rm -rf src'",
    "sudo -u me bash -c 'rm -rf src'",
    "flock --timeout 5 /tmp/l rm -rf src",
    "flock 9",
    "watch -n1 ls",
    "ssh host ls",
    "parallel rm ::: src",
    "script -q out.txt",
    "su -c 'rm -rf src'",
    "runuser -u x -- ls",
    "strace -o out.txt ls",
  ];
  denied(verifier, writers, "workit scratch confinement: verifier ver-reads");
  denied(
    implementer,
    writers.map((command) => `cd ${lead} && ${command}`),
    "workit worktree confinement: implementer impl-reads",
  );
  const reads = ["taskset -c 0 ls src", "chrt -f 1 ls", "nice -n 5 ls src", "timeout 5s ls src"];
  allowed(verifier, reads);
  allowed(
    implementer,
    reads.map((command) => `cd ${lead} && ${command}`),
  );
  allowed(implementer, ["flock /tmp/l touch x", "ssh host ls"]);
});

// Round 3, group 4: awk's commands and pipes, sed's `w`, `W` and `e`, a program file, `deno
// eval`, `tsx -e` and `ts-node -e` write wherever they run; `ftruncate` is a writer like `truncate`.
test("Given awk or sed that writes or runs a command, deno eval, tsx -e, ts-node -e or an ftruncate, When a judge or an implementer outside its worktree runs it, Then it is denied; the read-only forms run", () => {
  const writers = [
    `awk 'BEGIN { system("rm -rf src") }'`,
    `awk '{ print > "out.txt" }' package.json`,
    `awk '{ printf "%s", $1 >> "out.txt" }' package.json`,
    `awk '{ print | "sh" }' package.json`,
    `awk 'BEGIN { "date" | getline d }'`,
    "awk -f prog.awk package.json",
    `gawk -e 'BEGIN { system("id") }'`,
    "sed -n 'w out.txt' package.json",
    "sed '/name/W out.txt' package.json",
    "sed 's/a/b/w out.txt' package.json",
    "sed 's/a/b/e' package.json",
    "sed -e '1e rm -rf src' package.json",
    "sed -f prog.sed package.json",
    "sed -nf prog.sed package.json",
    "sed --expression='1e id' package.json",
    `deno eval "Deno.writeTextFileSync('x','a')"`,
    `tsx -e "require('fs').writeFileSync('x','a')"`,
    `ts-node -e "require('fs').writeFileSync('x','a')"`,
    `npx tsx -e "require('fs').writeFileSync('x','a')"`,
    `node -e "const { readFileSync: r, promises } = require('node:fs'); promises.ftruncate"`,
    `python3 -c "import os; f = os.ftruncate"`,
  ];
  denied(verifier, writers, "workit scratch confinement: verifier ver-reads");
  denied(
    implementer,
    writers.map((command) => `cd ${lead} && ${command}`),
    "workit worktree confinement: implementer impl-reads",
  );
});

// Round 3, self-probe: code from a YAML tag or an annotation, a private member, a copy through
// Python 3.14's Path, a read opened to write (`flag: 'w'` truncates) and the Function
// constructor reached through a prototype or a computed key.
test("Given inline code that runs code from data, opens a read to write or reaches a constructor, When a judge or an implementer outside its worktree runs it, Then it is denied", () => {
  const writers = [
    `python3 -c "import yaml; yaml.unsafe_load('!!python/object/apply:os.system [id]')"`,
    `python3 -c "import yaml; yaml.load('a: 1', Loader=yaml.Loader)"`,
    `python3 -c "import typing; typing.ForwardRef('1')"`,
    `python3 -c "import typing; print(typing.get_type_hints(int))"`,
    `python3 -c "import sys; print(sys._getframe())"`,
    `python3 -c "import json; json._default_decoder"`,
    `python3 -c "help('modules')"`,
    `python3 -c "from pathlib import Path; Path('a').copy('b')"`,
    `python3 -c "from pathlib import Path; Path('a').copy_into('b')"`,
    `python3 -c "from pathlib import Path; Path('a').move_into('b')"`,
    `node -e "require('fs').readFileSync('package.json', { flag: 'w' })"`,
    `node -e "const fs = require('fs'); fs.createReadStream('package.json', { flags: 'w' })"`,
    `node -e "const k = 'fl' + 'ag'; require('fs').readFileSync('package.json', { [k]: 'w' })"`,
    `node -e "require('fs').readFileSync('package.json', JSON.parse('{\\"flag\\":\\"w\\"}'))"`,
    `node -e "const F = (() => 1)['constructor']; F('return 1')"`,
    `node -e "const P = Object.getPrototypeOf(() => 1); P"`,
    `node -e "Object.getOwnPropertyNames(Function)"`,
  ];
  denied(verifier, writers, "workit scratch confinement: verifier ver-reads");
  denied(
    implementer,
    writers.map((command) => `cd ${lead} && ${command}`),
    "workit worktree confinement: implementer impl-reads",
  );
  allowed(verifier, [
    `python3 -c "import yaml; print(yaml.safe_load('a: 1'))"`,
    `python3 -c "d = {'a': 1}; print(d.copy())"`,
    `node -e "console.log([[1, 2], [3]].flat())"`,
  ]);
});
