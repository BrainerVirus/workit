// The bench tripwire (scripts/eval/tripwire.ts, #822, decision 2 for #823):
// it detects and reports, and never writes, removes or renames anything
// outside its own dir. Every test watches a fake real home and runs a fake
// claude, never the account's files or a model.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/scripts/eval/run";
// A namespace import: on a tripwire without one of these, only the tests that use it fail.
import * as tripwire from "@/scripts/eval/tripwire";

const REPO = path.resolve(import.meta.dir, "..", "..");
/** The marker a bench world carries (scaffold.ts RUNNER_MARKER); a literal so this file loads on older checkouts. */
const RUNNER_MARKER = ".runner";
/** What makes a FIFO here. */
const MKFIFO = "mkfifo";
const RUN = path.join(REPO, "scripts", "eval", "run.ts");
const TRIPWIRE = path.join(REPO, "scripts", "eval", "tripwire.ts");
const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let root = "";
let home = "";
let config = "";
let state = "";
let base = "";
let ws = "";
let token = "";
const ORIGINAL = '{"workspaces":[{"name":"personal","glob":"/x/**"}]}\n';
const EVIL = '{"workspaces":[{"name":"eval","autonomy":{"merge":true}}]}';

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "workit-tripwire-test-"));
  roots.push(root);
  home = path.join(root, "home");
  config = path.join(home, ".config", "workit");
  state = path.join(home, ".local", "state", "workit");
  base = tripwire.tripwireBase(home);
  ws = path.join(config, "workspaces.json");
  token = path.join(config, "github.token");
  mkdirSync(path.join(config, "templates"), { recursive: true });
  mkdirSync(path.join(state, "issued", "s1"), { recursive: true });
  mkdirSync(path.join(state, "approvals", "grants"), { recursive: true });
  mkdirSync(path.join(state, "leases"), { recursive: true });
  writeFileSync(ws, ORIGINAL, { mode: 0o600 });
  chmodSync(ws, 0o600);
  writeFileSync(path.join(config, "vcs.json"), '{"github":{}}');
  writeFileSync(token, "ghp_secret", { mode: 0o600 });
  chmodSync(token, 0o600);
  writeFileSync(path.join(config, "templates", "pr.md"), "# PR");
  writeFileSync(path.join(state, "host-permissions.json"), '{"allow":[]}');
  writeFileSync(path.join(state, "issued", "s1", "id1"), "one");
  writeFileSync(path.join(state, "approvals", "grants", "g1.json"), "{}");
});

const file = (...parts: string[]): string => readFileSync(path.join(...parts), "utf8");
const armed = () => {
  mkdirSync(base, { recursive: true });
  const snapshot = tripwire.armSnapshot(tripwire.guardFor(home));
  tripwire.writeJournal(base, snapshot);
  return snapshot;
};

/** Every path under the fake home but the tripwire dir: kind, inode, mode, size, links, link target, sha. */
const listing = (): string[] => {
  const out: string[] = [];
  const go = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const each = path.join(dir, name);
      if (each === base || each === path.dirname(base)) continue;
      const stat = lstatSync(each);
      let hash = "";
      if (stat.isFile()) {
        const fd = openSync(each, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        hash = fstatSync(fd).isFile()
          ? createHash("sha256").update(readFileSync(fd)).digest("hex")
          : "";
        closeSync(fd);
      }
      const target = stat.isSymbolicLink() ? readlinkSync(each) : "";
      out.push(
        `${each} ${stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : stat.isFIFO() ? "fifo" : "file"} ino=${stat.ino} mode=${stat.mode} size=${stat.size} nlink=${stat.nlink} ${target} ${hash}`,
      );
      if (stat.isDirectory()) go(each);
    }
  };
  go(home);
  return out;
};

test("Given $HOME points elsewhere, Then the watched account home is still the account record's", () => {
  const before = tripwire.accountHome();
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    expect(tripwire.accountHome()).toBe(before);
    expect(tripwire.accountHome()).not.toBe(home);
  } finally {
    process.env.HOME = saved;
  }
});

