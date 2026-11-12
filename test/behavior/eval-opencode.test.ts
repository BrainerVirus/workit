// The OpenCode leg of the local weak-model bench (scripts/eval/run.ts
// --host opencode) with a fake `opencode` binary: the plugin pin, the free ->
// go provider fallback, skipped (limit), the result layout and replay. No
// model is called here; docs/agents/eval.md.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { opencodeEnv } from "@/scripts/eval/opencode";
import { main } from "@/scripts/eval/run";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const event = (type: string, part: Record<string, unknown>, at: number) =>
  JSON.stringify({ type, timestamp: at, sessionID: "ses_1", part });

/** `workit check test`, then an answer: what a model that followed Workit does. */
const CLEAN = [
  event("step_start", { type: "step-start" }, 1000),
  event(
    "tool_use",
    {
      id: "call_1",
      type: "tool",
      tool: "shell",
      state: { status: "completed", input: { command: "workit check test" }, output: "passed\n" },
    },
    1500,
  ),
  event("step_finish", { type: "step-finish", reason: "tool-calls", cost: 0 }, 1600),
  event("step_start", { type: "step-start" }, 1700),
  event("text", { type: "text", text: "Tests pass." }, 1800),
  event("step_finish", { type: "step-finish", reason: "stop", cost: 0 }, 1900),
].join("\n");

const LIMIT_EVENT = JSON.stringify({
  type: "error",
  timestamp: 2,
  sessionID: "ses_1",
  // As OpenCode 2.2.7 reported it in the first real smoke run.
  error: {
    type: "provider.free-limit",
    status: 429,
    message: "Free usage limit reached. Connect a provider or subscribe to OpenCode Go.",
  },
});

const SAVED = [
  "WORKIT_SESSION_ID",
  "OPENCODE_SESSION_ID",
  "FAKE_OC_LOG",
  "FAKE_OC_OUT",
  "FAKE_OC_LIMITED",
  "FAKE_OC_CONFIG",
] as const;
const saved = Object.fromEntries(SAVED.map((key) => [key, process.env[key]]));
let root = "";
let argv: string[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "workit-eval-oc-test-"));
  roots.push(root);
  const cases = path.join(root, "cases");
  mkdirSync(cases);
  for (const id of ["a-smoke", "b-smoke"])
    writeFileSync(
      path.join(cases, `${id}.json`),
      JSON.stringify({
        id,
        source: "test",
        tier: "smoke",
        prompt: `do ${id} in {{root}}`,
        scaffold: { branch: "feature/x", checks: { test: ["true"] } },
        maxTurns: 6,
        allowedTools: ["Read", "Bash(workit *)"],
        expect: { configuredCheck: true },
      }),
    );
  mkdirSync(path.join(root, "plugin", "dist"), { recursive: true });
  writeFileSync(path.join(root, "plugin", "dist", "plugin.js"), "export default {};\n");
  const bin = path.join(root, "opencode");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "prompt=$(cat)",
      'model=""; prev=""',
      'for arg in "$@"; do [ "$prev" = "--model" ] && model=$arg; prev=$arg; done',
      'echo "run model=$model session=${WORKIT_SESSION_ID:-none} parent=${OPENCODE_SESSION_ID:-none} claude=${OPENCODE_DISABLE_CLAUDE_CODE:-0} install=$WORKIT_INSTALL_ROOT workit=$(command -v workit) prompt=$prompt args=$*" >> "$FAKE_OC_LOG"',
      'cp "$XDG_CONFIG_HOME/opencode/opencode.json" "$FAKE_OC_CONFIG"',
      'case ",$FAKE_OC_LIMITED," in *",$model,"*)',
      `  printf '%s\\n' '${LIMIT_EVENT}'; exit 1;;`,
      "esac",
      'cat "$FAKE_OC_OUT"',
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  writeFileSync(path.join(root, "out.jsonl"), CLEAN);
  Object.assign(process.env, {
    WORKIT_SESSION_ID: "lead-session",
    OPENCODE_SESSION_ID: "parent-session",
    FAKE_OC_LOG: path.join(root, "calls.log"),
    FAKE_OC_OUT: path.join(root, "out.jsonl"),
    FAKE_OC_LIMITED: "",
    FAKE_OC_CONFIG: path.join(root, "config.json"),
  });
  argv = [
    "--host",
    "opencode",
    "--model",
    "flash",
    "--bin",
    bin,
    "--plugin-dir",
    path.join(root, "plugin"),
    "--results",
    path.join(root, "results"),
    "--cases-dir",
    cases,
    // The tripwire guards, and the login is linked from, a fake real home (#822).
    "--real-home",
    path.join(root, "home"),
  ];
});

