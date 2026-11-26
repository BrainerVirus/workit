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
const slashed = (text: string): string =>
  process.platform === "win32" ? text.replaceAll("\\", "/") : text;

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
  // The long name of the temp dir where Windows has one (RUNNER~1 → runneradmin).
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-confine-ft-")));
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
  // Commands spell paths with forward slashes, as Git Bash on Windows does (`C:/…`).
  lead = slashed(lead);
  wt = slashed(wt);
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
    // A backslash in a test command is a shell escape; on Windows paths go with forward slashes.
    tool_input: { command: slashed(command) },
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

/** `command` is denied with exactly `Retry as: <retry>` as its second line. */
const retried = (
  run: (command: string) => Specific["hookSpecificOutput"],
  pairs: Array<[command: string, retry: string]>,
) => {
  for (const [command, retry] of pairs) {
    const out = run(command);
    expect(verdict(out), command).toBe("deny");
    expect(out?.permissionDecisionReason?.split("\n")[1], command).toBe(`Retry as: ${retry}`);
  }
};

// Review mwmcj4in: a judge's path from a shell variable is never followed (a later command
// can set the name again under a spelling Workit does not see); the retry spells it in.
test("Given a verifier, When it reads a path from a literal assignment (W=<checkout>; git -C $W …), Then it is denied with the literal spelled into the retry; plain git status runs", () => {
  retried(verifier, [
    [
      `W=${lead}; git -C $W rev-parse HEAD; git -C $W status --short`,
      `git -C ${lead} rev-parse HEAD; git -C ${lead} status --short`,
    ],
    [
      `W=${lead} && B='${wt}'; git -C $W log -1; git -C "\${B}" diff --stat`,
      `git -C ${lead} log -1; git -C "${wt}" diff --stat`,
    ],
    [`W=${lead}\ngit -C $W log --oneline -3`, `git -C ${lead} log --oneline -3`],
  ]);
  // A Windows path with backslashes is spelled into the retry as written (POSIX: the helper
  // keeps the backslashes there).
  if (process.platform !== "win32")
    retried(verifier, [
      ["W=C:\\Users\\me\\app; git -C $W log -1", "git -C C:\\Users\\me\\app log -1"],
    ]);
  // An 8.3 short name keeps its `~` in the retry; a `~` bash would expand is not spelled in.
  retried(verifier, [
    ["W=C:/Users/RUNNER~1/app; git -C $W log -1", "git -C C:/Users/RUNNER~1/app log -1"],
  ]);
  denied(verifier, ["W=~/app; git -C $W log -1", "W=/x:~/app; git -C $W log -1"]);
  allowed(verifier, [`git -C ${lead} status --short`]);
  denied(verifier, [
    "PATH=/x; git status",
    "W=$(cat f); git -C $W log",
    `GIT_DIR=${lead}/.git; git log`,
    `W=${lead}; W=/tmp; git -C $W log`,
    `W=${lead} git -C ${lead} log`,
  ]);
});

test("Given a verifier, When a literal assignment's name is single-quoted, escaped or read by a script, Then it is denied", () => {
  const scratch = `${lead}/.workit-scratch`;
  denied(verifier, [
    `W=${scratch}; echo a > '$W'`,
    `W=${scratch}; echo a > \\$W`,
    `W=${scratch}; bash <<'EOF'\necho a > $W/x\nEOF`,
    `W=${scratch}; for W in /tmp; do echo a > $W/x; done`,
    // A quote in the value would unbalance the spelled-in command: never substituted.
    `W='"'; echo "$W" > ${lead}/x`,
  ]);
  retried(verifier, [
    [
      `W=${scratch}; mkdir -p $W && echo a > "$W/x"`,
      `mkdir -p ${scratch} && echo a > "${scratch}/x"`,
    ],
  ]);
});

