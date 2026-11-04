// Verdict carry over trunk-only rebases, bookkeeping files and test-only
// pushes, built from the shapes that went stale on 2026-11-04:
//   #692  rebased onto a main whose PR added a CHANGELOG entry and
//         regenerated docs/qualification/context-budget.json, both files the
//         branch also changed (a hand-resolved CHANGELOG conflict);
//   #700  the same, plus main's release sync bumping the version of a
//         package.json the branch also edits;
//   #695  a 148-line test-only push on a full-lane PR with a unit verdict.
// The PR's own code changing still makes the verdict stale.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkVerdicts,
  readLedger,
  recordVerdict,
  type LedgerResult,
  type VerdictKind,
  type VerdictResult,
} from "@/packages/workit-core/src/ledger";
import { versionOnlyChange } from "@/packages/workit-core/src/core/policy/bookkeeping";

if (process.platform === "win32") setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const value = <T>(result: LedgerResult<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
};

const commit = (root: string, files: Record<string, string>, message: string): string => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

const BUDGET = "docs/qualification/context-budget.json";
const CURSOR = "packages/workit-cursor/package.json";
const ROOT_MANIFEST = JSON.stringify(
  { name: "repo", private: true, scripts: { "write:budget": "bun scripts/write-budget.ts" } },
  null,
  2,
);
const WRITER = `// Rewrites ${BUDGET} from the current sources.\nexport {};\n`;
const changelog = (...entries: string[]) =>
  `# Changelog\n\n## Unreleased\n\n${entries.map((entry) => `- ${entry}\n`).join("")}\n## 1.0.0\n\n- first\n`;
const budget = (skills: number) => `${JSON.stringify({ skills, tokens: skills * 100 }, null, 2)}\n`;
const cursorManifest = (version: string, files: string[]) =>
  `${JSON.stringify({ name: "@x/cursor", version, files }, null, 2)}\n`;
const APP = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const SKILL = "# Fanout\n\nStep 5: stop background commands.\n";

/** main with the bookkeeping files; feature/x changes code, CHANGELOG, budget and a manifest. */
const repo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-carry-bk-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  commit(
    root,
    {
      "package.json": ROOT_MANIFEST,
      "scripts/write-budget.ts": WRITER,
      "CHANGELOG.md": changelog(),
      [BUDGET]: budget(1),
      [CURSOR]: cursorManifest("1.0.0", ["skills"]),
      "skills/fanout/SKILL.md": "# Fanout\n",
    },
    "base",
  );
  git(root, "checkout", "-qb", "feature/x");
  commit(
    root,
    {
      "src/app.ts": APP,
      "skills/fanout/SKILL.md": SKILL,
      "CHANGELOG.md": changelog("agents stop background commands (#692)"),
      [BUDGET]: budget(2),
      [CURSOR]: cursorManifest("1.0.0", ["skills", "hooks/paths.mjs"]),
    },
    "feature",
  );
  return root;
};

const verdict = (root: string, kind: VerdictKind = "unit", result: VerdictResult = "verified") =>
  value(
    recordVerdict(
      { cwd: root, actor: { host: "cli", session: "reviewer-2", agentId: null } },
      { result, how: "exercised it", kind },
    ),
  );

const check = (root: string) =>
  checkVerdicts(root, "feature/x", value(readLedger(root, { integrity: true })).rows);

/**
 * main lands another PR (its CHANGELOG entry, a regenerated budget, a new
 * file) and a release sync bumps the cursor version; feature/x is then
 * rebuilt on main with the branch's own files as given (a rebase whose
 * conflicts were resolved by hand).
 */