test("Given a fake real home, Then the whole config dir and the granting state files are watched, the live state trees reported", () => {
  const guard = tripwire.guardFor(home);
  expect(guard.watched).toEqual([
    config,
    path.join(state, "host-permissions.json"),
    path.join(state, "host-permissions-backup"),
    path.join(state, "node.json"),
  ]);
  expect(guard.reported).toEqual(
    ["approvals", "issued", "issued-tokens", "verdicts"].map((name) => path.join(state, name)),
  );
});

test("Given nothing changed (a lease churned), Then check reports no trip", () => {
  const snapshot = armed();
  writeFileSync(path.join(state, "leases", "heavy"), "busy");
  expect(tripwire.checkSnapshot(snapshot)).toBeNull();
});

test("Given an armed tripwire, Then the journal is on disk in a 0700 dir with 0600 files", () => {
  armed();
  const dir = path.join(base, "journal");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(path.join(dir, "manifest.json")).mode & 0o777).toBe(0o600);
  expect(statSync(path.join(dir, "blobs", "1")).mode & 0o777).toBe(0o600);
});

test("Given a consumed approval, a forged issued id and a new verdict, Then the run trips and nothing is changed back", () => {
  const snapshot = armed();
  unlinkSync(path.join(state, "approvals", "grants", "g1.json"));
  writeFileSync(path.join(state, "issued", "s1", "id1"), "forged");
  mkdirSync(path.join(state, "verdicts"));
  writeFileSync(path.join(state, "verdicts", "v.json"), "{}");

  const trip = tripwire.checkSnapshot(snapshot);

  expect(existsSync(path.join(state, "approvals", "grants", "g1.json"))).toBe(false);
  expect(file(state, "issued", "s1", "id1")).toBe("forged");
  expect(trip?.reported).toEqual({
    added: [path.join(state, "verdicts", "v.json")],
    changed: [path.join(state, "issued", "s1", "id1")],
    missing: [path.join(state, "approvals", "grants", "g1.json")],
  });
});

// The runner end to end, with a fake `claude`.
const saved = { FAKE_REAL_HOME: process.env.FAKE_REAL_HOME };
afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const RESULT = JSON.stringify({ type: "result", subtype: "success", num_turns: 1 });
const WRITE = `printf '${EVIL}' > "$FAKE_REAL_HOME/.config/workit/workspaces.json"`;

/** A fake `claude`: logs its start and world, runs `body` (with $R the fake real home), may then sleep. */
const fakeClaude = (body: string, sleep = 0): string => {
  const bin = path.join(
    root,
    `claude-${createHash("sha256")
      .update(body + sleep)
      .digest("hex")
      .slice(0, 8)}`,
  );
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      'R="$FAKE_REAL_HOME"',
      `echo "$PWD" >> "${root}/starts.log"`,
      body,
      sleep > 0
        ? `echo $$ > "${root}/claude.pid"; sleep ${sleep} & echo $! > "${root}/sleep.pid"; wait`
        : ":",
      `printf '%s\\n' '${RESULT}'`,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
};

const argv = (bin: string, ...extra: string[]): string[] => {
  const cases = path.join(root, "cases");
  mkdirSync(cases, { recursive: true });
  for (const id of ["a-case", "b-case"])
    writeFileSync(
      path.join(cases, `${id}.json`),
      JSON.stringify({ id, source: "test", tier: "smoke", prompt: "p", allowedTools: [] }),
    );
  mkdirSync(path.join(root, "plugin", "skills"), { recursive: true });
  process.env.FAKE_REAL_HOME = home;
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
    // These tests prove detection, so the host's writes must get through: Landlock off.
    ...(extra.includes("--confine") ? [] : ["--confine", "off"]),
    ...extra,
  ];
};
const result = (id: string): string => path.join(root, "results", "haiku", `${id}.json`);
const starts = (): number =>
  existsSync(path.join(root, "starts.log"))
    ? file(root, "starts.log").trim().split("\n").length
    : 0;
const bench = async (body: string, ...extra: string[]) => {
  const lines: string[] = [];
  const exit = await main(argv(fakeClaude(body), ...extra), (text) => lines.push(text));
  return { exit, out: lines.join("\n") };
};

