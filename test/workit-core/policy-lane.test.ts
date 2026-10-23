import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LANE_THRESHOLDS,
  branchLane,
  changedFiles,
  computeLane,
  isRiskPath,
  laneGate,
  parseRiskPaths,
  type ChangedFile,
  type LaneInput,
} from "@/packages/workit-core/src/core/policy/lane";
import { cosmeticChange } from "@/packages/workit-core/src/core/policy/substance";

// #333 review lanes: none / self / focused / full, computed from the diff.

const file = (name: string, lines = 1, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path: name,
  added: lines,
  deleted: 0,
  ...extra,
});
const lane = (files: ChangedFile[], extra: Omit<LaneInput, "files"> = {}) =>
  computeLane({ files, ...extra }).lane;

test("none: docs, comment or formatting-only files and generated copies need no review", () => {
  expect(lane([file("README.md", 40), file("docs/guide/verification.md", 300)])).toBe("none");
  expect(lane([file("src/a.ts", 3, { cosmetic: true })])).toBe("none");
  expect(lane([file("packages/x/skills/a/SKILL.md", 5, { generated: true })])).toBe("none");
  // Only the base revision's .gitattributes marks a copy generated, never its path.
  expect(lane([file("src/api.generated.ts", 900)])).toBe("full");
  expect(lane([])).toBe("none");
});

test("self: a small behavior change off risk paths; agent instructions are behavior", () => {
  expect(lane([file("src/a.ts", 3), file("test/a.test.ts", 20)])).toBe("self");
  expect(lane([file("packages/core/skills/review/SKILL.md", 4)])).toBe("self");
  expect(lane([file("AGENTS.md", 2)])).toBe("self");
  // A lockfile changes what runs; its size never counts, and it is never self.
  expect(lane([file("bun.lock", 4000)])).toBe("focused");
  expect(lane([file("src/a.ts", 3), file("bun.lock", 4000)])).toBe("focused");
});

test("a recorded judgment only raises: high risk lifts anything to full; normal or trivial risk never lowers", () => {
  expect(lane([file("README.md")], { riskTier: "high" })).toBe("full");
  expect(lane([file("src/a.ts", 2)], { riskTier: "trivial" })).toBe("self");
  expect(lane([file("src/hooks/a.ts", 2)], { riskTier: "normal" })).toBe("full");
});

test("focused: more than selfMaxLines lines or selfMaxFiles behavior files", () => {
  const { selfMaxLines, selfMaxFiles, fullMinLines } = LANE_THRESHOLDS;
  expect(lane([file("src/a.ts", selfMaxLines)])).toBe("self");
  expect(lane([file("src/a.ts", selfMaxLines + 1)])).toBe("focused");
  expect(
    lane(Array.from({ length: selfMaxFiles + 1 }, (_, index) => file(`src/f${index}.ts`))),
  ).toBe("focused");
  expect(lane([file("src/a.ts", fullMinLines - 1)])).toBe("focused");
  // Docs lines never count toward size.
  expect(lane([file("src/a.ts", 2), file("docs/big.md", 5000)])).toBe("self");
});

test("full: a large diff or any behavior file on a risk path", () => {
  expect(lane([file("src/a.ts", LANE_THRESHOLDS.fullMinLines)])).toBe("full");
  const assessed = computeLane({ files: [file("src/a.ts"), file("src/hooks/stop.ts", 2)] });
  expect(assessed).toMatchObject({ lane: "full", riskFiles: ["src/hooks/stop.ts"] });
  expect(assessed.reasons[0]).toContain("risk path: src/hooks/stop.ts");
});

test("risk paths: gates, hooks, auth, release, migrations and CI; never tests or docs", () => {
  for (const risky of [
    "packages/core/src/core/policy/derive.ts",
    "src/hooks/stop.ts",
    "src/auth/session.ts",
    "src/oauth-client.ts",
    "app/auth.service.ts",
    "packages/cli/src/verbs/release.ts",
    "db/migrations/0001_init.sql",
    ".github/workflows/ci.yml",
    ".gitlab-ci.yml",
    "src/merge-gate.ts",
  ])
    expect(isRiskPath(risky)).toBe(true);
  for (const plain of [
    "src/author.ts",
    "src/feature.ts",
    "test/workit-core/hooks/stop.test.ts",
    "src/hooks/stop.test.ts",
  ])
    expect(isRiskPath(plain)).toBe(false);
  expect(lane([file("docs/guides/release.md", 3)])).toBe("none");
  // Markdown under an agents/ folder steers agents: behavior, so its path counts.
  expect(lane([file("docs/agents/release.md", 3)])).toBe("full");
  expect(lane([file("test/hooks/stop.test.ts", 3)])).toBe("self");
});

