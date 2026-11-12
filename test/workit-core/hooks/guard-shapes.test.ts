// The registry guard (issued registry, <state>/approvals/, the config dir's
// workspaces.json) judges a shell command by the same analysis that confines
// an implementer: wrappers, opaque writers and inline scripts that spell a
// guarded path are denied with the plain write's text, while reads through
// the same tools, and the same shapes elsewhere, pass (#818).
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grantsHome } from "@/packages/workit-core/src/autonomy";
import { configDir } from "@/packages/workit-core/src/core/workit-paths.mjs";
import { shellGate } from "@/packages/workit-core/src/hooks/write-gate";

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