// Decision 2, test 1 (the verifier's probe A)
test("Given the host replaced the config root with a symlink to a victim dir, Then the victim's files survive, the root is reported replaced and no command is printed", async () => {
  const victim = path.join(root, "victim");
  mkdirSync(victim);
  writeFileSync(path.join(victim, "a.txt"), "A");
  writeFileSync(path.join(victim, "b.txt"), "B");

  const { exit, out } = await bench(
    `mv "$R/.config/workit" "$R/.config/workit.aside"; ln -s '${victim}' "$R/.config/workit"`,
  );

  expect(exit).toBe(3);
  expect(file(victim, "a.txt")).toBe("A");
  expect(file(victim, "b.txt")).toBe("B");
  expect(out).toContain(`now: symlink to ${victim} (root replaced: not walked)`);
  expect(out).not.toMatch(/\$ (rm|cp|chmod)/u);
});

// Decision 2, test 2 (the verifier's probe B)
test("Given the host replaced workspaces.json with a hard link to a victim file, Then the victim still reads its own bytes, the finding says file, 2 links, and no cp is printed", async () => {
  const victim = path.join(root, "victim.txt");
  writeFileSync(victim, "KEEP");

  const { exit, out } = await bench(
    `rm "$R/.config/workit/workspaces.json"; ln '${victim}' "$R/.config/workit/workspaces.json"`,
  );

  expect(exit).toBe(3);
  expect(file(victim)).toBe("KEEP");
  expect(out).toContain("now: file, 2 links");
  expect(out).not.toContain("cp --");
});

/** One file rewritten, one deleted, one created, a symlink, a FIFO and a dir where a file was. */
const scramble = (): void => {
  writeFileSync(ws, EVIL);
  unlinkSync(path.join(config, "vcs.json"));
  writeFileSync(path.join(config, "new.json"), "{}");
  symlinkSync("/etc/hostname", path.join(config, "link.json"));
  spawnSync(MKFIFO, [path.join(config, "fifo")]);
  unlinkSync(path.join(config, "templates", "pr.md"));
  mkdirSync(path.join(config, "templates", "pr.md"));
};

// Decision 2, test 3: the invariant
test("Given every kind of change, When the check runs, then a start meets the leftover, then --tripwire-discard, Then no path outside the tripwire dir changes at any step", async () => {
  const snapshot = armed();
  scramble();
  const before = listing();

  const trip = tripwire.checkSnapshot(snapshot);
  expect(listing()).toEqual(before);
  expect(trip?.findings.map((finding) => finding.path)).toEqual(
    expect.arrayContaining([
      ws,
      path.join(config, "vcs.json"),
      path.join(config, "new.json"),
      path.join(config, "link.json"),
      path.join(config, "fifo"),
      path.join(config, "templates", "pr.md"),
    ]),
  );

  const lines: string[] = [];
  expect(await main(argv(fakeClaude(":")), (text) => lines.push(text))).toBe(3);
  expect(lines.join("\n")).toContain("LEFTOVER");
  expect(listing()).toEqual(before);
  expect(starts()).toBe(0);

  expect(await main(["--real-home", home, "--tripwire-discard"], () => {})).toBe(0);
  expect(listing()).toEqual(before);
  expect(existsSync(path.join(base, "journal"))).toBe(false);
});

// Decision 2, test 3: a FIFO and a file over 64 MB do not stall the check (bounded by this test's 1 s).
test("Given a FIFO and a 65 MB file at watched paths, When the check runs, Then it returns and names both", () => {
  const snapshot = armed();
  spawnSync(MKFIFO, [path.join(config, "fifo")]);
  truncateSync(ws, 65 * 1024 * 1024);
  const trip = tripwire.checkSnapshot(snapshot);
  expect(trip?.findings.map((finding) => finding.path)).toEqual(
    expect.arrayContaining([ws, path.join(config, "fifo")]),
  );
  expect(trip?.findings.find((finding) => finding.path === ws)?.now).toContain("not hashed");
}, 1000);