test("configured risk paths only tighten: a matching glob makes the lane full", () => {
  expect(lane([file("db/schema/0002.sql", 2)])).toBe("self");
  expect(lane([file("db/schema/0002.sql", 2)], { riskPaths: ["db/schema/**"] })).toBe("full");
  expect(lane([file("src/billing/charge.ts", 2)], { riskPaths: ["src/billing"] })).toBe("full");
});

// laneGate: what each lane asks of the ledger.

const verdict = (id: string) => ({ id }) as never;
const check = (
  accepted: string | null,
  self: string | null,
  reasons: string[] = accepted ? [] : ["no_verdict"],
) =>
  ({
    accepted: {
      accepted: accepted !== null,
      verdict: accepted ? verdict(accepted) : null,
      reasons,
    },
    selfVerdict: self ? verdict(self) : null,
  }) as never;

test("laneGate under proportional: none needs nothing, self takes the author's own, focused and full need a non-author verdict", () => {
  expect(laneGate(check(null, null), "proportional", { lane: "none" })).toMatchObject({
    need: "none",
    satisfied: true,
    verdictId: null,
  });
  expect(laneGate(check(null, "v-self"), "proportional", { lane: "self" })).toMatchObject({
    need: "self",
    satisfied: true,
    verdictId: "v-self",
    review: "self-reviewed",
  });
  expect(laneGate(check(null, null), "proportional", { lane: "self" }).satisfied).toBe(false);
  for (const name of ["focused", "full"] as const) {
    expect(laneGate(check(null, "v-self"), "proportional", { lane: name })).toMatchObject({
      need: "non-author",
      satisfied: false,
    });
    expect(laneGate(check("v-ind", null), "proportional", { lane: name })).toMatchObject({
      satisfied: true,
      verdictId: "v-ind",
      review: "verified",
    });
  }
});

test("laneGate: a current independent failure or a tampered ledger blocks every lane, even none", () => {
  expect(
    laneGate(check(null, null, ["failing_verdict"]), "proportional", { lane: "none" }).satisfied,
  ).toBe(false);
  expect(
    laneGate(check(null, null, ["ledger_tampered"]), "proportional", { lane: "none" }).satisfied,
  ).toBe(false);
});

test("laneGate under self or independent ignores the lane: an accepted non-author verdict, as before", () => {
  for (const mode of ["self", "independent"] as const) {
    expect(laneGate(check(null, null), mode, { lane: "none" })).toMatchObject({
      need: "non-author",
      satisfied: false,
    });
    expect(laneGate(check(null, "v-self"), mode, { lane: "self" }).satisfied).toBe(false);
    expect(laneGate(check("v-ind", null), mode, { lane: "full" }).satisfied).toBe(true);
  }
});

// The diff read from git.

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};
const write = (root: string, name: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), text);
};
const repoWith = (base: Record<string, string>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-lane-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  for (const [name, text] of Object.entries(base)) write(root, name, text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "switch", "-q", "-c", "feature/x");
  return root;
};
const commitAll = (root: string) => {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "change");
  return git(root, "rev-parse", "HEAD");
};

test("from git: whitespace-only and comment-only edits are cosmetic, a code edit is not", () => {
  const root = repoWith({
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "// old note\nexport const b = 2;\n",
    "src/c.py": "x = 1\n",
    "src/d.ts": "export const d = 4;\n",
  });
  write(root, "src/a.ts", "export const a  =  1;\n\n");
  write(root, "src/b.ts", "// a new, longer note\n/* and a block */\nexport const b = 2;\n");
  write(root, "src/c.py", "# why x\nx = 1\n");
  write(root, "src/d.ts", "export const d = 5;\n");
  const head = commitAll(root);
  const files = changedFiles(root, "main", head) ?? [];
  const cosmetic = Object.fromEntries(files.map((entry) => [entry.path, entry.cosmetic]));
  expect(cosmetic).toEqual({
    "src/a.ts": true,
    "src/b.ts": true,
    "src/c.py": true,
    "src/d.ts": false,
  });
  expect(branchLane(root, { base: "main", head })).toMatchObject({ lane: "self", files: 1 });
});

