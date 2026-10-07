import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { lintKnowledge } from "@/packages/workit-core/src/knowledge";

// `workit knowledge lint`: real files in temp repositories, the verb's exit
// codes, and registration as a configured check (`workit check knowledge`).

const CLI = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempRepo = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-knowledge-"));
  dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
};

const rulesOf = (root: string) =>
  lintKnowledge(root).findings.map((finding) => ({
    rule: finding.rule,
    file: finding.file,
    line: finding.line,
  }));

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "s-agent", WORKFLOW_WORKSPACE_ROOT: "" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
};

test("Given AGENTS.md of exactly 8192 bytes, Then it is within budget; at 8193 bytes it is a finding", () => {
  expect(rulesOf(tempRepo({ "AGENTS.md": "a".repeat(8192) }))).toEqual([]);
  expect(rulesOf(tempRepo({ "AGENTS.md": "a".repeat(8193) }))).toEqual([
    { rule: "agents-budget", file: "AGENTS.md", line: null },
  ]);
});

test("Given CLAUDE.md is a symlink to an oversized AGENTS.md, Then the budget is reported once; a separate oversized CLAUDE.md is reported on its own", () => {
  const linked = tempRepo({ "AGENTS.md": "a".repeat(9000) });
  symlinkSync("AGENTS.md", path.join(linked, "CLAUDE.md"));
  expect(rulesOf(linked)).toEqual([{ rule: "agents-budget", file: "AGENTS.md", line: null }]);

  const separate = tempRepo({ "AGENTS.md": "short\n", "CLAUDE.md": "b".repeat(9000) });
  expect(rulesOf(separate)).toEqual([{ rule: "agents-budget", file: "CLAUDE.md", line: null }]);
});

test("Given links and backticked pointers, Then only missing local targets are findings, with their line", () => {
  const root = tempRepo({
    "docs/present.md": "here\n",
    "AGENTS.md": [
      "# Agents", // 1
      "Read [present](docs/present.md) and [its section](docs/present.md#setup).", // 2
      "Then [gone](docs/missing.md).", // 3
      "External [site](https://example.test/x), [anchor](#agents), [mail](mailto:a@b.c).", // 4
      "Pointer `docs/present.md:12` exists; pointer `docs/renamed.md` does not.", // 5
      "Not pointers: `src/never.ts` (no src/), `npx -y pkg/cli`, `docs/<topic>/spec.md`.", // 6
      "```sh", // 7
      "cat [x](docs/also-missing.md)", // 8
      "```", // 9
      "[ref]: docs/old-ref.md", // 10
    ].join("\n"),
  });
  expect(rulesOf(root)).toEqual([
    { rule: "broken-link", file: "AGENTS.md", line: 3 },
    { rule: "broken-link", file: "AGENTS.md", line: 5 },
    { rule: "broken-link", file: "AGENTS.md", line: 10 },
  ]);
});

test("Given need-based files with only headings, comments, placeholders or a bare table header, Then each is a scaffold finding", () => {
  const root = tempRepo({
    "AGENTS.md": "Read CODING_STANDARDS.md before review.\n",
    "CODING_STANDARDS.md":
      "---\ntitle: standards\n---\n# Coding standards\n\n<!-- add rules\nlater -->\n## Tests\n\n- TBD\n- _None yet._\n- TODO: write the first rule\n\n---\n",
    "GLOSSARY.md": "# Glossary\n\n| Term | Meaning |\n| --- | --- |\n",
  });
  expect(rulesOf(root)).toEqual([
    { rule: "scaffold-file", file: "CODING_STANDARDS.md", line: null },
    { rule: "scaffold-file", file: "GLOSSARY.md", line: null },
  ]);
});

test("Given need-based files with one real entry each, Then neither is a scaffold finding", () => {
  const root = tempRepo({
    "CODING_STANDARDS.md": "# Coding standards\n\n- Parsers stay lenient on unknown keys.\n",
    "GLOSSARY.md":
      "# Glossary\n\n| Term | Meaning |\n| --- | --- |\n| Verdict | a pass/fail on a head |\n",
  });
  expect(rulesOf(root)).toEqual([]);
});

test("Given a rule that starts with TODO, Then it is an entry, while a bare TODO or a TODO: note is still a scaffold finding", () => {
  const rule = tempRepo({
    "CODING_STANDARDS.md": "# Coding standards\n\n- TODO comments name a tracker issue.\n",
  });
  expect(rulesOf(rule)).toEqual([]);
  for (const placeholder of ["- TODO", "- TODO: add rules"]) {
    const root = tempRepo({ "CODING_STANDARDS.md": `# Coding standards\n\n${placeholder}\n` });
    expect(rulesOf(root), placeholder).toEqual([
      { rule: "scaffold-file", file: "CODING_STANDARDS.md", line: null },
    ]);
  }
});

test("Given the same rule wrapped and marked up differently in AGENTS.md and CODING_STANDARDS.md, Then it is one duplicate finding; short shared phrases are not", () => {
  const root = tempRepo({
    "AGENTS.md": [
      "# Agents", // 1
      "", // 2
      "- Run the tests.", // 3
      "- Never run root `build` in a checkout a live host", // 4
      "  has loaded.", // 5
    ].join("\n"),
    "CODING_STANDARDS.md": [
      "# Standards",
      "",
      "Run the tests. Hooks fail open and never answer allow.",
      "",
      "- **Never** run root build in a checkout a live host has loaded",
    ].join("\n"),
  });
  const findings = lintKnowledge(root).findings;
  expect(findings.map(({ rule, file, line }) => ({ rule, file, line }))).toEqual([
    { rule: "duplicate-rule", file: "AGENTS.md", line: 4 },
  ]);
  expect(findings[0].message).toContain("CODING_STANDARDS.md:5");
});