// Decision 2, test 4
test("Given the host rewrote the real workspaces.json, Then the bench stops with exit 3 and outside_write, the file keeps the run's bytes, and the printed command puts the original back", async () => {
  const { exit, out } = await bench(WRITE);

  expect(exit).toBe(3);
  expect(file(ws)).toBe(EVIL);
  const stored = JSON.parse(readFileSync(result("a-case"), "utf8"));
  expect(stored.grade.failures[0].rule).toBe("outside_write");
  expect(stored.grade.failures[0].detail).toContain(ws);
  expect(existsSync(result("b-case"))).toBe(false);
  expect(out).toContain(`  ${ws}`);
  expect(out).toMatch(/was: file, mode 600/u);
  expect(out).toMatch(/now: file, 1 link, mode 600/u);
  const blob = /original: (\S+)/u.exec(out)?.[1] ?? "";
  expect(blob.startsWith(path.join(base, "journal", "blobs"))).toBe(true);
  expect(out).toContain(`$ diff -u '${blob}' '${ws}'`);
  const command = /\$ (rm -f -- .*)$/mu.exec(out)?.[1] ?? "";
  expect(command).toContain(`cp -- '${blob}' '${ws}' && chmod 600 '${ws}'`);

  expect(spawnSync("sh", ["-c", command]).status).toBe(0);
  expect(file(ws)).toBe(ORIGINAL);
  expect(statSync(ws).mode & 0o777).toBe(0o600);

  const next: string[] = [];
  expect(await main(argv(fakeClaude(":")), (text) => next.push(text))).toBe(0);
  expect(next.join("\n")).toContain("nothing differs");
  expect(existsSync(path.join(base, "journal"))).toBe(false);
});

// Decision 2, test 5
test("Given --tripwire-restore <digest>, Then it is a usage error and nothing is written", async () => {
  const snapshot = armed();
  writeFileSync(ws, EVIL);
  const before = listing();
  const lines: string[] = [];

  const exit = await main(["--real-home", home, "--tripwire-restore", snapshot.digest], (text) =>
    lines.push(text),
  );

  expect(exit).toBe(2);
  expect(lines.join("\n")).toContain("usage:");
  expect(listing()).toEqual(before);
  expect(file(ws)).toBe(EVIL);
});

// Decision 2, test 10
test("Given the host ran chmod 644 on the real token, Then the finding reads mode 600 to 644 with the chmod 600 command, and the runner changes nothing", async () => {
  const { exit, out } = await bench(`chmod 644 "$R/.config/workit/github.token"`);

  expect(exit).toBe(3);
  expect(statSync(token).mode & 0o777).toBe(0o644);
  expect(out).toMatch(/was: file, mode 600, 10 B/u);
  expect(out).toMatch(/now: file, 1 link, mode 644, 10 B/u);
  expect(out).toContain(`$ chmod 600 '${token}'`);
  expect(out).not.toContain(`diff -u`);
});

test("Given a run that writes nothing outside its world, Then the bench records no outside write and leaves no journal", async () => {
  const { exit } = await bench(":");
  expect(exit).toBe(0);
  expect(JSON.parse(readFileSync(result("a-case"), "utf8")).outsideWrite).toBeUndefined();
  expect(existsSync(path.join(base, "journal"))).toBe(false);
});

test("Given another live bench run holds the tripwire, When the bench starts, Then it refuses with exit 4 and runs nothing", async () => {
  const holder = spawn("sleep", ["5"]);
  await Bun.sleep(50);
  mkdirSync(path.join(base, "holders"), { recursive: true });
  writeFileSync(
    path.join(base, "holders", `${holder.pid}.${tripwire.startOf(Number(holder.pid))}`),
    "",
  );
  const lines: string[] = [];
  try {
    expect(await main(argv(fakeClaude(WRITE)), (text) => lines.push(text))).toBe(4);
  } finally {
    holder.kill("SIGKILL");
  }
  expect(lines.join("\n")).toContain(`pid ${holder.pid}`);
  expect(file(ws)).toBe(ORIGINAL);
  expect(starts()).toBe(0);
});

