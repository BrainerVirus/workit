// The local weak-model bench grades a stored `claude -p` stream-json
// transcript with no model (scripts/eval/grade.ts, docs/agents/eval.md).
import { describe, expect, test } from "bun:test";
import type { EvalCase } from "@/scripts/eval/cases";
import { grade, usageOf } from "@/scripts/eval/grade";

type Call = {
  name: string;
  input: Record<string, unknown>;
  result: string;
  failed?: boolean;
  parent?: string;
};

const transcript = (calls: Call[], result: Record<string, unknown> = {}): string =>
  [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku" }),
    ...calls.flatMap((call, at) => [
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: call.parent ?? null,
        message: {
          content: [
            { type: "text", text: "next" },
            { type: "tool_use", id: `tu${at}`, name: call.name, input: call.input },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        parent_tool_use_id: call.parent ?? null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `tu${at}`,
              content: [{ type: "text", text: call.result }],
              is_error: call.failed ?? false,
            },
          ],
        },
      }),
    ]),
    JSON.stringify({
      type: "result",
      subtype: "success",
      num_turns: 4,
      duration_ms: 9000,
      total_cost_usd: 0.021,
      ...result,
    }),
  ].join("\n");

const spec = (extra: Partial<EvalCase> = {}): EvalCase => ({
  id: "c",
  source: "test",
  tier: "smoke",
  prompt: "p",
  ...extra,
});

const spawn = { subagent_type: "workit:implementer", description: "add hello", prompt: "do it" };

describe("Given a saved transcript", () => {
  test("When an Agent spawn was refused by a hook, Then the case fails naming that call", () => {
    const graded = grade(
      transcript([
        { name: "Read", input: { file_path: "/r/README.md" }, result: "# demo" },
        {
          name: "Agent",
          input: spawn,
          failed: true,
          result:
            "PreToolUse:Agent hook blocked this call: run `workit fanout brief <slice>` first",
        },
      ]),
      spec(),
    );
    expect(graded.pass).toBe(false);
    expect(graded.failures).toEqual([
      {
        rule: "spawn-refused",
        detail:
          "#2 Agent(workit:implementer: add hello) was refused: PreToolUse:Agent hook blocked this call: run `workit fanout brief <slice>` first",
      },
    ]);
  });

  test("When the same spawn went through, Then the case passes", () => {
    const graded = grade(
      transcript([{ name: "Agent", input: spawn, result: "done: src/hello.ts added" }]),
      spec(),
    );
    expect(graded).toEqual({ graderVersion: 1, pass: true, calls: 1, failures: [] });
  });

  test("When a raw `git push` ran, even after a cd chain, Then it fails; `workit git push` passes", () => {
    const raw = grade(
      transcript([
        {
          name: "Bash",
          input: { command: "cd /r && GIT_X=1 git -C /r push -u origin feature/x" },
          result: "",
        },
      ]),
      spec(),
    );
    expect(raw.failures.map((failure) => failure.rule)).toEqual(["raw-git-push"]);
    const workit = grade(
      transcript([
        { name: "Bash", input: { command: "workit git --cwd /r push" }, result: "pushed" },
      ]),
      spec(),
    );
    expect(workit.pass).toBe(true);
  });

  test("When one call failed twice with the same input, Then it fails as a repeat; a changed retry passes", () => {
    const denied = "denied: run workit git stage";
    const repeated = grade(
      transcript([
        {
          name: "Bash",
          input: { command: "workit git add notes.md" },
          failed: true,
          result: denied,
        },
        {
          name: "Bash",
          input: { command: "workit git add notes.md" },
          failed: true,
          result: denied,
        },
      ]),
      spec(),
    );
    expect(repeated.failures).toEqual([
      {
        rule: "repeated-failing-call",
        detail:
          "#2 Bash(workit git add notes.md) repeats failed call #1: denied: run workit git stage",
      },
    ]);
    const corrected = grade(
      transcript([
        {
          name: "Bash",
          input: { command: "workit git add notes.md" },
          failed: true,
          result: denied,
        },
        { name: "Bash", input: { command: "workit git stage notes.md" }, result: "staged" },
      ]),
      spec(),
    );
    expect(corrected.pass).toBe(true);
  });

  test("When a case wants a configured check, Then only `workit check <configured name>` counts", () => {
    const checked = spec({
      scaffold: { checks: { test: ["sh", "-c", "true"] } },
      expect: { configuredCheck: true },
    });
    const adHoc = grade(
      transcript([
        {
          name: "Bash",
          input: { command: "workit check --name test -- bun test" },
          result: "passed",
        },
      ]),
      checked,
    );
    expect(adHoc.failures).toEqual([
      { rule: "configured-check", detail: "no `workit check <test>` call" },
    ]);
    const configured = grade(
      transcript([
        {
          name: "Bash",
          input: { command: "workit check --cwd /r --heavy test 2>&1 | tail -5" },
          result: "passed",
        },
      ]),
      checked,
    );
    expect(configured.pass).toBe(true);
  });

  test("When a forbidden pattern matched a subagent call, Then the failure names the call and the reason", () => {
    const graded = grade(
      transcript([
        { name: "Bash", input: { command: "workit git add notes.md" }, result: "", parent: "tu9" },
      ]),
      spec({
        expect: { forbid: [{ tool: "Bash", pattern: "workit git add", why: "the verb is stage" }] },
      }),
    );
    expect(graded.failures).toEqual([
      {
        rule: "forbid",
        detail:
          "#1 Bash(workit git add notes.md) in a subagent matches /workit git add/: the verb is stage",
      },
    ]);
  });

  test("When a required call is missing, Then the failure names the pattern", () => {
    const graded = grade(
      transcript([{ name: "Read", input: { file_path: "a" }, result: "a" }]),
      spec({
        expect: { require: [{ tool: "Bash", pattern: "\\bcommit\\b", why: "the commit is made" }] },
      }),
    );
    expect(graded.failures).toEqual([
      { rule: "require", detail: "no call matches /\\bcommit\\b/: the commit is made" },
    ]);
  });

  test("Then usage comes from the final result event", () => {
    expect(usageOf(transcript([], { subtype: "error_max_turns", num_turns: 8 }))).toEqual({
      turns: 8,
      durationMs: 9000,
      costUsd: 0.021,
      stop: "error_max_turns",
    });
  });

  test("When a case checks the final answer, Then a missing pattern fails and a match passes", () => {
    const asks = spec({
      expect: { answer: [{ pattern: "workit-contract", why: "quotes the tag" }] },
    });
    expect(grade(transcript([], { result: "No context was received." }), asks).failures).toEqual([
      {
        rule: "answer",
        detail: "the final answer does not match /workit-contract/: quotes the tag",
      },
    ]);
    expect(grade(transcript([], { result: "Yes: <workit-contract>." }), asks).pass).toBe(true);
  });
});

