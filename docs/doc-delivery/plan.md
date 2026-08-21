# Doc Delivery + SDD Gitignore Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/doc-delivery/spec.md`
**Branch:** `feature/doc-delivery`

**Goal:** Make doc delivery clickable (markdown links + summary) with post-hoc detection, and enforce `docs/<slug>/sdd/` gitignore in projects via validation gates and a wf-init gitignore ensure step.

**Architecture:** Extend `src/core/detector.ts` with `detectBacktickDocRefs`; extend the Spec 7 hook to inject a doc-delivery correction; add `sdd_not_ignored` to `docsValidate` and the promote gate; add a `gitignore` ensure action to `workit_init_apply`.

**Tech Stack:** TypeScript (existing), `bun test`, node:fs + child_process (existing patterns). No new dependencies.

## Global Constraints

- Delivery rule: `[spec.md](docs/<slug>/spec.md)` + 3-5 bullet summary.
- `detectBacktickDocRefs`: `` `docs/<path>.md` `` present AND no `[text](docs/` markdown link in the same text → match.
- `sdd_not_ignored`: hard finding when `docs/<slug>/sdd` exists and `git check-ignore` doesn't cover it; promote refuses unless `force`.
- Gitignore ensure: append missing entries only; never overwrite existing; requires `confirmed`.
- Hook corrections never throw (try/catch no-op).
- `bun run check` green. Version stays `0.4.0`.

---

### Task 1: Delivery rule in reminder + contract

**Files:**
- Modify: `src/core/reminder.ts` (add the delivery line)
- Modify: `templates/superpowers-doc-contract.md` (add "## Doc delivery" section)
- Modify: `cursor/hooks/session-start` (reminder text mirrored)
- Test: `test/enforcement-hook.test.ts` (assert reminder line), `test/contracts.test.ts`

**Interfaces:**
- Consumes: existing `REMINDER_TEXT`
- Produces: `REMINDER_TEXT` includes "Delivering docs → clickable markdown link ..."; contract has the section; cursor hook includes it

- [ ] **Step 1: Write the failing test**

Append to `test/enforcement-hook.test.ts`:

```typescript
import { REMINDER_TEXT } from "../src/core/reminder";

test("reminder includes the doc delivery rule", () => {
  expect(REMINDER_TEXT).toContain("clickable markdown link");
  expect(REMINDER_TEXT).toContain("3-5 bullet summary");
});
```

Append to `test/contracts.test.ts`:

```typescript
test("contract includes the doc delivery section", () => {
  const contract = readFileSync(path.resolve(import.meta.dir, "../templates/superpowers-doc-contract.md"), "utf8");
  expect(contract).toContain("## Doc delivery");
  expect(contract).toMatch(/\[spec\.md\]\(docs\/<slug>\/spec\.md\)/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/enforcement-hook.test.ts test/contracts.test.ts`
Expected: FAIL — reminder/contract lack the rule.

- [ ] **Step 3: Update `src/core/reminder.ts`**

Add to `REMINDER_TEXT` (before the closing tag):

```typescript
- Delivering docs → clickable markdown link \`[spec.md](docs/<slug>/spec.md)\` + 3-5 bullet summary.
```

- [ ] **Step 4: Update `templates/superpowers-doc-contract.md`**

Add before the closing content (after the "## Library documentation" section or wherever the contract ends):

```markdown
## Doc delivery

When delivering a spec or plan, use a clickable markdown link (`[spec.md](docs/<slug>/spec.md)`) and a 3-5 bullet summary of the content (Context, Goals, key decisions, status). Never reference docs with backtick-only paths.
```

- [ ] **Step 5: Mirror in `cursor/hooks/session-start`**

In the `context=$'...'` reminder block, add:

```bash
Delivering docs → clickable markdown link (docs/<slug>/spec.md) + 3-5 bullet summary.
```

- [ ] **Step 6: Run tests**

Run: `bun test test/enforcement-hook.test.ts test/contracts.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/reminder.ts templates/superpowers-doc-contract.md cursor/hooks/session-start test/enforcement-hook.test.ts test/contracts.test.ts
git commit -m "feat(delivery): clickable doc delivery rule in reminder + contract"
```

---

### Task 2: Backtick-ref detector + hook correction

