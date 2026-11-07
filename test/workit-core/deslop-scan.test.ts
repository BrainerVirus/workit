import { expect, test } from "bun:test";
import {
  deslopResultLine,
  lanePasses,
  raiseLane,
  scanSource,
} from "@/packages/workit-core/src/deslop/scan";

const classes = (file: string, source: string) =>
  scanSource(file, source, "all").map((finding) => [finding.line, finding.class, finding.reason]);

test("Given narration comments, When scanned, Then each is listed with its line as narration", () => {
  const source = [
    "export function total(items: number[]): number {",
    "  // start the sum at zero",
    "  let sum = 0;",
    "  // loop over the items and add each one",
    "  for (const item of items) sum += item;",
    "  return sum; // return the result",
    "}",
  ].join("\n");
  expect(classes("src/calc.ts", source)).toEqual([
    [2, "narration", "restates or narrates the code"],
    [4, "narration", "restates or narrates the code"],
    [6, "narration", "restates or narrates the code"],
  ]);
});

test("Given a licence header, a prettier-ignore and an issue-link comment, When scanned, Then all three are allowed", () => {
  const source = [
    "// SPDX-License-Identifier: MIT",
    "// Copyright (c) 2026 Example Corp",
    "// prettier-ignore",
    "const matrix = [1,0,",
    "                0,1];",
    "// the gateway drops the first request after idle, see #412",
    "export const retries = 2;",
  ].join("\n");
  expect(classes("src/matrix.ts", source)).toEqual([
    [1, "allowed", "licence"],
    [3, "allowed", "formatter directive prettier-ignore"],
    [6, "allowed", "issue or RFC link"],
  ]);
});

test("Given lint suppressions with and without a reason, When scanned, Then the bare one is a suppression, the justified one allowed, and both raise the lane", () => {
  const source = [
    "// eslint-disable-next-line no-console",
    "console.info(1);",
    "// oxlint-disable-next-line no-explicit-any -- the plugin API hands us untyped JSON",
    "const raw: any = JSON.parse('{}');",
    "// @ts-expect-error",
    "raw.call();",
  ].join("\n");
  const findings = scanSource("src/x.ts", source, "all");
  expect(findings.map((finding) => [finding.line, finding.class, finding.raisesLane])).toEqual([
    [1, "suppression", true],
    [3, "allowed", true],
    [5, "suppression", true],
  ]);
  expect(findings[1].reason).toBe(
    "justified suppression oxlint-disable-next-line: the plugin API hands us untyped JSON",
  );
});

test("Given a marker and a console.log, When scanned, Then they are marker and debug", () => {
  const source = [
    "// TODO: handle negatives",
    "console.log(sum);",
    "debugger;",
    'log("[DEBUG-7] cache miss");',
  ].join("\n");
  expect(classes("src/x.js", source)).toEqual([
    [1, "marker", "TODO"],
    [2, "debug", "debug leftover console.log"],
    [3, "debug", "debug leftover debugger"],
    [4, "debug", "debug leftover [DEBUG-7]"],
  ]);
});

test("Given comment-like text inside strings, template literals and regex literals, When scanned, Then nothing is reported", () => {
  const source = [
    'const url = "http://example.com/a//b";',
    "const fixture = `",
    "  // a comment inside a fixture string",
    "  console.log(1);",
    "`;",
    "const re = /https?:\\/\\//;",
    "const glob = 'src/**/*.ts';",
  ].join("\n");
  expect(scanSource("src/x.ts", source, "all")).toEqual([]);
});

test("Given a doc comment on an export and one on a private helper, When scanned, Then only the export's is public API docs", () => {
  const source = [
    "/** The sum of two numbers. */",
    "export const add = (x: number, y: number) => x + y;",
    "export type Options = {",
    "  /** Lines of context. */",
    "  context: number;",
    "};",
    "/** Adds one to the value. */",
    "const inc = (x: number) => x + 1;",
  ].join("\n");
  expect(classes("src/x.ts", source)).toEqual([
    [1, "allowed", "public API docs"],
    [4, "allowed", "public API docs"],
    [7, "narration", "restates or narrates the code"],
  ]);
});

test("Given an external quirk explained without a link, When scanned, Then it is allowed", () => {
  const source = [
    "# Windows git rejects a path with a trailing dot, so strip it first",
    'name="${name%.}"',
  ].join("\n");
  expect(classes("scripts/fix.sh", source)).toEqual([[1, "allowed", "external quirk"]]);
});

test("Given hash comments in Python and YAML, When scanned, Then shell variables and strings are not comments", () => {
  expect(classes("tool.py", 'x = "#1"  # noqa\ny = 2\n')).toEqual([
    [1, "suppression", "noqa without a reason"],
  ]);
  expect(classes("ci.yml", 'key: a#b\nother: "#x" # set the key\n')).toEqual([
    [2, "narration", "restates or narrates the code"],
  ]);
});

test("Given changed lines, When scanned, Then only comments on changed lines are reported", () => {
  const source = ["// old note", "const a = 1;", "// new note", "const b = 2;"].join("\n");
  expect(scanSource("src/x.ts", source, new Set([3, 4])).map((finding) => finding.line)).toEqual([
    3,
  ]);
});

test("Given an unknown file type, When scanned, Then nothing is reported", () => {
  expect(scanSource("README.md", "<!-- note -->\n// not code\n", "all")).toEqual([]);
});

test("Given lane self and a new suppression, When the lane is raised, Then it is focused; focused and full stay", () => {
  const findings = scanSource("src/x.ts", "// eslint-disable-next-line no-console\n", "all");
  expect(raiseLane("self", findings)).toMatchObject({ from: "self", lane: "focused" });
  expect(raiseLane("self", findings).reasons[0]).toContain("src/x.ts:1");
  expect(raiseLane("self", [])).toEqual({ from: "self", lane: "self", reasons: [] });
  expect(raiseLane("full", findings).lane).toBe("full");
  const allowed = scanSource("src/x.ts", "// prettier-ignore\n", "all");
  expect(raiseLane("self", allowed).lane).toBe("self");
});

test("Given each lane, Then deslop runs that lane's passes and every pass of the lanes below", () => {
  expect(lanePasses("none")).toEqual(["prose"]);
  expect(lanePasses("self")).toEqual(["prose", "scan", "mechanical"]);
  expect(lanePasses("focused")).toEqual([
    "prose",
    "scan",
    "mechanical",
    "no-comments",
    "test-quality",
  ]);
  expect(lanePasses("full")).toEqual([
    "prose",
    "scan",
    "mechanical",
    "no-comments",
    "test-quality",
    "mutate",
    "architect",
  ]);
});

test("Given a finished deslop, Then its result line reads lane, lines removed, reshapes and open items", () => {
  expect(deslopResultLine({ lane: "focused", removed: 42, reshapes: 3, open: 1 })).toBe(
    "deslop: lane focused, -42 lines, 3 reshapes, 1 open",
  );
});
