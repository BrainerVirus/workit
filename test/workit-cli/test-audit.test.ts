import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSource } from "@/packages/workit-cli/src/test-audit/ast";
import { auditFiles } from "@/packages/workit-cli/src/test-audit/audit";
import { auditParsed, RULES, type RuleId } from "@/packages/workit-cli/src/test-audit/rules";

// `workit test-audit` static rules. Every rule has a red fixture (a test the
// rule must flag) and a green fixture (a close behavioral neighbour it must
// leave alone). Fixtures are source text, so they never run as tests.

const HEADER = `import { expect, test, mock } from "bun:test";\nimport { add, total, slugify, render, formatDate, LIMITS, parse } from "../src/calc";\n`;

const audit = (body: string, file = "test/calc.test.ts") =>
  auditParsed(parseSource(HEADER + body, file), file).findings;

const rulesIn = (body: string, file?: string) => audit(body, file).map((finding) => finding.rule);

type Fixture = { red: string; green: string; file?: string };

const FIXTURES: Record<Exclude<RuleId, "duplicate-body">, Fixture> = {
  tautology: {
    red: `test("adds", () => {
  const a = 2;
  const b = 3;
  expect(add(a, b)).toBe(a + b);
});`,
    green: `test("adds two worked-example numbers", () => {
  const a = 2;
  const b = 3;
  expect(add(a, b)).toBe(5);
});`,
  },
  "mock-echo": {
    red: `test("loads the user", async () => {
  const fetchUser = mock(async () => ({ id: 1, name: "Ada" }));
  expect(await fetchUser()).toEqual({ id: 1, name: "Ada" });
});`,
    green: `test("greets the loaded user", async () => {
  const fetchUser = mock(async () => ({ id: 1, name: "Ada" }));
  expect(await render(fetchUser)).toBe("Hello, Ada");
});`,
  },
  "snapshot-of-constant": {
    red: `test("limits", () => {
  expect(LIMITS).toMatchSnapshot();
});`,
    green: `test("renders the limits table", () => {
  expect(render(LIMITS)).toMatchSnapshot();
});`,
  },
  "assertion-free": {
    red: `test("renders", () => {
  render({ id: 1 });
});`,
    green: `test("renders the id", () => {
  expect(render({ id: 1 })).toContain("1");
});`,
  },
  "prose-contains": {
    red: `test("readme explains setup", () => {
  expect(readFileSync("README.md", "utf8")).toContain("Run the setup wizard once before you start any task in a repo");
});`,
    green: `test("help names the verb", () => {
  expect(render("help")).toContain("workit init");
});`,
  },
  "byte-copy": {
    red: `test("host copy matches core", () => {
  expect(readFileSync("packages/host/skills/a/SKILL.md", "utf8")).toBe(readFileSync("packages/core/skills/a/SKILL.md", "utf8"));
});`,
    green: `test("a failed write leaves the file unchanged", () => {
  const before = readFileSync("state.json", "utf8");
  expect(() => parse("{")).toThrow();
  expect(readFileSync("state.json", "utf8")).toBe(before);
});`,
  },
  "constants-only": {
    red: `test("limit is ten", () => {
  expect(LIMITS_MAX).toBe(10);
});`,
    green: `test("parse caps at the limit", () => {
  expect(parse("x".repeat(20)).length).toBe(10);
});`,
  },
  "always-true": {
    red: `test("works", () => {
  render({ id: 1 });
  expect(true).toBe(true);
});`,
    green: `test("renders without an id", () => {
  expect(render({})).toBe("anonymous");
});`,
  },
  "over-mocking": {
    file: "test/calc.test.ts",
    red: `mock.module("../src/calc", () => ({ add: () => 5 }));
test("adds", () => {
  expect(add(2, 3)).toBe(5);
});`,
    green: `mock.module("node:fs", () => ({ readFileSync: () => "{}" }));
test("parses an empty file", () => {
  expect(parse("{}")).toEqual({});
});`,
  },
};

// The constants-only fixtures replace the header's imports with their own.
const CONSTANT_HEADER = `import { expect, test } from "bun:test";\nimport { LIMITS_MAX } from "../src/calc";\n`;
const PARSE_HEADER = `import { expect, test } from "bun:test";\nimport { parse } from "../src/calc";\n`;

for (const [rule, fixture] of Object.entries(FIXTURES) as [RuleId, Fixture][]) {
  const run = (body: string, header?: string) =>
    header
      ? auditParsed(
          parseSource(header + body, "test/calc.test.ts"),
          "test/calc.test.ts",
        ).findings.map((finding) => finding.rule)
      : rulesIn(body, fixture.file);
  const redHeader = rule === "constants-only" ? CONSTANT_HEADER : undefined;
  const greenHeader = rule === "constants-only" ? PARSE_HEADER : undefined;

  test(`${rule}: flags the red fixture`, () => {
    expect(run(fixture.red, redHeader)).toContain(rule);
  });

  test(`${rule}: leaves the green fixture alone`, () => {
    expect(run(fixture.green, greenHeader)).not.toContain(rule);
  });
}

test("every rule has fixtures", () => {
  expect([...Object.keys(FIXTURES), "duplicate-body"].toSorted()).toEqual(
    Object.keys(RULES).toSorted(),
  );
});

