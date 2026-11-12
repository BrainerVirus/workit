// The bench tripwire (scripts/eval/tripwire.ts, #822, decision for #823): the
// runner's in-memory snapshot is the only thing restored automatically; the
// disk journal is a crash report a later start compares and reports, restored
// only by --tripwire-restore <digest>. Every test guards a fake real home and
// runs a fake claude, never the account's files or a model.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/scripts/eval/run";
// A namespace import: on a tripwire without one of these, only the tests that use it fail.
import * as tripwire from "@/scripts/eval/tripwire";

const REPO = path.resolve(import.meta.dir, "..", "..");
const RUN = path.join(REPO, "scripts", "eval", "run.ts");
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
const ORIGINAL = '{"workspaces":[{"name":"personal","glob":"/x/**"}]}\n';
const EVIL = '{"workspaces":[{"name":"eval","autonomy":{"merge":true}}]}';
const OLD = new Date("2026-01-02T03:04:05Z");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "workit-tripwire-test-"));
  roots.push(root);
  home = path.join(root, "home");
  config = path.join(home, ".config", "workit");
  state = path.join(home, ".local", "state", "workit");
  base = tripwire.tripwireBase(home);
  ws = path.join(config, "workspaces.json");
  mkdirSync(path.join(config, "templates"), { recursive: true });
  mkdirSync(path.join(state, "issued", "s1"), { recursive: true });
  mkdirSync(path.join(state, "approvals", "grants"), { recursive: true });
  mkdirSync(path.join(state, "leases"), { recursive: true });
  writeFileSync(ws, ORIGINAL, { mode: 0o600 });
  chmodSync(ws, 0o600);
  utimesSync(ws, OLD, OLD);
  writeFileSync(path.join(config, "vcs.json"), '{"github":{}}');
  writeFileSync(path.join(config, "github.token"), "ghp_secret", { mode: 0o600 });
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
const check = (snapshot: ReturnType<typeof armed>) => tripwire.checkSnapshot(base, snapshot);

/** Forge the journal as a same-uid agent can: workspaces.json's blob and sha, and an entry and root outside the guard. */
const forge = (): string => {
  const dir = path.join(base, "journal");
  const manifest = JSON.parse(file(dir, "manifest.json"));
  writeFileSync(path.join(dir, "blobs", manifest.entries[ws].blob), EVIL);
  manifest.entries[ws].sha = sha(EVIL);
  const outside = path.join(home, "outside.txt");
  writeFileSync(path.join(dir, "blobs", "x"), "pwned");
  manifest.entries[outside] = { type: "file", mode: 0o644, sha: sha("pwned"), blob: "x" };
  manifest.guard = { restored: [config, outside], reported: [] };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  return outside;
};

