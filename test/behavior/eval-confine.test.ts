// Write confinement for bench hosts (scripts/eval/confine.ts, decision 2 for
// #823): under Landlock a host and everything it starts write only in its
// world, the temp dirs, /dev and its own credential file. Every test uses a
// fake real home under the temp dir, never the account's.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/scripts/eval/run";
// Namespace imports: on a checkout without the launcher, only the tests that use it fail.
import * as confine from "@/scripts/eval/confine";
import * as tripwire from "@/scripts/eval/tripwire";

const REPO = path.resolve(import.meta.dir, "..", "..");
const LAUNCHER = path.join(REPO, "scripts", "eval", "confine.ts");
/** Whether this kernel runs Landlock, read from the kernel, not from the launcher under test. */
const lsm = ((): string => {
  try {
    return readFileSync("/sys/kernel/security/lsm", "utf8");
  } catch {
    return "";
  }
})();
const landlock = process.platform === "linux" && lsm.split(",").includes("landlock");
if (!landlock)
  console.log(
    `eval-confine: Landlock tests skipped: this kernel runs no Landlock (${lsm.trim() || process.platform})`,
  );

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let root = "";
let home = "";
let config = "";
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "workit-confine-test-")));
  roots.push(root);
  home = path.join(root, "home");
  config = path.join(home, ".config", "workit");
  mkdirSync(config, { recursive: true });
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(path.join(home, ".local", "state", "workit", "approvals"), { recursive: true });
  writeFileSync(path.join(config, "workspaces.json"), '{"workspaces":[]}\n', { mode: 0o600 });
  writeFileSync(path.join(config, "vcs.json"), "{}");
  writeFileSync(path.join(home, ".claude", ".credentials.json"), "token-1", { mode: 0o600 });
  writeFileSync(path.join(home, ".claude.json"), "{}");
});

/** Every path under the fake home with its type, mode, inode and bytes' sha. */
const listing = (except: string[] = []): string[] => {
  const out: string[] = [];
  const go = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const file = path.join(dir, name);
      if (except.includes(file)) continue;
      const stat = lstatSync(file);
      const kind = stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file";
      const hash = stat.isFile()
        ? createHash("sha256").update(readFileSync(file)).digest("hex")
        : "";
      out.push(`${file} ${kind} ${stat.mode} ${stat.ino} ${hash}`);
      if (stat.isDirectory()) go(file);
    }
  };
  go(home);
  return out;
};

// Decision 2, test 7
test("Given a rule the launcher cannot add, Then it exits 126 and never runs the command", () => {
  const run = spawnSync(
    process.execPath,
    [LAUNCHER, "--rw", "/nonexistent", "--", "sh", "-c", "echo ran"],
    {
      encoding: "utf8",
    },
  );
  expect(run.status).toBe(126);
  expect(run.stdout).not.toContain("ran");
  expect(run.stderr).toContain("confine:");
  const bad = spawnSync(
    process.execPath,
    [LAUNCHER, "--bogus", "x", "--", "sh", "-c", "echo ran"],
    {
      encoding: "utf8",
    },
  );
  expect(bad.status).toBe(126);
  expect(bad.stdout).not.toContain("ran");
});

// Decision 2, test 9
test.skipIf(!landlock)(
  "Given the fake home under the temp dir, Then the temp dir is not writable for the host and the canary check reports on",
  async () => {
    const guard = tripwire.guardFor(home);
    const dirs = confine.writableDirs(path.join(root, "world"), [
      home,
      ...guard.watched,
      ...guard.reported,
      tripwire.tripwireBase(home),
    ]);
    expect(dirs).not.toContain(realpathSync(os.tmpdir()));
    expect(dirs).not.toContain("/tmp");
    expect(dirs).toContain("/dev");

    const lines: string[] = [];
    expect(await main(argv(fakeClaude(":")), (text) => lines.push(text))).toBe(0);
    expect(lines.join("\n")).toMatch(/^write confinement: on \(Landlock ABI \d+\)$/mu);
  },
);