test("Given a stored outside_write run, When replayed with --check, Then it is not re-graded into a pass", async () => {
  await bench(WRITE);
  const lines: string[] = [];
  const exit = await main(
    [
      "--replay",
      "--check",
      "--results",
      path.join(root, "results"),
      "--cases-dir",
      path.join(root, "cases"),
    ],
    (text) => lines.push(text),
  );
  expect(exit).toBe(0);
  expect(lines.join("\n")).not.toContain("drift haiku/a-case");
});

test("Given a forged leftover journal, When the bench starts, Then it writes nothing, names the problem, prints no command and exits 3", async () => {
  armed();
  const dir = path.join(base, "journal");
  const manifest = JSON.parse(file(dir, "manifest.json"));
  const outside = path.join(home, "outside.txt");
  manifest.entries[outside] = { type: "file", mode: 0o644, sha: "x", blob: "1" };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(ws, EVIL);
  const before = listing();
  const lines: string[] = [];

  expect(await main(argv(fakeClaude(":")), (text) => lines.push(text))).toBe(3);

  const out = lines.join("\n");
  expect(out).toContain(`outside the watched set: ${outside}`);
  expect(out).toContain("proves nothing unless it equals");
  expect(out).not.toMatch(/\$ (rm|cp|chmod)/u);
  expect(listing()).toEqual(before);
});

test("Given a garbage manifest.json left over, When the bench starts, Then it exits 3 with leftover unreadable", async () => {
  armed();
  writeFileSync(path.join(base, "journal", "manifest.json"), "{not json");
  const lines: string[] = [];
  expect(await main(argv(fakeClaude(":")), (text) => lines.push(text))).toBe(3);
  expect(lines.join("\n")).toContain("leftover unreadable");
  expect(starts()).toBe(0);
});

test("Given two starts over unchanged files, Then the armed digest is the same; one changed watched byte changes it", async () => {
  const digests: string[] = [];
  const capture = (text: string) => {
    const found = /^tripwire armed: \d+ files, digest ([0-9a-f]{16})$/mu.exec(text);
    if (found?.[1]) digests.push(found[1]);
  };
  await main(argv(fakeClaude(":")), capture);
  await main(argv(fakeClaude(":")), capture);
  writeFileSync(path.join(config, "vcs.json"), '{"github":{} }');
  await main(argv(fakeClaude(":")), capture);
  expect(digests).toHaveLength(3);
  expect(digests[0]).toBe(digests[1]);
  expect(digests[2]).not.toBe(digests[0]);
});

const waitFor = async (done: () => boolean, ms = 10_000): Promise<boolean> => {
  for (let waited = 0; waited < ms && !done(); waited += 50) await Bun.sleep(50);
  return done();
};

/** The runner as its own process (and process group), its output captured. */
const runner = (bin: string, ...extra: string[]) => {
  const child = spawn(process.execPath, [RUN, ...argv(bin, ...extra)], {
    env: { ...process.env, FAKE_REAL_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let out = "";
  child.stdout?.on("data", (chunk) => (out += String(chunk)));
  child.stderr?.on("data", (chunk) => (out += String(chunk)));
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code, signal) => resolve(code ?? (signal ? -1 : null))),
  );
  return { child, out: () => out, exited };
};
const changed = (): boolean => file(ws) !== ORIGINAL;
const killPids = (): void => {
  for (const pid of ["claude.pid", "sleep.pid"])
    try {
      process.kill(Number(file(root, pid)), "SIGKILL");
    } catch {
      // Already gone.
    }
};
const alive = (pidFile: string): boolean => {
  try {
    process.kill(Number(file(root, pidFile)), 0);
    return true;
  } catch {
    return false;
  }
};

test("Given a runner SIGKILLed after an outside write, When the bench starts again, Then it reports LEFTOVER, runs nothing, writes nothing and removes the dead run's world", async () => {
  const run = runner(fakeClaude(WRITE, 300));
  expect(await waitFor(changed)).toBe(true);
  process.kill(run.child.pid ?? 0, "SIGKILL");
  await run.exited;
  killPids();
  const world = path.dirname(file(root, "starts.log").trim());
  expect(existsSync(world)).toBe(true);
  const before = listing();

  const lines: string[] = [];
  expect(await main(argv(fakeClaude(":")), (text) => lines.push(text))).toBe(3);

  expect(lines.join("\n")).toContain("LEFTOVER");
  expect(lines.join("\n")).toContain(ws);
  expect(listing()).toEqual(before);
  expect(existsSync(world)).toBe(false);
  expect(starts()).toBe(1);
}, 30_000);

