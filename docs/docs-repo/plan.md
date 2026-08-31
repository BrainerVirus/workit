# Docs Repo — Link, List, Promote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/docs-repo/spec.md`
**Branch:** `feature/docs-repo`

**Goal:** Add three tools — `workit_docs_repo_link`, `workit_docs_list`, `workit_docs_promote` — that link a docs repo in the toolkit config, list local specs with promotion status, and promote selected specs into `features/YYYY-MM-<slug>/` (README + spec + plan, index updated) behind a quality gate, without ever committing.

**Architecture:** A new `src/core/docs-repo.ts` module owns config read/write (`~/.config/workflow-toolkit/docs-repo.json`) and promotion logic (copy, README generation, index update). Three tools registered in the OpenCode plugin (`src/tools/docs-repo.ts`) and the Cursor MCP server. The promote gate reuses `docsValidate` + `qualitySpec` from `src/core/docs-validate.ts`.

**Tech Stack:** TypeScript + zod (existing), `bun test`, node:fs + child_process (existing patterns). No new dependencies.

## Global Constraints

- Config file: `$WORKFLOW_DOCS_REPO_CONFIG` env override, else `$XDG_CONFIG_HOME|$HOME/.config/workflow-toolkit/docs-repo.json`, shape `{ "path": string }`.
- Link requires `confirmed: true`; validates path is a git repo and `features/` exists-or-created.
- List scans `docs/*/spec.md`; `promoted` = `features/*/<slug>/` dir exists (basename match).
- Promote copies to `features/YYYY-MM-<slug>/` (current month); generates feature README; upserts the index row in `features/README.md`.
- Quality gate: `docsValidate` passes AND `qualitySpec(specText)` has zero hard findings, unless `force: true`.
- Promote never commits/pushes.
- Re-promote is idempotent (overwrite files, replace index row).
- `bun run check` green after every task. Version stays `0.4.0`.

---

### Task 1: `src/core/docs-repo.ts` — config + link validation

**Files:**
- Create: `src/core/docs-repo.ts`
- Test: `test/docs-repo.test.ts`

**Interfaces:**
- Consumes: nothing (node:fs, node:child_process)
- Produces:
  - `readDocsRepoConfig(): { path: string } | null` — null when file missing/invalid
  - `writeDocsRepoConfig(path: string): void` — writes `{ "path": ... }` to the config file (env-overridable)
  - `docsRepoPath(): string | null` — returns configured path or null
  - `validateDocsRepo(path: string): { ok: true } | { ok: false; error: string }` — path exists, is git repo, `features/` exists or created
  - `linkDocsRepo(path: string, confirmed: boolean): { ok: true; path: string } | { ok: false; error: string }` — requires confirmed, validates, writes config

- [ ] **Step 1: Write the failing test**

Create `test/docs-repo.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  readDocsRepoConfig, writeDocsRepoConfig, docsRepoPath,
  validateDocsRepo, linkDocsRepo,
} from "../src/core/docs-repo";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-docsrepo-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "T"]);
  return dir;
};

test("readDocsRepoConfig returns null when missing", () => {
  expect(readDocsRepoConfig()).toBeNull();
});

test("writeDocsRepoConfig + readDocsRepoConfig round trip", () => {
  const dir = makeRepo();
  try {
    writeDocsRepoConfig(dir);
    expect(readDocsRepoConfig()).toEqual({ path: dir });
    expect(docsRepoPath()).toBe(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("validateDocsRepo rejects non-git paths and creates features/", () => {
  const plain = mkdtempSync(path.join(os.tmpdir(), "wf-docsrepo-plain-"));
  try {
    const bad = validateDocsRepo(plain);
    expect(bad.ok).toBe(false);
  } finally { rmSync(plain, { recursive: true, force: true }); }

  const repo = makeRepo();
  try {
    const ok = validateDocsRepo(repo);
    expect(ok.ok).toBe(true);
    expect(existsSync(path.join(repo, "features"))).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("linkDocsRepo requires confirmed and writes config", () => {
  const repo = makeRepo();
  try {
    const noConfirm = linkDocsRepo(repo, false);
    expect(noConfirm.ok).toBe(false);
    const linked = linkDocsRepo(repo, true);
    expect(linked.ok).toBe(true);
    expect(docsRepoPath()).toBe(repo);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
```

Note: the config file is user-global (`~/.config/workflow-toolkit/docs-repo.json`); the test uses the real path but the round-trip test cleans nothing there. To keep tests hermetic, tests may set `process.env.WORKFLOW_DOCS_REPO_CONFIG` to a temp path at the top of the file:

```typescript
process.env.WORKFLOW_DOCS_REPO_CONFIG = path.join(os.tmpdir(), "wf-docsrepo-config-test.json");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/docs-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/docs-repo.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const configPath = () =>
  process.env.WORKFLOW_DOCS_REPO_CONFIG
  ?? path.join(os.homedir(), ".config", "workflow-toolkit", "docs-repo.json");

export const readDocsRepoConfig = (): { path: string } | null => {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as { path?: string };
    return parsed.path ? { path: parsed.path } : null;
  } catch {
    return null;
  }
};

export const writeDocsRepoConfig = (docsPath: string): void => {
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ path: docsPath }, null, 2) + "\n", "utf8");
};

export const docsRepoPath = (): string | null => readDocsRepoConfig()?.path ?? null;

export const validateDocsRepo = (docsPath: string): { ok: true } | { ok: false; error: string } => {
  if (!existsSync(docsPath)) return { ok: false, error: `docs repo path does not exist: ${docsPath}` };
  try {
    execFileSync("git", ["-C", docsPath, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
  } catch {
    return { ok: false, error: `docs repo is not a git repository: ${docsPath}` };
  }
  const featuresDir = path.join(docsPath, "features");
  if (!existsSync(featuresDir)) mkdirSync(featuresDir, { recursive: true });
  return { ok: true };
};

export const linkDocsRepo = (
  docsPath: string,
  confirmed: boolean,
): { ok: true; path: string } | { ok: false; error: string } => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  const valid = validateDocsRepo(docsPath);
  if (!valid.ok) return valid;
  writeDocsRepoConfig(docsPath);
  return { ok: true, path: docsPath };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/docs-repo.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/docs-repo.ts test/docs-repo.test.ts
git commit -m "feat(core): docs repo config link with validation"
```

---

### Task 2: List specs with promotion status

**Files:**
- Modify: `src/core/docs-repo.ts` (add `listSpecs`)
- Test: `test/docs-repo.test.ts` (extend)

**Interfaces:**
- Consumes: `docsRepoPath()` (Task 1)
- Produces:
  - `listSpecs(workspaceRoot: string): { docs_repo: string | null; specs: { slug: string; spec: string; promoted: boolean; target: string | null }[] }` — scans `docs/*/spec.md`; promoted when `<docs-repo>/features/*/<slug>/` exists

- [ ] **Step 1: Write the failing test**

Append to `test/docs-repo.test.ts`:

```typescript
test("listSpecs reports promotion status per slug", () => {
  const repo = makeRepo();
  const work = makeRepo();
  try {
    writeDocsRepoConfig(repo);
    mkdirSync(path.join(work, "docs", "alpha"), { recursive: true });
    mkdirSync(path.join(work, "docs", "beta"), { recursive: true });
    writeFileSync(path.join(work, "docs/alpha/spec.md"), "# Alpha\n\n**Branch:** `feature/alpha`\n");
    writeFileSync(path.join(work, "docs/beta/spec.md"), "# Beta\n\n**Branch:** `feature/beta`\n");
    mkdirSync(path.join(repo, "features", "2026-08-alpha"), { recursive: true });

    const { docs_repo, specs } = listSpecs(work);
    expect(docs_repo).toBe(repo);
    expect(specs).toEqual([
      { slug: "alpha", spec: "docs/alpha/spec.md", promoted: true, target: `${repo}/features/2026-08-alpha` },
      { slug: "beta", spec: "docs/beta/spec.md", promoted: false, target: null },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/docs-repo.test.ts`
Expected: FAIL — `listSpecs` not exported.

- [ ] **Step 3: Implement `listSpecs`**

Append to `src/core/docs-repo.ts`:

```typescript
import { readdirSync } from "node:fs";

export const listSpecs = (
  workspaceRoot: string,
): { docs_repo: string | null; specs: { slug: string; spec: string; promoted: boolean; target: string | null }[] } => {
  const repoPath = docsRepoPath();
  const specs: { slug: string; spec: string; promoted: boolean; target: string | null }[] = [];
  const docsDir = path.join(workspaceRoot, "docs");
  if (existsSync(docsDir)) {
    for (const slug of readdirSync(docsDir)) {
      if (slug.startsWith(".")) continue;
      const spec = path.posix.join("docs", slug, "spec.md");
      if (!existsSync(path.join(workspaceRoot, spec))) continue;
      let promoted = false;
      let target: string | null = null;
      if (repoPath) {
        const featuresDir = path.join(repoPath, "features");
        if (existsSync(featuresDir)) {
          const match = readdirSync(featuresDir).find((d) => d.endsWith(`-${slug}`));
          if (match) {
            promoted = true;
            target = path.join(repoPath, "features", match);
          }
        }
      }
      specs.push({ slug, spec, promoted, target });
    }
  }
  return { docs_repo: repoPath, specs };
};
```

