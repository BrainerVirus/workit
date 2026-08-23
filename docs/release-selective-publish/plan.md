# Release Selective Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/release-selective-publish/spec.md`
**Branch:** `bugfix/release-selective-publish`

**Goal:** Gate releases on product-path changes and publish only packages whose payload changed since the previous tag.

**Architecture:** Two new Bun scripts wired through `@semantic-release/exec`: an `analyzeCmd` that replaces message-only analysis with path-aware gating, and a `publishCmd` that publishes only drifted packages. The four npm plugins stay as prepare-time bumpers with `npmPublish: false`; lockstep versioning and AR-15 sync are untouched.

**Tech Stack:** Bun + TypeScript scripts, `node:child_process` git plumbing, semantic-release exec hooks, `bun:test` fixture repositories.

## Global Constraints

- Product path = any tracked file under `packages/workit-core/`, `packages/workit-opencode/`, `packages/workit-cursor/`, or `packages/workit-cli/` (spec: Data flow / contracts).
- Root-level `README.md`, `AGENTS.md`, `.github/`, `test/`, `docs/` are non-product and can never trigger a release.
- Release level precedence: BREAKING CHANGE → `major`, `feat` → `minor`, `fix`/`perf` → `patch`; highest wins; non-conventional subjects ignored.
- First-ever release (no previous `v*` tag): default level `minor`, all four packages treated as changed.
- Skip log line format, exact: `skip <pkg> (no payload change since <tag>)`.
- The four `@semantic-release/npm` plugins remain configured with `npmPublish: false` (prepare-time version bumps preserved).
- Lockstep versions: AR-15 sync behavior unchanged; no new runtime dependencies anywhere.
- Orchestration pins (spec CA-08): `analyzeCmd` present, four `npmPublish: false` entries, `publishCmd` between the last npm plugin and `@semantic-release/github`.

---

### Task 1: Path-gated release analyzer

**Files:**
- Create: `packages/workit-core/scripts/analyze-release-scope.ts`
- Test: `test/workit-core/analyze-release-scope.test.ts`

**Interfaces:**
- Produces: `latestTag(root?: string): string | null` — newest `v*` tag or `null` when none exists.
- Produces: `analyzeReleaseScope(root: string): { level: "major" | "minor" | "patch" | null; productPkgs: string[] }` — `level: null` means "no release"; `productPkgs` lists packages whose files changed since the previous tag (used by tests; Task 2 recomputes independently).
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeReleaseScope,
  latestTag,
} from "../../packages/workit-core/scripts/analyze-release-scope";

type Repo = { root: string; cleanup(): void; commit(msg: string, files: Record<string, string>): void; tag(name: string): void };

function repo(): Repo {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-relscope-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.name", "t"]);
  g(["config", "user.email", "t@t"]);
  writeFileSync(path.join(root, "seed.md"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "chore: seed"]);
  const api: Repo = {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    commit: (msg, files) => {
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), body);
      }
      g(["add", "-A"]);
      g(["commit", "-q", "-m", msg]);
    },
    tag: (name) => g(["tag", name]),
  };
  return api;
}

describe("latestTag", () => {
  test("returns null when no v* tag exists", () => {
    const r = repo();
    try { expect(latestTag(r.root)).toBeNull(); } finally { r.cleanup(); }
  });
  test("returns the newest semver-sorted v* tag", () => {
    const r = repo();
    try {
      r.commit("chore: a", { "x.txt": "a" }); r.tag("v0.8.9");
      r.commit("chore: b", { "x.txt": "b" }); r.tag("v0.8.10");
      expect(latestTag(r.root)).toBe("v0.8.10");
    } finally { r.cleanup(); }
  });
});