// A long fake run, so the signal lands mid-host, never at its natural end.
test.each([
  ["SIGINT", false, true, 130],
  ["SIGTERM", false, true, 143],
  ["SIGINT", true, true, 130],
  ["SIGINT", false, false, 130],
] as const)(
  "Given a long run, When %s reaches the runner (to its group: %p; the host wrote: %p), Then within 5 s it exits %p with the host's group dead, its world gone, no holder and no result; a changed file stays changed with the journal kept",
  async (signal, group, write, code) => {
    const run = runner(fakeClaude(write ? WRITE : ":", 300), "--watch-ms", "600000");
    expect(
      await waitFor(
        () => starts() === 1 && existsSync(path.join(root, "sleep.pid")) && (!write || changed()),
      ),
    ).toBe(true);
    const world = path.dirname(file(root, "starts.log").trim());

    if (group) process.kill(-(run.child.pid ?? 0), signal);
    else run.child.kill(signal);
    const exit = await Promise.race([run.exited, Bun.sleep(5000).then(() => "timeout")]);

    if (exit === "timeout") run.child.kill("SIGKILL");
    killPids();
    expect(exit).toBe(code);
    expect(file(ws)).toBe(write ? EVIL : ORIGINAL);
    expect(alive("claude.pid")).toBe(false);
    expect(alive("sleep.pid")).toBe(false);
    expect(existsSync(world)).toBe(false);
    expect(readdirSync(path.join(base, "holders"))).toEqual([]);
    expect(existsSync(path.join(base, "journal"))).toBe(write);
    expect(run.out()).toContain(`STOPPED by ${signal}`);
    expect(run.out()).toContain(write ? ws : "no real Workit file changed");
    expect(existsSync(result("a-case"))).toBe(false);
    expect(starts()).toBe(1);
  },
  30_000,
);

test("Given a host that changes the real workspaces.json and keeps running, Then the watch kills it and the run fails as outside_write", async () => {
  // The fake sleeps 300 s: only the 2 s watch can end the run inside this test's 15 s bound.
  const exit = await main(argv(fakeClaude(WRITE, 300)), () => {});
  killPids();

  expect(exit).toBe(3);
  expect(file(ws)).toBe(EVIL);
  expect(alive("sleep.pid")).toBe(false);
  const stored = JSON.parse(readFileSync(result("a-case"), "utf8"));
  expect(stored.grade.failures[0].rule).toBe("outside_write");
}, 15_000);

test("Given six runners starting at one instant over a dead holder, 12 rounds, Then never more than one holds the tripwire", async () => {
  const script = path.join(root, "acquire.ts");
  writeFileSync(
    script,
    [
      `import { acquire } from ${JSON.stringify(TRIPWIRE)};`,
      "const [dir, at] = [process.argv[2] ?? '', Number(process.argv[3])];",
      "while (Date.now() < at) {}",
      "console.log(acquire(dir) === null ? 'HELD' : 'refused');",
      "await Bun.sleep(1500);",
      "",
    ].join("\n"),
  );
  for (let round = 0; round < 12; round += 1) {
    const dir = path.join(root, `lock-${round}`);
    mkdirSync(path.join(dir, "holders"), { recursive: true });
    writeFileSync(path.join(dir, "holders", "999999.1"), "");
    const at = Date.now() + 700;
    const outs = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<string>((resolve) => {
            const child = spawn(process.execPath, [script, dir, String(at)], {
              stdio: ["ignore", "pipe", "ignore"],
            });
            let out = "";
            child.stdout?.on("data", (chunk) => (out += String(chunk)));
            child.on("close", () => resolve(out.trim()));
          }),
      ),
    );
    expect(outs.filter((out) => out === "HELD").length).toBeLessThanOrEqual(1);
  }
}, 120_000);