test("Given a test whose expected value is computed by the code under test, Then it is flagged with the reason and an independent oracle", () => {
  const [finding] = audit(`test("total", () => {
  const items = [{ price: 5 }, { price: 10 }];
  expect(total(items)).toBe(items.reduce((sum, item) => sum + item.price, 0));
});`);
  expect(finding).toMatchObject({
    rule: "tautology",
    severity: "high",
    file: "test/calc.test.ts",
    line: 5,
    test: "total",
  });
  expect(finding.why).toContain("items.reduce");
  expect(finding.suggestion).toContain("literal");
});

test("tautology: an expected value computed by another function of the unit's module is flagged", () => {
  const findings = audit(`test("renders the date", () => {
  const day = new Date(0);
  expect(render(day)).toBe(formatDate(day));
});`);
  expect(findings.map((finding) => [finding.rule, finding.confidence])).toEqual([
    ["tautology", "medium"],
  ]);
});

test("tautology: self-comparison is flagged, but re-reading after an action and metamorphic checks are not", () => {
  expect(
    rulesIn(`test("x", () => { const value = { a: 1 }; expect(value).toEqual(value); });`),
  ).toEqual(["tautology"]);
  expect(
    rulesIn(`test("order does not matter", () => {
  expect(total([{ price: 1 }, { price: 2 }])).toBe(total([{ price: 2 }, { price: 1 }]));
});`),
  ).toEqual([]);
  expect(
    rulesIn(`test("slug of a title", () => {
  expect(slugify("Hello World")).toBe("hello-world");
});`),
  ).toEqual([]);
});

test("tautology: negated assertions and values produced by an earlier step are not flagged", () => {
  expect(
    rulesIn(`test("dates differ from the raw render", () => {
  const day = new Date(0);
  expect(render(day)).not.toBe(formatDate(day));
});
test("parse keeps the token it was given", () => {
  const token = formatDate(new Date(0));
  expect(parse(token)).toBe(token);
});`),
  ).toEqual([]);
});

test("add(2, 3) expected as 2 + 3 restates the arithmetic", () => {
  expect(rulesIn(`test("adds", () => { expect(add(2, 3)).toBe(2 + 3); });`)).toEqual(["tautology"]);
});

test("mock-echo: a spy asserted on its own configured value is flagged", () => {
  expect(
    rulesIn(`test("now", () => {
  const clock = { now: () => 1 };
  spyOn(clock, "now").mockReturnValue(42);
  expect(clock.now()).toBe(42);
});`),
  ).toContain("mock-echo");
});

test("suppression comments silence a finding on the next line", () => {
  expect(
    rulesIn(`test("protocol constant", () => {
  // workit-test-audit-ignore always-true -- external protocol value
  expect(1).toBe(1);
});`),
  ).toEqual([]);
});

test("assertion helpers and node:assert count as assertions", () => {
  expect(
    rulesIn(`const expectRendered = (value) => expect(render(value)).toBeTruthy();
test("a", () => { expectRendered({ id: 1 }); });
test("b", () => { assert.strictEqual(render({ id: 1 }), "1"); });`),
  ).toEqual([]);
});

test("duplicate-body: identical test bodies across files are flagged once per copy", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-test-audit-dup-"));
  try {
    const body = `test("NAME", () => {\n  expect(render({ id: 1, name: "Ada" })).toBe("Ada (1)");\n});\n`;
    for (const name of ["a", "b"])
      writeFileSync(path.join(dir, `${name}.test.ts`), HEADER + body.replace("NAME", name));
    writeFileSync(
      path.join(dir, "c.test.ts"),
      HEADER + `test("c", () => {\n  expect(render({ id: 2, name: "Bo" })).toBe("Bo (2)");\n});\n`,
    );
    const report = auditFiles(
      ["a", "b", "c"].map((name) => path.join(dir, `${name}.test.ts`)),
      (file) => path.basename(file),
    );
    expect(report.findings.map((finding) => [finding.rule, finding.file])).toEqual([
      ["duplicate-body", "b.test.ts"],
    ]);
    expect(report.findings[0].why).toContain("a.test.ts:3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TSX and JS test files parse; a syntax error is reported, not thrown", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-test-audit-parse-"));
  try {
    mkdirSync(path.join(dir, "ui"));
    writeFileSync(
      path.join(dir, "ui", "view.test.tsx"),
      `import { test, expect } from "vitest";\ntest("x", () => { const el = <div>{1 as number}</div>; expect(el).toBe(el); });\n`,
    );
    writeFileSync(path.join(dir, "plain.test.js"), `test("y", () => {});\n`);
    writeFileSync(path.join(dir, "broken.test.ts"), `test("z", () => { expect(`);
    const report = auditFiles(
      ["ui/view.test.tsx", "plain.test.js", "broken.test.ts"].map((file) => path.join(dir, file)),
      (file) => path.relative(dir, file),
    );
    expect(report.findings.map((finding) => `${finding.file}:${finding.rule}`).toSorted()).toEqual([
      "plain.test.js:assertion-free",
      "ui/view.test.tsx:tautology",
    ]);
    expect(report.parseErrors.map((error) => error.file)).toEqual(["broken.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
