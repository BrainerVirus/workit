# Project Hygiene Files — Validation + Ensure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/hygiene/spec.md`
**Branch:** `feature/hygiene`

**Goal:** Detect and create project hygiene files (CHANGELOG.md Keep-a-Changelog, README.md, .editorconfig, .gitattributes, and open-source LICENSE/CONTRIBUTING.md) via `workit_docs_validate` findings, `workit_verify`, and a `wf-init` `hygiene` action — never overwriting existing files.

**Architecture:** New `src/core/hygiene.ts` (state detection + ensure from `templates/hygiene/`). `docsValidate` appends hygiene warnings (reusing `changelogUnreleasedStats` for the changelog format). `verify-project.sh` gains a changelog check. `workit_init_apply` gains `action: "hygiene"` on both platforms.

**Tech Stack:** TypeScript (existing), `bun test`, node:fs (existing patterns), shell for verify. No new dependencies.

## Global Constraints

- Hygiene findings are **warnings** (never hard).
- `invalid` applies only to CHANGELOG.md: `has_unreleased === false` → invalid.
- `ensureHygieneFiles` only creates missing files; never overwrites; requires `confirmed`; skips files whose template is missing (no fail).
- `openSource` heuristic: exists `LICENSE`, or `package.json` `private !== true`, or dirname is `workflow-toolkit`.
- `bun run check` green. Version stays `0.4.0`.

---

### Task 1: `src/core/hygiene.ts` + templates

**Files:**
- Create: `src/core/hygiene.ts`
- Create: `templates/hygiene/{CHANGELOG.md,README.md,.editorconfig,.gitattributes,LICENSE,CONTRIBUTING.md}`
- Test: `test/hygiene.test.ts`

**Interfaces:**
- Consumes: `changelogUnreleasedStats` from `./changelog`
- Produces:
  - `type HygieneFile = "CHANGELOG.md" | "README.md" | ".editorconfig" | ".gitattributes" | "LICENSE" | "CONTRIBUTING.md"`
  - `hygieneFiles(workspaceRoot): { state: Record<HygieneFile, "missing" | "invalid" | "ok" | "skip">; openSource: boolean }`
  - `ensureHygieneFiles(workspaceRoot, { confirmed, includeOpenSource? }): { ok: true; created: string[] } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing test**

Create `test/hygiene.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hygieneFiles, ensureHygieneFiles } from "../src/core/hygiene";