test("Given the read rules, Then a dir holding the real home or a guarded path is never readable; system dirs and the toolchains are", () => {
  mkdirSync(path.join(root, "toolchain"), { recursive: true });
  const dirs = confine.readableDirs(
    [root, path.join(root, "toolchain"), "/nonexistent-toolchain"],
    [home, path.join(home, ".claude")],
  );
  expect(dirs).not.toContain(root);
  expect(dirs).toContain(path.join(root, "toolchain"));
  expect(dirs).not.toContain("/nonexistent-toolchain");
  expect(dirs).toContain("/usr");
  expect(dirs).toContain("/etc");
  const bin = path.join(root, "toolchain", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "tool"), "");
  expect(confine.toolchainDir("tool", `/nonexistent${path.delimiter}${bin}`)).toBe(
    path.join(root, "toolchain"),
  );
  expect(confine.toolchainDir("no-such-tool", bin)).toBeNull();
});

/** Each line prints `<read> ok` or `<read> denied`. */
const READS = (r: string): string => {
  const reads: [string, string][] = [
    ["real-config", `cat ${r}/.config/workit/workspaces.json`],
    ["real-home", `ls ${r}`],
    ["host-config", `cat ${r}/.claude.json`],
    ["host-dir", `ls ${r}/.claude`],
    ["real-state", `ls ${r}/.local/state/workit`],
    ["world", 'ls "$(dirname "$PWD")"'],
    ["credential", 'cat "$HOME/.claude/.credentials.json"'],
    ["system", "cat /etc/hostname"],
  ];
  return reads
    .map(
      ([name, cmd]) =>
        `if ( ${cmd} ) >/dev/null 2>&1; then say "${name} ok"; else say "${name} denied"; fi`,
    )
    .join("\n");
};

test.skipIf(!landlock)(
  "Given Landlock, When the host reads the real Workit config, home, state or host config, Then each read is denied; the world, its credential and system files stay readable",
  async () => {
    const lines: string[] = [];
    expect(await main(argv(fakeClaude(READS(home))), (text) => lines.push(text))).toBe(0);
    const transcript = readFileSync(
      path.join(root, "results", "haiku", "a-case.transcript.jsonl"),
      "utf8",
    );
    for (const read of ["real-config", "real-home", "host-config", "host-dir", "real-state"])
      expect(transcript).toContain(`${read} denied`);
    for (const read of ["world", "credential", "system"])
      expect(transcript).toContain(`${read} ok`);
    expect(lines.join("\n")).toMatch(/^read confinement: on$/mu);
  },
  30_000,
);

const RESULT = JSON.stringify({ type: "result", subtype: "success", num_turns: 1 });