**Files:**
- Modify: `src/core/detector.ts` (add `detectBacktickDocRefs`)
- Modify: `src/core/reminder.ts` (add `DOC_DELIVERY_TEXT`)
- Modify: `src/plugin.ts` (hook checks backtick refs)
- Test: `test/detector.test.ts`, `test/enforcement-hook.test.ts`

**Interfaces:**
- Produces:
  - `detectBacktickDocRefs(text: string): string[] | null`
  - `DOC_DELIVERY_TEXT` — the correction block

- [ ] **Step 1: Write the failing test**

Append to `test/detector.test.ts`:

```typescript
import { detectBacktickDocRefs } from "../src/core/detector";

test("detects backtick-only doc references", () => {
  const refs = detectBacktickDocRefs("Spec is at `docs/upgrade-19/spec.md`. Please review.");
  expect(refs).not.toBeNull();
  if (refs) expect(refs[0]).toBe("`docs/upgrade-19/spec.md`");
});

test("does not detect when a markdown link is present", () => {
  expect(detectBacktickDocRefs("See [spec.md](docs/upgrade-19/spec.md) and `docs/upgrade-19/plan.md`.")).toBeNull();
});

test("null when no doc references", () => {
  expect(detectBacktickDocRefs("No docs here.")).toBeNull();
});
```

Append to `test/enforcement-hook.test.ts`:

```typescript
test("hook injects doc-delivery correction on backtick-only refs", async () => {
  const hooks = await plugin({ directory: "/repo", worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
  const output = {
    messages: [
      userMessage("start"),
      assistantMessage("Spec is at `docs/x/spec.md`. Please review."),
      userMessage("ok"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const currentText = output.messages[2].parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  expect(currentText).toContain("workflow-doc-delivery");
});

test("hook does not correct when markdown link used", async () => {
  const hooks = await plugin({ directory: "/repo", worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
  const output = {
    messages: [
      userMessage("start"),
      assistantMessage("See [spec.md](docs/x/spec.md) for details."),
      userMessage("ok"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const currentText = output.messages[2].parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  expect(currentText).not.toContain("workflow-doc-delivery");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/detector.test.ts test/enforcement-hook.test.ts`
Expected: FAIL — detector/hook lack the feature.

- [ ] **Step 3: Add `detectBacktickDocRefs` to `src/core/detector.ts`**

```typescript
export const detectBacktickDocRefs = (text: string): string[] | null => {
  const refs = [...text.matchAll(/`docs\/[^`\s]+\.md`/g)].map((m) => m[0]);
  if (!refs.length) return null;
  if (/\[[^\]]+\]\(docs\//.test(text)) return null;
  return refs;
};
```

- [ ] **Step 4: Add `DOC_DELIVERY_TEXT` to `src/core/reminder.ts`**

```typescript
export const DOC_DELIVERY_TEXT = `<workflow-doc-delivery>
You referenced a doc with a backtick-only path. Deliver docs with a clickable markdown link \`[spec.md](docs/<slug>/spec.md)\` and a 3-5 bullet summary of the content.
</workflow-doc-delivery>`;
```

- [ ] **Step 5: Extend the hook in `src/plugin.ts`**

Inside the existing `chat.messages.transform`, after the prose-choice detection block, add:

```typescript
        if (lastAssistant) {
          const docRefs = detectBacktickDocRefs(assistantText);
          if (docRefs && !currentText.includes("workflow-doc-delivery")) {
            currentUser.parts.unshift(makePart(DOC_DELIVERY_TEXT));
          }
        }
