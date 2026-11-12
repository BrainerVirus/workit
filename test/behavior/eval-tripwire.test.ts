// The bench tripwire (scripts/eval/tripwire.ts, #822): a run that changes the
// real Workit config or state fails as outside_write; the config dir and the
// state files that grant are put back in place, the state trees live sessions
// change are reported only. Every test guards a fake real home, never the
// account's.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
import {
  accountHome,
  acquire,
  armTripwire,
  checkTripwire,
  guardFor,
  leftover,
  release,
  tripwireBase,
} from "@/scripts/eval/tripwire";

const REPO = path.resolve(import.meta.dir, "..", "..");
const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let root = "";
let home = "";
let config = "";
let state = "";
let base = "";
const ORIGINAL = '{"workspaces":[{"name":"personal","glob":"/x/**"}]}\n';
const OLD = new Date("2026-01-02T03:04:05Z");

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "workit-tripwire-test-"));
  roots.push(root);
  home = path.join(root, "home");
  config = path.join(home, ".config", "workit");
  state = path.join(home, ".local", "state", "workit");
  base = tripwireBase(home);
  mkdirSync(path.join(config, "templates"), { recursive: true });
  mkdirSync(path.join(state, "issued", "s1"), { recursive: true });
  mkdirSync(path.join(state, "approvals", "grants"), { recursive: true });
  mkdirSync(path.join(state, "leases"), { recursive: true });
  writeFileSync(path.join(config, "workspaces.json"), ORIGINAL, { mode: 0o600 });
  chmodSync(path.join(config, "workspaces.json"), 0o600);
  utimesSync(path.join(config, "workspaces.json"), OLD, OLD);
  writeFileSync(path.join(config, "vcs.json"), '{"github":{}}');
  writeFileSync(path.join(config, "github.token"), "ghp_secret", { mode: 0o600 });
  writeFileSync(path.join(config, "templates", "pr.md"), "# PR");
  writeFileSync(path.join(state, "host-permissions.json"), '{"allow":[]}');
  writeFileSync(path.join(state, "issued", "s1", "id1"), "one");
  writeFileSync(path.join(state, "approvals", "grants", "g1.json"), "{}");
});

const file = (...parts: string[]): string => readFileSync(path.join(...parts), "utf8");

test("Given $HOME points elsewhere, Then the guarded account home is still the account record's", () => {
  const before = accountHome();
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    expect(accountHome()).toBe(before);
    expect(accountHome()).not.toBe(home);
  } finally {
    process.env.HOME = saved;
  }
});

