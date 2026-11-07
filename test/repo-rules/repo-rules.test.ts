import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/scripts/repo-rules/check.mts";

// Each rule runs through the real oxlint plugin on the snippet of the past
// mistake it was written from (the code as it was before the cited fix), and
// stays quiet on the fixed shape.

type Case = { rule: string; file: string; line: number; source: string };

const CITED: Case[] = [
  {
    rule: "spawn-timeout",
    file: "packages/workit-core/src/core/pr-create.ts",
    line: 3,
    // ef49c5ed^ (#644): repoRoot() before `...LOCAL` bounded it.
    source: `import { spawnSync } from "node:child_process";
export function repoRoot(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : cwd;
}
`,
  },
  {
    rule: "spawn-env-path",
    file: "packages/workit-core/src/core/pr-env.ts",
    line: 2,
    // c8b30bd4^: prCreate's gh env.
    source: `export function ghEnv(token: string): NodeJS.ProcessEnv {
  return { ...process.env, GH_TOKEN: token };
}
`,
  },
  {
    rule: "home-expanded-vars",
    file: "packages/workit-core/src/hooks/write-gate.ts",
    line: 4,
    // retro 2026-11-07 R2: workitCwd() resolving `--cwd $W`.
    source: `import path from "node:path";
declare const homeExpanded: (word: string) => string;
export function workitCwd(dir: string, cwd: string | null, rest: string[]) {
  return { at: cwd === null ? dir : path.resolve(dir, homeExpanded(cwd)), args: rest };
}
`,
  },
  {
    rule: "no-wall-clock-assert",
    file: "test/workit-core/revision-retry.test.ts",
    line: 6,
    // 7c78623e^ (#176): the retry-cap test bounded by runner wall time.
    source: `import { expect, test } from "bun:test";
test("retries stop at the cap", async () => {
  const begin = performance.now();
  await Promise.resolve();
  const elapsed = performance.now() - begin;
  expect(elapsed).toBeLessThan(2_000);
});
`,
  },
  {
    rule: "exit-after-flush",
    file: "packages/workit-cli/src/main.ts",
    line: 3,
    // fab43755^ (#535): the CLI entry point.
    source: `declare const main: (argv: string[], env: object, options: object) => Promise<number>;
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), {}, { diagnostics: true }));
}
`,
  },
];

const FIXED: Record<string, string> = {
  "packages/workit-core/src/core/pr-create-fixed.ts": `import { spawnSync } from "node:child_process";
const LOCAL = { encoding: "utf8" as const, timeout: 20_000 };
export const a = spawnSync("git", ["rev-parse"], { cwd: "/", ...LOCAL });
export const b = spawnSync("git", ["rev-parse"], { cwd: "/", timeout: 1_000 });
`,
  "packages/workit-core/src/core/pr-env-fixed.ts": `export const env = (token: string) => ({ ...process.env, PATH: process.env.PATH ?? "", GH_TOKEN: token });
`,
  "packages/workit-core/src/hooks/write-gate-fixed.ts": `declare const homeExpanded: (word: string) => string;
declare const expandVars: (word: string, vars: Map<string, string>) => string;
export const at = (cwd: string, vars: Map<string, string>) => homeExpanded(expandVars(cwd, vars));
`,
  "test/workit-core/revision-retry-fixed.test.ts": `import { expect, test } from "bun:test";
test("retries stop at the cap", () => {
  const attempts = 8;
  expect(attempts).toBeLessThan(9);
});
`,
  "packages/workit-cli/src/main-fixed.ts": `declare const flushStreams: () => Promise<void>;
export async function run(code: number) {
  await flushStreams();
  process.exit(code);
}
`,
  // Outside a rule's paths: tests may spawn without a timeout, packages may time.
  "test/workit-core/spawn-in-test.test.ts": `import { spawnSync } from "node:child_process";
export const probe = spawnSync("git", ["--version"]);
`,
};