test("from git: .gitattributes linguist-generated marks generated copies; the working tree counts untracked files", () => {
  const root = repoWith({
    ".gitattributes": "copies/** linguist-generated\n",
    "copies/a.ts": "export const a = 1;\n",
  });
  write(root, "copies/a.ts", "export const a = 2;\n");
  const head = commitAll(root);
  expect(branchLane(root, { base: "main", head }).lane).toBe("none");
  write(root, "src/new.ts", "export const n = 1;\n");
  expect(branchLane(root, { base: "main", head: null, workingTree: true })).toMatchObject({
    lane: "self",
    files: 1,
  });
});

test("from git: an unreadable diff is focused, never none", () => {
  const root = repoWith({ "a.ts": "1\n" });
  expect(branchLane(root, { base: "main", head: "0".repeat(40) })).toMatchObject({
    lane: "focused",
  });
});

// Review finding mvkcoxgb: the lane fails closed. Any doubt about a file is a
// behavior change, and a risk path is never below full.

/** The lane of one commit on top of `base` that writes `change` (null deletes). */
const laneOf = (base: Record<string, string>, change: Record<string, string | null>) => {
  const root = repoWith(base);
  for (const [name, text] of Object.entries(change))
    if (text === null) rmSync(path.join(root, name));
    else write(root, name, text);
  const head = commitAll(root);
  return branchLane(root, { base: "main", head });
};

test("comments: code after a block comment, an HTML comment or a continuation star is code", () => {
  const login = {
    "src/auth/login.ts": 'export function check(t) {\n  return t === "ok";\n}\n',
  };
  expect(
    laneOf(login, {
      "src/auth/login.ts": "export function check(t) {\n  /* audited */ return true;\n}\n",
    }).lane,
  ).toBe("full");
  const app = {
    "src/app/a.ts": "export function check(t) {\n  return t;\n}\n",
  };
  expect(
    laneOf(app, {
      "src/app/a.ts": "export function check(t) {\n  /* audited */ return true;\n}\n",
    }).lane,
  ).toBe("self");
  expect(
    laneOf(
      { "web/page.html": "<p>hi</p>\n" },
      { "web/page.html": "<p>hi</p>\n<!-- x --><script>alert(1)</script>\n" },
    ).lane,
  ).toBe("self");
  expect(
    laneOf(
      { "src/app/t.ts": "export const ms = 60\n  * 60;\n" },
      { "src/app/t.ts": "export const ms = 60\n  * 1000;\n" },
    ).lane,
  ).toBe("self");
});

test("comments: a comment-looking line inside a template literal or string is code", () => {
  expect(
    laneOf(
      { "src/app/s.ts": "export const url = `\nhttps://ok\n`;\n" },
      {
        "src/app/s.ts": "export const url = `\n// http://evil\nhttps://ok\n`;\n",
      },
    ).lane,
  ).toBe("self");
  expect(
    laneOf(
      { "src/app/s.py": 'X = """\nkeep\n"""\n' },
      { "src/app/s.py": 'X = """\n# injected\nkeep\n"""\n' },
    ).lane,
  ).toBe("self");
  // Whitespace inside a string is the string's value.
  expect(
    laneOf(
      { "src/app/w.ts": 'export const s = "a b";\n' },
      { "src/app/w.ts": 'export const s = "a  b";\n' },
    ).lane,
  ).toBe("self");
});

test("comments: a changed shebang, a directive comment, a workflow comment are code", () => {
  expect(
    laneOf(
      { "scripts/run.sh": "#!/bin/sh\necho hi\n" },
      { "scripts/run.sh": "#!/bin/bash\necho hi\n" },
    ).lane,
  ).toBe("self");
  expect(
    laneOf(
      { "src/app/d.ts": "export const d: number = 1;\n" },
      { "src/app/d.ts": "// @ts-nocheck\nexport const d: number = 1;\n" },
    ).lane,
  ).toBe("self");
  expect(
    laneOf(
      { ".github/workflows/ci.yml": "on: push\njobs: {}\n" },
      { ".github/workflows/ci.yml": "# note\non: push\njobs: {}\n" },
    ).lane,
  ).toBe("full");
  // A plain comment edit off risk paths stays none.
  expect(
    laneOf(
      { "src/app/c.ts": "// old\nexport const c = 1; // why\n" },
      {
        "src/app/c.ts": "// new, longer\n/* block\n * more */\nexport const c = 1; // because\n",
      },
    ).lane,
  ).toBe("none");
});