- [ ] **Step 4: Run tests**

Run: `bun test test/docs-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/docs-repo.ts test/docs-repo.test.ts
git commit -m "feat(core): list local specs with docs-repo promotion status"
```

---

### Task 3: Promote — copy, README, index (with quality gate)

**Files:**
- Modify: `src/core/docs-repo.ts` (add `promoteSpec`)
- Test: `test/docs-repo.test.ts` (extend)

**Interfaces:**
- Consumes: `docsRepoPath()`, `listSpecs` internals, `docsValidate` + `qualitySpec` from `./docs-validate`
- Produces:
  - `promoteSpec(workspaceRoot: string, slug: string, opts: { confirmed: boolean; force?: boolean }): { ok: true; target_dir: string; files: string[]; index_updated: boolean } | { ok: false; error: string; findings?: unknown[] }`
  - Behavior: gate (docsValidate pass + no hard quality findings unless force); copy spec.md (+ plan.md if present) into `features/YYYY-MM-<slug>/`; write feature README.md; upsert row in `features/README.md`; never commits.

- [ ] **Step 1: Write the failing test**

Append to `test/docs-repo.test.ts`:

```typescript
import { docsValidate } from "../src/core/docs-validate";

const goodSpec = (slug: string) => `# Spec: ${slug}

**Branch:** \`feature/${slug}\`

## Context

Promotes ${slug} to the docs repo.

## Goals

- Ship ${slug}

## Non-goals

- Nothing

## Architecture

No flow here.

## Acceptance criteria

- CA-01 done
`;