const fakeClaude = (body: string): string => {
  const bin = path.join(root, "claude");
  // `say` prints a line as an event: the runner stores nothing that is not one.
  const say = `say() { printf '{"type":"probe","text":"%s"}\\n' "$1"; }`;
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\n${say}\n${body}\nprintf '%s\\n' '${RESULT}'\n`);
  chmodSync(bin, 0o755);
  return bin;
};

const argv = (bin: string): string[] => {
  const cases = path.join(root, "cases");
  mkdirSync(cases, { recursive: true });
  writeFileSync(
    path.join(cases, "a-case.json"),
    JSON.stringify({ id: "a-case", source: "test", tier: "smoke", prompt: "p", allowedTools: [] }),
  );
  mkdirSync(path.join(root, "plugin", "skills"), { recursive: true });
  return [
    "--model",
    "haiku",
    "--force",
    "--bin",
    bin,
    "--plugin-dir",
    path.join(root, "plugin"),
    "--results",
    path.join(root, "results"),
    "--cases-dir",
    cases,
    "--real-home",
    home,
  ];
};

/**
 * Spellings of the real config's path no reader of a command's text decides
 * (a glob, a class, a backslash, ANSI-C quoting, a brace, a path an
 * interpreter builds, a script the host wrote, a symlink): each line prints
 * `<spelling> ok` or `<spelling> denied`. The scrub (privacy.ts) keeps a
 * result on the kernel's word, so the kernel must refuse every one.
 */
const SPELLINGS = (r: string): string => {
  const dir = `${r}/.config/workit`;
  const spellings: [string, string][] = [
    ["glob", `cat ${r}/.config/work?t/workspaces.json`],
    ["class", `cat ${r}/.[c]onfig/workit/workspaces.json`],
    ["backslash", `cat ${r}/\\.config/workit/workspaces\\.json`],
    ["ansi-c", `bash -c "cat \\$'${dir}/workspaces.json'"`],
    ["brace", `bash -c 'cat ${r}/.config/{workit,workit}/workspaces.json'`],
    ["dotdot", `cat ${dir}/../workit/workspaces.json`],
    ["python3", `python3 -c "print(open('${r}'+'/.config/'+'workit/workspaces.json').read())"`],
    ["script", `printf 'cat ${dir}/workspaces.json\\n' > "$W/probe.sh" && sh "$W/probe.sh"`],
    ["symlink", `ln -s ${dir} "$W/link" && cat "$W/link/workspaces.json"`],
    // The same spellings on a world file: they work where the kernel allows the read.
    ["world-glob", `printf w > "$W/note.txt" && cat "$W"/not?.txt`],
    ["world-brace", `bash -c 'cat "$0"/{note,note}.txt' "$W"`],
    [
      "world-python3",
      `python3 -c "import sys; print(open(sys.argv[1]+'/no'+'te.txt').read())" "$W"`,
    ],
  ];
  return [
    'W="$(dirname "$PWD")"',
    ...spellings.map(
      ([name, cmd]) =>
        `if ( ${cmd} ) >/dev/null 2>&1; then say "${name} ok"; else say "${name} denied"; fi`,
    ),
  ].join("\n");
};

test.skipIf(!landlock)(
  "Given Landlock, When the host reads the real Workit config through a spelling no text reader decides, Then the kernel denies each one; the same spellings read a world file",
  async () => {
    const lines: string[] = [];
    expect(await main(argv(fakeClaude(SPELLINGS(home))), (text) => lines.push(text))).toBe(0);
    const transcript = readFileSync(
      path.join(root, "results", "haiku", "a-case.transcript.jsonl"),
      "utf8",
    );
    for (const spelling of [
      "glob",
      "class",
      "backslash",
      "ansi-c",
      "brace",
      "dotdot",
      "python3",
      "script",
      "symlink",
    ])
      expect(transcript).toContain(`${spelling} denied`);
    for (const spelling of ["world-glob", "world-brace", "world-python3"])
      expect(transcript).toContain(`${spelling} ok`);
    expect(lines.join("\n")).toMatch(/^read confinement: on$/mu);
  },
  30_000,
);

// Invented values: no real account id is read into a test.
const FAKE_USER_ID = `${"e".repeat(60)}4567`;
const FAKE_ACCOUNT_UUID = "22222222-aaaa-4bbb-8ccc-ffffffffffff";

test.skipIf(!landlock)(
  "Given Landlock, When a call prints the world's sign-in state without naming it, Then the kernel allows the read and the run fails as private_content naming account id; nothing is written",
  async () => {
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        userID: FAKE_USER_ID,
        oauthAccount: { accountUuid: FAKE_ACCOUNT_UUID, billingType: "stripe_subscription" },
      }),
    );
    // The reproduction's call, run for real inside the world: its result is the file's text.
    const command = `python3 -c "import os;print(open(os.environ['HOME']+'/.claude.json').read())"`;
    const emit = [
      "import json, os",
      "text = open(os.environ['HOME'] + '/.claude.json').read()",
      `call = {'type': 'tool_use', 'id': 't1', 'name': 'Bash', 'input': {'command': ${JSON.stringify(command)}}}`,
      "print(json.dumps({'type': 'assistant', 'message': {'content': [call]}}))",
      "result = {'type': 'tool_result', 'tool_use_id': 't1', 'content': text}",
      "print(json.dumps({'type': 'user', 'message': {'content': [result]}}))",
    ].join("\n");
    const lines: string[] = [];
    const exit = await main(argv(fakeClaude(`python3 - <<'PY'\n${emit}\nPY`)), (text) =>
      lines.push(text),
    );
    const said = lines.join("\n");
    expect(said).toMatch(/^read confinement: on$/mu);
    expect(said).toContain("private_content: ");
    expect(said).toContain("a-case.transcript.jsonl holds account id");
    expect(said).not.toContain(FAKE_USER_ID);
    expect(said).not.toContain(FAKE_ACCOUNT_UUID);
    expect(exit).toBe(1);
    const dir = path.join(root, "results", "haiku");
    expect(
      existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("a-case")) : [],
    ).toEqual([]);
  },
  30_000,
);

/** The R4 shapes: each line prints `<shape> ok` or `<shape> denied`. */
const SHAPES = (r: string): string => {
  const ws = `${r}/.config/workit/workspaces.json`;
  const shapes: [string, string][] = [
    ["redirect", `printf x > ${ws}`],
    ["python3", `python3 -c "open('${ws}', 'w').write('x')"`],
    ["truncate", `truncate -s 0 ${ws}`],
    ["rm", `rm -f ${r}/.config/workit/vcs.json`],
    ["mv-over", `printf x > "$W/x" && mv -f "$W/x" ${ws}`],
    ["create", `printf x > ${r}/.config/workit/new.json`],
    ["hard-link", `printf KEEP > "$W/victim" && ln -f "$W/victim" ${ws}`],
    ["symlink", `ln -sf /etc/hostname ${ws}`],
    ["mkfifo", `mkfifo ${r}/.config/workit/fifo`],
    ["mkdir", `mkdir ${r}/.config/workit/d`],
    ["move-config", `mv ${r}/.config/workit ${r}/.config/workit.aside`],
    ["move-dotconfig", `mv ${r}/.config ${r}/.config.aside`],
    ["setsid", `setsid -w sh -c 'printf x > ${ws}'`],
  ];
  return [
    'W="$(dirname "$PWD")"',
    ...shapes.map(
      ([name, cmd]) =>
        `if ( ${cmd} ) 2>/dev/null; then say "${name} ok"; else say "${name} denied"; fi`,
    ),
    `if ( printf w > "$W/world.txt" ) 2>/dev/null; then say "world ok"; else say "world denied"; fi`,
    `if ( printf token-2 > "$HOME/.claude/.credentials.json" ) 2>/dev/null; then say "credential ok"; else say "credential denied"; fi`,
  ].join("\n");
};

// Decision 2, test 6
test.skipIf(!landlock)(
  "Given Landlock, When the host tries every R4 write shape on the real home, Then each is denied, the home is unchanged and the run is no outside_write; the world and the credential stay writable",
  async () => {
    const credential = path.join(home, ".claude", ".credentials.json");
    // The runner (unconfined) keeps its own tripwire dir under the home's .cache.
    const runner = path.join(home, ".cache");
    const before = listing([credential, runner]);
    const lines: string[] = [];

    const exit = await main(argv(fakeClaude(SHAPES(home))), (text) => lines.push(text));

    const transcript = readFileSync(
      path.join(root, "results", "haiku", "a-case.transcript.jsonl"),
      "utf8",
    );
    for (const shape of [
      "redirect",
      "python3",
      "truncate",
      "rm",
      "mv-over",
      "create",
      "hard-link",
      "symlink",
      "mkfifo",
      "mkdir",
      "move-config",
      "move-dotconfig",
      "setsid",
    ])
      expect(transcript).toContain(`${shape} denied`);
    expect(transcript).toContain("world ok");
    expect(transcript).toContain("credential ok");
    expect(listing([credential, runner])).toEqual(before);
    expect(readFileSync(credential, "utf8")).toBe("token-2");
    expect(exit).toBe(0);
    const stored = JSON.parse(
      readFileSync(path.join(root, "results", "haiku", "a-case.json"), "utf8"),
    );
    expect(stored.outsideWrite).toBeUndefined();
    expect(lines.join("\n")).toContain("write confinement: on");
  },
  30_000,
);