test("a risk path is never below full: comment-only, generated, lockfile", () => {
  expect(
    laneOf(
      { "src/auth/login.ts": "export const ok = 1;\n" },
      { "src/auth/login.ts": "// audited\nexport const ok = 1;\n" },
    ).lane,
  ).toBe("full");
  expect(
    laneOf(
      {
        ".gitattributes": "src/hooks/** linguist-generated\n",
        "src/hooks/g.ts": "export const g = 1;\n",
      },
      { "src/hooks/g.ts": "export const g = 2;\n" },
    ).lane,
  ).toBe("full");
  expect(lane([file("src/hooks/a.ts", 2, { cosmetic: true })])).toBe("full");
  expect(lane([file("src/auth/bun.lock", 2)])).toBe("full");
});

test("paths with spaces, quotes or non-ASCII characters are read, never dropped", () => {
  for (const name of [
    "src/auth/check token.ts",
    'src/auth/we"ird.ts',
    "src/auth/sesión.ts",
    "src/auth/back\\slash.ts",
  ])
    expect(
      laneOf({ [name]: "export const a = 1;\n" }, { [name]: "export const a = 2;\n" }),
    ).toMatchObject({ lane: "full", riskFiles: [name] });
  expect(
    laneOf(
      { "src/app/check token.ts": "export const a = 1;\n" },
      { "src/app/check token.ts": "export const a = 2;\n" },
    ).lane,
  ).toBe("self");
});

test("generated: only the base tree's .gitattributes counts; .git/info/attributes and the PR's own never do", () => {
  const root = repoWith({ "src/app/a.ts": "export const a = 1;\n" });
  write(root, "src/app/a.ts", "export const a = 2;\n");
  const head = commitAll(root);
  writeFileSync(path.join(root, ".git/info/attributes"), "* linguist-generated\n");
  expect(branchLane(root, { base: "main", head }).lane).toBe("self");
  // The PR marking its own code generated is a .gitattributes change: full.
  expect(
    laneOf(
      { "src/app/a.ts": "export const a = 1;\n" },
      {
        ".gitattributes": "src/** linguist-generated\n",
        "src/app/a.ts": "export const a = 2;\n",
      },
    ).lane,
  ).toBe("full");
  // A nested .gitattributes at the base applies to its directory.
  expect(
    laneOf(
      {
        "gen/.gitattributes": "*.ts linguist-generated\n",
        "gen/x.ts": "export const x = 1;\n",
      },
      { "gen/x.ts": "export const x = 2;\n" },
    ).lane,
  ).toBe("none");
  // The working tree's .gitattributes is not read either.
  const tree = repoWith({ "src/app/a.ts": "export const a = 1;\n" });
  write(tree, "src/app/a.ts", "export const a = 2;\n");
  git(tree, "add", "src/app/a.ts");
  git(tree, "commit", "-q", "-m", "change");
  write(tree, ".gitattributes", "* linguist-generated\n");
  expect(branchLane(tree, { base: "main", head: git(tree, "rev-parse", "HEAD") }).lane).toBe(
    "self",
  );
});

test("docs by extension only: code under docs/ or a generated/ folder is behavior", () => {
  expect(lane([file("docs/conf.py", 3)])).toBe("self");
  expect(lane([file("docs/notes.txt", 3), file("CHANGELOG", 3), file("LICENSE.md", 3)])).toBe(
    "none",
  );
  expect(lane([file("src/generated/api.ts", 3)])).toBe("self");
  expect(lane([file("src/api.generated.ts", 3)])).toBe("self");
  expect(lane([file("LICENSE.sh", 3)])).toBe("self");
});

