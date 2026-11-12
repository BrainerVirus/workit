// The registry guard (issued registry, <state>/approvals/, the config dir's
// workspaces.json) judges a shell command by the same analysis that confines
// an implementer: wrappers, opaque writers and inline scripts that spell a
// guarded path are denied with the plain write's text, while reads through
// the same tools, and the same shapes elsewhere, pass (#818).
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grantsHome } from "@/packages/workit-core/src/autonomy";
import { configDir } from "@/packages/workit-core/src/core/workit-paths.mjs";
import {
  shellGate,
  unquotedWindowsRegistry,
  writeGate,
} from "@/packages/workit-core/src/hooks/write-gate";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-guard-shapes-")));
const home = path.join(base, "home");
const state = path.join(base, "state");
const root = path.join(base, "repo");
const elsewhere = path.join(base, "elsewhere");
// APPDATA too: on Windows the default config dir is %APPDATA%\workit, never the runner's own.
const KEYS = [
  "HOME",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "WORKIT_CONFIG",
  "WORKIT_CONFIG_DIR",
  "WORKIT_STATE_DIR",
];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const savedResolve = grantsHome.resolve;
const set = (env: Record<string, string> = {}) => {
  for (const key of KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.WORKIT_STATE_DIR = state;
  Object.assign(process.env, env);
};
beforeEach(() => {
  set();
  grantsHome.resolve = () => path.join(base, "account");
});
afterEach(() => {
  grantsHome.resolve = savedResolve;
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A path as a POSIX shell on Windows (Git Bash) is given it: forward slashes. */
const sh = (file: string) => file.replaceAll("\\", "/");
const CONFIG = configDir({ HOME: home });

type Kind = { name: string; dir: string; file: string; text: string };
const KINDS: Kind[] = [
  {
    name: "issued",
    dir: path.join(state, "issued"),
    file: path.join(state, "issued", "s1.json"),
    text: "issued-registry guard",
  },
  {
    name: "approvals",
    dir: path.join(state, "approvals", "grants"),
    file: path.join(state, "approvals", "grants", "a.json"),
    text: "approvals guard",
  },
  {
    name: "grants",
    dir: CONFIG,
    file: path.join(CONFIG, "workspaces.json"),
    text: "config guard",
  },
];
for (const kind of KINDS) {
  mkdirSync(kind.dir, { recursive: true });
  writeFileSync(kind.file, "{}");
}
mkdirSync(root, { recursive: true });
writeFileSync(path.join(root, "x.json"), "{}");

const decide = (command: string) => shellGate(root, command, null);
/** The deny text past the target's spelling: the guard and the command to run instead. */
const tail = (reason: string) => reason.slice(reason.indexOf(" is under "));

/** Shapes that write the guarded file `f` (or into its dir `d`, whose basename is `b`). */
type Shape = (f: string, d: string, b: string) => string;
const WRITES: Record<string, Shape> = {
  "bash -c literal": (f) => `bash -c 'echo {} > ${f}'`,
  "sh -c literal": (f) => `sh -c "echo {} > ${f}"`,
  "zsh -c literal": (f) => `zsh -c 'echo {} > ${f}'`,
  "bash -c $S set in the same command": (f) => `S='echo {} > ${f}'; bash -c "$S"`,
  "heredoc-fed shell": (f) => `bash <<'EOF'\necho {} > ${f}\nEOF`,
  "literal eval": (f) => `eval "echo {} > ${f}"`,
  rsync: (f) => `rsync x.json ${f}`,
  "curl -o": (f) => `curl -so ${f} https://example.com/x`,
  "find -delete": (_f, d) => `find ${d} -name '*.json' -delete`,
  "tar -C": (_f, d) => `tar -xf a.tar -C ${d}`,
  "git -C checkout": (_f, d, b) => `git -C ${d} checkout -- ${b}`,
  "git -C restore": (_f, d, b) => `git -C ${d} restore ${b}`,
  "git -C apply": (_f, d) => `git -C ${d} apply p.patch`,
  "python3 -c": (f) => `python3 -c "open('${f}','w').write('{}')"`,
  "node -e": (f) => `node -e "require('fs').writeFileSync('${f}','{}')"`,
  "vim -c": (f) => `vim -c wq ${f}`,
  "vim +cmd": (f) => `vim +wq ${f}`,
  "vim -s": (f) => `vim -s cmds.vim ${f}`,
  "ed with a stdin script": (f) => `ed ${f} <<'EOF'\n1d\nw\nEOF`,
};
const READS: Record<string, Shape> = {
  cat: (f) => `cat ${f}`,
  "cp out": (f) => `cp ${f} /tmp/copy.json`,
  jq: (f) => `jq . ${f} > out.json`,
  "bash -c cat": (f) => `bash -c 'cat ${f}'`,
  "rsync out": (f) => `rsync ${f} ./copy.json`,
  "git -C status": (_f, d) => `git -C ${d} status`,
  find: (_f, d) => `find ${d} -name '*.json'`,
  "vim with no write command": (f) => `vim ${f}`,
  "ln -s": (f) => `ln -s ${f} view.json`,
  "eval read": (f) => `eval "cat ${f}"`,
};

const shapes = (table: Record<string, Shape>, kind: Kind, dir = kind.dir) => {
  const file = path.join(dir, path.basename(kind.file));
  return Object.entries(table).map(
    ([name, shape]) =>
      [name, shape(sh(file), sh(dir), path.basename(kind.file))] as [string, string],
  );
};

test("G each guarded kind, W a wrapper, opaque writer, inline script or scripted editor writes it, T denied with the plain write's text", () => {
  for (const kind of KINDS) {
    const plain = decide(`echo '{}' > ${sh(kind.file)}`);
    expect(plain.kind, `${kind.name}: plain`).toBe("deny");
    const reason = plain.kind === "deny" ? plain.reason : "";
    expect(reason).toStartWith(`workit ${kind.text}: `);
    for (const [name, command] of shapes(WRITES, kind)) {
      const out = decide(command);
      expect(out.kind, `${kind.name}: ${name}: ${command}`).toBe("deny");
      const got = out.kind === "deny" ? out.reason : "";
      expect(got, `${kind.name}: ${name}`).toStartWith(`workit ${kind.text}: `);
      expect(tail(got), `${kind.name}: ${name}`).toBe(tail(reason));
    }
  }
});

test("G each guarded kind, W the same tools only read it, T nothing is denied", () => {
  for (const kind of KINDS)
    for (const [name, command] of shapes(READS, kind))
      expect(decide(command).kind, `${kind.name}: ${name}: ${command}`).toBe("none");
});

test("G a dir outside the guarded ones, W every write shape names a file there, T nothing is denied", () => {
  for (const kind of KINDS) {
    const dir = path.join(elsewhere, kind.name);
    for (const [name, command] of shapes(WRITES, kind, dir))
      expect(decide(command).kind, `${kind.name} elsewhere: ${name}: ${command}`).toBe("none");
  }
  const schema = "packages/workit-core/schemas/workspaces.json";
  for (const command of [
    `bash -c 'echo {} > ${schema}'`,
    `rsync x.json ${schema}`,
    `python3 -c "open('${schema}','w')"`,
    `vim -c wq ${schema}`,
  ])
    expect(decide(command).kind, command).toBe("none");
});

test("G an inline interpreter that only reads a guarded file, W it runs, T the accepted false deny names workit grant show", () => {
  const out = decide(`python3 -c "print(open('${sh(KINDS[2].file)}').read())"`);
  expect(out.kind).toBe("deny");
  expect(out.kind === "deny" ? out.reason : "").toContain("workit grant show");
});

test("G env vars the hook's environment holds, W a write spells a guarded path through them or a ${X:-default}, T denied", () => {
  const xdg = path.join(base, "xdg");
  const wc = path.join(base, "wc");
  const cases: Array<[string, Record<string, string>]> = [
    ["echo '{}' > $XDG_CONFIG_HOME/workit/workspaces.json", { XDG_CONFIG_HOME: xdg }],
    [
      "echo '{}' > \"${XDG_CONFIG_HOME:-$HOME/.config}/workit/workspaces.json\"",
      { XDG_CONFIG_HOME: xdg },
    ],
    ["echo '{}' > $WORKIT_STATE_DIR/approvals/grants/a.json", {}],
    ["rm -rf ${WORKIT_STATE_DIR}/issued", {}],
    ["cp x.json $WORKIT_CONFIG/", { WORKIT_CONFIG: wc }],
  ];
  // The default dir is ~/.config/workit only off Windows (%APPDATA%\workit there).
  if (process.platform !== "win32")
    cases.push(["echo '{}' > \"${XDG_CONFIG_HOME:-$HOME/.config}/workit/workspaces.json\"", {}]);
  for (const [command, env] of cases) {
    set(env);
    expect(decide(command).kind, `${command} ${JSON.stringify(env)}`).toBe("deny");
  }
  set({ XDG_CONFIG_HOME: xdg });
  for (const command of [
    "echo hi > $UNSET_DIR/out.txt",
    "echo '{}' > $XDG_CONFIG_HOME/other/workspaces.json",
    "echo '{}' > \"${NOT_SET_HERE:-/tmp}/workspaces.json\"",
  ])
    expect(decide(command).kind, command).toBe("none");
});

test("G a write target with a glob, W it may expand to a guarded path, T matched segment by segment and denied; other globs pass", () => {
  const cfg = sh(CONFIG);
  const fromHome = sh(path.relative(home, CONFIG))
    .split("/")
    .map((part) => `${part.slice(0, 4)}*`)
    .join("/");
  for (const command of [
    `cp x.json ${cfg}/work*.json`,
    `echo '{}' | tee ${cfg}/workspaces.j?on`,
    `cp x.json ~/${fromHome}/w*.json`,
    `rm ${sh(state)}/appr*/grants/*.json`,
    `rm -rf ${sh(state)}/iss*`,
    `cp x.json ${sh(state)}/[ai]*/grants/a.json`,
  ])
    expect(decide(command).kind, command).toBe("deny");
  for (const command of [
    `rm -f /tmp/zz*/x.json src/*.ts`,
    `cp x.json ${sh(elsewhere)}/work*.json`,
    `cp x.json ${cfg}/rules/*.md`,
    `ls ${cfg}/*.json > list.txt`,
  ])
    expect(decide(command).kind, command).toBe("none");
});

test("G a hard link to a guarded file, W a shell or the Edit tool writes it, or a command makes one, T denied; a symlink and unrelated links pass", () => {
  const links = path.join(root, "links");
  mkdirSync(links, { recursive: true });
  for (const kind of KINDS) {
    const link = path.join(links, `${kind.name}.json`);
    linkSync(kind.file, link);
    for (const command of [
      `echo '{}' > links/${kind.name}.json`,
      `sed -i s/a/b/ links/${kind.name}.json`,
      `ln ${sh(kind.file)} links/${kind.name}-2.json`,
      `cp -l ${sh(kind.file)} links/${kind.name}-3.json`,
    ])
      expect(decide(command).kind, `${kind.name}: ${command}`).toBe("deny");
    expect(writeGate(root, [link]).kind, `${kind.name}: Edit through a hard link`).toBe("deny");
    expect(decide(`ln -s ${sh(kind.file)} links/${kind.name}-view.json`).kind).toBe("none");
  }
  writeFileSync(path.join(links, "two.json"), "{}");
  linkSync(path.join(links, "two.json"), path.join(links, "two-b.json"));
  expect(decide("echo '{}' > links/two.json").kind).toBe("none");
  expect(writeGate(root, [path.join(links, "two-b.json")]).kind).toBe("none");
  expect(decide(`cp -l links/two.json links/two-c.json`).kind).toBe("none");
});

test("G script files that spell a guarded path in a write, W a shell or interpreter runs them, T read at hook time and denied; other scripts pass", () => {
  const scripts = path.join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  const put = (name: string, text: string) => writeFileSync(path.join(scripts, name), text);
  for (const kind of KINDS) {
    const f = sh(kind.file);
    put("forge.sh", `#!/bin/sh\necho '{}' > ${f}\n`);
    put("forge-cd.sh", `cd ${sh(kind.dir)}\necho '{}' > ${path.basename(kind.file)}\n`);
    put("forge.py", `import json\njson.dump({}, open("${f}", "w"))\n`);
    put("forge.mjs", `import fs from "node:fs";\nfs.writeFileSync("${f}", "{}");\n`);
    put("forge.rb", `File.write("${f}", "{}")\n`);
    for (const command of [
      "bash scripts/forge.sh",
      "sh ./scripts/forge.sh",
      "zsh scripts/forge-cd.sh",
      ". ./scripts/forge.sh",
      "source scripts/forge.sh",
      "./scripts/forge.sh",
      "cd scripts && ./forge.sh",
      "python3 scripts/forge.py",
      "node scripts/forge.mjs",
      "ruby scripts/forge.rb",
      `cat > t.sh <<'EOF'\necho '{}' > ${f}\nEOF\nbash t.sh`,
    ])
      expect(decide(command).kind, `${kind.name}: ${command}`).toBe("deny");
  }
  put("ok.sh", "echo hi > out.txt\n");
  put("ok.py", 'print(open("/etc/hostname").read())\n');
  put("ok.mjs", 'console.log("hi");\n');
  // Past the 256 KB cap a script is not read.
  put("big.sh", `${"# pad\n".repeat(50_000)}echo '{}' > ${sh(KINDS[2].file)}\n`);
  for (const command of [
    "bash scripts/ok.sh",
    "./scripts/ok.sh",
    "python3 scripts/ok.py",
    "node scripts/ok.mjs",
    "bash scripts/missing.sh",
    "bash scripts/big.sh",
    `cat > t.sh <<'EOF'\necho hi > out.txt\nEOF\nbash t.sh`,
  ])
    expect(decide(command).kind, command).toBe("none");
});

test("G Windows registry paths with unquoted backslashes, W the guarded path is only read, T no deny; in a write position, T denied", () => {
  set({ WORKIT_STATE_DIR: "C:\\st", WORKIT_CONFIG: "C:\\cfg" });
  const cases: Array<[string, string | null]> = [
    ["cp C:\\cfg\\workspaces.json backup.json", null],
    ["type C:\\cfg\\workspaces.json > out.json", null],
    ["cat C:\\st\\issued\\x | tee copy.txt", null],
    ["cp C:\\cfg\\workspaces.json C:\\cfg\\rules\\copy.json", null],
    ["cp backup.json C:\\cfg\\workspaces.json", "grants"],
    ["cp backup.json C:\\cfg\\", "grants"],
    ["echo x > C:\\st\\approvals\\grants\\a.json", "approvals"],
    ["rm -rf C:\\st\\issued", "issued"],
  ];
  for (const [command, want] of cases)
    expect(unquotedWindowsRegistry(command, "win32"), command).toBe(want as never);
  expect(unquotedWindowsRegistry("cp backup.json C:\\cfg\\workspaces.json", "linux")).toBeNull();
});

test("G an interpreter fed its script on stdin, W the heredoc spells a guarded path, directly or from a script file, T denied", () => {
  const scripts = path.join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const kind of KINDS) {
    const f = sh(kind.file);
    const heredoc = `python3 << 'PY'\nimport json\nwith open("${f}", "w") as out:\n    json.dump({}, out)\nPY`;
    writeFileSync(path.join(scripts, "fed.sh"), `#!/bin/bash\nset -e\n${heredoc}\n`);
    for (const command of [
      heredoc,
      `node <<'JS'\nrequire("fs").writeFileSync("${f}", "{}")\nJS`,
      "bash scripts/fed.sh",
    ])
      expect(decide(command).kind, `${kind.name}: ${command}`).toBe("deny");
  }
  expect(decide(`python3 <<'PY'\nprint("hi")\nPY`).kind).toBe("none");
});