const trunkMovesAndRebase = (root: string, own: Record<string, string> = {}) => {
  git(root, "checkout", "-q", "main");
  commit(
    root,
    {
      "src/ci.ts": "export const rerun = true;\n",
      "CHANGELOG.md": changelog("ci rerun --ref (#693)"),
      [BUDGET]: budget(3),
    },
    "feat(ci): rerun --ref (#693)",
  );
  commit(root, { [CURSOR]: cursorManifest("2.0.0", ["skills"]) }, "chore(release): sync to 2.0.0");
  git(root, "checkout", "-q", "-B", "feature/x", "main");
  commit(
    root,
    {
      "src/app.ts": APP,
      "skills/fanout/SKILL.md": SKILL,
      "CHANGELOG.md": changelog("agents stop background commands (#692)", "ci rerun --ref (#693)"),
      [BUDGET]: budget(4),
      [CURSOR]: cursorManifest("2.0.0", ["skills", "hooks/paths.mjs"]),
      ...own,
    },
    "feature (rebased)",
  );
};

test("Given a verified head, When it is rebased onto a trunk that changed CHANGELOG.md, the budget json and a manifest version the branch also touches, Then the verdict carries", () => {
  const root = repo();
  const judged = verdict(root);
  trunkMovesAndRebase(root);
  const result = check(root);
  expect(result.head).not.toBe(judged.head);
  expect(result.accepted).toMatchObject({ accepted: true, reasons: [] });
  expect(result.current.basis).toBe("carried");
  expect(result.carry).toMatchObject({ rule: "lane-none", since: judged.head as string });
  expect(result.carry?.files.toSorted()).toEqual(["CHANGELOG.md", BUDGET]);
  expect(result.reverify).toBeNull();
});

test("Given a verified head, When the rebase also changes the branch's own code, Then the verdict is stale and the code file is named", () => {
  const root = repo();
  verdict(root);
  trunkMovesAndRebase(root, { "src/app.ts": APP.replace("a + b", "b + a") });
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
  expect(result.carry).toBeNull();
  expect(result.reverify?.files).toContain("src/app.ts");
});

test("Given a verified head, When the rebase also changes the branch's agent instructions, Then the verdict is stale", () => {
  const root = repo();
  verdict(root);
  trunkMovesAndRebase(root, { "skills/fanout/SKILL.md": `${SKILL}Step 6: new rule.\n` });
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
});

test("Given a verified head, When a clean rebase onto a trunk that changed only other files follows, Then the verdict carries", () => {
  const root = repo();
  verdict(root);
  git(root, "checkout", "-q", "main");
  commit(root, { "src/ci.ts": "export const rerun = true;\n" }, "feat(ci): rerun");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: true, reasons: [] });
  expect(result.current.basis).toBe("carried");
});

const NUMBERED = (edits: Record<number, string> = {}) =>
  Array.from({ length: 20 }, (_, index) => edits[index] ?? `line ${index}`).join("\n") + "\n";

test("Given a verified head, When trunk edits a line next to the branch's hunk (the patch-id moves) and the rebase is clean, Then the verdict carries as a rebase", () => {
  const root = repo();
  git(root, "checkout", "-q", "main");
  commit(root, { "src/shared.ts": NUMBERED() }, "shared");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  commit(root, { "src/shared.ts": NUMBERED({ 2: "line 2 branch" }) }, "edit shared");
  const judged = verdict(root);
  git(root, "checkout", "-q", "main");
  commit(root, { "src/shared.ts": NUMBERED({ 4: "line 4 main" }) }, "main edits near");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: true, reasons: [] });
  expect(result.carry).toEqual({ rule: "rebase", since: judged.head as string, files: [] });
});

test("Given a verified head, When a push changes only CHANGELOG.md, the regenerated budget json and a manifest version, Then the verdict carries", () => {
  const root = repo();
  const judged = verdict(root);
  commit(
    root,
    {
      "CHANGELOG.md": changelog("agents stop background commands (#692)", "and say so"),
      [BUDGET]: budget(5),
      [CURSOR]: cursorManifest("1.0.1", ["skills", "hooks/paths.mjs"]),
    },
    "chore: bookkeeping",
  );
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: true, reasons: [] });
  expect(result.carry).toEqual({
    rule: "lane-none",
    since: judged.head as string,
    files: ["CHANGELOG.md", BUDGET, CURSOR],
  });
});