describe("Given a saved `opencode run --format json` transcript", () => {
  const line = (type: string, part: Record<string, unknown>, at: number, session = "ses_root") =>
    JSON.stringify({ type, timestamp: at, sessionID: session, part });
  const shell = (id: string, command: string, status: string, output: string, session?: string) =>
    line(
      "tool_use",
      {
        id,
        type: "tool",
        tool: "shell",
        state:
          status === "error"
            ? { status, input: { command }, error: output }
            : { status, input: { command }, output },
      },
      2000,
      session,
    );

  test("When it ran shell and subagent calls, Then they grade as Bash and Agent with the same rules", () => {
    const opencode = [
      line("step_start", { type: "step-start" }, 1000),
      shell("c1", "git push origin HEAD", "error", "Permission denied: shell"),
      shell("c2", "git push origin HEAD", "error", "Permission denied: shell"),
      line(
        "tool_use",
        {
          id: "c3",
          type: "tool",
          tool: "subagent",
          state: {
            status: "error",
            input: { agent: "workit-implementer", description: "add hello" },
            error: "denied by the Workit spawn hook",
          },
        },
        2500,
      ),
      shell("c4", "workit check test", "completed", "passed", "ses_child"),
      line("step_finish", { type: "step-finish", reason: "tool-calls", cost: 0.002 }, 3000),
      line("step_start", { type: "step-start" }, 3100),
      line("text", { type: "text", text: "Pushed." }, 3200),
      line("step_finish", { type: "step-finish", reason: "stop", cost: 0.001 }, 4000),
    ].join("\n");
    const graded = grade(
      opencode,
      spec({
        scaffold: { checks: { test: ["true"] } },
        expect: {
          configuredCheck: true,
          answer: [{ pattern: "^Pushed\\.$", why: "says what it did" }],
        },
      }),
    );
    expect(graded.calls).toBe(4);
    expect(graded.failures.map((failure) => failure.rule)).toEqual([
      "spawn-refused",
      "raw-git-push",
      "raw-git-push",
      "repeated-failing-call",
    ]);
    expect(graded.failures[0]?.detail).toBe(
      "#3 Agent(workit-implementer: add hello) was refused: denied by the Workit spawn hook",
    );
    expect(usageOf(opencode)).toEqual({ turns: 2, durationMs: 3000, costUsd: 0.003, stop: "stop" });
  });

  test("When the run stopped on a provider error, Then it fails with run-error, never passes", () => {
    const stopped = JSON.stringify({
      type: "error",
      timestamp: 1,
      sessionID: "ses_root",
      error: { type: "provider.auth", status: 401, message: "This API key has expired." },
    });
    expect(grade(stopped, spec()).failures).toEqual([
      {
        rule: "run-error",
        detail: "the run stopped on: provider.auth 401 This API key has expired.",
      },
    ]);
    expect(usageOf(stopped).stop).toBe("error");
  });
});

test("Given expect.atMost, When more calls match than allowed, Then the case fails naming them", () => {
  const helps = spec({
    expect: {
      atMost: [{ tool: "Bash", pattern: "\\bworkit help\\b", max: 2, why: "the verbs guide" }],
    },
  });
  const calls = (count: number) =>
    transcript(
      Array.from({ length: count }, (_, at) => ({
        name: "Bash",
        input: { command: `workit help release ${at}` },
        result: "usage: …",
      })),
    );
  expect(grade(calls(2), helps).pass).toBe(true);
  expect(grade(calls(3), helps).failures).toEqual([
    {
      rule: "at-most",
      detail: "3 calls match /\\bworkit help\\b/, at most 2: the verbs guide (#1, #2, #3)",
    },
  ]);
});