describe("analyzeReleaseScope", () => {
  test("tooling-only commits yield no release", () => {
    const r = repo(); r.tag("v0.8.11");
    try {
      r.commit("fix(ci): workflow tweak", { ".github/workflows/x.yml": "on: push\n" });
      expect(analyzeReleaseScope(r.root)).toEqual({ level: null, productPkgs: [] });
    } finally { r.cleanup(); }
  });

  test("product fix yields patch scoped to its package", () => {
    const r = repo(); r.tag("v0.8.11");
    try {
      r.commit("fix(cli): flag parsing", { "packages/workit-cli/src/index.tsx": "export {};\n" });
      expect(analyzeReleaseScope(r.root)).toEqual({ level: "patch", productPkgs: ["workit-cli"] });
    } finally { r.cleanup(); }
  });

  test("feat beats fix; BREAKING beats feat", () => {
    const r = repo(); r.tag("v0.8.11");
    try {
      r.commit("fix(core): bug", { "packages/workit-core/src/a.ts": "a\n" });
      r.commit("feat(cursor): thing", { "packages/workit-cursor/hooks/h.ts": "h\n" });
      expect(analyzeReleaseScope(r.root).level).toBe("minor");
      r.commit("fix(opencode): boom\n\nBREAKING CHANGE: dropped flag", { "packages/workit-opencode/src/b.ts": "b\n" });
      expect(analyzeReleaseScope(r.root).level).toBe("major");
    } finally { r.cleanup(); }
  });

  test("mixed tooling+product counts; squash subjects parse", () => {
    const r = repo(); r.tag("v0.8.11");
    try {
      r.commit("docs: readme", { "README.md": "# x\n" });
      r.commit("fix(workit-cli): title (#42)", { "packages/workit-cli/src/main.ts": "m\n" });
      expect(analyzeReleaseScope(r.root)).toEqual({ level: "patch", productPkgs: ["workit-cli"] });
    } finally { r.cleanup(); }
  });

  test("first-ever release defaults to minor across all packages", () => {
    const r = repo();
    try {
      r.commit("fix(cli): first", { "packages/workit-cli/src/f.ts": "f\n" });
      expect(analyzeReleaseScope(r.root)).toEqual({
        level: "minor",
        productPkgs: ["workit-core", "workit-opencode", "workit-cursor", "workit-cli"],
      });
    } finally { r.cleanup(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/workit-core/analyze-release-scope.test.ts`
Expected: FAIL — cannot find module `analyze-release-scope`.

- [ ] **Step 3: Write minimal implementation**

```ts
#!/usr/bin/env bun
// AR-16: path-gated releases. Replaces message-only commit analysis: a
// releasable commit counts only when it touches a PRODUCT PATH (any of the
// four package dirs). Tooling-only merges produce no release at all.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export const RELEASE_PACKAGES = [
  "workit-core",
  "workit-opencode",
  "workit-cursor",
  "workit-cli",
] as const;

const g = (root: string, args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function latestTag(root = process.cwd()): string | null {
  const out = g(root, ["tag", "--list", "v*", "--sort=-v:refname"])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return out[0] ?? null;
}

type Level = "major" | "minor" | "patch";
const LEVEL_RANK: Record<Level, number> = { patch: 1, minor: 2, major: 3 };
const TYPE_LEVEL: Record<string, Level> = { fix: "patch", perf: "patch", feat: "minor" };

const subjectLevel = (commit: string): Level | null => {
  const firstLine = commit.split("\n")[0] ?? "";
  const m = /^(?:fix|perf|feat)(?:\([^)]*\))?!?:/.exec(firstLine);
  if (!m) return null;
  if (/!:/.test(firstLine)) return "major";
  const body = commit.split("\n").slice(1).join("\n");
  return /BREAKING CHANGE:/.test(body) ? "major" : TYPE_LEVEL[m[0].split("(")[0].replace("!", "")];
};

/** Commits (message + changed-file list) since `from`, inclusive of paths filter when given. */
const commitsSince = (root: string, from: string): { message: string; files: string[] }[] => {
  const raw = g(root, ["log", "--reverse", "--format=%H%x00%B%x00", "--name-only", `${from}..HEAD`]);
  const out: { message: string; files: string[] }[] = [];
  let cur: { message: string; files: string[] } | null = null;
  for (const line of raw.split("\n")) {
    if (line.includes("\0")) {
      if (cur) out.push(cur);
      const [, , hashTail] = line.split("\0"); // %B ends with \0 separator variant
      cur = { message: hashTail ?? "", files: [] };
      continue;
    }
    if (cur && line.trim() !== "") cur.files.push(line.trim());
  }
  if (cur) out.push(cur);
  // Fallback parser note: `%H\x00%B\x00 --name-only` interleaves; simpler split below.
  return parseLog(raw);
};

// Deterministic parser: records separated by NUL-terminated hash lines; the
// message block runs until the first blank line, then file lines until the
// next record. Implemented as its own function so tests can pin behavior.
const parseLog = (raw: string): { message: string; files: string[] }[] => {
  const out: { message: string; files: string[] }[] = [];
  let mode: "hash" | "rest" = "hash";
  let message = "";
  let files: string[] = [];
  for (const line of raw.split("\n")) {
    if (mode === "hash") {
      const hash = line.replace(/\0.*$/, "").trim();
      if (hash === "") continue;
      mode = "rest";
      message = "";
      files = [];
      continue;
    }
    if (line.trim() === "") {
      if (message !== "" || files.length > 0) out.push({ message, files });
      message = "";
      files = [];
      mode = "hash";
      continue;
    }
    if (files.length === 0 && message === "") { message = line; continue; }
    if (/^[a-z0-9]{40}$/.test(line)) { out.push({ message, files }); message = ""; files = []; mode = "hash"; continue; }
    files.push(line);
  }
  if (message !== "" || files.length > 0) out.push({ message, files });
  void mode;
  return out;
};

export function analyzeReleaseScope(
  root = process.cwd(),
): { level: Level | null; productPkgs: string[] } {
  const from = latestTag(root);
  if (from === null) {
    return { level: "minor", productPkgs: [...RELEASE_PACKAGES] };
  }
  const commits = commitsSince(root, from);
  const levels: Level[] = [];
  const pkgs = new Set<string>();
  for (const { message, files } of commits) {
    const touched = files.filter((f) => RELEASE_PACKAGES.some((p) => f.startsWith(`packages/${p}/`)));
    if (touched.length === 0) continue;
    const lvl = subjectLevel(message);
    if (lvl) levels.push(lvl);
    for (const p of RELEASE_PACKAGES) if (touched.some((f) => f.startsWith(`packages/${p}/`))) pkgs.add(p);
  }
  if (levels.length === 0) return { level: null, productPkgs: [...pkgs] };
  const level = levels.reduce<Level>((best, l) => (LEVEL_RANK[l] > LEVEL_RANK[best] ? l : best), "patch");
  return { level, productPkgs: [...pkgs] };
}

if (import.meta.main) {
  const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const { level } = analyzeReleaseScope(root);
  if (level) process.stdout.write(`${level}\n`);
}
```

NOTE to implementer: the double-parser sketch above must collapse into ONE correct `commitsSince`. Use this exact implementation instead of both sketches:

```ts
const commitsSince = (root: string, from: string): { message: string; files: string[] }[] => {
  const sep = "\u0000";
  const fmt = [`--format=%H${sep}%s%n%b`, "--name-only"];
  const raw = g(root, ["log", "--reverse", ...fmt, `${from}..HEAD`]);
  const blocks = raw.split(/(?=^[a-f0-9]{40}$)/m).filter((b) => b.trim() !== "");
  return blocks.map((block) => {
    const [head, ...rest] = block.split("\n").filter((l) => l !== "");
    const message = head!.slice(41); // after hash + NUL
    const files = rest.filter((l) => !l.startsWith("\u0000"));
    return { message, files };
  });
};
```

If the multi-line `%B` + `--name-only` interleave proves brittle in testing, switch to two-pass collection instead: first `git log --format=%H%s|%b` delimited records, then `git show --name-only --format= <hash>` per commit (bounded by commit count on merge trains, acceptable for this repo's cadence).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/workit-core/analyze-release-scope.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/workit-core/scripts/analyze-release-scope.ts test/workit-core/analyze-release-scope.test.ts
git commit -m "feat(release): path-gated release scope analyzer"
```

---

### Task 2: Selective publisher

**Files:**
- Create: `packages/workit-core/scripts/publish-changed-packages.ts`
- Test: `test/workit-core/publish-changed-packages.test.ts`

**Interfaces:**
- Consumes: `latestTag` from Task 1 (`../../scripts/analyze-release-scope`).
- Produces: `changedPackages(root: string, fromTag: string | null): string[]` — package names whose directory has a non-empty diff vs `fromTag` (`RELEASE_PACKAGES` order, all four when `fromTag` is null).
- Produces: `publishChanged(opts: { root: string; dryRun?: boolean; run?: (cmd: string, args: string[], opts: { cwd: string }) => unknown }): { published: string[]; skipped: string[]; tag: string | null }` — injectable runner keeps tests offline; production default shells to `npm publish --access public`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changedPackages,
  publishChanged,
} from "../../packages/workit-core/scripts/publish-changed-packages";

type Repo = ReturnType<typeof repo>;
function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-pubchg-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.name", "t"]);
  g(["config", "user.email", "t@t"]);
  for (const pkg of ["workit-core", "workit-opencode", "workit-cursor", "workit-cli"]) {
    mkdirSync(path.join(root, "packages", pkg, "src"), { recursive: true });
    writeFileSync(path.join(root, "packages", pkg, "src", "i.ts"), "i\n");
    writeFileSync(path.join(root, "packages", pkg, "package.json"), `{"name":"@brainervirus/${pkg}","version":"0.8.10"}\n`);
  }
  g(["add", "-A"]); g(["commit", "-q", "-m", "chore: seed"]); g(["tag", "v0.8.10"]);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    change: (rel: string, body: string) => {
      const f = path.join(root, rel);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, body);
    },
  };
}

describe("changedPackages", () => {
  test("lists only packages with payload diffs", () => {
    const r = repo();
    try {
      r.change("packages/workit-cli/src/i.ts", "c\n");
      expect(changedPackages(r.root, "v0.8.10")).toEqual(["workit-cli"]);
    } finally { r.cleanup(); }
  });
  test("manifest-only edits count (dependency bumps are real content)", () => {
    const r = repo();
    try {
      r.change("packages/workit-opencode/package.json", `{"name":"@brainervirus/workit-opencode","version":"0.8.11"}\n`);
      expect(changedPackages(r.root, "v0.8.10")).toEqual(["workit-opencode"]);
    } finally { r.cleanup(); }
  });
  test("non-product roots never appear", () => {
    const r = repo();
    try {
      r.change(".github/workflows/ci.yml", "on: push\n");
      expect(changedPackages(r.root, "v0.8.10")).toEqual([]);
    } finally { r.cleanup(); }
  });
});

describe("publishChanged", () => {
  test("publishes changed, skips unchanged, exact skip line", () => {
    const r = repo();
    try {
      r.change("packages/workit-core/src/i.ts", "c\n");
      const calls: string[] = [];
      const result = publishChanged({
        root: r.root,
        run: (_cmd, args, opts) => { calls.push(`${args.join(" ")} @ ${opts.cwd}`); },
      });
      expect(result.published).toEqual(["workit-core"]);
      expect(result.skipped).toEqual([
        "workit-opencode",
        "workit-cursor",
        "workit-cli",
      ]);
      expect(calls[0]).toBe(`publish --access public @ ${path.join(r.root, "packages/workit-core")}`);
    } finally { r.cleanup(); }
  });
  test("dryRun records without invoking npm", () => {
    const r = repo();
    try {
      r.change("packages/workit-cli/src/i.ts", "c\n");
      let ran = 0;
      const result = publishChanged({ root: r.root, dryRun: true, run: () => { ran++; } });
      expect(result.published).toEqual(["workit-cli"]);
      expect(ran).toBe(0);
    } finally { r.cleanup(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/workit-core/publish-changed-packages.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
#!/usr/bin/env bun
// AR-16: selective publishing. Publishes only packages whose directory
// changed since the previous v* tag; logs an exact skip line per unchanged
// package so release logs answer "what shipped?" without leaving the terminal.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { latestTag, RELEASE_PACKAGES } from "./analyze-release-scope";

const git = (root: string, args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function changedPackages(root: string, fromTag: string): string[] {
  return RELEASE_PACKAGES.filter((pkg) => {
    const out = git(root, ["diff", "--name-only", `${fromTag}..HEAD`, "--", `packages/${pkg}`]);
    return out !== "";
  });
}

export function publishChanged(opts: {
  root: string;
  dryRun?: boolean;
  run?: (cmd: string, args: string[], o: { cwd: string }) => unknown;
}): { published: string[]; skipped: string[]; tag: string | null } {
  const { root, dryRun = false } = opts;
  const run =
    opts.run ??
    ((cmd: string, args: string[], o: { cwd: string }) =>
      execFileSync(cmd, args, { cwd: o.cwd, encoding: "utf8", stdio: "inherit" }));
  const tag = latestTag(root);
  if (tag === null) {
    // First-ever release: everything ships.
    const published: string[] = [];
    for (const pkg of RELEASE_PACKAGES) {
      const cwd = resolve(root, "packages", pkg);
      if (!dryRun) run("npm", ["publish", "--access", "public"], { cwd });
      published.push(pkg);
    }
    return { published, skipped: [], tag: null };
  }
  const changed = new Set(changedPackages(root, tag));
  const published: string[] = [];
  const skipped: string[] = [];
  for (const pkg of RELEASE_PACKAGES) {
    if (!changed.has(pkg)) {
      skipped.push(pkg);
      console.log(`skip ${pkg} (no payload change since ${tag})`);
      continue;
    }
    const cwd = resolve(root, "packages", pkg);
    if (!dryRun) run("npm", ["publish", "--access", "public"], { cwd });
    published.push(pkg);
    console.log(`published ${pkg} @ ${cwd}`);
  }
  return { published, skipped, tag };
}

if (import.meta.main) {
  const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  publishChanged({ root, dryRun: process.env.PUBLISH_DRY_RUN === "1" });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/workit-core/publish-changed-packages.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/workit-core/scripts/publish-changed-packages.ts test/workit-core/publish-changed-packages.test.ts
git commit -m "feat(release): selective per-package publisher"
```

---

### Task 3: Wire the pipeline, pin contracts, document

**Files:**
- Modify: `release.config.cjs`
- Test: `test/artifacts/release-orchestration.test.ts`
- Modify: `README.md` (release section), `CHANGELOG.md` (Unreleased)

**Interfaces:**
- Consumes: `analyzeCmd` output contract (`major|minor|patch` line, or empty) and `publishChanged` CLI from Tasks 1–2.
- Produces: final plugin order pinned by test — `[exec analyzeCmd] → release-notes-generator → [exec verifyConditionsCmd] → npm ×4 (npmPublish:false) → [exec prepareCmd] → [exec publishCmd] → github`.

- [ ] **Step 1: Update the failing orchestration assertions**

In `test/artifacts/release-orchestration.test.ts`, replace the `"rewrite runs before npm package verification and after version assignment"` test body's tail with added pins (keep existing verify/prepare ordering checks):

```ts
  const config = read("release.config.cjs");
  const analyze = config.indexOf('analyzeCmd');
  const npmEntries = config.split("@semantic-release/npm").length - 1;
  const npmPublishFalse = config.match(/npmPublish:\s*false/g)?.length ?? 0;
  const publishCmd = config.indexOf('publishCmd');
  const githubIdx = config.indexOf('"@semantic-release/github"');
  expect(analyze).toBeGreaterThanOrEqual(0);
  expect(npmEntries).toBe(4);
  expect(npmPublishFalse).toBe(4);
  // analyze gate runs first; selective publish lands after the bumpers and
  // before the GitHub release/tag plugin (AR-16).
  expect(analyze).toBeLessThan(config.indexOf("@semantic-release/npm"));
  expect(publishCmd).toBeGreaterThan(config.lastIndexOf("@semantic-release/npm"));
  expect(publishCmd).toBeLessThan(githubIdx);
```

- [ ] **Step 2: Run to verify RED**

Run: `bun test test/artifacts/release-orchestration.test.ts`
Expected: FAIL — `release.config.cjs` lacks `analyzeCmd`, `npmPublish`, `publishCmd`.

- [ ] **Step 3: Rewire `release.config.cjs`**

Replace the plugins array with:

```js
module.exports = {
  branches: ["main"],
  plugins: [
    // AR-16: path-gated release decision — prints major|minor|patch only when
    // product paths changed since the previous v* tag; empty output skips the
    // release entirely (no tag, no publish, no sync PR).
    ["@semantic-release/exec", {
      analyzeCmd: "bun packages/workit-core/scripts/analyze-release-scope.ts",
    }],
    "@semantic-release/release-notes-generator",
    // AR-02: verify-time rewrite runs FIRST — before any npm plugin's
    // verification — so package verification never sees a workspace:* manifest.
    ["@semantic-release/exec", {
      verifyConditionsCmd: "bun packages/workit-core/scripts/rewrite-workspace-deps.ts",
    }],
    // AR-16: bumpers only — selective publishing is owned by publish-changed
    // below, so identical-content packages stop reaching the registry.
    ["@semantic-release/npm", { pkgRoot: "packages/workit-core", npmPublish: false }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-opencode", npmPublish: false }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cursor", npmPublish: false }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cli", npmPublish: false }],
    // AR-02/RR-01: prepare-time rewrite AFTER version bumps (unchanged).
    ["@semantic-release/exec", {
      prepareCmd: "bun packages/workit-core/scripts/rewrite-workspace-deps.ts",
    }],
    // AR-16: publish only packages with payload changes since the previous tag.
    ["@semantic-release/exec", {
      publishCmd: "bun packages/workit-core/scripts/publish-changed-packages.ts",
    }],
    "@semantic-release/github",
  ],
};
```

Also remove the now-unused `"@semantic-release/commit-analyzer"` entry from `devDependencies` in `package.json`, then run `bun install` to refresh `bun.lock`.

- [ ] **Step 4: Run to verify GREEN**

Run: `bun test test/artifacts/release-orchestration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Document**

- `README.md` release section (grep `semantic-release`): append one paragraph — "Releases are path-gated: merges touching only CI/test/docs produce no release, and npm receives only packages whose payload changed since the previous tag (AR-16)."
- `CHANGELOG.md` Unreleased → Changed: "- Releases are now path-gated and selectively published: tooling-only merges cut no release, and npm receives only packages whose payload changed since the previous tag."

- [ ] **Step 6: Commit**

```bash
git add release.config.cjs test/artifacts/release-orchestration.test.ts README.md CHANGELOG.md package.json bun.lock
git commit -m "feat(release): wire path-gated analysis and selective publishing"
```

---

### Task 4: Full verification and flow completion

**Files:**
- Verify: everything from Tasks 1–3.

**Interfaces:**
- Consumes: complete pipeline from Task 3.

- [ ] **Step 1: Full local verification**

Run: `bun run check`
Expected: build, lint, format, full suite (≥1240 tests), typecheck — all exit 0.

- [ ] **Step 2: Repository verification**

Run: `workflow_verify` — expected 5 passed / 0 failed / 1 skipped. Run `workflow_docs_validate` on this spec/plan pair — expected ok with no quality findings.

- [ ] **Step 3: Complete the flow**

Append the validated ledger line for the final task with the real non-empty range, confirm all task IDs complete, then call `workflow_plan_complete`. Expected final execution status: `completed`.