test("indentation-sensitive files: only trailing whitespace is cosmetic", () => {
  const py = {
    "src/app/m.py": "def f(x):\n    if x:\n        a()\n        b()\n",
  };
  expect(
    laneOf(py, {
      "src/app/m.py": "def f(x):\n    if x:\n        a()\n    b()\n",
    }).lane,
  ).toBe("self");
  expect(
    laneOf(py, {
      "src/app/m.py": "def f(x):  \n    if x:\n        a()\n        b()\n",
    }).lane,
  ).toBe("none");
  expect(
    laneOf({ "conf/a.yml": "a:\n  b: 1\nc: 2\n" }, { "conf/a.yml": "a:\n  b: 1\n  c: 2\n" }).lane,
  ).toBe("self");
  expect(laneOf({ "conf/a.foo": "x\n  y\n" }, { "conf/a.foo": "x\ny\n" }).lane).toBe("self");
  expect(
    laneOf({ "conf/Makefile": "a:\n\techo a\n" }, { "conf/Makefile": "a:\n        echo a\n" }).lane,
  ).toBe("self");
});

test("repo risk paths: .workit/risk-paths at the base tightens; the PR cannot loosen it", () => {
  const base = {
    ".workit/risk-paths": "# billing is risky\n\nsrc/billing/**\n",
    "src/billing/charge.ts": "export const fee = 1;\n",
  };
  expect(laneOf(base, { "src/billing/charge.ts": "export const fee = 2;\n" })).toMatchObject({
    lane: "full",
    riskFiles: ["src/billing/charge.ts"],
  });
  expect(
    laneOf(base, {
      ".workit/risk-paths": null,
      "src/billing/charge.ts": "export const fee = 2;\n",
    }).riskFiles,
  ).toContain("src/billing/charge.ts");
  // A risk-paths file the PR adds is not read for that PR, but it is itself a risk path.
  expect(
    laneOf({ "src/app/a.ts": "export const a = 1;\n" }, { ".workit/risk-paths": "src/app/**\n" })
      .lane,
  ).toBe("full");
});

test("substance: the lexer reads strings, regexes and comments with the whole file as context", () => {
  const cosmetic = (name: string, before: string, after: string) =>
    cosmeticChange(name, Buffer.from(before), Buffer.from(after));
  // A JSDoc line edited in place is a comment: the block opens lines above.
  expect(
    cosmetic(
      "a.ts",
      "/**\n * Old.\n * @x\n */\nexport const a = 1;\n",
      "/**\n * New.\n * @x\n */\nexport const a = 1;\n",
    ),
  ).toBe(true);
  // `//` inside a regex is the regex, not a comment.
  expect(cosmetic("a.ts", "const r = /a\\/\\/b/; go(1);\n", "const r = /a\\/\\/b/; go(2);\n")).toBe(
    false,
  );
  expect(cosmetic("a.ts", "const x = a / b; // half\n", "const x = a / b; // a half\n")).toBe(true);
  // A template literal's text and its `${}` code.
  expect(cosmetic("a.ts", "const s = `${a /* c */}`;\n", "const s = `${a}`;\n")).toBe(true);
  expect(cosmetic("a.ts", "const s = `x ${a} y`;\n", "const s = `x ${a}  y`;\n")).toBe(false);
  // Go raw strings, Python trailing comments, TOML literal strings.
  expect(cosmetic("a.go", "var s = `a // b`\n", "var s = `a // c`\n")).toBe(false);
  expect(cosmetic("a.py", "x = 1  # one\n", "x = 1  # uno\n")).toBe(true);
  expect(cosmetic("a.toml", "p = 'C:\\' # dir\n", "p = 'C:\\' # folder\n")).toBe(true);
  // Unterminated strings or comments, invalid UTF-8 and binaries are substantive.
  expect(cosmetic("a.ts", "const s = 'x\n", "const s = 'x\n// c\n")).toBe(false);
  expect(cosmetic("a.ts", "/* open\n", "/* open, longer\n")).toBe(false);
  expect(
    cosmeticChange("a.txt", Buffer.from([0x61, 0xff, 0x0a]), Buffer.from([0x61, 0xfe, 0x0a])),
  ).toBe(false);
  // No lexer (shell, YAML, JSX): only trailing whitespace and blank lines.
  expect(cosmetic("a.sh", "echo hi\n", "# note\necho hi\n")).toBe(false);
  expect(cosmetic("a.sh", "echo hi\n", "echo hi   \n\n")).toBe(true);
  expect(cosmetic("a.tsx", "<p>don't</p>\n", "<p>don't</p>  \n")).toBe(true);
});

