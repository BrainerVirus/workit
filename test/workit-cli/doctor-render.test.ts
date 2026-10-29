// The human `workit doctor` report: plain (pipes, agents, NO_COLOR) stays the
// line format it has always been; a color terminal gets highlighted status
// words, wrapped details and a closing "Needs attention" section.
import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { DoctorReport } from "@/packages/workit-cli/src/admin/doctor";
import { renderDoctor } from "@/packages/workit-cli/src/verbs/doctor";
import { createStyle } from "@/packages/workit-cli/src/style";

const report = {
  ok: false,
  exitCode: 1,
  offline: true,
  host: "cli",
  checked_at: "2026-10-29T00:00:00.000Z",
  summary: { passed: 2, warned: 1, failed: 1, total: 4 },
  checks: [
    { id: "cli_version", status: "pass", detail: "workit 8.40.8" },
    { id: "knowledge", status: "info", detail: "a newer host CLI than qualified" },
    {
      id: "session_hook",
      status: "warn",
      detail:
        "the prepare-commit-msg hook that adds the Workit-Session trailer is missing from this workspace",
      fix: "workit doctor --fix",
    },
    {
      id: "codex_permissions",
      status: "fail",
      detail: "permission block missing",
      fix: "workit setup --hosts=codex\nsecond line",
    },
  ],
  fixes: [],
} as unknown as DoctorReport;
const knowledge = "info knowledge — no AGENTS.md; 0 finding(s) (workit knowledge lint)";

const PLAIN = [
  "workit doctor — problems found (offline)",
  "ok   cli_version — workit 8.40.8",
  "ok   knowledge — a newer host CLI than qualified",
  "WARN session_hook — the prepare-commit-msg hook that adds the Workit-Session trailer is missing from this workspace",
  "     fix: workit doctor --fix",
  "FAIL codex_permissions — permission block missing",
  "     fix: workit setup --hosts=codex\n          second line",
  knowledge,
  "passed 2 / warned 1 / failed 1",
];

test("Given a pipe, NO_COLOR or CI, When the report renders, Then it is the unchanged plain format", () => {
  for (const options of [
    { stream: { isTTY: false }, env: {} },
    { stream: { isTTY: true, columns: 40 }, env: { NO_COLOR: "1" } },
    { stream: { isTTY: true, columns: 40 }, env: { CI: "true" } },
    { stream: { isTTY: true, columns: 40 }, env: { FORCE_COLOR: "1" }, json: true },
  ])
    expect(renderDoctor(report, knowledge, createStyle(options))).toEqual(PLAIN);
});

test("Given FORCE_COLOR, When the report renders, Then statuses, ids, fixes and the summary are colored", () => {
  const lines = renderDoctor(report, knowledge, createStyle({ env: { FORCE_COLOR: "1" } }));
  const text = lines.join("\n");
  expect(lines[0]).toContain("\x1b[1;31mproblems found\x1b[0m");
  expect(text).toContain("\x1b[32mok  \x1b[0m \x1b[1mcli_version      \x1b[0m");
  expect(text).toContain("\x1b[2minfo\x1b[0m");
  expect(text).toContain("\x1b[33mWARN\x1b[0m");
  expect(text).toContain("\x1b[1;31mFAIL\x1b[0m \x1b[1mcodex_permissions\x1b[0m");
  expect(text).toContain("fix: \x1b[1;36mworkit doctor --fix\x1b[0m");
  expect(text).toContain(
    "\x1b[1;36mworkit setup --hosts=codex\x1b[0m\n          \x1b[1;36msecond line\x1b[0m",
  );
  expect(lines.at(-1)).toBe("\x1b[1;31mpassed 2 / warned 1 / failed 1\x1b[0m");
  // Failures and warnings repeat at the end, each with its fix.
  const tail = stripVTControlCharacters(text.slice(text.indexOf("Needs attention:")));
  expect(tail).toContain("WARN session_hook");
  expect(tail).toContain("FAIL codex_permissions");
  expect(tail).toContain("fix: workit doctor --fix");
  expect(tail).not.toContain("cli_version");
});

test("Given a 60-column terminal, When a detail is long, Then it wraps between words under the detail column", () => {
  const lines = renderDoctor(
    report,
    knowledge,
    createStyle({ stream: { isTTY: true, columns: 60 }, env: {} }),
  ).flatMap((line) => stripVTControlCharacters(line).split("\n"));
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
  const at = lines.findIndex((line) => line.startsWith("WARN session_hook"));
  const column = "WARN codex_permissions  ".length;
  expect(lines[at + 1].slice(0, column).trim()).toBe("");
  expect(lines[at + 1][column]).not.toBe(" ");
  const words = lines
    .slice(at, at + 3)
    .join(" ")
    .split(/ +/);
  expect(words).toContain("prepare-commit-msg");
  expect(words).toContain("Workit-Session");
});

test("Given a clean report, When it renders in color, Then the summary is green and nothing needs attention", () => {
  const clean = {
    ...report,
    ok: true,
    summary: { passed: 1, warned: 0, failed: 0, total: 1 },
    checks: [report.checks[0]],
  } as DoctorReport;
  const lines = renderDoctor(clean, knowledge, createStyle({ env: { FORCE_COLOR: "1" } }));
  expect(lines[0]).toContain("\x1b[32mhealthy\x1b[0m");
  expect(lines.join("\n")).not.toContain("Needs attention");
  expect(lines.at(-1)).toBe("\x1b[32mpassed 1 / warned 0 / failed 0\x1b[0m");
});