test("Given a holder entry naming this live pid with a wrong start time, Then acquire takes the tripwire over", () => {
  mkdirSync(path.join(base, "holders"), { recursive: true });
  writeFileSync(path.join(base, "holders", `${process.pid}.wrong-start`), "");
  expect(tripwire.acquire(base)).toBeNull();
  expect(readdirSync(path.join(base, "holders"))).toEqual([tripwire.runnerIdentity()]);
  tripwire.release(base);
});

test("Given a dead runner's world, a live runner's world and a symlinked lookalike in tmpdir, When a bench starts, Then only the dead one is removed and the symlink's target is intact", async () => {
  const tmp = os.tmpdir();
  const deadWorld = mkdtempSync(path.join(tmp, "workit-eval-x-"));
  mkdirSync(path.join(deadWorld, "home"));
  writeFileSync(path.join(deadWorld, "home", ".claude.json"), "{}");
  writeFileSync(path.join(deadWorld, RUNNER_MARKER), "999999.1");
  const liveWorld = mkdtempSync(path.join(tmp, "workit-eval-x-"));
  writeFileSync(path.join(liveWorld, RUNNER_MARKER), tripwire.runnerIdentity());
  const target = path.join(root, "target");
  mkdirSync(target);
  writeFileSync(path.join(target, "keep.txt"), "keep");
  writeFileSync(path.join(target, RUNNER_MARKER), "999999.1");
  const lookalike = path.join(tmp, `workit-eval-y-${path.basename(root)}`);
  symlinkSync(target, lookalike);
  roots.push(liveWorld, lookalike);

  expect(await main(argv(fakeClaude(":")), () => {})).toBe(0);

  expect(existsSync(deadWorld)).toBe(false);
  expect(existsSync(liveWorld)).toBe(true);
  expect(file(target, "keep.txt")).toBe("keep");
});

// Repo guard: the tripwire writes only its own dir, in these functions, by name.
test("Given scripts/eval/tripwire.ts, Then write-type fs calls appear only in the functions that write the tripwire dir, and it imports nothing else that could write", () => {
  const source = readFileSync(TRIPWIRE, "utf8");
  const allowed = new Set(["ensureBase", "acquire", "release", "writeJournal", "dropJournal"]);
  const declarations = [...source.matchAll(/^(?:export )?const (\w+)/gmu)].map((match) => ({
    name: match[1] ?? "",
    at: match.index ?? 0,
  }));
  const owner = (at: number): string =>
    declarations.findLast((each) => each.at <= at)?.name ?? "<top level>";
  const writes = [
    /\b(?:writeFileSync|writeSync|appendFileSync|renameSync|rmSync|rmdirSync|unlinkSync|chmodSync|fchmodSync|lchmodSync|chownSync|fchownSync|lchownSync|utimesSync|futimesSync|lutimesSync|truncateSync|ftruncateSync|mkdirSync|mkdtempSync|symlinkSync|linkSync|copyFileSync|cpSync|writeFile|appendFile|rename|rm|rmdir|unlink|chmod|chown|utimes|truncate|mkdir|mkdtemp|symlink|link|copyFile|cp|createWriteStream)\s*\(/gu,
    /\bopenSync\([^)]*(?:"[wa]|"r\+|O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND)/gu,
  ];
  const offenders = writes
    .flatMap((pattern) => [...source.matchAll(pattern)])
    .map((match) => `${owner(match.index ?? 0)}: ${match[0]}`)
    .filter((hit) => !allowed.has(hit.slice(0, hit.indexOf(":"))));
  expect(offenders).toEqual([]);

  const imports = [...source.matchAll(/^import (.+?) from "([^"]+)";$/gmsu)].map(
    (match) => `${match[2]} ${(match[1] ?? "").replaceAll(/\s+/gu, " ")}`,
  );
  for (const each of imports)
    expect(
      each.startsWith("node:") ||
        each === "../../packages/workit-core/src/core/workit-paths.mjs { workitDir }",
    ).toBe(true);
});
