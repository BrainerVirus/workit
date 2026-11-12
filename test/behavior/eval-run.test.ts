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
import { main, readOnlyCdChain } from "@/scripts/eval/run";

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
  "FAKE_CLAUDE_GRANTS",
  "FAKE_WORKIT_MAIN",
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
      'echo "run cwd=$PWD key=${ANTHROPIC_API_KEY:-none} session=${WORKIT_SESSION_ID:-none} prompt=$prompt commits=$(git rev-list --count HEAD) args=$*" >> "$FAKE_CLAUDE_LOG"',
      `printf '{"type":"system","subtype":"init","cwd":"%s","memory":"%s","owner":"%s"}\\n' "$PWD" "$(pwd | tr -c '[:alnum:]_\\n' -)" "$(id -un)"`,
      // The n-th call prints $FAKE_CLAUDE_OUT.<n> when that file exists.
      'n=$(wc -l < "$FAKE_CLAUDE_LOG" | tr -d " ")',
      'if [ -f "$FAKE_CLAUDE_OUT.$n" ]; then cat "$FAKE_CLAUDE_OUT.$n"; else cat "$FAKE_CLAUDE_OUT"; fi',
      'if [ -n "${FAKE_CLAUDE_GRANTS:-}" ]; then bun "$FAKE_WORKIT_MAIN" grant show --json > "$FAKE_CLAUDE_GRANTS"; fi',
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
    // The tripwire guards a fake real home, never the account's (#822).
    "--real-home",
    path.join(root, "home"),
    // The fake claude logs outside its world; confinement has its own tests (eval-confine).
    "--confine",
    "off",
  ];
});

afterEach(() => {
  for (const key of SAVED)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});

const calls = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
const quiet = (lines: string[]) => (text: string) => lines.push(text);

test("Given --tier smoke --model haiku --budget-runs 2, When run, Then at most 2 runs start and results land under results/haiku", async () => {
  const printed: string[] = [];
  const code = await main(
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

test("Given a run, Then claude -p gets the isolation flags, no API key, no parent Workit session and a substituted prompt", async () => {
  await main(["--model", "haiku", "--budget-runs", "1", ...argv], quiet([]));
  const [call = ""] = calls();
  expect(call).toContain("key=none session=none");
  expect(call).toMatch(/prompt=do a-smoke in \/\S+\/repo /);
  expect(call).toContain("--setting-sources  --strict-mcp-config --no-session-persistence");
  expect(call).toContain("--output-format stream-json");
  expect(call).toContain(`--plugin-dir ${path.join(root, "plugin")}`);
  expect(call).toContain("--model haiku");
});

test("Given a run, Then the stored transcript names no temp path, project slug or login name", async () => {
  await main(["--model", "haiku", "--budget-runs", "1", ...argv], quiet([]));
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

test("Given cached results for case+model+version, When run again, Then no model call is made", async () => {
  await main(["--model", "haiku", "--budget-runs", "3", ...argv], quiet([]));
  expect(calls()).toHaveLength(3);
  const printed: string[] = [];
  expect(await main(["--model", "haiku", "--budget-runs", "3", ...argv], quiet(printed))).toBe(0);
  expect(calls()).toHaveLength(3);
  expect(printed.filter((text) => text.startsWith("cached pass"))).toHaveLength(3);
  await main(
    ["--model", "haiku", "--budget-runs", "3", "--force", "--cases", "b-smoke", ...argv],
    quiet([]),
  );
  expect(calls()).toHaveLength(4);
  await main(["--model", "sonnet", "--budget-runs", "1", "--cases", "b-smoke", ...argv], quiet([]));
  expect(calls()).toHaveLength(5);
});

test("Given a failing transcript, When run, Then the exit code is 1 and the stored grade names the call", async () => {
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
  expect(await main(["--model", "haiku", "--budget-runs", "1", ...argv], quiet(printed))).toBe(1);
  expect(printed.join("\n")).toContain(
    "raw-git-push: #1 Bash(git push origin HEAD) pushes with raw git",
  );
  expect(readFileSync(path.join(root, "results", "haiku", "summary.json"), "utf8")).toContain(
    '"failures": ["raw-git-push"],',
  );
});

test("Given a stored grade that no longer matches the grader, When replayed with --check, Then it reports drift; plain --replay rewrites it", async () => {
  await main(["--model", "haiku", "--budget-runs", "1", ...argv], quiet([]));
  const file = path.join(root, "results", "haiku", "a-smoke.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...stored, grade: { ...stored.grade, pass: false } }));
  expect(await main(["--replay", "--check", ...argv], quiet([]))).toBe(1);
  expect(await main(["--replay", ...argv], quiet([]))).toBe(0);
  expect(await main(["--replay", "--check", ...argv], quiet([]))).toBe(0);
  expect(calls()).toHaveLength(1);
});

test("Given a case with scaffold commits and no allowed tools, Then the repo has them and claude -p gets no --allowedTools", async () => {
  writeFileSync(
    path.join(root, "cases", "e-full.json"),
    JSON.stringify({
      id: "e-full",
      source: "test",
      tier: "full",
      prompt: "p",
      allowedTools: [],
      scaffold: { commits: [{ message: "fix: adjust", files: { "a.ts": "b\n" } }] },
    }),
  );
  await main(["--model", "haiku", "--tier", "full", "--cases", "e-full", ...argv], quiet([]));
  const [call = ""] = calls();
  expect(call).toContain("commits=2 ");
  expect(call).not.toContain("--allowedTools");
  expect(call).toContain("--permission-mode dontAsk --disallowedTools WebFetch WebSearch");
});

const PUSH = [
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "git push origin HEAD" } },
      ],
    },
  }),
  JSON.stringify({ type: "result", subtype: "success", num_turns: 1 }),
].join("\n");