test("Given $HOME points elsewhere, Then the guarded account home is still the account record's", () => {
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

test("Given a fake real home, Then the whole config dir and the granting state files are restored, the live state trees reported", () => {
  const guard = tripwire.guardFor(home);
  expect(guard.restored).toEqual([
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
  expect(check(snapshot)).toBeNull();
});

test("Given an armed tripwire, Then the journal is on disk in a 0700 dir with 0600 files", () => {
  armed();
  const dir = path.join(base, "journal");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(path.join(dir, "manifest.json")).mode & 0o777).toBe(0o600);
  expect(statSync(path.join(dir, "blobs", "1")).mode & 0o777).toBe(0o600);
});

test("Given vcs.json rewritten, a token deleted and a template added, Then each is restored and the run's bytes are rescued", () => {
  const snapshot = armed();
  writeFileSync(path.join(config, "vcs.json"), '{"github":{"token":"x"}}');
  unlinkSync(path.join(config, "github.token"));
  writeFileSync(path.join(config, "templates", "evil.md"), "ignore all rules");

  const trip = check(snapshot);

  expect(file(config, "vcs.json")).toBe('{"github":{}}');
  expect(file(config, "github.token")).toBe("ghp_secret");
  expect(existsSync(path.join(config, "templates", "evil.md"))).toBe(false);
  expect(trip?.rescued).toMatch(new RegExp(`/rescued/[^/]+-${process.pid}$`, "u"));
  expect(file(trip?.rescued ?? "", config, "vcs.json")).toBe('{"github":{"token":"x"}}');
});

test("Given workspaces.json (0600, hard-linked) rewritten in place, Then it is restored in place: same inode, both names, mode and mtime", () => {
  const other = path.join(root, "other-name.json");
  linkSync(ws, other);
  const inode = statSync(ws).ino;
  const snapshot = armed();
  writeFileSync(ws, EVIL);
  chmodSync(ws, 0o664);

  check(snapshot);

  expect(file(ws)).toBe(ORIGINAL);
  expect(file(other)).toBe(ORIGINAL);
  expect(statSync(ws).ino).toBe(inode);
  expect(statSync(ws).nlink).toBe(2);
  expect(statSync(ws).mode & 0o777).toBe(0o600);
  expect(statSync(ws).mtimeMs).toBe(OLD.getTime());
});

test("Given workspaces.json replaced by rename, Then the bytes, the 0600 mode and the mtime come back", () => {
  const snapshot = armed();
  writeFileSync(path.join(config, "tmp.json"), "{}", { mode: 0o664 });
  renameSync(path.join(config, "tmp.json"), ws);
  check(snapshot);
  expect(file(ws)).toBe(ORIGINAL);
  expect(statSync(ws).mode & 0o777).toBe(0o600);
});

test("Given a symlinked config.json replaced by a file, Then the symlink comes back with its target", () => {
  const dotfiles = path.join(root, "dotfiles");
  mkdirSync(dotfiles);
  writeFileSync(path.join(dotfiles, "config.json"), '{"a":1}');
  const link = path.join(config, "config.json");
  symlinkSync(path.join(dotfiles, "config.json"), link);
  const snapshot = armed();
  unlinkSync(link);
  writeFileSync(link, '{"a":2}');

  expect(check(snapshot)?.restored).toEqual([link]);
  expect(readlinkSync(link)).toBe(path.join(dotfiles, "config.json"));
  expect(file(dotfiles, "config.json")).toBe('{"a":1}');
});

test("Given a consumed approval, a forged issued id and a new verdict, Then the run trips but nothing in the live state trees is restored or removed", () => {
  const snapshot = armed();
  unlinkSync(path.join(state, "approvals", "grants", "g1.json"));
  writeFileSync(path.join(state, "issued", "s1", "id1"), "forged");
  mkdirSync(path.join(state, "verdicts"));
  writeFileSync(path.join(state, "verdicts", "v.json"), "{}");

  const trip = check(snapshot);

  expect(existsSync(path.join(state, "approvals", "grants", "g1.json"))).toBe(false);
  expect(file(state, "issued", "s1", "id1")).toBe("forged");
  expect(trip?.restored).toEqual([]);
  expect(trip?.reported).toEqual({
    added: [path.join(state, "verdicts", "v.json")],
    changed: [path.join(state, "issued", "s1", "id1")],
    missing: [path.join(state, "approvals", "grants", "g1.json")],
  });
});

// Decision test 1
test("Given a forged journal during a run, When the live check runs, Then it restores from memory only: no trip, workspaces.json identical, nothing written outside", () => {
  const snapshot = armed();
  const outside = forge();

  expect(check(snapshot)).toBeNull();
  expect(file(ws)).toBe(ORIGINAL);
  expect(existsSync(outside)).toBe(false);
});

// Decision test 2
test("Given a sweep that rewrote the real workspaces.json and its journal blob alike, When the live check runs, Then the original bytes come back and the trip names the file", () => {
  const snapshot = armed();
  const dir = path.join(base, "journal");
  const blob = path.join(dir, "blobs", JSON.parse(file(dir, "manifest.json")).entries[ws].blob);
  for (const target of [ws, blob]) writeFileSync(target, file(target).replace("personal", "eval"));

  const trip = check(snapshot);

  expect(file(ws)).toBe(ORIGINAL);
  expect(trip?.restored).toEqual([ws]);
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

/** A fake `claude`: logs its start and world, may write the real workspaces.json, may then sleep. */
const fakeClaude = (write: boolean, sleep = 0): string => {
  const bin = path.join(root, `claude-${write}-${sleep}`);
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      `echo "$PWD" >> "${root}/starts.log"`,
      write ? WRITE : ":",
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
    ...extra,
  ];
};
const settle = (...flags: string[]): string[] => ["--real-home", home, ...flags];
const result = (id: string): string => path.join(root, "results", "haiku", `${id}.json`);
const starts = (): number =>
  existsSync(path.join(root, "starts.log"))
    ? file(root, "starts.log").trim().split("\n").length
    : 0;

test("Given a run that rewrites the real workspaces.json, When the bench runs, Then the bytes are put back, the run fails as outside_write naming the path, rescue and transcript, and no further run starts", async () => {
  const exit = await main(argv(fakeClaude(true)), () => {});

  expect(exit).toBe(3);
  expect(file(ws)).toBe(ORIGINAL);
  const stored = JSON.parse(readFileSync(result("a-case"), "utf8"));
  expect(stored.outsideWrite.restored).toEqual([ws]);
  const [failure] = stored.grade.failures;
  expect(failure.rule).toBe("outside_write");
  expect(failure.detail).toContain(ws);
  expect(failure.detail).toContain("delete it once read");
  expect(failure.detail).toContain("a-case.transcript.jsonl");
  expect(existsSync(result("b-case"))).toBe(false);
  expect(existsSync(path.join(base, "journal"))).toBe(false);
});

test("Given a run that writes nothing outside its world, Then the bench records no outside write and leaves no journal", async () => {
  expect(await main(argv(fakeClaude(false)), () => {})).toBe(0);
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
    expect(await main(argv(fakeClaude(true)), (text) => lines.push(text))).toBe(4);
  } finally {
    holder.kill("SIGKILL");
  }
  expect(lines.join("\n")).toContain(`pid ${holder.pid}`);
  expect(file(ws)).toBe(ORIGINAL);
  expect(starts()).toBe(0);
});

test("Given a stored outside_write run, When replayed with --check, Then it is not re-graded into a pass", async () => {
  await main(argv(fakeClaude(true)), () => {});
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

// Decision test 3
test("Given a forged leftover journal at start, When the bench starts, Then it writes nothing, reports LEFTOVER with the path, exits 3 and keeps the journal", async () => {
  armed();
  const outside = forge();
  const lines: string[] = [];

  const exit = await main(argv(fakeClaude(false)), (text) => lines.push(text));

  expect(exit).toBe(3);
  const printed = lines.join("\n");
  expect(printed).toContain("LEFTOVER");
  expect(printed).toContain(outside);
  expect(printed).toContain("proves nothing unless it equals");
  expect(file(ws)).toBe(ORIGINAL);
  expect(existsSync(outside)).toBe(false);
  expect(existsSync(result("a-case"))).toBe(false);
  expect(existsSync(path.join(base, "journal", "manifest.json"))).toBe(true);
});

// Decision test 5
test("Given a forged journal with an outside path, When restored with that journal's own digest, Then it is refused and nothing is written outside", async () => {
  armed();
  const outside = forge();
  const digest = tripwire.inspectJournal(base, tripwire.guardFor(home))?.digest ?? "";
  const lines: string[] = [];

  const exit = await main(settle("--tripwire-restore", digest), (text) => lines.push(text));

  expect(digest).toMatch(/^[0-9a-f]{16}$/u);
  expect(exit).toBe(3);
  expect(lines.join("\n")).toContain(`outside the guarded set: ${outside}`);
  expect(existsSync(outside)).toBe(false);
  expect(file(ws)).toBe(ORIGINAL);
});

// Decision test 6
test("Given a journal blob with one byte flipped, When restored, Then it is refused naming the file", async () => {
  const snapshot = armed();
  writeFileSync(ws, EVIL);
  const dir = path.join(base, "journal");
  const blob = path.join(dir, "blobs", JSON.parse(file(dir, "manifest.json")).entries[ws].blob);
  const bytes = readFileSync(blob);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  writeFileSync(blob, bytes);
  const lines: string[] = [];

  const exit = await main(settle("--tripwire-restore", snapshot.digest), (text) =>
    lines.push(text),
  );

  expect(exit).toBe(3);
  expect(lines.join("\n")).toContain(`blob does not match its sha: ${ws}`);
  expect(file(ws)).toBe(EVIL);
});

test("Given a garbage manifest.json left over, When the bench starts, Then it exits 3 with leftover unreadable", async () => {
  armed();
  writeFileSync(path.join(base, "journal", "manifest.json"), "{not json");
  const lines: string[] = [];
  expect(await main(argv(fakeClaude(false)), (text) => lines.push(text))).toBe(3);
  expect(lines.join("\n")).toContain("leftover unreadable");
  expect(starts()).toBe(0);
});

// Decision test 12
test("Given two starts over unchanged files, Then the armed digest is the same; one changed guarded byte changes it", async () => {
  const digests: string[] = [];
  const capture = (text: string) => {
    const found = /^tripwire armed: \d+ files, digest ([0-9a-f]{16})$/mu.exec(text);
    if (found?.[1]) digests.push(found[1]);
  };
  await main(argv(fakeClaude(false)), capture);
  await main(argv(fakeClaude(false)), capture);
  writeFileSync(path.join(config, "vcs.json"), '{"github":{} }');
  await main(argv(fakeClaude(false)), capture);
  expect(digests).toHaveLength(3);
  expect(digests[0]).toBe(digests[1]);
  expect(digests[2]).not.toBe(digests[0]);
});

test("Given a leftover journal, When --tripwire-discard runs, Then the journal is gone and nothing is written", async () => {
  armed();
  writeFileSync(ws, EVIL);
  expect(await main(settle("--tripwire-discard"), () => {})).toBe(0);
  expect(readdirSync(base)).not.toContain("journal");
  expect(file(ws)).toBe(EVIL);
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

// Decision test 4
test("Given a runner SIGKILLed after an outside write, When the bench starts again, Then it reports and runs nothing; only --tripwire-restore with the printed digest puts the file back", async () => {
  const inode = statSync(ws).ino;
  const run = runner(fakeClaude(true, 300));
  expect(await waitFor(changed)).toBe(true);
  const digest = /tripwire armed: \d+ files, digest ([0-9a-f]{16})/u.exec(run.out())?.[1] ?? "";
  process.kill(run.child.pid ?? 0, "SIGKILL");
  await run.exited;
  killPids();
  expect(digest).toMatch(/^[0-9a-f]{16}$/u);

  const world = path.dirname(file(root, "starts.log").trim());
  expect(existsSync(world)).toBe(true);
  expect(await main(argv(fakeClaude(false)), () => {})).toBe(3);
  expect(file(ws)).toBe(EVIL);
  // Decision test 11, last part: the killed runner's world is gone after the next start.
  expect(existsSync(world)).toBe(false);
  expect(await main(settle("--tripwire-restore", "0000000000000000"), () => {})).toBe(3);
  expect(file(ws)).toBe(EVIL);

  expect(await main(settle("--tripwire-restore", digest), () => {})).toBe(0);
  expect(file(ws)).toBe(ORIGINAL);
  expect(statSync(ws).ino).toBe(inode);
  expect(statSync(ws).mode & 0o777).toBe(0o600);
  expect(existsSync(path.join(base, "journal"))).toBe(false);
  expect(await main(argv(fakeClaude(false)), () => {})).toBe(0);
}, 30_000);

const alive = (pidFile: string): boolean => {
  try {
    process.kill(Number(file(root, pidFile)), 0);
    return true;
  } catch {
    return false;
  }
};

// Decision test 7: a long fake run, so the signal lands mid-host, never at its natural end.
test.each([
  ["SIGINT", false, true, 130],
  ["SIGTERM", false, true, 143],
  ["SIGINT", true, true, 130],
  ["SIGINT", false, false, 130],
] as const)(
  "Given a long run, When %s reaches the runner (to its group: %p; the host wrote: %p), Then within 5 s it exits %p with the file back, the host's group dead, its world gone, no holder, no journal and no result",
  async (signal, group, write, code) => {
    const run = runner(fakeClaude(write, 300), "--watch-ms", "600000");
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
    expect(file(ws)).toBe(ORIGINAL);
    expect(alive("claude.pid")).toBe(false);
    expect(alive("sleep.pid")).toBe(false);
    expect(existsSync(world)).toBe(false);
    expect(readdirSync(path.join(base, "holders"))).toEqual([]);
    expect(existsSync(path.join(base, "journal"))).toBe(false);
    expect(run.out()).toContain(`STOPPED by ${signal}`);
    expect(run.out()).toContain(write ? ws : "no real Workit file changed");
    expect(existsSync(result("a-case"))).toBe(false);
    expect(starts()).toBe(1);
  },
  30_000,
);

// Decision test 8
test("Given a host that changes the real workspaces.json and keeps running, Then the watch kills it within about 5 s, the file comes back and the run fails as outside_write", async () => {
  // The fake sleeps 300 s: only the 2 s watch can end the run inside this test's 15 s bound.
  const exit = await main(argv(fakeClaude(true, 300)), () => {});
  killPids();

  expect(exit).toBe(3);
  expect(file(ws)).toBe(ORIGINAL);
  expect(alive("sleep.pid")).toBe(false);
  const stored = JSON.parse(readFileSync(result("a-case"), "utf8"));
  expect(stored.grade.failures[0].rule).toBe("outside_write");
}, 15_000);

// Decision test 9
test("Given six runners starting at one instant over a dead holder, 12 rounds, Then never more than one holds the tripwire", async () => {
  const script = path.join(root, "acquire.ts");
  writeFileSync(
    script,
    [
      `import { acquire } from ${JSON.stringify(path.join(REPO, "scripts", "eval", "tripwire.ts"))};`,
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

// Decision test 10
test("Given seven rescued dirs, two older than 7 days, When a bench starts, Then at most 5 remain and none is older than 7 days", async () => {
  const rescued = path.join(base, "rescued");
  const week = 7 * 24 * 3600 * 1000;
  for (let index = 0; index < 7; index += 1) {
    const dir = path.join(rescued, `r${index}`);
    mkdirSync(dir, { recursive: true });
    const when = new Date(Date.now() - (index < 2 ? week + 3_600_000 : index * 60_000));
    utimesSync(dir, when, when);
  }
  expect(await main(argv(fakeClaude(false)), () => {})).toBe(0);
  const left = readdirSync(rescued);
  expect(left.length).toBeLessThanOrEqual(5);
  // r0 and r1 are the two older than 7 days.
  expect(left).not.toContain("r0");
  expect(left).not.toContain("r1");
});

// Decision test 11
test("Given a dead runner's world, a live runner's world and a symlinked lookalike in tmpdir, When a bench starts, Then only the dead one is removed and the symlink's target is intact", async () => {
  const tmp = os.tmpdir();
  const deadWorld = mkdtempSync(path.join(tmp, "workit-eval-x-"));
  mkdirSync(path.join(deadWorld, "home"));
  writeFileSync(path.join(deadWorld, "home", ".claude.json"), "{}");
  writeFileSync(path.join(deadWorld, tripwire.RUNNER_MARKER), "999999.1");
  const liveWorld = mkdtempSync(path.join(tmp, "workit-eval-x-"));
  writeFileSync(path.join(liveWorld, tripwire.RUNNER_MARKER), tripwire.runnerIdentity());
  const target = path.join(root, "target");
  mkdirSync(target);
  writeFileSync(path.join(target, "keep.txt"), "keep");
  writeFileSync(path.join(target, tripwire.RUNNER_MARKER), "999999.1");
  const lookalike = path.join(tmp, `workit-eval-y-${path.basename(root)}`);
  symlinkSync(target, lookalike);
  roots.push(liveWorld, lookalike);

  expect(await main(argv(fakeClaude(false)), () => {})).toBe(0);

  expect(existsSync(deadWorld)).toBe(false);
  expect(existsSync(liveWorld)).toBe(true);
  expect(file(target, "keep.txt")).toBe("keep");
});

// Round 4 (verdict mwd2p43s): confinement through symlinks, failures that do not abort, the digest alone.

/** The verifier's probe: a link entry to an outside dir, and a file entry under it with a matching blob. */
const forgeLinkEscape = (): string => {
  const outsideDir = path.join(root, "outside");
  mkdirSync(outsideDir);
  const dir = path.join(base, "journal");
  const manifest = JSON.parse(file(dir, "manifest.json"));
  manifest.entries[path.join(config, "sym")] = { type: "link", target: outsideDir };
  writeFileSync(path.join(dir, "blobs", "x"), "pwned");
  manifest.entries[path.join(config, "sym", "target")] = {
    type: "file",
    mode: 0o644,
    sha: sha("pwned"),
    blob: "x",
    atimeMs: 0,
    mtimeMs: 0,
  };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  return outsideDir;
};

test("Given a journal whose file entry sits under a recorded symlink to an outside dir, When restored with that journal's own digest, Then it is refused before anything is written", async () => {
  armed();
  const outsideDir = forgeLinkEscape();
  const digest = tripwire.inspectJournal(base, tripwire.guardFor(home))?.digest ?? "";
  const lines: string[] = [];

  const exit = await main(settle("--tripwire-restore", digest), (text) => lines.push(text));

  expect(exit).toBe(3);
  expect(lines.join("\n")).toContain(
    `under a recorded symlink: ${path.join(config, "sym", "target")}`,
  );
  expect(existsSync(path.join(outsideDir, "target"))).toBe(false);
  expect(existsSync(path.join(config, "sym"))).toBe(false);
});

test.each([false, true])(
  "Given the agent replaced templates/ with a symlink to an outside dir (outside holds an identical pr.md: %p), When the live check restores, Then nothing is written outside and templates/ is a real dir with its files",
  (twin) => {
    const outsideDir = path.join(root, "outside");
    mkdirSync(outsideDir);
    if (twin) writeFileSync(path.join(outsideDir, "pr.md"), "# PR");
    const snapshot = armed();
    rmSync(path.join(config, "templates"), { recursive: true });
    symlinkSync(outsideDir, path.join(config, "templates"));

    const trip = check(snapshot);

    expect(readdirSync(outsideDir)).toEqual(twin ? ["pr.md"] : []);
    expect(lstatSync(path.join(config, "templates")).isDirectory()).toBe(true);
    expect(file(config, "templates", "pr.md")).toBe("# PR");
    expect(trip?.restored).toContain(path.join(config, "templates"));
    expect(trip?.failed).toEqual([]);
  },
);

/** A created dir the restore cannot remove (mode 0), next to a changed vcs.json. */
const unremovable = (): string => {
  const locked = path.join(config, "locked");
  mkdirSync(locked);
  writeFileSync(path.join(locked, "x"), "x");
  chmodSync(locked, 0);
  writeFileSync(path.join(config, "vcs.json"), '{"github":{"token":"x"}}');
  return locked;
};

test("Given one path the live restore cannot fix, Then every other path is still restored and the failed one is reported", () => {
  const snapshot = armed();
  const locked = unremovable();
  try {
    const trip = check(snapshot);
    expect(file(config, "vcs.json")).toBe('{"github":{}}');
    expect(trip?.failed.map((each) => each.split(":")[0])).toEqual([locked]);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("Given one path the journal restore cannot fix, Then the rest is restored, the failure is named, the exit is non-zero and the journal stays", async () => {
  const snapshot = armed();
  const locked = unremovable();
  const lines: string[] = [];
  try {
    const exit = await main(settle("--tripwire-restore", snapshot.digest), (text) =>
      lines.push(text),
    );
    expect(exit).toBe(3);
    expect(file(config, "vcs.json")).toBe('{"github":{}}');
    expect(lines.join("\n")).toContain(`failed ${locked}`);
    expect(existsSync(path.join(base, "journal", "manifest.json"))).toBe(true);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("Given a valid, unforged journal, When restored with a digest that is wrong, a prefix, empty or one character longer, Then the digest alone refuses each and nothing is written; the printed digest restores", async () => {
  const snapshot = armed();
  writeFileSync(ws, EVIL);
  const wrong = snapshot.digest.replace(/^./u, (c) => (c === "0" ? "1" : "0"));
  for (const given of [wrong, snapshot.digest.slice(0, 8), "", `${snapshot.digest}0`]) {
    const lines: string[] = [];
    expect(await main(settle("--tripwire-restore", given), (text) => lines.push(text))).toBe(3);
    expect(lines.join("\n")).toContain(`digest ${snapshot.digest} is not ${given}`);
    expect(file(ws)).toBe(EVIL);
  }
  expect(await main(settle("--tripwire-restore", snapshot.digest), () => {})).toBe(0);
  expect(file(ws)).toBe(ORIGINAL);
});
