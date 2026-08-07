# Toolkit Config Phase 1 — Config core, assisted init, locale, branch policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/toolkit-config/spec.md`
**Branch:** `feature/toolkit-config`
**Goal:** Add the multi-user config core: `config.json` (locale + branch policy) read/written via `src/core/config.ts`, an assisted `wf-init` wizard mode, locale-aware bootstrap injection, and branch-policy-driven branch tools — all with fallback to today's defaults.

**Architecture:** A new `src/core/config.ts` owns `config.json` (env-overridable `WORKFLOW_TOOLKIT_CONFIG` dir, default `~/.config/workflow-toolkit/`). `resolveBranchPolicy()` feeds `src/core/branch.ts` (replacing hardcoded `BRANCH_PAT`/`PROTECTED`) and `docs-validate.ts`. The bootstrap injects `config.locale`. `workflow_toolkit_init_apply` gains guided-mode args (config values passed by the skill after native questions).

**Tech Stack:** TypeScript + zod (existing), `bun test`, node:fs (existing patterns). No new dependencies.

## Global Constraints

- Config file: `$WORKFLOW_TOOLKIT_CONFIG_DIR` env override, else `$XDG_CONFIG_HOME|$HOME/.config/workflow-toolkit/`; `config.json` inside it.
- `locale` validated `/^[a-z]{2,3}(-[A-Z]{2})?$/`; default `en`.
- Branch policy presets: `gitflow` (default; allowed `feature/*`,`bugfix/*`,`hotfix/*`,`release/*`; protected `main`,`develop`,`master`,`prod`,`production`), `github-flow` (allowed `*`; protected `main`), `trunk-based` (allowed `*`; protected `main`), `custom` (explicit lists authoritative).
- `allowed` patterns convert to regex (`*` → `[^/]*`); `protected` is an exact-name set.
- Missing config.json → defaults (en, gitflow) — toolkit still works.
- `bun run check` green after every task. Version stays `0.4.0`.

---

### Task 1: `src/core/config.ts` — config core

**Files:**
- Create: `src/core/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing (node:fs)
- Produces:
  - `configDir(): string` — env-overridable config dir
  - `readConfig(): ToolkitConfig` — parsed config.json, defaults when missing/invalid (never throws)
  - `writeConfig(config: ToolkitConfig): void` — writes config.json (mkdir -p)
  - `type ToolkitConfig = { locale: string; localeOptions: string[]; timezone: string; branchPolicy: { preset: BranchPreset; allowed: string[]; protected: string[] } }`
  - `type BranchPreset = "gitflow" | "github-flow" | "trunk-based" | "custom"`
  - `PRESETS: Record<BranchPreset, { allowed: string[]; protected: string[] }>`
  - `resolveBranchPolicy(config: ToolkitConfig): { allowed: RegExp[]; protected: Set<string> }` — preset defaults overridden by explicit fields; custom uses fields as-is

- [ ] **Step 1: Write the failing test**

Create `test/config.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configDir, readConfig, writeConfig, resolveBranchPolicy, PRESETS,
  type ToolkitConfig,
} from "../src/core/config";

const cfgDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-config-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
  return dir;
};