const summaryOf = (model = "haiku") =>
  JSON.parse(readFileSync(path.join(root, "results", model, "summary.json"), "utf8"));

test("Given --repeat 3 and one failing run, When run, Then every run is stored and the case passes on 2 of 3", async () => {
  writeFileSync(`${process.env.FAKE_CLAUDE_OUT}.2`, PUSH);
  const printed: string[] = [];
  const code = await main(
    ["--model", "haiku", "--cases", "a-smoke", "--repeat", "3", ...argv],
    quiet(printed),
  );
  expect(code).toBe(0);
  expect(calls()).toHaveLength(3);
  expect(readdirSync(path.join(root, "results", "haiku")).toSorted()).toEqual([
    "a-smoke.json",
    "a-smoke.run2.json",
    "a-smoke.run2.transcript.jsonl",
    "a-smoke.run3.json",
    "a-smoke.run3.transcript.jsonl",
    "a-smoke.transcript.jsonl",
    "summary.json",
  ]);
  expect(printed.join("\n")).toContain("pass a-smoke: 2 of 3 run(s) passed (needs 2)");
  const summary = summaryOf();
  expect(summary).toMatchObject({ passed: 1, total: 1 });
  expect(summary.cases[0]).toMatchObject({ case: "a-smoke", pass: true, passes: 2 });
  expect(summary.cases[0].runs.map((run: { pass: boolean }) => run.pass)).toEqual([
    true,
    false,
    true,
  ]);
  // A second invocation finds all three runs cached.
  expect(
    await main(["--model", "haiku", "--cases", "a-smoke", "--repeat", "3", ...argv], quiet([])),
  ).toBe(0);
  expect(calls()).toHaveLength(3);
  expect(await main(["--replay", "--check", ...argv], quiet([]))).toBe(0);
});

test("Given --repeat 3 and two failing runs, When run, Then the case fails and the exit code is 1", async () => {
  writeFileSync(`${process.env.FAKE_CLAUDE_OUT}.1`, PUSH);
  writeFileSync(`${process.env.FAKE_CLAUDE_OUT}.3`, PUSH);
  const printed: string[] = [];
  expect(
    await main(
      ["--model", "haiku", "--cases", "a-smoke", "--repeat", "3", ...argv],
      quiet(printed),
    ),
  ).toBe(1);
  expect(printed.join("\n")).toContain("FAIL a-smoke: 1 of 3 run(s) passed (needs 2)");
  expect(summaryOf().cases[0]).toMatchObject({
    pass: false,
    passes: 1,
    failures: ["raw-git-push"],
  });
});