```

Import `detectBacktickDocRefs` and `DOC_DELIVERY_TEXT`.

- [ ] **Step 6: Run tests**

Run: `bun test test/detector.test.ts test/enforcement-hook.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/detector.ts src/core/reminder.ts src/plugin.ts test/detector.test.ts test/enforcement-hook.test.ts
git commit -m "feat(delivery): backtick doc-ref detector + hook correction"
```

---

### Task 3: `sdd_not_ignored` validation + promote gate

**Files:**
- Modify: `src/core/docs-validate.ts` (add sdd gitignore check)
- Modify: `src/core/docs-repo.ts` (promote refuses unignored sdd)
- Test: `test/docs-validate.test.ts`, `test/docs-repo.test.ts`

**Interfaces:**
- Consumes: `execFileSync` (already used), slug derivation from spec path
- Produces:
  - `docsValidate` success includes a hard finding `sdd_not_ignored` when `docs/<slug>/sdd` exists and is not git-ignored
  - `promoteSpec` refuses with that finding unless `force`

- [ ] **Step 1: Write the failing test**

Append to `test/docs-validate.test.ts`:

```typescript
test("sdd_not_ignored when sdd dir exists and is not gitignored", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-ignore-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "T"]);
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# Spec\n\n**Branch:** `feature/x`\n");
    writeFileSync(path.join(root, "docs/x/plan.md"), "# Plan\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n");
    writeFileSync(path.join(root, "docs/x/sdd/progress.md"), "Task 1: complete\n");

    const raw = await createSddTools(new WorkflowStateStore()).workit_docs_validate.execute(
      { spec_path: "docs/x/spec.md", plan_path: "docs/x/plan.md" },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(out.data.quality.some((f: any) => f.code === "sdd_not_ignored")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no sdd_not_ignored when sdd is gitignored", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-ignore-ok-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "T"]);
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n", "utf8");
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# Spec\n\n**Branch:** `feature/x`\n");
    writeFileSync(path.join(root, "docs/x/plan.md"), "# Plan\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n");
    writeFileSync(path.join(root, "docs/x/sdd/progress.md"), "Task 1: complete\n");

    const raw = await createSddTools(new WorkflowStateStore()).workit_docs_validate.execute(
      { spec_path: "docs/x/spec.md", plan_path: "docs/x/plan.md" },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    const out = JSON.parse(raw as string);
    expect(out.data.quality.some((f: any) => f.code === "sdd_not_ignored")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/docs-validate.test.ts -t "sdd_not_ignored"`
Expected: FAIL — no such finding.

- [ ] **Step 3: Add the sdd check to `src/core/docs-validate.ts`**

In `qualitySpec` (or a new helper called from `docsValidate` success), add the sdd check. It needs the workspace root and spec path — so add it in `docsValidate` after computing `relSpec`:

```typescript
import { execFileSync } from "node:child_process";

const sddIgnored = (cwd: string, slug: string): boolean => {
  const sddDir = path.join(cwd, "docs", slug, "sdd");
  if (!existsSync(sddDir)) return true;
  try {
    execFileSync("git", ["-C", cwd, "check-ignore", path.join("docs", slug, "sdd", "progress.md")], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};
```

In `docsValidate`, after `const slug = path.basename(path.dirname(spec_path));` (or derive from spec path), before returning success:

```typescript
  const slug = path.basename(path.dirname(spec_path));
  const findings = qualitySpec(specText!);
  if (!sddIgnored(cwd, slug)) {
    findings.push({ code: "sdd_not_ignored", message: `docs/${slug}/sdd/ exists but is not gitignored — add 'docs/*/sdd/' to .gitignore (or run wf-init)`, severity: "hard" });
  }
  // return quality: findings
```

Update the success return to include the sdd finding in `quality`.

- [ ] **Step 4: Add the promote gate in `src/core/docs-repo.ts`**

In `promoteSpec`, after the quality gate:

```typescript
  const slugDir = path.basename(path.dirname(specRel));
  const sddDir = path.join(workspaceRoot, "docs", slugDir, "sdd");
  if (existsSync(sddDir) && !opts.force) {
    try {
      execFileSync("git", ["-C", workspaceRoot, "check-ignore", path.join("docs", slugDir, "sdd", "progress.md")], { stdio: "pipe" });
    } catch {
      return { ok: false, error: `docs/${slugDir}/sdd/ is not gitignored — add 'docs/*/sdd/' to .gitignore or pass force: true` };
    }
  }
```

- [ ] **Step 5: Run tests**

Run: `bun test test/docs-validate.test.ts test/docs-repo.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/docs-validate.ts src/core/docs-repo.ts test/docs-validate.test.ts test/docs-repo.test.ts
git commit -m "feat(validate): sdd_not_ignored finding + promote gate"
```

---

### Task 4: wf-init gitignore ensure action

**Files:**
- Modify: `src/core/gitignore.ts` (new module)
- Modify: `src/tools/repo.ts` (init_apply gains `gitignore` action or extends `config`)
- Modify: `cursor/mcp/server.ts` (mirror)
- Test: `test/gitignore.test.ts`

**Interfaces:**
- Produces:
  - `ensureProjectGitignore(workspaceRoot: string, confirmed: boolean): { ok: true; path: string; added: string[] } | { ok: false; error: string }`
  - `GITIGNORE_ENTRIES` — the common entries list

- [ ] **Step 1: Write the failing test**

Create `test/gitignore.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureProjectGitignore, GITIGNORE_ENTRIES } from "../src/core/gitignore";

test("creates .gitignore with common entries when missing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-gitignore-"));
  try {
    const result = ensureProjectGitignore(dir, true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toContain("docs/*/sdd/");
      expect(result.added).toContain(".DS_Store");
      const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
      expect(content).toContain("docs/*/sdd/");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appends only missing entries, preserves existing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-gitignore-keep-"));
  try {
    writeFileSync(path.join(dir, ".gitignore"), "# custom\nmy-secret.txt\n", "utf8");
    const result = ensureProjectGitignore(dir, true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toContain("docs/*/sdd/");
      expect(result.added).not.toContain("my-secret.txt");
      const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
      expect(content).toContain("# custom");
      expect(content).toContain("my-secret.txt");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("requires confirmed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-gitignore-conf-"));
  try {
    const no = ensureProjectGitignore(dir, false);
    expect(no.ok).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/gitignore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/gitignore.ts`**

```typescript
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const GITIGNORE_ENTRIES = [
  "# workflow-toolkit: SDD working state (never commit)",
  "docs/*/sdd/",
  "",
  "# OS / editor cruft",
  ".DS_Store",
  "Thumbs.db",
  "*.swp",
  ".idea/",
  ".vscode/",
  ".env",
  "node_modules/",
  "dist/",
  "*.log",
  ".cache/",
];

export const ensureProjectGitignore = (
  workspaceRoot: string,
  confirmed: boolean,
): { ok: true; path: string; added: string[] } | { ok: false; error: string } => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  const file = path.join(workspaceRoot, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const existingLines = new Set(existing.split("\n").map((l) => l.trim()).filter(Boolean));
  const added: string[] = [];
  const append: string[] = [];
  for (const entry of GITIGNORE_ENTRIES) {
    if (entry.trim() === "" || existingLines.has(entry.trim())) continue;
    append.push(entry);
    added.push(entry);
  }
  if (append.length) {
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(file, existing + separator + (existing ? "\n" : "") + append.join("\n") + "\n", "utf8");
  } else if (!existsSync(file)) {
    writeFileSync(file, "", "utf8");
  }
  return { ok: true, path: file, added };
};
```

- [ ] **Step 4: Wire into `workit_init_apply`**

In `src/tools/repo.ts`, add `ensureProjectGitignore` handling: extend the `config` action (or add a `gitignore` action) — when the action is `gitignore` (or config with `ensure_gitignore: true`), call `ensureProjectGitignore(context.directory, confirmed)` after writing config and merge the result. Mirror in `cursor/mcp/server.ts`.

- [ ] **Step 5: Update `skills/wf-init/SKILL.md`**

Add to the guided-config section: "After writing config, call `workit_init_apply` with `action: "gitignore"` and `confirmed: true` to ensure the project `.gitignore` covers `docs/*/sdd/` and common OS/editor entries."

- [ ] **Step 6: Run tests**

Run: `bun test test/gitignore.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/gitignore.ts src/tools/repo.ts cursor/mcp/server.ts skills/wf-init/SKILL.md test/gitignore.test.ts
git commit -m "feat(init): ensure project .gitignore covers sdd + common entries"
```

---

## Post-plan checklist

- [ ] `bun run check` green after each task.
- [ ] Reminder + contract contain the delivery rule.
- [ ] `detectBacktickDocRefs` tested (match / markdown-link no-match / null).
- [ ] Hook injects `workflow-doc-delivery` correction; not when markdown link used.
- [ ] `sdd_not_ignored` hard finding in docsValidate when sdd unignored; promote refuses unless force.
- [ ] `ensureProjectGitignore` tested (create / append-preserve / confirmed).
- [ ] wf-init skill mentions the gitignore action.