test("Given a clean repo and a broken one, When workit knowledge lint runs, Then it exits 0 and 1 and lists each finding", async () => {
  const clean = tempRepo({
    "AGENTS.md": "# Agents\n\nRead [standards](CODING_STANDARDS.md).\n",
    "CODING_STANDARDS.md": "- Parsers stay lenient on unknown keys.\n",
  });
  const ok = await run(clean, ["knowledge", "lint"]);
  expect(ok.code).toBe(0);
  expect(ok.stdout).toContain("knowledge lint: 0 findings in 2 files");

  const broken = tempRepo({ "AGENTS.md": "# Agents\n\nRead [standards](CODING_STANDARDS.md).\n" });
  const bad = await run(broken, ["knowledge", "lint"]);
  expect(bad.code).toBe(1);
  expect(bad.stdout).toContain("AGENTS.md:3 [broken-link]");

  const json = await run(broken, ["knowledge", "lint", "--json"]);
  expect(json.code).toBe(1);
  const envelope = JSON.parse(json.stdout);
  expect(envelope).toMatchObject({ ok: false, code: "failed" });
  expect(envelope.data.findings).toHaveLength(1);

  expect((await run(clean, ["knowledge"])).code).toBe(2);
});

test("Given workit.checks.json registers knowledge, When workit check knowledge runs, Then the configured check fails on a finding and passes once fixed", async () => {
  const root = tempRepo({
    "AGENTS.md": "# Agents\n\nSee [gone](docs/gone.md).\n",
    "workit.checks.json": JSON.stringify({
      checks: { knowledge: [process.execPath, CLI, "knowledge", "lint"] },
    }),
  });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Workit Test");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature/knowledge");

  const failing = await run(root, ["check", "knowledge", "--json"]);
  expect(failing.code).toBe(1);
  expect(JSON.parse(failing.stdout).data).toMatchObject({ name: "knowledge", configured: true });

  writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n\nSee the README.\n");
  const passing = await run(root, ["check", "knowledge", "--json"]);
  expect(passing.code).toBe(0);
});

const gitRepo = (root: string) => {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("add", ".");
  return root;
};

test("Given dot-directory pointers, Then only ./ and ../ are relative, and a dot-dir must be a tracked top-level entry", () => {
  const root = gitRepo(
    tempRepo({
      ".github/workflows/ci.yml": "on: push\n",
      "AGENTS.md": [
        "CI lives in `.github/workflows/ci.yml`; `.github/workflows/gone.yml` is stale.", // 1
        "Not pointers: `.out-of-scope/x.md` and `.claude/settings.local.json`.", // 2
        "Relative: `./docs/missing.md`.", // 3
      ].join("\n"),
    }),
  );
  // Present on disk but untracked: still not a pointer, so local and CI agree.
  mkdirSync(path.join(root, ".claude"));
  writeFileSync(path.join(root, ".claude/other.json"), "{}");
  expect(rulesOf(root)).toEqual([
    { rule: "broken-link", file: "AGENTS.md", line: 1 },
    { rule: "broken-link", file: "AGENTS.md", line: 3 },
  ]);
});

test("Given links in inline code, indented code and long fences, and a target with parentheses, Then only real links are checked", () => {
  const root = tempRepo({
    "docs/a (v2).md": "here\n",
    "AGENTS.md": [
      "Example syntax: `[x](docs/inline-missing.md)`.", // 1
      "", // 2
      "    [x](docs/indented-missing.md)", // 3
      "", // 4
      "````md", // 5
      "```", // 6
      "[x](docs/fenced-missing.md)", // 7
      "````", // 8
      "Read [v2](docs/a%20(v2).md) and [old](docs/old(v1).md).", // 9
      "- a list item", // 10
      "", // 11
      "    continued [gone](docs/list-missing.md)", // 12
    ].join("\n"),
  });
  expect(rulesOf(root)).toEqual([
    { rule: "broken-link", file: "AGENTS.md", line: 9 },
    { rule: "broken-link", file: "AGENTS.md", line: 12 },
  ]);
  expect(lintKnowledge(root).findings[0].message).toContain("docs/old(v1).md");
});

const asRoot = process.getuid?.() === 0;

test.skipIf(asRoot)(
  "Given an unreadable AGENTS.md, When workit knowledge lint runs, Then it reports unavailable (exit 5) instead of crashing",
  async () => {
    const root = tempRepo({ "AGENTS.md": "# Agents\n" });
    chmodSync(path.join(root, "AGENTS.md"), 0o000);
    try {
      expect(lintKnowledge(root).unreadable).toEqual(["AGENTS.md"]);
      const result = await run(root, ["knowledge", "lint", "--json"]);
      expect(result.code).toBe(5);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "unavailable" });
    } finally {
      chmodSync(path.join(root, "AGENTS.md"), 0o644);
    }
  },
);