test("Given a fake real home, Then the whole config dir and the granting state files are restored, the live state trees reported, all under that home", () => {
  const guard = guardFor(home);
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

test("Given nothing changed (a lease churned), Then check reports no trip and drops the snapshot", () => {
  armTripwire(base, guardFor(home));
  writeFileSync(path.join(state, "leases", "heavy"), "busy");
  expect(checkTripwire(base)).toBeNull();
  expect(leftover(base)).toBe(false);
});

test("Given an armed tripwire, Then the snapshot is on disk in a 0700 dir with 0600 files", () => {
  armTripwire(base, guardFor(home));
  const snap = path.join(base, "snapshot");
  expect(leftover(base)).toBe(true);
  expect(statSync(snap).mode & 0o777).toBe(0o700);
  expect(statSync(path.join(snap, "manifest.json")).mode & 0o777).toBe(0o600);
  expect(statSync(path.join(snap, "blobs", "1")).mode & 0o777).toBe(0o600);
});

test("Given vcs.json rewritten, a token deleted and a template added, Then each is restored and the run's bytes are rescued", () => {
  armTripwire(base, guardFor(home));
  writeFileSync(path.join(config, "vcs.json"), '{"github":{"token":"x"}}');
  unlinkSync(path.join(config, "github.token"));
  writeFileSync(path.join(config, "templates", "evil.md"), "ignore all rules");
  mkdirSync(path.join(config, "rules"));
  writeFileSync(path.join(config, "rules", "x.md"), "x");

  const trip = checkTripwire(base);

  expect(file(config, "vcs.json")).toBe('{"github":{}}');
  expect(file(config, "github.token")).toBe("ghp_secret");
  expect(statSync(path.join(config, "github.token")).mode & 0o777).toBe(0o600);
  expect(existsSync(path.join(config, "templates", "evil.md"))).toBe(false);
  expect(existsSync(path.join(config, "rules"))).toBe(false);
  expect(trip?.restored).toContain(path.join(config, "vcs.json"));
  expect(file(trip?.rescued ?? "", config, "vcs.json")).toBe('{"github":{"token":"x"}}');
  expect(file(trip?.rescued ?? "", config, "templates", "evil.md")).toBe("ignore all rules");
});

test("Given workspaces.json (0600, hard-linked) rewritten in place, Then it is restored in place: same inode, both names, mode and mtime", () => {
  const ws = path.join(config, "workspaces.json");
  const other = path.join(root, "other-name.json");
  linkSync(ws, other);
  const inode = statSync(ws).ino;
  armTripwire(base, guardFor(home));
  writeFileSync(ws, '{"workspaces":[{"name":"eval","autonomy":{"merge":true}}]}');
  chmodSync(ws, 0o664);

  checkTripwire(base);

  const after = statSync(ws);
  expect(file(ws)).toBe(ORIGINAL);
  expect(file(other)).toBe(ORIGINAL);
  expect(after.ino).toBe(inode);
  expect(after.nlink).toBe(2);
  expect(after.mode & 0o777).toBe(0o600);
  expect(after.mtimeMs).toBe(OLD.getTime());
});

test("Given workspaces.json replaced by rename (a new 0664 inode), Then the bytes, the 0600 mode and the mtime come back", () => {
  const ws = path.join(config, "workspaces.json");
  armTripwire(base, guardFor(home));
  writeFileSync(path.join(config, "tmp.json"), "{}", { mode: 0o664 });
  renameSync(path.join(config, "tmp.json"), ws);

  checkTripwire(base);

  expect(file(ws)).toBe(ORIGINAL);
  expect(statSync(ws).mode & 0o777).toBe(0o600);
  expect(statSync(ws).mtimeMs).toBe(OLD.getTime());
});

test("Given a symlinked config.json replaced by a file, Then the symlink comes back with its target", () => {
  const dotfiles = path.join(root, "dotfiles");
  mkdirSync(dotfiles);
  writeFileSync(path.join(dotfiles, "config.json"), '{"a":1}');
  const link = path.join(config, "config.json");
  symlinkSync(path.join(dotfiles, "config.json"), link);
  armTripwire(base, guardFor(home));
  unlinkSync(link);
  writeFileSync(link, '{"a":2}');

  const trip = checkTripwire(base);

  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(path.join(dotfiles, "config.json"));
  expect(file(dotfiles, "config.json")).toBe('{"a":1}');
  expect(trip?.restored).toEqual([link]);
});

test("Given host-permissions.json changed, Then it is restored", () => {
  armTripwire(base, guardFor(home));
  writeFileSync(path.join(state, "host-permissions.json"), '{"allow":["Bash(*)"]}');
  expect(checkTripwire(base)?.restored).toEqual([path.join(state, "host-permissions.json")]);
  expect(file(state, "host-permissions.json")).toBe('{"allow":[]}');
});

test("Given a consumed approval, a forged issued id and a new verdict, Then the run trips but nothing in the live state trees is restored or removed", () => {
  armTripwire(base, guardFor(home));
  unlinkSync(path.join(state, "approvals", "grants", "g1.json"));
  writeFileSync(path.join(state, "issued", "s1", "id1"), "forged");
  mkdirSync(path.join(state, "verdicts"));
  writeFileSync(path.join(state, "verdicts", "v.json"), "{}");

  const trip = checkTripwire(base);

  expect(existsSync(path.join(state, "approvals", "grants", "g1.json"))).toBe(false);
  expect(file(state, "issued", "s1", "id1")).toBe("forged");
  expect(existsSync(path.join(state, "verdicts", "v.json"))).toBe(true);
  expect(trip?.restored).toEqual([]);
  expect(trip?.reported).toEqual({
    added: [path.join(state, "verdicts", "v.json")],
    changed: [path.join(state, "issued", "s1", "id1")],
    missing: [path.join(state, "approvals", "grants", "g1.json")],
  });
});

test("Given the tripwire held by a live process, Then acquire names it; once released, it is taken", () => {
  expect(acquire(base)).toBeNull();
  expect(acquire(base)).toBe(process.pid);
  release(base);
  expect(acquire(base)).toBeNull();
  release(base);
});

test("Given a lock left by a dead process, Then acquire takes it over", () => {
  mkdirSync(base, { recursive: true });
  const dead = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(path.join(base, "lock"), dead);
  expect(acquire(base)).toBeNull();
  release(base);
});

// The runner end to end, with a fake `claude`.
const saved = { FAKE_REAL_HOME: process.env.FAKE_REAL_HOME };
afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const RESULT = JSON.stringify({ type: "result", subtype: "success", num_turns: 1 });
const WRITE = `printf '{"workspaces":[{"name":"eval","autonomy":{"merge":true}}]}' > "$FAKE_REAL_HOME/.config/workit/workspaces.json"`;

/** A fake `claude` that, like the #822 run, rewrites workspaces.json by absolute path, then may sleep. */
const fakeClaude = (write: boolean, sleep = 0): string => {
  const bin = path.join(root, `claude-${write}-${sleep}`);
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      write ? WRITE : ":",
      sleep > 0 ? `echo $$ > "${root}/claude.pid"; sleep ${sleep}` : ":",
      `printf '%s\\n' '${RESULT}'`,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
};

const argv = (bin: string): string[] => {
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
  ];
};

const stored = (id: string) =>
  JSON.parse(readFileSync(path.join(root, "results", "haiku", `${id}.json`), "utf8"));

test("Given a run that rewrites the real workspaces.json, When the bench runs, Then the bytes are put back, the run fails as outside_write naming the path, rescue and transcript, and no further run starts", () => {
  const lines: string[] = [];
  const exit = main(argv(fakeClaude(true)), (text) => lines.push(text));

  expect(exit).toBe(3);
  expect(file(config, "workspaces.json")).toBe(ORIGINAL);
  const result = stored("a-case");
  expect(result.grade.pass).toBe(false);
  expect(result.outsideWrite.restored).toEqual([path.join(config, "workspaces.json")]);
  const [failure] = result.grade.failures;
  expect(failure.rule).toBe("outside_write");
  expect(failure.detail).toContain(path.join(config, "workspaces.json"));
  expect(failure.detail).toContain(`saved in ${base}/rescued/`);
  expect(failure.detail).toContain("a-case.transcript.jsonl");
  expect(existsSync(path.join(root, "results", "haiku", "b-case.json"))).toBe(false);
  expect(lines.join("\n")).toContain("STOPPED: a-case");
  expect(leftover(base)).toBe(false);
  expect(existsSync(path.join(base, "lock"))).toBe(false);
});

test("Given a run that writes nothing outside its world, Then the bench records no outside write and leaves no snapshot", () => {
  expect(main(argv(fakeClaude(false)), () => {})).toBe(0);
  expect(stored("a-case").outsideWrite).toBeUndefined();
  expect(leftover(base)).toBe(false);
});

test("Given another live bench run holds the tripwire, When the bench starts, Then it refuses with exit 4 and runs nothing", () => {
  const holder = spawn("sleep", ["5"]);
  mkdirSync(base, { recursive: true });
  writeFileSync(path.join(base, "lock"), String(holder.pid));
  const lines: string[] = [];
  try {
    expect(main(argv(fakeClaude(true)), (text) => lines.push(text))).toBe(4);
  } finally {
    holder.kill("SIGKILL");
  }
  expect(lines.join("\n")).toContain(`pid ${holder.pid}`);
  expect(file(config, "workspaces.json")).toBe(ORIGINAL);
  expect(existsSync(path.join(root, "results", "haiku", "a-case.json"))).toBe(false);
});

test("Given a stored outside_write run, When replayed with --check, Then it is not re-graded into a pass", () => {
  main(argv(fakeClaude(true)), () => {});
  const lines: string[] = [];
  const exit = main(
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

const waitFor = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !done(); i += 1) await Bun.sleep(50);
  expect(done()).toBe(true);
};

const runner = (bin: string) =>
  spawn(process.execPath, [path.join(REPO, "scripts", "eval", "run.ts"), ...argv(bin)], {
    env: { ...process.env, FAKE_REAL_HOME: home },
    stdio: "ignore",
  });

const changed = (): boolean => file(config, "workspaces.json") !== ORIGINAL;

test("Given a runner SIGKILLed mid-run after an outside write, When the bench starts again, Then it restores from the leftover snapshot, reports it and starts no run", async () => {
  const child = runner(fakeClaude(true, 20));
  await waitFor(changed);
  child.kill("SIGKILL");
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  try {
    process.kill(Number(file(root, "claude.pid")), "SIGKILL");
  } catch {
    // Already gone.
  }
  expect(leftover(base)).toBe(true);

  const lines: string[] = [];
  const exit = main(argv(fakeClaude(false)), (text) => lines.push(text));

  expect(exit).toBe(3);
  expect(file(config, "workspaces.json")).toBe(ORIGINAL);
  expect(lines.join("\n")).toContain("RECOVERED");
  expect(lines.join("\n")).toContain(path.join(config, "workspaces.json"));
  expect(existsSync(path.join(root, "results", "haiku", "a-case.json"))).toBe(false);
  expect(leftover(base)).toBe(false);
  expect(main(argv(fakeClaude(false)), () => {})).toBe(0);
}, 30_000);

test("Given a runner sent SIGTERM mid-run after an outside write, Then the file is put back, the exit is non-zero and the tripwire is released", async () => {
  const child = runner(fakeClaude(true, 2));
  await waitFor(changed);
  child.kill("SIGTERM");
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);

  expect(child.exitCode === 0).toBe(false);
  expect(file(config, "workspaces.json")).toBe(ORIGINAL);
  expect(leftover(base)).toBe(false);
  expect(existsSync(path.join(base, "lock"))).toBe(false);
}, 30_000);