afterEach(() => {
  for (const key of SAVED)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});

const calls = (): string[] => {
  const log = path.join(root, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
};
const results = () => path.join(root, "results", "opencode-flash");
const stored = (id: string) => JSON.parse(readFileSync(path.join(results(), `${id}.json`), "utf8"));
const quiet = (lines: string[]) => (text: string) => lines.push(text);

test("Given --host opencode --model flash, When the smoke tier runs, Then each case runs `opencode run` on the free provider with the plugin pinned from the checkout and the same grader passes it", () => {
  const printed: string[] = [];
  expect(main(["--tier", "smoke", ...argv], quiet(printed))).toBe(0);
  const runs = calls();
  expect(runs).toHaveLength(2);
  expect(runs[0]).toMatch(/model=opencode\/flash-free /);
  expect(runs[0]).toContain("run --standalone --format json --auto --archived");
  expect(runs[0]).toContain("session=none parent=none claude=1");
  expect(runs[0]).toMatch(/prompt=do a-smoke in (\/\S+)\/repo /);
  const world = /prompt=do a-smoke in (\/\S+)\/repo /.exec(runs[0] ?? "")?.[1];
  // The plugin would put an installed Workit CLI ahead of this checkout's.
  expect(runs[0]).toContain(`install=${world}/install `);
  expect(runs[0]).toContain(
    `workit=${path.resolve(import.meta.dir, "..", "..", "packages", "workit-claude-code", "bin", "workit")} `,
  );
  const config = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"));
  expect(config.plugins).toEqual([pathToFileURL(path.join(root, "plugin")).href]);
  expect(config.agents).toEqual({ build: { steps: 6 } });
  expect(config.permissions).toEqual([
    { action: "*", resource: "*", effect: "deny" },
    { action: "workit_*", resource: "*", effect: "allow" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "shell", resource: "workit *", effect: "allow" },
  ]);
  const result = stored("a-smoke");
  expect(result).toMatchObject({ host: "opencode", model: "flash", provider: "free" });
  expect(result.grade).toMatchObject({ pass: true, calls: 1, failures: [] });
  expect(result.usage).toEqual({ turns: 2, durationMs: 900, costUsd: 0, stop: "stop" });
  expect(readdirSync(path.join(root, "results"))).toEqual(["opencode-flash"]);
  expect(printed.join("\n")).toContain("pass a-smoke (free) 2 turns $0.000");
});

test("Given the free provider answers with its limit, When a case runs, Then it is retried on the go provider, records provider: go, and later cases go straight to go", () => {
  process.env.FAKE_OC_LIMITED = "opencode/flash-free";
  expect(main(["--tier", "smoke", ...argv], quiet([]))).toBe(0);
  expect(calls().map((run) => /model=(\S+)/.exec(run)?.[1])).toEqual([
    "opencode/flash-free",
    "opencode-go/flash",
    "opencode-go/flash",
  ]);
  for (const id of ["a-smoke", "b-smoke"]) {
    const result = stored(id);
    expect(result.provider).toBe("go");
    expect(result.grade.pass).toBe(true);
    expect(result.limits).toEqual([
      {
        provider: "free",
        error:
          "provider.free-limit 429 Free usage limit reached. Connect a provider or subscribe to OpenCode Go.",
      },
    ]);
  }
  const summary = JSON.parse(readFileSync(path.join(results(), "summary.json"), "utf8"));
  expect(summary.cases.map((row: { provider: string }) => row.provider)).toEqual(["go", "go"]);
});

test("Given both providers are limited, Then the case is recorded skipped (limit), never passed, the summary says so and replay leaves it alone", () => {
  process.env.FAKE_OC_LIMITED = "opencode/flash-free,opencode-go/flash";
  const printed: string[] = [];
  expect(main(["--tier", "smoke", ...argv], quiet(printed))).toBe(1);
  expect(calls()).toHaveLength(2);
  for (const id of ["a-smoke", "b-smoke"]) {
    const result = stored(id);
    expect(result.skipped).toBe("limit");
    expect(result.grade.pass).toBe(false);
    expect(result.provider).toBeUndefined();
    expect(result.limits.map((limit: { provider: string }) => limit.provider)).toEqual([
      "free",
      "go",
    ]);
  }
  const summary = JSON.parse(readFileSync(path.join(results(), "summary.json"), "utf8"));
  expect(summary).toMatchObject({ passed: 0, total: 2, skipped: 2 });
  expect(summary.cases[0]).toMatchObject({ case: "a-smoke", pass: false, skipped: "limit" });
  const text = printed.join("\n");
  expect(text).toContain("skipped (limit) a-smoke\n    free: provider.free-limit 429");
  expect(text).toContain(
    "skipped (limit): 2 case(s) not graded, every provider reported its limit: a-smoke, b-smoke",
  );
  expect(main(["--replay", "--check", ...argv], quiet([]))).toBe(0);
  expect(main(["--replay", ...argv], quiet([]))).toBe(0);
  expect(stored("a-smoke").grade.pass).toBe(false);
  // A skipped case is never a cache hit: the next run tries the providers again.
  process.env.FAKE_OC_LIMITED = "";
  expect(main(["--tier", "smoke", ...argv], quiet([]))).toBe(0);
  expect(stored("a-smoke")).toMatchObject({ provider: "free", grade: { pass: true } });
});

test("Given a provider error that is not a limit, Then the case fails with run-error and is not retried on go", () => {
  writeFileSync(
    process.env.FAKE_OC_OUT ?? "",
    JSON.stringify({
      type: "error",
      timestamp: 1,
      sessionID: "ses_1",
      error: { type: "provider.auth", status: 401, message: "This API key has expired." },
    }),
  );
  const printed: string[] = [];
  expect(main(["--cases", "a-smoke", ...argv], quiet(printed))).toBe(1);
  expect(calls()).toHaveLength(1);
  expect(stored("a-smoke")).toMatchObject({ provider: "free", grade: { pass: false } });
  expect(printed.join("\n")).toContain(
    "run-error: the run stopped on: provider.auth 401 This API key has expired.",
  );
});

test("Given stored OpenCode results, When replayed with --check, Then they re-grade with no model and a changed grade is drift", () => {
  main(["--cases", "a-smoke", ...argv], quiet([]));
  expect(main(["--replay", "--check", ...argv], quiet([]))).toBe(0);
  const file = path.join(results(), "a-smoke.json");
  writeFileSync(file, JSON.stringify({ ...stored("a-smoke"), grade: { pass: false } }));
  const printed: string[] = [];
  expect(main(["--replay", "--check", ...argv], quiet(printed))).toBe(1);
  expect(printed).toContain("drift opencode-flash/a-smoke: fail -> pass");
  expect(calls()).toHaveLength(1);
});

test("Given a parent shell elsewhere, Then the OpenCode child's PWD is the world repo (OpenCode runs its shell there) and no parent OPENCODE_* variable leaks", () => {
  const world = {
    dir: "/w",
    repo: "/w/repo",
    worktree: null,
    state: "/w/state",
    config: "/w/config",
    bin: "/w/bin",
    home: "/w/home",
  };
  const env = opencodeEnv(
    {
      PWD: "/checkout",
      OPENCODE_SESSION_ID: "parent",
      OPENCODE_CONFIG: "/mine.json",
      PATH: "/bin",
    },
    "/w/xdg",
    world,
  );
  expect(env).toEqual({
    PWD: "/w/repo",
    PATH: "/bin",
    WORKIT_INSTALL_ROOT: "/w/install",
    XDG_CONFIG_HOME: "/w/xdg",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  });
});
