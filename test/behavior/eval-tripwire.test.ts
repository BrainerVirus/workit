// The bench tripwire (scripts/eval/tripwire.ts, #822): a run that changes the
// real Workit config or state is put back byte for byte and fails as
// outside_write. Every test guards a fake real home, never the account's.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/scripts/eval/run";
import { accountHome, guardFor, restore, snapshot } from "@/scripts/eval/tripwire";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let root = "";
let home = "";
let config = "";
let state = "";
const ORIGINAL = '{"workspaces":[{"name":"personal","glob":"/x/**"}]}\n';

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "workit-tripwire-test-"));
  roots.push(root);
  home = path.join(root, "home");
  config = path.join(home, ".config", "workit");
  state = path.join(home, ".local", "state", "workit");
  mkdirSync(config, { recursive: true });
  mkdirSync(path.join(state, "issued", "s1"), { recursive: true });
  writeFileSync(path.join(config, "workspaces.json"), ORIGINAL);
  writeFileSync(path.join(state, "issued", "s1", "id1"), "one");
});

test("Given a fake real home, Then the guard names its config files and state trees, nothing of the account's", () => {
  const guard = guardFor(home);
  expect(guard.files).toContain(path.join(config, "workspaces.json"));
  expect(guard.trees).toEqual([
    path.join(state, "approvals"),
    path.join(state, "issued"),
    path.join(state, "issued-tokens"),
  ]);
  for (const file of [...guard.files, ...guard.trees]) expect(file.startsWith(home)).toBe(true);
});

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

test("Given nothing changed, Then restore reports no trip", () => {
  const guard = guardFor(home);
  expect(restore(guard, snapshot(guard))).toBeNull();
});

test("Given a rewritten workspaces.json, a created config.json, an edited and a new state file, Then each is restored or reported", () => {
  const guard = guardFor(home);
  const before = snapshot(guard);
  writeFileSync(path.join(config, "workspaces.json"), '{"workspaces":[{"name":"eval"}]}');
  writeFileSync(path.join(config, "config.json"), "{}");
  writeFileSync(path.join(state, "issued", "s1", "id1"), "forged");
  mkdirSync(path.join(state, "approvals", "grants"), { recursive: true });
  writeFileSync(path.join(state, "approvals", "grants", "g1.json"), "{}");

  const trip = restore(guard, before);

  expect(readFileSync(path.join(config, "workspaces.json"), "utf8")).toBe(ORIGINAL);
  expect(existsSync(path.join(config, "config.json"))).toBe(false);
  expect(readFileSync(path.join(state, "issued", "s1", "id1"), "utf8")).toBe("one");
  expect(trip?.restored.toSorted()).toEqual(
    [
      path.join(config, "workspaces.json"),
      path.join(config, "config.json"),
      path.join(state, "issued", "s1", "id1"),
    ].toSorted(),
  );
  expect(trip?.added).toEqual([path.join(state, "approvals", "grants", "g1.json")]);
});

const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, FAKE_REAL_HOME: undefined };
afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const RESULT = JSON.stringify({ type: "result", subtype: "success", num_turns: 1 });

/** A fake `claude` that, like the #822 run, rewrites workspaces.json by absolute path. */
const fakeClaude = (dir: string, write: boolean): string => {
  const bin = path.join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      write
        ? `printf '{"workspaces":[{"name":"eval","autonomy":{"merge":true}}]}' > "$FAKE_REAL_HOME/.config/workit/workspaces.json"`
        : ":",
      `printf '%s\\n' '${RESULT}'`,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
};

const runBench = (write: boolean, lines: string[]): number => {
  const cases = path.join(root, "cases");
  mkdirSync(cases, { recursive: true });
  for (const id of ["a-case", "b-case"])
    writeFileSync(
      path.join(cases, `${id}.json`),
      JSON.stringify({ id, source: "test", tier: "smoke", prompt: "p", allowedTools: [] }),
    );
  mkdirSync(path.join(root, "plugin", "skills"), { recursive: true });
  process.env.FAKE_REAL_HOME = home;
  return main(
    [
      "--model",
      "haiku",
      "--bin",
      fakeClaude(root, write),
      "--plugin-dir",
      path.join(root, "plugin"),
      "--results",
      path.join(root, "results"),
      "--cases-dir",
      cases,
      "--real-home",
      home,
    ],
    (text) => lines.push(text),
  );
};

test("Given a run that rewrites the real workspaces.json, When the bench runs, Then the bytes are put back, the run fails as outside_write naming the path and transcript, and no further run starts", () => {
  const lines: string[] = [];
  const exit = runBench(true, lines);

  expect(exit).toBe(3);
  expect(readFileSync(path.join(config, "workspaces.json"), "utf8")).toBe(ORIGINAL);
  const stored = JSON.parse(
    readFileSync(path.join(root, "results", "haiku", "a-case.json"), "utf8"),
  );
  expect(stored.grade.pass).toBe(false);
  expect(stored.outsideWrite.restored).toEqual([path.join(config, "workspaces.json")]);
  const [failure] = stored.grade.failures;
  expect(failure.rule).toBe("outside_write");
  expect(failure.detail).toContain(path.join(config, "workspaces.json"));
  expect(failure.detail).toContain("a-case.transcript.jsonl");
  expect(existsSync(path.join(root, "results", "haiku", "b-case.json"))).toBe(false);
  expect(lines.join("\n")).toContain("STOPPED: a-case");
});

test("Given a run that writes nothing outside its world, Then the bench records no outside write", () => {
  const exit = runBench(false, []);
  const stored = JSON.parse(
    readFileSync(path.join(root, "results", "haiku", "a-case.json"), "utf8"),
  );
  expect(exit).toBe(0);
  expect(stored.outsideWrite).toBeUndefined();
  expect(readFileSync(path.join(config, "workspaces.json"), "utf8")).toBe(ORIGINAL);
});

test("Given a stored outside_write run, When replayed with --check, Then it is not re-graded into a pass", () => {
  runBench(true, []);
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