test("Given a stored run's grade drifts, When replayed, Then --check reports that run and plain --replay rewrites the summary", async () => {
  await main(["--model", "haiku", "--cases", "a-smoke", "--repeat", "3", ...argv], quiet([]));
  const file = path.join(root, "results", "haiku", "a-smoke.run3.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...stored, grade: { ...stored.grade, pass: false } }));
  const printed: string[] = [];
  expect(await main(["--replay", "--check", ...argv], quiet(printed))).toBe(1);
  expect(printed.join("\n")).toContain("drift haiku/a-smoke.run3: fail -> pass");
  expect(await main(["--replay", ...argv], quiet([]))).toBe(0);
  expect(summaryOf().cases[0]).toMatchObject({ pass: true, passes: 3 });
});

test("Given --repeat 1 after --repeat 3, Then the extra runs are dropped and the summary row is a single run", async () => {
  await main(["--model", "haiku", "--cases", "a-smoke", "--repeat", "3", ...argv], quiet([]));
  await main(["--model", "haiku", "--cases", "a-smoke", ...argv], quiet([]));
  expect(readdirSync(path.join(root, "results", "haiku")).toSorted()).toEqual([
    "a-smoke.json",
    "a-smoke.transcript.jsonl",
    "summary.json",
  ]);
  expect(summaryOf().cases[0].runs).toBeUndefined();
});

test("Given a case with scaffold.workspace, Then the agent's world reports that workspace's endpoint through workit grant show", async () => {
  writeFileSync(
    path.join(root, "cases", "f-full.json"),
    JSON.stringify({
      id: "f-full",
      source: "test",
      tier: "full",
      prompt: "p",
      scaffold: { branch: "feature/x", workspace: { defaultEndpoint: "pr" } },
    }),
  );
  const grants = path.join(root, "grants.json");
  process.env.FAKE_CLAUDE_GRANTS = grants;
  process.env.FAKE_WORKIT_MAIN = path.resolve(
    import.meta.dir,
    "..",
    "..",
    "packages",
    "workit-cli",
    "src",
    "main.ts",
  );
  await main(["--model", "haiku", "--tier", "full", "--cases", "f-full", ...argv], quiet([]));
  const shown = JSON.parse(readFileSync(grants, "utf8"));
  expect(shown.ok).toBe(true);
  expect(shown.data).toMatchObject({
    workspace: "eval",
    defaultEndpoint: "pr",
    effectiveEndpoint: "pr",
  });
  expect(shown.data.note ?? "").not.toContain("does not apply to grants");
});

// #793: the bench's PreToolUse hook allows only a `cd` chain that reads.
test.each([
  "cd /w/wt && git status --short && git branch --show-current && git log --oneline -3 && ls -la notes.md",
  "cd /w/wt && git diff",
])("Given `%s`, Then the bench allows it as a read-only cd chain", (command) => {
  expect(readOnlyCdChain(command)).toBe(true);
});

test.each([
  "cd /w/wt && git commit -m x",
  "cd /w/wt && git add notes.md && git status",
  "cd /w/wt && git status; rm -rf x",
  "cd /w/wt && git status > out",
  "cd /w/wt && git log | tee x",
  "cd $W && git status",
  "cd /w/wt && git diff --output=x",
  "cd /w/wt && git branch new",
  "cd /w/wt",
  "git status && cd /w/wt",
  "cd /w/wt && git status & rm x",
  "cd /w/wt && git diff --outp=x",
  "cd /w/wt && git show --out=f",
  "cd /w/wt && git diff --ext-diff",
  "cd /w/wt && git diff --no-index a b",
  "cd /w/wt && grep -f patterns notes.md",
  "cd /w/wt && git log --output=x",
])("Given `%s`, Then the bench hook leaves it to the host", (command) => {
  expect(readOnlyCdChain(command)).toBe(false);
});