let root = "";
const write = (file: string, source: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
};
const run = (...args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(["--root", root, ...args], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const baselineFile = () => path.join(root, "scripts/repo-rules/baseline.json");
const readBaseline = () => JSON.parse(readFileSync(baselineFile(), "utf8")) as unknown;
const setBaseline = (baseline: object) =>
  write("scripts/repo-rules/baseline.json", JSON.stringify(baseline));

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "wk-repo-rules-"));
  for (const entry of CITED) write(entry.file, entry.source);
  for (const [file, source] of Object.entries(FIXED)) write(file, source);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("Given each cited past mistake and an empty baseline, When the repo rules run, Then each rule fails at its file:line and names the fix", () => {
  setBaseline({});
  const { code, err } = run();
  expect(code).toBe(1);
  const lines = err.split("\n");
  for (const entry of CITED) {
    const hit = lines.find((line) => line.startsWith(`${entry.file}:${entry.line}:`));
    expect(hit, `${entry.rule} on ${entry.file}:${entry.line}`).toContain(`workit/${entry.rule}: `);
    expect(hit).toContain(" Fix: ");
  }
  expect(err).toContain("repo rules: 5 new hits.");
});

test("Given the fixed shapes and files outside a rule's paths, When the repo rules run, Then none of them is reported", () => {
  setBaseline({});
  const { err } = run();
  for (const file of Object.keys(FIXED)) expect(err).not.toContain(`${file}:`);
});

test("Given a baseline that holds every hit, When the repo rules run, Then they pass", () => {
  setBaseline(Object.fromEntries(CITED.map((entry) => [entry.rule, { [entry.file]: 1 }])));
  expect(run()).toEqual({ code: 0, out: "", err: "" });
});

test("Given a file with one hit more than its baseline count, When the repo rules run, Then they fail naming the file's hits and the allowance", () => {
  const exit = CITED.find((entry) => entry.rule === "exit-after-flush");
  write(
    "packages/workit-cli/src/main.ts",
    `${exit?.source ?? ""}export const again = () => process.exit(1);\n`,
  );
  try {
    setBaseline(Object.fromEntries(CITED.map((entry) => [entry.rule, { [entry.file]: 1 }])));
    const { code, err } = run();
    expect(code).toBe(1);
    expect(err).toContain("packages/workit-cli/src/main.ts:5:28 workit/exit-after-flush: ");
    expect(err).toContain(
      "packages/workit-cli/src/main.ts has 2 workit/exit-after-flush hits; the baseline allows 1: fix the new one",
    );
    expect(err).toContain("repo rules: 1 new hit.");
  } finally {
    write("packages/workit-cli/src/main.ts", exit?.source ?? "");
  }
});

test("Given a baselined hit that was fixed, When the repo rules run, Then they pass and ask to shrink the baseline, and --write shrinks it", () => {
  const full = Object.fromEntries(CITED.map((entry) => [entry.rule, { [entry.file]: 1 }]));
  setBaseline({
    ...full,
    "spawn-timeout": { "packages/workit-core/src/core/pr-create.ts": 1, "packages/gone.ts": 2 },
    "retired-rule": { "packages/workit-core/src/core/pr-create.ts": 1 },
  });
  const report = run();
  expect(report.code).toBe(0);
  expect(report.out).toContain("workit/spawn-timeout packages/gone.ts: 2 -> 0");
  expect(report.out).toContain(
    "workit/retired-rule packages/workit-core/src/core/pr-create.ts: 1 -> 0",
  );
  expect(report.out).toContain("run: bun run lint:rules --write");

  const shrunk = run("--write");
  expect(shrunk.code).toBe(0);
  expect(shrunk.out).toBe("repo rules: baseline 8 -> 5 hits");
  expect(readBaseline()).toEqual({
    "exit-after-flush": { "packages/workit-cli/src/main.ts": 1 },
    "home-expanded-vars": { "packages/workit-core/src/hooks/write-gate.ts": 1 },
    "no-wall-clock-assert": { "test/workit-core/revision-retry.test.ts": 1 },
    "spawn-env-path": { "packages/workit-core/src/core/pr-env.ts": 1 },
    "spawn-timeout": { "packages/workit-core/src/core/pr-create.ts": 1 },
  });
});

test("Given new hits, When --write runs, Then the baseline never grows and the run still fails", () => {
  setBaseline({});
  const { code } = run("--write");
  expect(code).toBe(1);
  expect(readBaseline()).toEqual({});
});

test("Given a newly added rule, When --grandfather names it, Then only that rule's current hits are seeded", () => {
  setBaseline({});
  const seeded = run("--grandfather", "home-expanded-vars");
  expect(seeded.code).toBe(1);
  expect(readBaseline()).toEqual({
    "home-expanded-vars": { "packages/workit-core/src/hooks/write-gate.ts": 1 },
  });
  expect(run("--grandfather", "no-such-rule").code).toBe(2);
});