test("Given a verified head, When a manifest changes more than its version, Then the verdict is stale", () => {
  const root = repo();
  verdict(root);
  commit(root, { [CURSOR]: cursorManifest("1.0.1", ["skills"]) }, "chore: drop a file");
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
  expect(result.reverify?.files).toEqual([CURSOR]);
});

test("Given a verified head, When a json file that no write script at the base regenerates changes, Then the verdict is stale (a branch cannot mark its own file)", () => {
  const root = repo();
  verdict(root);
  commit(
    root,
    {
      "config/flags.json": '{ "fast": true }\n',
      "scripts/write-budget.ts": `${WRITER}// also config/flags.json\n`,
    },
    "feat: flags",
  );
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
});

test("Given a unit verdict on a full-lane PR, When a 148-line test-only push follows, Then it carries as tests-only", () => {
  const root = repo();
  const judged = verdict(root, "unit");
  const lines = (tag: string, count: number) =>
    Array.from({ length: count }, (_, index) => `test("${tag} ${index}", () => {});`).join("\n");
  commit(
    root,
    {
      "test/workit-core/workit-paths.test.ts": `${lines("paths", 126)}\n`,
      "test/workit-core/config-dir.test.ts": `${lines("config", 22)}\n`,
    },
    "test: resolver tests hold on a Windows host",
  );
  const result = check(root);
  expect(result.accepted).toMatchObject({ accepted: true, reasons: [] });
  expect(result.carry).toEqual({
    rule: "tests-only",
    since: judged.head as string,
    files: ["test/workit-core/config-dir.test.ts", "test/workit-core/workit-paths.test.ts"],
  });
});

test("Given a unit verdict, When a helper, a runner config or a fixture under test/ changes, Then it is not a tests-only carry", () => {
  for (const [file, content] of [
    ["test/helpers/runtime.ts", "export const runtime = () => 1;\n"],
    ["test/bunfig.toml", '[test]\npreload = ["./shared/setup.ts"]\n'],
    ["test/fixtures/x.json", '{ "x": 1 }\n'],
  ] as const) {
    const root = repo();
    verdict(root, "unit");
    commit(root, { [file]: content }, `test: ${file}`);
    const result = check(root);
    expect(result.accepted, file).toMatchObject({ accepted: false, reasons: ["stale"] });
    expect(result.carry, file).toBeNull();
  }
});

test("Given a live verdict, When the same large test-only push follows, Then it does not carry", () => {
  const root = repo();
  verdict(root, "live");
  commit(
    root,
    { "test/app.test.ts": `${"// a\n".repeat(10)}export {};\n${"x();\n".repeat(140)}` },
    "test",
  );
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
});

test("Given a unit verdict, When a test on a repo risk path changes, Then it does not carry as tests-only", () => {
  const root = repo();
  git(root, "checkout", "-q", "main");
  commit(root, { ".workit/risk-paths": "test/gates/**\n" }, "risk paths");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");
  verdict(root, "unit");
  commit(root, { "test/gates/merge.test.ts": "export {};\n" }, "test");
  expect(check(root).accepted).toMatchObject({ accepted: false, reasons: ["stale"] });
});

test("versionOnlyChange: only a top-level semver version string may differ", () => {
  expect(versionOnlyChange('{"version":"1.0.0","a":1}', '{"version":"2.0.0","a":1}')).toBe(true);
  expect(versionOnlyChange('{"version":"1.0.0","a":1}', '{"version":"2.0.0","a":2}')).toBe(false);
  expect(versionOnlyChange('{"version":1,"a":1}', '{"version":2,"a":1}')).toBe(false);
  expect(versionOnlyChange('{"a":1}', '{"version":"1.0.0","a":1}')).toBe(false);
  expect(versionOnlyChange("[1]", "[2]")).toBe(false);
  expect(versionOnlyChange(null, '{"version":"1.0.0"}')).toBe(false);
});