test("lane: a lone CR, U+2028 or U+2029 makes a file opaque (at least focused); CRLF stays cosmetic", () => {
  const order = ["none", "self", "focused", "full"];
  const atLeastFocused = (name: string) => order.indexOf(name) >= order.indexOf("focused");
  for (const [name, before, after] of [
    ["src/app/a.ts", "// note\rexport const x = 1;\n", "// note\rexport const x = 2;\n"],
    ["src/app/a.py", "# note\rx = 1\n", "# note\rx = 2\n"],
    ["src/app/a.ts", "// note\u2028export const x = 1;\n", "// note\u2028export const x = 2;\n"],
    ["src/app/a.ts", "// note\u2029export const x = 1;\n", "// note\u2029export const x = 2;\n"],
  ])
    expect(atLeastFocused(laneOf({ [name]: before }, { [name]: after }).lane)).toBe(true);
  // An untracked file with the same shape counts too.
  const root = repoWith({ "src/app/b.ts": "export const b = 1;\n" });
  write(root, "src/app/new.ts", "// note\rexport const x = 1;\n");
  expect(
    atLeastFocused(branchLane(root, { base: "main", head: null, workingTree: true }).lane),
  ).toBe(true);
  expect(
    laneOf(
      { "src/app/a.ts": "export const x = 1;\n// c\n" },
      { "src/app/a.ts": "export const x = 1;\r\n// c  \r\n" },
    ).lane,
  ).toBe("none");
});

const lexCases: [string, string, string, string][] = [
  [
    "js regex after )",
    "a.ts",
    "if (ok) /x\\/\\//.test(u) && safe();\n",
    "if (ok) /x\\/\\//.test(u) && evil();\n",
  ],
  ["js CR line terminator", "a.ts", "// note\rsafe();\n", "// note\revil();\n"],
  ["js U+2028", "a.ts", "// note\u2028safe();\n", "// note\u2028evil();\n"],
  ["js U+2029", "a.js", "/* a */ x = 1; // n\u2029y = 2;\n", "/* a */ x = 1; // n\u2029y = 3;\n"],
  ["py CR", "a.py", "# c\rsafe()\n", "# c\revil()\n"],
  [
    "py nested fstring 3.12",
    "a.py",
    'print(f"{d["#"]}"); safe()\n',
    'print(f"{d["#"]}"); evil()\n',
  ],
  ["py rb prefix", "a.py", 'x = rb"\\\\" # c\nsafe()\n', 'x = rb"\\\\" # c\nevil()\n'],
  ["cpp raw string", "a.cpp", 'auto s = R"(a" // )"; safe();\n', 'auto s = R"(a" // )"; evil();\n'],
  [
    "cs verbatim",
    "a.cs",
    'var s = @"\\" + "/*"; safe(); // */\n',
    'var s = @"\\" + "/*"; evil(); // */\n',
  ],
  [
    "rust char quote",
    "a.rs",
    'let a = \'"\'; let b = "//"; safe();\n',
    'let a = \'"\'; let b = "//"; evil();\n',
  ],
  ["rust raw string", "a.rs", 'let s = r#"a" // "#; safe();\n', 'let s = r#"a" // "#; evil();\n'],
  [
    "sql backslash",
    "q.sql",
    "SELECT 'C:\\', 'x -- ', safe FROM t;\n",
    "SELECT 'C:\\', 'x -- ', evil FROM t;\n",
  ],
  [
    "css url",
    "a.css",
    "a{background:url(/*);color:red}\nb{} /* */\n",
    "a{background:url(/*);color:blue}\nb{} /* */\n",
  ],
  ["c trigraph", "a.c", 's = "??/"; /* "; safe(); /* */\n', 's = "??/"; /* "; evil(); /* */\n'],
  ["c line-comment backslash", "a.c", "// note \\\nsafe();\n", "// note \\\nevil();\n"],
  ["c preproc", "a.c", "#define X 1\n", "#define X 2\n"],
  ["toml multiline", "a.toml", 'a = """\nx # y\n"""\n', 'a = """\nx # z\n"""\n'],
  ["toml literal ml", "a.toml", "a = '''\nx \\''' # c\nb = 1\n", "a = '''\nx \\''' # c\nb = 2\n"],
  [
    "html string",
    "a.html",
    '<a title="x"><!-- c --></a>\n<p>1</p>\n',
    '<a title="x"><!-- c --></a>\n<p>2</p>\n',
  ],
  ["bom", "a.ts", "\uFEFFx = 1;\n", "x = 1;\n"],
  ["crlf", "a.ts", "x = 1;\r\n", "x = 1;\n"],
  ["js keyword-like regex", "a.ts", "x = a\n/re/g.test(s) // c\n", "x = a\n/re/g.test(t) // c\n"],
  ["js div after ]", "a.ts", "y = arr[0] / 2 // c\n", "y = arr[0] / 3 // c\n"],
  ["go", "a.go", "s := `a//` + x // c\n", "s := `a//` + y // c\n"],
  ["swift multiline", "a.swift", 's = """\na // b\n"""\n', 's = """\na // c\n"""\n'],
  [
    "js }/ regex",
    "a.ts",
    "if (a) {}\n/x/.test(s) ? safe() : 0\n",
    "if (a) {}\n/x/.test(s) ? evil() : 0\n",
  ],
  ["js obj division", "a.ts", "v = {a:1}.a / 2 + 3 // /\n", "v = {a:1}.a / 2 + 4 // /\n"],
  [
    "js `}` from block then divide",
    "a.ts",
    "f = function(){} / 1 / 2 // c\n",
    "f = function(){} / 1 / 3 // c\n",
  ],
  ["ts generic >", "a.ts", "let x = a<b>/1/2 // c\n", "let x = a<b>/1/3 // c\n"],
  [
    "kotlin char",
    "a.kt",
    'val c = \'"\'; val s = "//"; safe()\n',
    'val c = \'"\'; val s = "//"; evil()\n',
  ],
  ["py string prefix u", "a.py", "x = u'#'; safe()\n", "x = u'#'; evil()\n"],
];