test("readConfig returns defaults when config.json missing", () => {
  const dir = cfgDir();
  try {
    const cfg = readConfig();
    expect(cfg.locale).toBe("en");
    expect(cfg.branchPolicy.preset).toBe("gitflow");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeConfig + readConfig round trip", () => {
  const dir = cfgDir();
  try {
    const cfg: ToolkitConfig = {
      locale: "es-CL",
      localeOptions: ["en", "es-CL"],
      timezone: "America/Santiago",
      branchPolicy: { preset: "custom", allowed: ["feature/*", "codex/*"], protected: ["main"] },
    };
    writeConfig(cfg);
    expect(readConfig()).toEqual(cfg);
    expect(existsSync(path.join(dir, "config.json"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid locale falls back to en", () => {
  const dir = cfgDir();
  try {
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ locale: "not-valid!" }), "utf8");
    expect(readConfig().locale).toBe("en");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("presets define allowed/protected lists", () => {
  expect(PRESETS.gitflow.allowed).toContain("feature/*");
  expect(PRESETS.gitflow.allowed).toContain("bugfix/*");
  expect(PRESETS.gitflow.protected).toContain("develop");
  expect(PRESETS.githubflow?.allowed ?? PRESETS["github-flow"].allowed).toContain("*");
});

test("resolveBranchPolicy honors preset and custom overrides", () => {
  const dir = cfgDir();
  try {
    const gitflow = resolveBranchPolicy(readConfig());
    expect(gitflow.allowed.some((r) => r.test("feature/x"))).toBe(true);
    expect(gitflow.allowed.some((r) => r.test("codex/feature/x"))).toBe(false);
    expect(gitflow.protected.has("main")).toBe(true);

    writeConfig({
      locale: "en", localeOptions: ["en"], timezone: "UTC",
      branchPolicy: { preset: "custom", allowed: ["codex/*"], protected: ["main"] },
    });
    const custom = resolveBranchPolicy(readConfig());
    expect(custom.allowed.some((r) => r.test("codex/feature/x"))).toBe(true);
    expect(custom.allowed.some((r) => r.test("feature/x"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/config.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type BranchPreset = "gitflow" | "github-flow" | "trunk-based" | "custom";

export type ToolkitConfig = {
  locale: string;
  localeOptions: string[];
  timezone: string;
  branchPolicy: { preset: BranchPreset; allowed: string[]; protected: string[] };
};

export const PRESETS: Record<BranchPreset, { allowed: string[]; protected: string[] }> = {
  gitflow: { allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"], protected: ["main", "develop", "master", "prod", "production"] },
  "github-flow": { allowed: ["*"], protected: ["main"] },
  "trunk-based": { allowed: ["*"], protected: ["main"] },
  custom: { allowed: [], protected: [] },
};

export const configDir = (): string =>
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR
  ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "workflow-toolkit");

const LOCALE_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

const DEFAULTS: ToolkitConfig = {
  locale: "en",
  localeOptions: ["en", "es-CL", "es-MX", "es-AR", "pt-BR"],
  timezone: "America/Santiago",
  branchPolicy: { preset: "gitflow", allowed: PRESETS.gitflow.allowed, protected: PRESETS.gitflow.protected },
};

const readSafe = (p: string): string | null => {
  try { return readFileSync(p, "utf8"); } catch { return null; }
};

export const readConfig = (): ToolkitConfig => {
  const raw = readSafe(path.join(configDir(), "config.json"));
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<ToolkitConfig>;
    const locale = LOCALE_RE.test(String(parsed.locale ?? "")) ? parsed.locale as string : DEFAULTS.locale;
    const preset = (parsed.branchPolicy?.preset ?? "gitflow") as BranchPreset;
    const presetOk = preset in PRESETS ? preset : "gitflow";
    const presetDefs = PRESETS[presetOk];
    return {
      locale,
      localeOptions: Array.isArray(parsed.localeOptions) ? parsed.localeOptions : DEFAULTS.localeOptions,
      timezone: parsed.timezone ?? DEFAULTS.timezone,
      branchPolicy: {
        preset: presetOk,
        allowed: Array.isArray(parsed.branchPolicy?.allowed) ? parsed.branchPolicy.allowed : presetDefs.allowed,
        protected: Array.isArray(parsed.branchPolicy?.protected) ? parsed.branchPolicy.protected : presetDefs.protected,
      },
    };
  } catch {
    return DEFAULTS;
  }
};

export const writeConfig = (config: ToolkitConfig): void => {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
};

export const resolveBranchPolicy = (config: ToolkitConfig): { allowed: RegExp[]; protected: Set<string> } => {
  const allowed = config.branchPolicy.allowed.map((p) =>
    new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`));
  return { allowed, protected: new Set(config.branchPolicy.protected.map((p) => p.toLowerCase())) };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts test/config.test.ts
git commit -m "feat(core): config.json with locale and branch policy presets"
```

---

### Task 2: Branch policy drives branch tools

**Files:**
- Modify: `src/core/branch.ts` (use `resolveBranchPolicy` instead of hardcoded `BRANCH_PAT`/`PROTECTED`)
- Modify: `src/core/docs-validate.ts` (branch check via policy when requested)
- Test: `test/branch-policy.test.ts` (extend — policy rejects codex/, custom allows)

**Interfaces:**
- Consumes: `readConfig`, `resolveBranchPolicy` (Task 1)
- Produces: branch tools validate against the resolved policy; `docsValidate` branch check unchanged by default (gitflow) but policy-aware

- [ ] **Step 1: Write the failing test**

Append to `test/branch-policy.test.ts`:

```typescript
import { readConfig, writeConfig, resolveBranchPolicy } from "../src/core/config";

test("branch policy rejects codex/ under gitflow and allows under custom", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-branch-policy-"));
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
    const { resolveBranch } = await import("../src/core/branch");

    // gitflow default: codex/feature/x rejected
    const repo = mkdtempSync(path.join(os.tmpdir(), "wf-branch-policy-repo-"));
    const run = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    run(["init", "-q", "-b", "develop"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(path.join(repo, "r.md"), "x");
    run(["add", "r.md"]);
    run(["commit", "-q", "-m", "base"]);
    run(["checkout", "-q", "-b", "main"]);
    mkdirSync(path.join(repo, "docs", "codex-feat"), { recursive: true });
    writeFileSync(path.join(repo, "docs/codex-feat/spec.md"), "# S\n\n**Branch:** `codex/feature/x`\n");
    writeFileSync(path.join(repo, "docs/codex-feat/plan.md"), "# P\n\n**Spec:** `docs/codex-feat/spec.md`\n**Branch:** `codex/feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n");

    const gitflowRes = resolveBranch({ spec_path: "docs/codex-feat/spec.md", plan_path: "docs/codex-feat/plan.md", workspace_root: repo });
    expect("error" in gitflowRes).toBe(true);

    // custom allows codex/*
    writeConfig({
      locale: "en", localeOptions: ["en"], timezone: "UTC",
      branchPolicy: { preset: "custom", allowed: ["codex/*"], protected: ["main"] },
    });
    const customRes = resolveBranch({ spec_path: "docs/codex-feat/spec.md", plan_path: "docs/codex-feat/plan.md", workspace_root: repo });
    expect("error" in customRes).toBe(false);
    if (!("error" in customRes)) expect(customRes.branch).toBe("codex/feature/x");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/branch-policy.test.ts -t "branch policy rejects"`
Expected: FAIL — `codex/feature/x` passes under the hardcoded gitflow pattern... (verify: the current `normalizeBranch` rejects it because `BRANCH_PAT` only allows `feature|bugfix`; so the gitflow case passes already. The custom case fails — `codex/feature/x` is still rejected.)

- [ ] **Step 3: Wire policy into `src/core/branch.ts`**

Replace the module-level constants with policy-driven lookups:

```typescript
import { readConfig, resolveBranchPolicy } from "./config";

// Replace: const PROTECTED = ...; const BRANCH_PAT = ...;
const policy = () => resolveBranchPolicy(readConfig());
```

Update each usage:

```typescript
// normalizeBranch: use policy().allowed
const normalizeBranch = (name: string): string | null => {
  let n = name.trim().replace(/`/g, "").replace(/\.+$/, "");
  const pol = policy();
  if (pol.protected.has(n.toLowerCase())) return null;
  if (!pol.allowed.some((r) => r.test(n))) return null;
  const [kind, ...restParts] = n.split("/");
  const rest = restParts.join("/").toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  if (!rest) return null;
  return `${kind.toLowerCase()}/${rest}`;
};
```

```typescript
// use-current checks: replace BRANCH_PAT.test(current) with policy().allowed.some(r => r.test(current))
// keep-current: same
// docsBranch keep check: same
// branchSetup protected: replace PROTECTED.has(target) with policy().protected.has(target.toLowerCase())
// branchSetup target kind check: replace /^(feature|bugfix)\// with policy().allowed.some(r => r.test(target))
```

Note: `policy()` reads config each call (cheap, file-based); acceptable — no caching needed at this scale.

- [ ] **Step 4: Wire policy into `src/core/docs-validate.ts`**

The `readBranch` check uses `BRANCH_RE` (regex for the `**Branch:**` header) — that stays. The branch *mismatch* check (`specBranch != planBranch`) stays. Policy does not change header parsing; only branch *tools* validate names against the policy. No change needed in docs-validate unless a branch-name validity check is added — skip for Phase 1.

- [ ] **Step 5: Run tests**

Run: `bun test test/branch-policy.test.ts && bun test`
Expected: PASS — new test + existing branch tests (gitflow default behavior unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/core/branch.ts test/branch-policy.test.ts
git commit -m "feat(core): branch tools use configurable branch policy"
```

---

### Task 3: Locale-aware bootstrap

**Files:**
- Modify: `src/bootstrap.ts` (inject `config.locale` into the contract)
- Test: `test/bootstrap.test.ts` (extend)

**Interfaces:**
- Consumes: `readConfig` (Task 1)
- Produces: bootstrap contract includes one line: "Answer the user in `{locale}` unless a template declares otherwise."

- [ ] **Step 1: Write the failing test**

Append to `test/bootstrap.test.ts`:

```typescript
test("bootstrap contract declares the configured locale", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-bootstrap-locale-"));
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      locale: "es-CL", localeOptions: ["en", "es-CL"], timezone: "UTC",
      branchPolicy: { preset: "gitflow" },
    }, null, 2));
    const fresh = await import(`../src/bootstrap?locale=${Date.now()}`);
    const bootstrap = fresh.getWorkflowBootstrap();
    expect(bootstrap).toContain("es-CL");
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bootstrap.test.ts -t "declares the configured locale"`
Expected: FAIL — bootstrap does not mention locale.

- [ ] **Step 3: Inject locale in `src/bootstrap.ts`**

In `getWorkflowBootstrap()`, after building the contract text, append the locale line:

```typescript
import { readConfig } from "./core/config";
// ...
const config = readConfig();
cached = `${marker}
HARD-GATE: ... (existing)

## Locale

Answer the user in \`${config.locale}\` unless a specific template declares otherwise.
`;
```

(Keep the existing contract text; add the `## Locale` section before the closing marker.)

- [ ] **Step 4: Run tests**

Run: `bun test test/bootstrap.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap.ts test/bootstrap.test.ts
git commit -m "feat(bootstrap): inject configured locale into the contract"
```

---

### Task 4: Assisted init — guided config values in `workflow_toolkit_init_apply`

**Files:**
- Modify: `src/tools/repo.ts` (`workflow_toolkit_init_apply` accepts and writes config.json values)
- Modify: `cursor/mcp/server.ts` (same args)
- Test: `test/config-tools.test.ts`

**Interfaces:**
- Consumes: `writeConfig`, `readConfig` (Task 1)
- Produces: `workflow_toolkit_init_apply` gains optional args `{ locale?, localeOptions?, timezone?, branch_policy_preset?, branch_policy_allowed?, branch_policy_protected? }` — when present, writes/updates `config.json`; when absent, current behavior unchanged

- [ ] **Step 1: Write the failing test**

Create `test/config-tools.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepoTools } from "../src/tools/repo";
import { readConfig } from "../src/core/config";

test("init_apply writes config.json with guided values", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-config-tools-"));
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
    const tools = createRepoTools();
    const raw = await tools.workflow_toolkit_init_apply.execute({
      confirmed: true,
      action: "config",
      locale: "es-CL",
      branch_policy_preset: "custom",
      branch_policy_allowed: ["feature/*", "codex/*"],
      branch_policy_protected: ["main"],
    }, { directory: dir, worktree: dir } as never);
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    const cfg = readConfig();
    expect(cfg.locale).toBe("es-CL");
    expect(cfg.branchPolicy.preset).toBe("custom");
    expect(cfg.branchPolicy.allowed).toContain("codex/*");
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config-tools.test.ts`
Expected: FAIL — `action: "config"` unsupported.

- [ ] **Step 3: Extend `workflow_toolkit_init_apply` in `src/tools/repo.ts`**

Find the tool (around line 284). It currently maps `action` to `init/apply.sh`. Add a `config` action handled in TS before the script dispatch:

```typescript
// inside workflow_toolkit_init_apply execute, before the script call:
if (action === "config") {
  const current = readConfig();
  const next: ToolkitConfig = {
    locale: locale ?? current.locale,
    localeOptions: localeOptions ?? current.localeOptions,
    timezone: timezone ?? current.timezone,
    branchPolicy: {
      preset: (branch_policy_preset as BranchPreset) ?? current.branchPolicy.preset,
      allowed: branch_policy_allowed ?? current.branchPolicy.allowed,
      protected: branch_policy_protected ?? current.branchPolicy.protected,
    },
  };
  writeConfig(next);
  return output(ok({ action: "config", path: path.join(configDir(), "config.json"), ...next }));
}
```

Extend the tool args:

```typescript
locale: tool.schema.string().optional(),
localeOptions: tool.schema.array(tool.schema.string()).optional(),
timezone: tool.schema.string().optional(),
branch_policy_preset: tool.schema.enum(["gitflow", "github-flow", "trunk-based", "custom"]).optional(),
branch_policy_allowed: tool.schema.array(tool.schema.string()).optional(),
branch_policy_protected: tool.schema.array(tool.schema.string()).optional(),
```

- [ ] **Step 4: Mirror in `cursor/mcp/server.ts`**

In the `workflow_toolkit_init_apply` registration, add the same optional zod fields and a `config` branch in the handler that calls `writeConfig`/`readConfig` with the same merge logic.

- [ ] **Step 5: Run tests**

Run: `bun test test/config-tools.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 6: Update `skills/wf-init/SKILL.md`**

Add a guided-mode section: after native questions (VCS, YouTrack, locale combobox, branch preset), call `workflow_toolkit_init_apply` with `action: "config"` and the answered values.

- [ ] **Step 7: Commit**

```bash
git add src/tools/repo.ts cursor/mcp/server.ts test/config-tools.test.ts skills/wf-init/SKILL.md
git commit -m "feat(init): assisted config action with locale and branch policy"
```

---

## Post-plan checklist (Phase 1)

- [ ] `bun run check` green after each task.
- [ ] `src/core/config.ts` exports `configDir`, `readConfig`, `writeConfig`, `PRESETS`, `resolveBranchPolicy`.
- [ ] Branch tools reject `codex/feature/x` under gitflow; custom policy allows it (tested).
- [ ] Bootstrap contract includes the configured locale line.
- [ ] `workflow_toolkit_init_apply` accepts `action: "config"` with guided values on both platforms.
- [ ] Existing behavior unchanged with no config.json (defaults en/gitflow).
- [ ] Missing config never hard-fails any tool.