test("Given a verifier, When it redirects outside its scratch dir, Then line 2 is the same command written into the scratch dir", () => {
  // The scratch dir as a retry spells it: its real path, with forward slashes (Git Bash on Windows).
  const scratch = path.join(realpathSync.native(lead), ".workit-scratch").replaceAll("\\", "/");
  const out = verifier(`workit check --cwd ${lead} lint > /tmp/x.log 2>&1`);
  expect(verdict(out)).toBe("deny");
  expect(out?.permissionDecisionReason?.split("\n")[1]).toBe(
    `Retry as: workit check --cwd ${lead} lint > ${scratch}/x.log 2>&1`,
  );
  expect(verifier(`git -C ${lead} log | tee -a /tmp/y.txt`)?.permissionDecisionReason).toContain(
    `\nRetry as: git -C ${lead} log | tee -a ${scratch}/y.txt`,
  );
  expect(verdict(verifier(`git -C ${lead} log > ${lead}/.workit-scratch/x.log 2>&1`))).toBe(
    "allow",
  );
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

test("Given a verifier, When it runs git remote get-url, range-diff or worktree list, Then each runs; a for over literal words is denied with the loop unrolled in the retry", () => {
  allowed(verifier, [
    `git -C ${lead} remote get-url origin`,
    `git -C ${lead} remote -v`,
    `git -C ${lead} range-diff main...HEAD`,
    `git -C ${lead} worktree list`,
  ]);
  retried(verifier, [
    [
      `for f in package.json a.ts; do git -C ${lead} log -1 -- $f; done`,
      `git -C ${lead} log -1 -- package.json; git -C ${lead} log -1 -- a.ts`,
    ],
  ]);
  const many = Array.from({ length: 17 }, (_, index) => `f${index}`).join(" ");
  denied(verifier, [
    `for f in ${many}; do git -C ${lead} log -1 -- $f; done`,
    `for f in $(ls); do git -C ${lead} log -1 -- $f; done`,
    `git -C ${lead} remote add x /tmp/x`,
  ]);
});

// #880: the read-only one-liners it lists run; the writes hidden in inline code stay denied.
test("Given the one-liners #880 lists and writes hidden in inline code, When a judge runs them, Then each one-liner runs and each write is denied; a heredoc that only reads still runs", () => {
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
  // The worktree as the hook names it (its real path, in the platform's separators).
  const retry = `cd ${realpathSync.native(wt)} && python3 -c "open('x','w')"`;
  expect(out?.permissionDecisionReason?.split("\n")[1]).toBe(`Retry as: ${retry}`);
  expect(verdict(implementer(retry))).toBe("allow");
});

// Review mwm7hutf (adversarial, round 1): each form below passed on a67cf06c and is denied again.
test("Given review mwm7hutf's bypasses, When a judge runs a write hidden by a triple-quoted string, a regex literal holding a quote or a pandas writer, Then each is denied", () => {
  const target = `${lead}/package.json`;
  denied(verifier, [
    `python3 - <<'EOF'\ns = ''' x '\n# '''; open("${target}", "w").write("x")\nEOF`,
    `python3 - <<'EOF'\ns = """ x "\n# """; open("${target}", "w").write("x")\nEOF`,
    `python3 - <<'EOF'\nfrom pathlib import Path\ns = ''' x '\n# '''; Path("${target}").write_text("x")\nEOF`,
    `python3 - <<'EOF'\ns = f''' x '\n{open("${target}", "w")} '''\nEOF`,
    `node - <<'EOF'\n0 || /'/.test("") || require("fs").writeFileSync("${target}", "x") // '\nEOF`,
    `node - <<'EOF'\nconst fs = require("fs")\nif (1) /'/.test("") || fs.writeFileSync("${target}", "x") // '\nEOF`,
    `node - <<'EOF'\nconst fs = require("fs")\nfor (;;) { /'/.test("") || fs.writeFileSync("${target}", "x"); break } // '\nEOF`,
    `python3 - <<'EOF'\ns = '''a"""b'''; t = """ x '\n# """; open("${target}","w").write("x") #'\nEOF`,
    `python3 - <<'EOF'\ns = b''' x '\n# '''; open("${target}","w").write("x")\nEOF`,
    `python3 -c "import pandas as pd; pd.read_csv('a.csv').to_csv('${target}')"`,
    `python3 -c "import pandas as pd; pd.DataFrame([1]).head(5).to_csv('${target}')"`,
  ]);
  // A docstring that only reads still runs.
  allowed(verifier, [
    `python3 - <<'EOF'\n"""Print the version."""\nimport json\nprint(json.load(open('package.json'))['version'])\nEOF`,
  ]);
});

test("Given the lead or an implementer, When a script names the Workit config dir anywhere and may write, Then it is refused as before this slice (lead ruling: no config-as-data relaxation)", () => {
  const asLead = (command: string) => bash(command, "", "");
  const C = resolveConfigDir();
  const py = (body: string) => `python3 - <<'EOF'\n${body}\nEOF`;
  const node = (body: string) => `node - <<'EOF'\n${body}\nEOF`;
  expect(verdict(implementer(`touch ${wt}/a.ts`))).toBe("allow");
  for (const command of [
    // A plan JSON whose string value only mentions the dir: still refused (base behavior).
    py(
      `import json\nplan = {"name": "x", "notes": "grants live in ${C} and stay"}\nwith open('.git/workit/plans/x.json', 'w') as f:\n    json.dump(plan, f)`,
    ),
    py(`with open('${C}/workspaces.json', 'w') as f:\n    f.write('{}')`),
    py(`import os\nd = "${C}"\nopen(os.path.join(d, "workspaces.json"), "w").write("{}")`),
    py(`open(" ${C}".strip() + "/grants.json", "w").write("{}")`),
    py(`d = " ${C} ".split()[0]\nopen(d + "/workspaces.json", "w").write("{}")`),
    node(`const d = \`\${""}${C}\`\nrequire("fs").writeFileSync(d + "/workspaces.json", "{}")`),
    py(
      `note = {"cfg": "x ${C}"}\nopen(note["cfg"].split()[1] + "/workspaces.json", "w").write("{}")`,
    ),
    // Review mwm8naps probe4: list or dict + strip, split concatenation, glob, implicit
    // concatenation, bytes.fromhex, rmtree or rename of the dir, .split()[1], .lower(), Node.
    py(`x = [" ${C} "]\nopen(x[0].strip() + "/works" + "paces.json", "w").write("{}")`),
    py(`x = {"k": " ${C}"}["k"].strip()\nopen(x + "/" + "workspace" + "s.json", "w").write("{}")`),
    py(
      `import glob\nd = [" ${C} "][0].strip()\nfor f in glob.glob(d + "/w*.json"):\n    open(f, "w").write("{}")`,
    ),
    py(
      `import os\nx = [" ${C} "]\nopen(os.path.join(x[0].strip(), "works" "paces.json"), "w").write("{}")`,
    ),
    py(
      `x = [" ${C} "]\nn = bytes.fromhex("776f726b7370616365732e6a736f6e").decode()\nopen(x[0].strip() + "/" + n, "w").write("{}")`,
    ),
    py(`import shutil\nshutil.rmtree([" ${C} "][0].strip())`),
    node(
      `const d = [" ${C} "][0].trim()\nrequire("fs").writeFileSync(d + "/works" + "paces.json", "{}")`,
    ),
    node(
      `const d = {k: " ${C}"}.k.trim()\nrequire("fs").writeFileSync(\`\${d}/works\${"paces"}.json\`, "{}")`,
    ),
    py(
      `x = ["see ${C} here"]\nd = x[0].split()[1]\nopen(d + "/works" + "paces.json", "w").write("{}")`,
    ),
    py(
      `import os\nd = [" ${C} "][0].strip()\nfor f in os.listdir(d):\n    open(os.path.join(d, f), "w").write("{}")`,
    ),
    py(`import os\nos.rename([" ${C} "][0].strip(), "/tmp/wk-moved")`),
    py(`x = [" ${C} "]\nopen(x[0].strip() + "/WORKSPACES.json".lower(), "w").write("{}")`),
  ]) {
    expect(verdict(asLead(command)), command).toBe("deny");
    expect(verdict(implementer(command)), command).toBe("deny");
  }
});

test("Given review mwm7hutf, When a judge assigns a name the shell sets itself (read, getopts, mapfile) or reads, Then it is denied", () => {
  const scratch = `${lead}/.workit-scratch`;
  denied(verifier, [
    `REPLY=${scratch}/x; read < ${scratch}/t; echo pwned > $REPLY`,
    `OPTARG=${scratch}/x; getopts a: o -a ${lead}/package.json; echo pwned > $OPTARG`,
    `MAPFILE=${scratch}/x; mapfile < ${scratch}/t; echo pwned > $MAPFILE`,
    `_=${scratch}/x; echo pwned > $_`,
    `W=HEAD,--output=/tmp/pwn-wk; IFS=,; git -C ${lead} show $W`,
  ]);
});

test("Given review mwm7hutf, When a retry is printed, Then it is a complete call: the assignments kept in front, no doubled space, a computed value left whole", () => {
  const scratch = `${lead}/.workit-scratch`;
  const real = path.join(realpathSync.native(lead), ".workit-scratch");
  const judged = verifier(`W=${scratch}/..; echo a > $W/x`)?.permissionDecisionReason ?? "";
  expect(judged.split("\n")[1]).toBe(`Retry as: echo a > ${scratch}/../x`);
  expect(real).toContain(".workit-scratch");
  const built = implementer(`W=$(pwd)/..; echo x > $W/a`)?.permissionDecisionReason ?? "";
  expect(built.split("\n")[1]).toBe("Retry as: W=$(pwd)/..; echo x > <absolute path of $W>/a");
});

// Reviews mwmaow76 and mwmcj4in: no name is followed for a judge; a zsh modifier or subscript
// gets no retry.
test("Given a judge, When it reads a path from any assigned or loop name, or uses a zsh modifier or subscript, Then it is denied; the retry spells the literal in", () => {
  const scratch = `${lead}/.workit-scratch`;
  const names = ["DIRSTACK", "FUNCNAME", "GROUPS", "PIPESTATUS", "COLUMNS", "LINES", "IFS"];
  const refused = [
    ...[...names, "NULLCMD", "TMPPREFIX", "HISTFILE", "path", "status"].flatMap((name) => [
      `${name}=${scratch}; echo x > $${name}/x`,
      `${name}=${scratch}/r; git -C $${name} commit -qm x --allow-empty`,
    ]),
    `for path in ${scratch}; do git status; done`,
    `for DIRSTACK in ${scratch}; do echo x > $DIRSTACK/package.json; done`,
    // probe8: zsh modifiers and subscripts reach the checkout from a scratch path.
    `W=${scratch}/a/b; echo x > $W:h:h:h/package.json`,
    `W=${scratch}/a/b; echo x > "$W:h:h:h/package.json"`,
    `W=${scratch}/a/b; echo x > $W[1,${lead.length}]/package.json`,
    `for f in ${scratch}/a/b; do echo x > $f:h:h:h/package.json; done`,
    `W=${scratch}/a/b; git -C $W:h:h:h commit -qm x --allow-empty`,
    `W=${scratch}/a/b; cp ${scratch}/x $W:h:h:h/package.json`,
    `W=${scratch}; echo x > \${W:-/tmp}/x`,
    `W=${scratch}; echo x > \${W}x`,
  ];
  const reviewer = (command: string) => bash(command, "workit:reviewer", "rev-ft");
  denied(verifier, refused);
  denied(reviewer, refused);
  retried(verifier, [
    [`W=${lead}; git -C $W status --short`, `git -C ${lead} status --short`],
    [`wt=${lead}; git -C $wt status --short`, `git -C ${lead} status --short`],
    [`W=${scratch}; mkdir -p "$W"/x`, `mkdir -p "${scratch}"/x`],
    [`W=${scratch}; echo x > \${W}/x`, `echo x > ${scratch}/x`],
    [
      `for f in a b; do git -C ${lead} log -1 -- $f; done`,
      `git -C ${lead} log -1 -- a; git -C ${lead} log -1 -- b`,
    ],
  ]);
  const retry = verifier(`path=${scratch}; echo x > $path/x`)?.permissionDecisionReason ?? "";
  expect(retry.split("\n")[1]).toBe(`Retry as: echo x > ${scratch}/x`);
  const zsh = verifier(`W=${scratch}/a/b; echo x > $W:h/x`)?.permissionDecisionReason ?? "";
  expect(zsh.split("\n")[1]).toMatch(/^Why: /);
});

// Review mwmcj4in probe9: a name set again under a spelling Workit does not read.
test("Given review mwmcj4in's probe9 forms, When a judge runs them, Then each is denied; plain git status and remote get-url run", () => {
  const P = `${lead}/package.json`;
  const S = `${lead}/.workit-scratch`;
  const reviewer = (command: string) => bash(command, "workit:reviewer", "rev-ft");
  const forms = [
    `echo x > ${P}`,
    `W=${S}/a; echo x > $W/out.txt`,
    `WT=${S}/x; printf -v W"T" %s ${P}; echo x > $WT`,
    `W=${S}/x; printf -v "$(printf '\\x57')" %s ${P}; echo x > $W`,
    `WT=${S}/x; declare W\\T=${P}; echo x > $WT`,
    `W=${S}/x; declare "$(printf '\\x57')=${P}"; echo x > $W`,
    `WT=${S}/x; read -r W""T < ${S}/f; echo x > $WT`,
    `WT=${S}/x; printf -v W"T" %s ${lead}; git -C $WT commit -qm x --allow-empty`,
    `WT=${S}/x; printf -v W"T" %s ${P}; cp ${S}/y $WT`,
    `q=W; WT=${S}/x; printf -v $q"T" %s ${P}; echo x > $WT`,
    `W=${S}/x; echo x > $$W`,
    `W=${S}/x; echo x > "$(echo '$W')"`,
    `W=${S}/..; echo x > $W/package.json`,
    `W=${S}; echo x > "$W"/../package.json`,
    `A=${S}; echo x > $A/../package.json`,
    `_=${S}; echo x > $_/o`,
    `W=${S}/x; cat <<< hi > $W`,
    `W=${S}; echo x > $(echo $W)/o`,
    `W=${lead}; git -C $W -c core.hooksPath=${S} commit -qm x --allow-empty`,
    `git range-diff --output=${P} HEAD~1...HEAD`,
    `git range-diff --output ${P} HEAD~1...HEAD`,
    `git -c core.hooksPath=/x remote get-url origin`,
    `git remote set-url origin /x`,
    `for W in ${S}; do echo x > $W/o; done; echo y > $W/../package.json`,
    `W=${S}/a/package.json; declare "$(printf 'I\\x46S')=/"; cp ${S}/y $W`,
    `WT=${S}/x; export W"T"=${P}; echo x > $WT`,
    `WT=${S}/x; f() { typeset -g W"T"=${P}; }; f; echo x > $WT`,
  ];
  for (const command of forms) {
    expect(verdict(verifier(command)), command).toBe("deny");
    expect(verdict(reviewer(command)), command).toBe("deny");
  }
  allowed(reviewer, [
    `git remote get-url --push --all origin`,
    "git status",
    `git -C ${lead} status`,
  ]);
});