test("promoteSpec copies spec+plan, writes README, updates index", () => {
  const repo = makeRepo();
  const work = makeRepo();
  try {
    writeDocsRepoConfig(repo);
    mkdirSync(path.join(work, "docs", "alpha"), { recursive: true });
    writeFileSync(path.join(work, "docs/alpha/spec.md"), goodSpec("alpha"));
    writeFileSync(
      path.join(work, "docs/alpha/plan.md"),
      "# Plan\n\n**Spec:** `docs/alpha/spec.md`\n**Branch:** `feature/alpha`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );

    const result = promoteSpec(work, "alpha", { confirmed: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files).toEqual(expect.arrayContaining(["spec.md", "plan.md", "README.md"]));
      const target = result.target_dir;
      expect(existsSync(path.join(target, "spec.md"))).toBe(true);
      expect(existsSync(path.join(target, "plan.md"))).toBe(true);
      expect(existsSync(path.join(target, "README.md"))).toBe(true);
      const readme = readFileSync(path.join(target, "README.md"), "utf8");
      expect(readme).toContain("# Feature: alpha");
      expect(readme).toContain("Spec en revisión");
      const index = readFileSync(path.join(repo, "features", "README.md"), "utf8");
      expect(index).toContain("alpha");
    }
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});

test("promoteSpec refuses on hard quality findings unless force", () => {
  const repo = makeRepo();
  const work = makeRepo();
  try {
    writeDocsRepoConfig(repo);
    mkdirSync(path.join(work, "docs", "bad"), { recursive: true });
    writeFileSync(path.join(work, "docs/bad/spec.md"), "# Spec\n\n**Branch:** `feature/bad`\n");

    const refused = promoteSpec(work, "bad", { confirmed: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.findings?.length).toBeGreaterThan(0);

    const forced = promoteSpec(work, "bad", { confirmed: true, force: true });
    expect(forced.ok).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});

test("promoteSpec is idempotent on re-promote", () => {
  const repo = makeRepo();
  const work = makeRepo();
  try {
    writeDocsRepoConfig(repo);
    mkdirSync(path.join(work, "docs", "gamma"), { recursive: true });
    writeFileSync(path.join(work, "docs/gamma/spec.md"), goodSpec("gamma"));
    promoteSpec(work, "gamma", { confirmed: true });
    const again = promoteSpec(work, "gamma", { confirmed: true });
    expect(again.ok).toBe(true);
    if (again.ok) {
      const index = readFileSync(path.join(repo, "features", "README.md"), "utf8");
      expect((index.match(/gamma/g) ?? []).length).toBe(1);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});

test("promoteSpec errors when docs repo not linked", () => {
  const work = makeRepo();
  try {
    process.env.WORKFLOW_DOCS_REPO_CONFIG = path.join(os.tmpdir(), "wf-docsrepo-unlinked.json");
    const result = promoteSpec(work, "alpha", { confirmed: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("docs repo not linked");
  } finally { rmSync(work, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/docs-repo.test.ts`
Expected: FAIL — `promoteSpec` not exported.

- [ ] **Step 3: Implement `promoteSpec`**

Append to `src/core/docs-repo.ts`:

```typescript
import { docsValidate, qualitySpec } from "./docs-validate";

const monthPrefix = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

const readSafe = (p: string): string | null => {
  try { return readFileSync(p, "utf8"); } catch { return null; }
};

const specSummary = (specText: string): string => {
  const contextMatch = specText.match(/## Context\n\n([\s\S]*?)(?=\n## )/);
  if (!contextMatch) return "";
  const first = contextMatch[1].trim().split("\n").find((l) => l.trim() && !l.startsWith("<!--"));
  return (first ?? "").trim();
};

const specRepos = (specText: string): string => {
  const match = specText.match(/^\*\*Repos:\*\*\s*(.+)$/m);
  return match?.[1]?.trim() ?? "—";
};

export const promoteSpec = (
  workspaceRoot: string,
  slug: string,
  opts: { confirmed: boolean; force?: boolean },
): { ok: true; target_dir: string; files: string[]; index_updated: boolean }
  | { ok: false; error: string; findings?: unknown[] } => {
  if (!opts.confirmed) return { ok: false, error: "confirmed: true required" };
  const repoPath = docsRepoPath();
  if (!repoPath) return { ok: false, error: "docs repo not linked — run workit_docs_repo_link" };

  const specRel = path.posix.join("docs", slug, "spec.md");
  const planRel = path.posix.join("docs", slug, "plan.md");
  const specText = readSafe(path.join(workspaceRoot, specRel));
  if (specText === null) return { ok: false, error: `docs/${slug}/spec.md not found` };

  const planText = readSafe(path.join(workspaceRoot, planRel));
  const validated = docsValidate({ spec_path: specRel, plan_path: planRel, workspace_root: workspaceRoot });
  if (validated.ok === false) return { ok: false, error: validated.error };

  const findings = qualitySpec(specText);
  const hardFindings = findings.filter((f) => f.severity === "hard");
  if (hardFindings.length > 0 && !opts.force) {
    return { ok: false, error: "spec has hard quality findings; pass force: true to override", findings };
  }

  const prefix = monthPrefix();
  const targetDir = path.join(repoPath, "features", `${prefix}-${slug}`);
  mkdirSync(targetDir, { recursive: true });

  const files: string[] = ["spec.md"];
  writeFileSync(path.join(targetDir, "spec.md"), specText, "utf8");
  if (planText !== null) {
    writeFileSync(path.join(targetDir, "plan.md"), planText, "utf8");
    files.push("plan.md");
  }

  const title = specText.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;
  const readme = `# Feature: ${title}

**Fecha:** ${prefix}
**Estado:** Spec en revisión
**Repos afectados:** ${specRepos(specText)}

## Resumen

${specSummary(specText)}

## Documentación

| Documento | Contenido |
| --- | --- |
| [spec.md](./spec.md) | Especificación completa |
${planText !== null ? "| [plan.md](./plan.md) | Plan de implementación |\n" : ""}`;
  writeFileSync(path.join(targetDir, "README.md"), readme, "utf8");
  files.push("README.md");

  const indexPath = path.join(repoPath, "features", "README.md");
  const indexText = readSafe(indexPath) ?? `# Features\n\nEspecificaciones y planes por feature.\n\n## Features documentadas\n\n| Feature | Repos afectados | Estado |\n| --- | --- | --- |\n`;
  const row = `| [${slug}](./${prefix}-${slug}/) | ${specRepos(specText)} | Spec en revisión |`;
  const rowRe = new RegExp(`^\\| \\[${slug}\\]\\([^)]*\\) \\|.*$`, "m");
  let newIndex: string;
  if (rowRe.test(indexText)) {
    newIndex = indexText.replace(rowRe, row);
  } else if (/^(\| --- \| --- \| --- \|\n)/m.test(indexText)) {
    newIndex = indexText.replace(/^(\| --- \| --- \| --- \|\n)/m, `$1${row}\n`);
  } else {
    newIndex = indexText + `\n${row}\n`;
  }
  writeFileSync(indexPath, newIndex, "utf8");

  return { ok: true, target_dir: targetDir, files, index_updated: true };
};
```

- [ ] **Step 4: Run tests**

Run: `bun test test/docs-repo.test.ts`
Expected: PASS (7 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add src/core/docs-repo.ts test/docs-repo.test.ts
git commit -m "feat(core): promote spec+plan to docs repo with quality gate and index"
```

---

### Task 4: Register the three tools (OpenCode plugin + Cursor MCP)

**Files:**
- Create: `src/tools/docs-repo.ts`
- Modify: `src/tools/index.ts`
- Modify: `cursor/mcp/server.ts`
- Modify: `test/plugin.test.ts` (tool list fixture)
- Modify: `test/smoke.ts` (tool count)
- Test: `test/docs-repo-tools.test.ts`

**Interfaces:**
- Consumes: `linkDocsRepo`, `listSpecs`, `promoteSpec` from `src/core/docs-repo`
- Produces (registered tools, `{ ok, data, error }` envelope):
  - `workit_docs_repo_link({ path, confirmed })`
  - `workit_docs_list()` — reads `context.directory` as workspace
  - `workit_docs_promote({ slug, confirmed, force? })`

- [ ] **Step 1: Write the failing test**

Create `test/docs-repo-tools.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createDocsRepoTools } from "../src/tools/docs-repo";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
const makeRepo = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-docsrepo-tool-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "T"]);
  return dir;
};

test("repo_link requires confirmed and persists", async () => {
  const repo = makeRepo();
  try {
    process.env.WORKFLOW_DOCS_REPO_CONFIG = path.join(os.tmpdir(), "wf-docsrepo-tool-config.json");
    const tools = createDocsRepoTools();
    const ctx = { directory: repo, worktree: repo } as never;
    const no = JSON.parse(await tools.workit_docs_repo_link.execute({ path: repo, confirmed: false }, ctx) as string);
    expect(no.ok).toBe(false);
    const yes = JSON.parse(await tools.workit_docs_repo_link.execute({ path: repo, confirmed: true }, ctx) as string);
    expect(yes.ok).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("docs_list reports specs; promote copies files", async () => {
  const repo = makeRepo();
  const work = makeRepo();
  try {
    process.env.WORKFLOW_DOCS_REPO_CONFIG = path.join(os.tmpdir(), "wf-docsrepo-tool-config2.json");
    const { writeDocsRepoConfig } = await import("../src/core/docs-repo");
    writeDocsRepoConfig(repo);
    mkdirSync(path.join(work, "docs", "zeta"), { recursive: true });
    writeFileSync(path.join(work, "docs/zeta/spec.md"),
      `# Spec: zeta\n\n**Branch:** \`feature/zeta\`\n\n## Context\n\nPromotes zeta.\n\n## Goals\n\n- Ship zeta\n\n## Non-goals\n\n- Nothing\n\n## Architecture\n\nNo flow here.\n\n## Acceptance criteria\n\n- CA-01 done\n`);

    const tools = createDocsRepoTools();
    const ctx = { directory: work, worktree: work } as never;
    const list = JSON.parse(await tools.workit_docs_list.execute({}, ctx) as string);
    expect(list.ok).toBe(true);
    expect(list.data.specs[0].slug).toBe("zeta");
    expect(list.data.specs[0].promoted).toBe(false);

    const promote = JSON.parse(await tools.workit_docs_promote.execute(
      { slug: "zeta", confirmed: true }, ctx) as string);
    expect(promote.ok).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/docs-repo-tools.test.ts`
Expected: FAIL — `createDocsRepoTools` not found.

- [ ] **Step 3: Implement `src/tools/docs-repo.ts`**

```typescript
import { tool } from "@opencode-ai/plugin";
import { fail, ok } from "../core";
import { linkDocsRepo, listSpecs, promoteSpec } from "../core/docs-repo";

const output = (value: unknown) => JSON.stringify(value, null, 2);

export function createDocsRepoTools() {
  return {
    workit_docs_repo_link: tool({
      description: "Link the component docs repo in the toolkit config (validates git repo + features/)",
      args: {
        path: tool.schema.string(),
        confirmed: tool.schema.boolean(),
      },
      execute: async ({ path: docsPath, confirmed }, _context) => {
        const result = linkDocsRepo(docsPath, confirmed);
        return output(result.ok ? ok({ path: result.path }) : fail(result.error));
      },
    }),
    workit_docs_list: tool({
      description: "List local specs (docs/<slug>/spec.md) with docs-repo promotion status",
      args: {},
      execute: async (_input, context) => {
        const result = listSpecs(context.directory);
        return output(ok(result));
      },
    }),
    workit_docs_promote: tool({
      description: "Promote a spec (+plan) to the linked docs repo features/YYYY-MM-<slug>/ with quality gate",
      args: {
        slug: tool.schema.string(),
        confirmed: tool.schema.boolean(),
        force: tool.schema.boolean().optional(),
      },
      execute: async ({ slug, confirmed, force }, context) => {
        const result = promoteSpec(context.directory, slug, { confirmed, force });
        if (result.ok) return output(ok({ target_dir: result.target_dir, files: result.files, index_updated: result.index_updated }));
        return output(fail(result.error, { findings: result.findings ?? [] } as never));
      },
    }),
  };
}
```

- [ ] **Step 4: Register in `src/tools/index.ts`**

Add import + spread:

```typescript
import { createDocsRepoTools } from "./docs-repo";
// inside createTools(...):
  ...createDocsRepoTools(),
```

- [ ] **Step 5: Register in `cursor/mcp/server.ts`**

Import the core functions:

```typescript
import { linkDocsRepo, listSpecs, promoteSpec } from "../../src/core/docs-repo";
```

Register three tools before the transport (match the existing `server.registerTool` pattern with zod schemas):

```typescript
server.registerTool(
  "workit_docs_repo_link",
  {
    description: "Link the component docs repo in the toolkit config",
    inputSchema: {
      path: z.string(),
      confirmed: z.boolean(),
    },
  },
  async ({ path: docsPath, confirmed }) => {
    const result = linkDocsRepo(docsPath, confirmed);
    if (!result.ok) return jsonResult({ error: result.error });
    return jsonResult({ path: result.path });
  },
);

server.registerTool(
  "workit_docs_list",
  {
    description: "List local specs with docs-repo promotion status",
    inputSchema: { workspace_root: workspaceRootSchema },
  },
  async ({ workspace_root }) => jsonResult(listSpecs(workspace_root ?? process.cwd())),
);

server.registerTool(
  "workit_docs_promote",
  {
    description: "Promote a spec (+plan) to the linked docs repo with quality gate",
    inputSchema: {
      slug: z.string(),
      confirmed: z.boolean(),
      force: z.boolean().optional(),
      workspace_root: workspaceRootSchema,
    },
  },
  async ({ slug, confirmed, force, workspace_root }) => {
    const result = promoteSpec(workspace_root ?? process.cwd(), slug, { confirmed, force });
    if (!result.ok) return jsonResult({ error: result.error, findings: result.findings ?? [] });
    return jsonResult({ target_dir: result.target_dir, files: result.files, index_updated: result.index_updated });
  },
);
```

- [ ] **Step 6: Update tool-list fixtures**

In `test/plugin.test.ts`, add the three names to the `fixtures` map (they return errors on missing inputs, which is fine for the envelope test):

```typescript
workit_docs_repo_link: { path: "missing", confirmed: false },
workit_docs_list: {},
workit_docs_promote: { slug: "x", confirmed: false },
```

In `test/smoke.ts`, bump the tool count from 35 to 38:

```typescript
expect(Object.keys(hooks.tool ?? {})).toHaveLength(38);
```

- [ ] **Step 7: Run the full suite**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tools/docs-repo.ts src/tools/index.ts cursor/mcp/server.ts test/docs-repo-tools.test.ts test/plugin.test.ts test/smoke.ts
git commit -m "feat(tools): register docs repo link/list/promote on opencode + cursor"
```

---

## Post-plan checklist

- [ ] `bun run check` green after each task.
- [ ] `src/core/docs-repo.ts` exports `readDocsRepoConfig`, `writeDocsRepoConfig`, `docsRepoPath`, `validateDocsRepo`, `linkDocsRepo`, `listSpecs`, `promoteSpec`.
- [ ] Config file env-overridable (`WORKFLOW_DOCS_REPO_CONFIG`) and hermetic in tests.
- [ ] Promote gate uses `docsValidate` + `qualitySpec`; `force` bypasses hard findings.
- [ ] Promote never commits; idempotent on re-promote.
- [ ] Three tools registered on both platforms; smoke tool count = 38.
- [ ] Feature README + index follow the bulkload format (`features/YYYY-MM-<slug>/`).