test("all files missing on a fresh dir", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-"));
  try {
    const { state } = hygieneFiles(dir);
    expect(state["CHANGELOG.md"]).toBe("missing");
    expect(state["README.md"]).toBe("missing");
    expect(state[".editorconfig"]).toBe("missing");
    expect(state[".gitattributes"]).toBe("missing");
    expect(state.LICENSE).toBe("missing");
    expect(state["CONTRIBUTING.md"]).toBe("missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("valid changelog is ok, malformed is invalid", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-ch-"));
  try {
    writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- x\n", "utf8");
    expect(hygieneFiles(dir).state["CHANGELOG.md"]).toBe("ok");

    writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## [1.0.0]\n\n### Added\n\n- x\n", "utf8");
    expect(hygieneFiles(dir).state["CHANGELOG.md"]).toBe("invalid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("openSource heuristic: LICENSE present or private false", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-os-"));
  try {
    writeFileSync(path.join(dir, "LICENSE"), "MIT\n", "utf8");
    expect(hygieneFiles(dir).openSource).toBe(true);

    const dir2 = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-os2-"));
    writeFileSync(path.join(dir2, "package.json"), JSON.stringify({ private: false }), "utf8");
    expect(hygieneFiles(dir2).openSource).toBe(true);
    rmSync(dir2, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ensure creates missing files, preserves existing, requires confirmed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-ensure-"));
  try {
    writeFileSync(path.join(dir, "README.md"), "# Custom README\n", "utf8");
    const no = ensureHygieneFiles(dir, { confirmed: false });
    expect(no.ok).toBe(false);

    const result = ensureHygieneFiles(dir, { confirmed: true, includeOpenSource: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toContain("CHANGELOG.md");
      expect(result.created).toContain(".editorconfig");
      expect(result.created).toContain("LICENSE");
      expect(result.created).not.toContain("README.md");
    }
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# Custom README\n");
    expect(readFileSync(path.join(dir, "CHANGELOG.md"), "utf8")).toContain("## [Unreleased]");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hygiene.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the templates**

`templates/hygiene/CHANGELOG.md`:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed
```

`templates/hygiene/README.md`:

```markdown
# <PROJECT>

<!-- Describe the project: what it does, how to run it, how to contribute. -->
```

`templates/hygiene/.editorconfig`:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
```

`templates/hygiene/.gitattributes`:

```gitattributes
* text=auto
*.md text
*.bat text eol=crlf
```

`templates/hygiene/LICENSE`:

```text
MIT License

Copyright (c) <YEAR> <HOLDER>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`templates/hygiene/CONTRIBUTING.md`:

```markdown
# Contributing

<!-- How to report issues, propose changes, and the review process. -->
```

- [ ] **Step 4: Implement `src/core/hygiene.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogUnreleasedStats } from "./changelog";

export type HygieneFile = "CHANGELOG.md" | "README.md" | ".editorconfig" | ".gitattributes" | "LICENSE" | "CONTRIBUTING.md";
type State = "missing" | "invalid" | "ok" | "skip";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const templatesDir = () => path.join(repoRoot, "templates", "hygiene");

const isOpenSource = (root: string): boolean => {
  if (existsSync(path.join(root, "LICENSE"))) return true;
  if (existsSync(path.join(root, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      if (pkg.private === false) return true;
    } catch { /* ignore */ }
  }
  return path.basename(root) === "workflow-toolkit";
};

export const hygieneFiles = (root: string): { state: Record<HygieneFile, State>; openSource: boolean } => {
  const openSource = isOpenSource(root);
  const state = {} as Record<HygieneFile, State>;
  for (const file of ["CHANGELOG.md", "README.md", ".editorconfig", ".gitattributes", "LICENSE", "CONTRIBUTING.md"] as HygieneFile[]) {
    if (file === "LICENSE" || file === "CONTRIBUTING.md") {
      state[file] = openSource ? (existsSync(path.join(root, file)) ? "ok" : "missing") : "skip";
      continue;
    }
    if (!existsSync(path.join(root, file))) { state[file] = "missing"; continue; }
    if (file === "CHANGELOG.md") {
      const stats = changelogUnreleasedStats(root);
      state[file] = stats.exists && stats.has_unreleased ? "ok" : "invalid";
      continue;
    }
    state[file] = "ok";
  }
  return { state, openSource };
};

export const ensureHygieneFiles = (
  root: string,
  opts: { confirmed: boolean; includeOpenSource?: boolean },
): { ok: true; created: string[] } | { ok: false; error: string } => {
  if (!opts.confirmed) return { ok: false, error: "confirmed: true required" };
  const files = ["CHANGELOG.md", "README.md", ".editorconfig", ".gitattributes"] as HygieneFile[];
  if (opts.includeOpenSource) files.push("LICENSE", "CONTRIBUTING.md");
  const created: string[] = [];
  const tplDir = templatesDir();
  for (const file of files) {
    if (existsSync(path.join(root, file))) continue;
    const tpl = path.join(tplDir, file);
    if (!existsSync(tpl)) continue; // skip missing template, never fail
    const content = readFileSync(tpl, "utf8")
      .replace(/<PROJECT>/g, path.basename(root))
      .replace(/<YEAR>/g, String(new Date().getFullYear()))
      .replace(/<HOLDER>/g, "");
    writeFileSync(path.join(root, file), content, "utf8");
    created.push(file);
  }
  return { ok: true, created };
};
```

- [ ] **Step 5: Run tests**

Run: `bun test test/hygiene.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/hygiene.ts templates/hygiene/ test/hygiene.test.ts
git commit -m "feat(core): project hygiene files detection + ensure with templates"
```

---

### Task 2: Hygiene findings in `docsValidate`

**Files:**
- Modify: `src/core/docs-validate.ts` (append hygiene warnings)
- Test: `test/docs-validate.test.ts`

**Interfaces:**
- Consumes: `hygieneFiles` (Task 1)
- Produces: `docsValidate` success `quality` includes hygiene warnings

- [ ] **Step 1: Write the failing test**

Append to `test/docs-validate.test.ts`:

```typescript
test("docsValidate reports hygiene warnings", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-validate-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "T"]);
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# Spec\n\n**Branch:** `feature/x`\n");
    writeFileSync(path.join(root, "docs/x/plan.md"), "# Plan\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n");

    const raw = await createSddTools(new WorkflowStateStore()).workit_docs_validate.execute(
      { spec_path: "docs/x/spec.md", plan_path: "docs/x/plan.md" },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    const out = JSON.parse(raw as string);
    const codes = out.data.quality.map((f: any) => f.code);
    expect(codes).toContain("changelog_missing");
    expect(codes).toContain("readme_missing");
    expect(codes).toContain("editorconfig_missing");
    expect(codes).toContain("gitattributes_missing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/docs-validate.test.ts -t "hygiene warnings"`
Expected: FAIL — no hygiene findings.

- [ ] **Step 3: Append hygiene findings in `src/core/docs-validate.ts`**

After the sdd check (near the `quality` push), add:

```typescript
import { hygieneFiles } from "./hygiene";
// ...
  const hygiene = hygieneFiles(cwd);
  const hyState = hygiene.state;
  if (hyState["CHANGELOG.md"] === "missing") quality.push({ code: "changelog_missing", message: "CHANGELOG.md missing — create it with Keep a Changelog format (run wf-init hygiene)", severity: "warning" });
  if (hyState["CHANGELOG.md"] === "invalid") quality.push({ code: "changelog_invalid_format", message: "CHANGELOG.md lacks ## [Unreleased] — Keep a Changelog format required", severity: "warning" });
  if (hyState["README.md"] === "missing") quality.push({ code: "readme_missing", message: "README.md missing", severity: "warning" });
  if (hyState[".editorconfig"] === "missing") quality.push({ code: "editorconfig_missing", message: ".editorconfig missing", severity: "warning" });
  if (hyState[".gitattributes"] === "missing") quality.push({ code: "gitattributes_missing", message: ".gitattributes missing", severity: "warning" });
  if (hygiene.openSource && hyState.LICENSE === "missing") quality.push({ code: "license_missing", message: "LICENSE missing (open-source repo)", severity: "warning" });
  if (hygiene.openSource && hyState["CONTRIBUTING.md"] === "missing") quality.push({ code: "contributing_missing", message: "CONTRIBUTING.md missing (open-source repo)", severity: "warning" });
```

- [ ] **Step 4: Run tests**

Run: `bun test test/docs-validate.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/docs-validate.ts test/docs-validate.test.ts
git commit -m "feat(validate): hygiene findings in workit_docs_validate"
```

---

### Task 3: `workit_verify` changelog check

**Files:**
- Modify: `scripts/verify-project.sh`
- Test: `test/hygiene-verify.test.ts` (shell-level)

**Interfaces:**
- Consumes: nothing
- Produces: verify output includes `CHANGELOG.md format` check (pass/fail)

- [ ] **Step 1: Write the failing test**

Create `test/hygiene-verify.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const run = (cwd: string, args: string[]) => spawnSync("bash", args, { cwd, encoding: "utf8" });

test("verify passes with valid changelog, fails without", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-verify-"));
  try {
    writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- x\n", "utf8");
    const ok = run(dir, [path.resolve(import.meta.dir, "../scripts/verify-project.sh")]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("CHANGELOG.md format");

    rmSync(path.join(dir, "CHANGELOG.md"));
    const fail = run(dir, [path.resolve(import.meta.dir, "../scripts/verify-project.sh")]);
    expect(fail.status).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hygiene-verify.test.ts`
Expected: FAIL — verify has no changelog check.

- [ ] **Step 3: Add the changelog check to `scripts/verify-project.sh`**

Before the final summary, add:

```bash
## CHANGELOG.md format

if [ -f CHANGELOG.md ]; then
  if grep -q '## \[Unreleased\]' CHANGELOG.md; then
    printf 'status: pass\n'
    passed=$((passed + 1))
  else
    printf 'status: fail (missing ## [Unreleased])\n'
    failed=$((failed + 1))
  fi
else
  printf 'status: fail (missing CHANGELOG.md)\n'
  failed=$((failed + 1))
fi
```

- [ ] **Step 4: Run tests**

Run: `bun test test/hygiene-verify.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-project.sh test/hygiene-verify.test.ts
git commit -m "feat(verify): CHANGELOG.md format check"
```

---

### Task 4: `hygiene` action in `workit_init_apply` + wf-init skill

**Files:**
- Modify: `src/tools/repo.ts`
- Modify: `cursor/mcp/server.ts`
- Modify: `skills/wf-init/SKILL.md`
- Test: `test/hygiene-tools.test.ts`

**Interfaces:**
- Consumes: `ensureHygieneFiles` (Task 1)
- Produces: `workit_init_apply` accepts `action: "hygiene"` (+ optional `include_open_source`) on both platforms

- [ ] **Step 1: Write the failing test**

Create `test/hygiene-tools.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepoTools } from "../src/tools/repo";

test("init_apply hygiene action creates missing files", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-tools-"));
  try {
    const tools = createRepoTools();
    const no = JSON.parse(await tools.workit_init_apply.execute({
      confirmed: false, action: "hygiene",
    }, { directory: dir, worktree: dir } as never) as string);
    expect(no.ok).toBe(false);

    const yes = JSON.parse(await tools.workit_init_apply.execute({
      confirmed: true, action: "hygiene", include_open_source: true,
    }, { directory: dir, worktree: dir } as never) as string);
    expect(yes.ok).toBe(true);
    expect(yes.data.created).toContain("CHANGELOG.md");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hygiene-tools.test.ts`
Expected: FAIL — action not supported.

- [ ] **Step 3: Extend `workit_init_apply` in `src/tools/repo.ts`**

Add `"hygiene"` to the action enum and `include_open_source` arg; add the branch before the script dispatch:

```typescript
if (action === "hygiene") {
  const result = ensureHygieneFiles(context.directory, { confirmed, includeOpenSource: include_open_source });
  return output(result.ok ? ok(result) : fail(result.error));
}
```

Import `ensureHygieneFiles`.

- [ ] **Step 4: Mirror in `cursor/mcp/server.ts`**

Same enum addition, `include_open_source` optional boolean, branch calling `ensureHygieneFiles(workspace_root ?? process.cwd(), { confirmed, includeOpenSource: include_open_source })`.

- [ ] **Step 5: Update `skills/wf-init/SKILL.md`**

Add after the gitignore step:

```markdown
After gitignore, call `workit_init_apply` with `action: "hygiene"`, `confirmed: true`, and `include_open_source: true` for open-source repos — creates CHANGELOG.md (Keep a Changelog), README.md, .editorconfig, .gitattributes, and optionally LICENSE + CONTRIBUTING.md. Never overwrites existing files.
```

- [ ] **Step 6: Run tests**

Run: `bun test test/hygiene-tools.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/repo.ts cursor/mcp/server.ts skills/wf-init/SKILL.md test/hygiene-tools.test.ts
git commit -m "feat(init): hygiene action creates project files from templates"
```

---

## Post-plan checklist

- [ ] `bun run check` green after each task.
- [ ] `src/core/hygiene.ts` exported and tested (missing/invalid/ok, openSource heuristic, ensure create/preserve/confirmed).
- [ ] Templates in `templates/hygiene/` for all six files.
- [ ] `docsValidate` reports the hygiene warnings (changelog/readme/editorconfig/gitattributes/license/contributing).
- [ ] `verify-project.sh` has the CHANGELOG format check.
- [ ] `hygiene` action on both platforms + wf-init skill updated.
