// The local weak-model bench runner (scripts/eval/run.ts) with a fake
// `claude` binary: budget, cache, result layout, isolation and replay. No
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
import { main } from "@/scripts/eval/run";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const CLEAN = [
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "workit check test" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content: "passed", is_error: false }],
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    num_turns: 2,
    duration_ms: 1000,
    total_cost_usd: 0.01,
  }),
].join("\n");

const SAVED = [
  "ANTHROPIC_API_KEY",
  "WORKIT_SESSION_ID",
  "FAKE_CLAUDE_LOG",
  "FAKE_CLAUDE_OUT",
] as const;
const saved = Object.fromEntries(SAVED.map((key) => [key, process.env[key]]));
let root = "";
let log = "";
let argv: string[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "workit-eval-test-"));
  roots.push(root);
  const cases = path.join(root, "cases");
  mkdirSync(cases);
  for (const [id, tier] of [
    ["a-smoke", "smoke"],
    ["b-smoke", "smoke"],
    ["c-smoke", "smoke"],
    ["d-full", "full"],
  ])
    writeFileSync(
      path.join(cases, `${id}.json`),
      JSON.stringify({
        id,
        source: "test",
        tier,
        prompt: `do ${id} in {{root}}`,
        scaffold: { branch: "feature/x" },
      }),
    );
  mkdirSync(path.join(root, "plugin", "skills"), { recursive: true });
  const bin = path.join(root, "claude");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "prompt=$(cat)",
      'echo "run cwd=$PWD key=${ANTHROPIC_API_KEY:-none} session=${WORKIT_SESSION_ID:-none} prompt=$prompt args=$*" >> "$FAKE_CLAUDE_LOG"',
      `printf '{"type":"system","subtype":"init","cwd":"%s","memory":"%s","owner":"%s"}\\n' "$PWD" "$(pwd | tr -c '[:alnum:]_\\n' -)" "$(id -un)"`,
      'cat "$FAKE_CLAUDE_OUT"',
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  log = path.join(root, "calls.log");
  writeFileSync(path.join(root, "out.jsonl"), CLEAN);
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
    WORKIT_SESSION_ID: "lead-session",
    FAKE_CLAUDE_LOG: log,
    FAKE_CLAUDE_OUT: path.join(root, "out.jsonl"),
  });
  argv = [
    "--bin",
    bin,
    "--plugin-dir",
    path.join(root, "plugin"),
    "--results",
    path.join(root, "results"),
    "--cases-dir",
    cases,
  ];
});

afterEach(() => {
  for (const key of SAVED)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});

const calls = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
const quiet = (lines: string[]) => (text: string) => lines.push(text);

test("Given --tier smoke --model haiku --budget-runs 2, When run, Then at most 2 runs start and results land under results/haiku", () => {
  const printed: string[] = [];
  const code = main(
    ["--tier", "smoke", "--model", "haiku", "--budget-runs", "2", ...argv],
    quiet(printed),
  );
  expect(code).toBe(0);
  expect(calls()).toHaveLength(2);
  expect(readdirSync(path.join(root, "results", "haiku")).toSorted()).toEqual([
    "a-smoke.json",
    "a-smoke.transcript.jsonl",
    "b-smoke.json",
    "b-smoke.transcript.jsonl",
    "summary.json",
  ]);
  expect(printed.join("\n")).toContain(
    "incomplete: 1 case(s) not run, budget spent (--budget-runs 2): c-smoke",
  );
  const result = JSON.parse(
    readFileSync(path.join(root, "results", "haiku", "a-smoke.json"), "utf8"),
  );
  expect(result.grade.pass).toBe(true);
  expect(result.usage).toEqual({ turns: 2, durationMs: 1000, costUsd: 0.01, stop: "success" });
});

test("Given a run, Then claude -p gets the isolation flags, no API key, no parent Workit session and a substituted prompt", () => {
  main(["--model", "haiku", "--budget-runs", "1", ...argv], quiet([]));
  const [call = ""] = calls();
  expect(call).toContain("key=none session=none");
  expect(call).toMatch(/prompt=do a-smoke in \/\S+\/repo /);
  expect(call).toContain("--setting-sources  --strict-mcp-config --no-session-persistence");
  expect(call).toContain("--output-format stream-json");
  expect(call).toContain(`--plugin-dir ${path.join(root, "plugin")}`);
  expect(call).toContain("--model haiku");
});

test("Given a run, Then the stored transcript names no temp path, project slug or login name", () => {
  main(["--model", "haiku", "--budget-runs", "1", ...argv], quiet([]));
  const [init = ""] = readFileSync(
    path.join(root, "results", "haiku", "a-smoke.transcript.jsonl"),
    "utf8",
  ).split("\n");
  expect(JSON.parse(init)).toEqual({
    type: "system",
    subtype: "init",
    cwd: "<world>/repo",
    memory: "<world>-repo",
    owner: "<user>",
  });
});

test("Given cached results for case+model+version, When run again, Then no model call is made", () => {
  main(["--model", "haiku", "--budget-runs", "3", ...argv], quiet([]));
  expect(calls()).toHaveLength(3);
  const printed: string[] = [];
  expect(main(["--model", "haiku", "--budget-runs", "3", ...argv], quiet(printed))).toBe(0);
  expect(calls()).toHaveLength(3);
  expect(printed.filter((text) => text.startsWith("cached pass"))).toHaveLength(3);
  main(
    ["--model", "haiku", "--budget-runs", "3", "--force", "--cases", "b-smoke", ...argv],
    quiet([]),
  );
  expect(calls()).toHaveLength(4);
  main(["--model", "sonnet", "--budget-runs", "1", "--cases", "b-smoke", ...argv], quiet([]));
  expect(calls()).toHaveLength(5);
});

test("Given a failing transcript, When run, Then the exit code is 1 and the stored grade names the call", () => {
  writeFileSync(
    process.env.FAKE_CLAUDE_OUT ?? "",
    [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "git push origin HEAD" },
            },
          ],
        },
      }),
      JSON.stringify({ type: "result", subtype: "success", num_turns: 1 }),
    ].join("\n"),
  );
  const printed: string[] = [];
  expect(main(["--model", "haiku", "--budget-runs", "1", ...argv], quiet(printed))).toBe(1);
  expect(printed.join("\n")).toContain(
    "raw-git-push: #1 Bash(git push origin HEAD) pushes with raw git",
  );
});

test("Given a stored grade that no longer matches the grader, When replayed with --check, Then it reports drift; plain --replay rewrites it", () => {
  main(["--model", "haiku", "--budget-runs", "1", ...argv], quiet([]));
  const file = path.join(root, "results", "haiku", "a-smoke.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...stored, grade: { ...stored.grade, pass: false } }));
  expect(main(["--replay", "--check", ...argv], quiet([]))).toBe(1);
  expect(main(["--replay", ...argv], quiet([]))).toBe(0);
  expect(main(["--replay", "--check", ...argv], quiet([]))).toBe(0);
  expect(calls()).toHaveLength(1);
});