test("substance: every reviewed lexer probe fails closed; BOM and CRLF stay cosmetic", () => {
  for (const [name, probe, before, after] of lexCases) {
    const expected = name === "bom" || name === "crlf";
    expect([name, cosmeticChange(probe, Buffer.from(before), Buffer.from(after))]).toEqual([
      name,
      expected,
    ]);
  }
});

test("substance: unlexed languages keep their comments; lexed ones fail closed on what they misread", () => {
  const cosmetic = (name: string, before: string, after: string) =>
    cosmeticChange(name, Buffer.from(before), Buffer.from(after));
  for (const ext of ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "cs", "rs", "sql"]) {
    expect(cosmetic(`a.${ext}`, "x();\n", "// note\nx();\n")).toBe(false);
    expect(cosmetic(`a.${ext}`, "x();\n", "x();   \n\n")).toBe(true);
  }
  expect(cosmetic("a.py", 'x = f"{{a}} {b}" # c\n', 'x = f"{{a}} {b}" # d\n')).toBe(true);
  expect(cosmetic("a.py", 'x = f"{a" # c\n', 'x = f"{a" # d\n')).toBe(false);
  expect(
    cosmetic("a.css", 'a{background:url("x")} /* c */\n', 'a{background:url("x")} /* d */\n'),
  ).toBe(true);
  expect(
    cosmetic("a.css", "a{background:url(x)} /* c */\n", "a{background:url(x)} /* d */\n"),
  ).toBe(false);
  expect(cosmetic("a.ts", "y = f(a) / 2;\n// c\n", "y = f(a) / 2;\n// d\n")).toBe(true);
  expect(cosmetic("a.ts", "y = f(a) / 2 / 3; // c\n", "y = f(a) / 2 / 3; // d\n")).toBe(false);
});

test("this repository's .workit/risk-paths names real gate files", () => {
  const root = path.resolve(import.meta.dir, "../..");
  const globs = parseRiskPaths(readFileSync(path.join(root, ".workit/risk-paths"), "utf8"));
  expect(globs).toContain("packages/workit-core/src/core/policy/**");
  for (const glob of globs.filter((entry) => !entry.includes("*")))
    expect(existsSync(path.join(root, glob))).toBe(true);
  for (const gate of [
    "packages/workit-core/src/forge/pr-ops.ts",
    "packages/workit-cli/src/verbs/grant.ts",
    "packages/workit-core/src/core/policy/lane.ts",
    "packages/workit-core/src/hooks/stop.ts",
  ])
    expect(isRiskPath(gate, globs)).toBe(true);
  expect(isRiskPath("packages/workit-core/src/core/hygiene.ts", globs)).toBe(false);
});

test("lockfile-only and binary-only changes are focused, not self", () => {
  expect(lane([file("bun.lock", 4)])).toBe("focused");
  expect(lane([file("assets/logo.png", 0, { binary: true })])).toBe("focused");
});
