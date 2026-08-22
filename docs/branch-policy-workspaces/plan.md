# Per-Workspace Branch Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/branch-policy-workspaces/spec.md`
**Branch:** `feature/workit-reliability-overhaul`

**Goal:** Per-workspace `branchPolicy` (preset, develop branch, prefixes, protected, `integration: pr|merge`) with a git-flow-style idempotent detection init, CLI wizard parity, and a repo AGENTS.md documenting the multi-platform contract.

**Architecture:** `workspaces.json` entries gain `branchPolicy`; one shared `resolveBranchPolicyFor(workspace_root)` (workspace > global > preset) replaces every per-consumer `resolveBranchPolicy(readConfig())`. A new core `detectBranchPolicy(root)` inspects main/master/develop presence and proposes a policy; the init action and CLI wizard share the same proposal→write path. `prCreate` gains `integration: "merge"` support (local finish: merge feature → target, push, no PR).

**Tech Stack:** TypeScript (bun), existing core modules (`config.ts`, `workspaces.ts`, `branch.ts`, `init.ts`, `pr-create.ts`), CLI Ink wizard (`wizard-state.ts`, `steps.tsx`, `logic.ts`), OpenCode plugin + Cursor MCP tool adapters, `bun test` / `bun run check`.

## Global Constraints

- Resolution order is fixed: workspace `branchPolicy` > global `config.json` `branchPolicy` > preset defaults (CA-01).
- Every policy consumer goes through the single resolver `resolveBranchPolicyFor(workspace_root)` (CA-09); consumers never read `readConfig()` + `resolveBranchPolicy()` themselves.
- `integration` defaults to `"pr"`; gitflow detection proposes `"merge"` (CA-04, D-03).
- Detection rules (CA-02): `develop` present → gitflow (protected root+develop, prefixes `feature/* bugfix/* hotfix/* release/*`, developBranch `develop`, integration `merge`); only `main` → github-flow (protected `main`, allowed `*`, `pr`); only `master` → trunk-based (protected `master`, allowed `*`, `pr`).
- Init is idempotent: identical re-run → already-configured; drift (new `develop`) proposes update; the workspace entry is created when absent (glob = repo root) and other workspace fields are preserved (CA-03).
- `vcs.defaultTargetBranch` is set when unset: gitflow → `develop`, github-flow/trunk-based → `main`/`master` (CA-05).
- Wizard and host init action produce byte-identical workspace writes on the same fixture (CA-06).
- Feature work ships with README/AGENTS.md updates and a CHANGELOG Unreleased entry (CA-07, CA-08).
- git-flow release start/finish/tags are OUT of scope (D-05).

---

### Task 1: Workspace-aware policy resolution in core

**Files:**
- Modify: `packages/workit-core/src/core/workspaces.ts` (WorkspaceConfig + `branchPolicy` type)
- Modify: `packages/workit-core/src/core/config.ts` (`resolveBranchPolicy` gains an optional workspace argument)
- Modify: `packages/workit-core/src/core/branch.ts` (new `resolveBranchPolicyFor(root)`; `docsBranch` uses it)
- Modify: `packages/workit-opencode/src/tools/repo.ts` (commit gate uses `resolveBranchPolicyFor(context.directory)`)
- Modify: `packages/workit-core/src/core/pr-create.ts` (target-override validation uses `resolveBranchPolicyFor(root)`)
- Modify: `packages/workit-cursor/mcp/server.ts` (any policy use routes through the core resolver)
- Test: `test/workit-core/branch-policy.test.ts` (extend)

**Interfaces:**
- Consumes: `PRESETS`, `BranchPreset`, `mergePreset` (config.ts), `resolveWorkspace(root)` (workspaces.ts).
- Produces: `type IntegrationMode = "pr" | "merge"`; `type WorkspaceBranchPolicy = { preset: BranchPreset; developBranch?: string; prefixes?: { feature: string; bugfix: string; release: string; hotfix: string }; allowed?: string[]; protected?: string[]; integration: IntegrationMode }`; `WorkspaceConfig.branchPolicy?: WorkspaceBranchPolicy`; `resolveBranchPolicy(config, workspace?)`; `resolveBranchPolicyFor(workspace_root: string)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/workit-core/branch-policy.test.ts` (place near the existing RL-03 cross-surface test, reusing `repoWithDevelop()` and the isolated config helpers):

```ts
test("CA-01: workspace branchPolicy overrides global config policy across consumers", async () => {
  const { root, remote } = repoWithDevelop();
  try {
    writeFileSync(
      path.join(isolatedConfig, "workit", "config.json"),
      JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
    );
    writeFileSync(
      path.join(isolatedConfig, "workit", "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            name: "w",
            glob: `${root}/**`,
            branchPolicy: { preset: "gitflow", integration: "merge" },
          },
        ],
      }),
    );
    git(root, ["checkout", "-q", "-b", "feature/rel03"]);
    const pol = resolveBranchPolicyFor(root);
    expect(pol.preset).toBe("gitflow");
    expect(pol.integration).toBe("merge");
    expect(pol.protected).toContain("develop");
    const db = docsBranch({ plan_path: "docs/x/plan.md", workspace_root: root });
    expect(db.base).toBe("develop");
    const p = prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    expect(p.ok, JSON.stringify(p)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("CA-01: unmatched repo falls back to global policy, then preset defaults", async () => {
  const { root, remote } = repoWithDevelop();
  try {
    writeFileSync(
      path.join(isolatedConfig, "workit", "config.json"),
      JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
    );
    writeFileSync(path.join(isolatedConfig, "workit", "workspaces.json"), "{\"workspaces\":[]}");
    git(root, ["checkout", "-q", "-b", "feature/x"]);
    expect(resolveBranchPolicyFor(root).preset).toBe("github-flow");
    rmSync(path.join(isolatedConfig, "workit", "config.json"), { force: true });
    expect(resolveBranchPolicyFor(root).preset).toBe("gitflow"); // PRESETS default
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
```

Also extend the existing RL-03 cross-surface test: its workspace entries gain `branchPolicy: { preset: c.preset }`; assertions stay the same.

- [ ] **Step 2: Run RED**

Run: `bun test test/workit-core/branch-policy.test.ts`
Expected: FAIL — `resolveBranchPolicyFor` is not defined; workspace policy ignored; `prCreate`/`docsBranch` still resolve the global policy only.

- [ ] **Step 3: Implement the minimum resolution change**

In `packages/workit-core/src/core/workspaces.ts`:

```ts
export type IntegrationMode = "pr" | "merge";

export type WorkspaceBranchPolicy = {
  preset: BranchPreset;
  developBranch?: string;
  prefixes?: { feature: string; bugfix: string; release: string; hotfix: string };
  allowed?: string[];
  protected?: string[];
  integration: IntegrationMode;
};

export type WorkspaceConfig = {
  name: string;
  glob: string;
  vcs?: { provider: VcsProvider; defaultTargetBranch?: string };
  youtrack?: { baseUrl?: string; link_issues?: boolean };
  issues?: { provider?: "github"; link_on_pr?: boolean };
  branchPolicy?: WorkspaceBranchPolicy;
};
```

In `packages/workit-core/src/core/config.ts`, change the resolver signature and the preset fallback:

```ts
export function resolveBranchPolicy(
  config: Record<string, any>,
  workspace?: { branchPolicy?: Record<string, any> } | null,
): { preset: BranchPreset; allowed: RegExp[]; protected: Set<string> } {
  const preset = String(
    workspace?.branchPolicy?.preset ?? config.branchPolicy?.preset ?? "gitflow",
  ) as BranchPreset;
  const wp = (workspace?.branchPolicy ?? {}) as Record<string, any>;
  const merged = mergePreset(preset, {
    allowed: wp.allowed,
    protectedNames: wp.protected,
  });
  return {
    preset,
    allowed: merged.allowed.map((r) => new RegExp(r)),
    protected: new Set(merged.protected),
  };
}
```

Note: `mergePreset` resets derived fields when the preset changes (RL-02); a workspace preset therefore re-derives allowed/protected from its own values or the preset table, never the global config's.

In `packages/workit-core/src/core/branch.ts`, add the single resolver and route `docsBranch` through it:

```ts
import { resolveWorkspace } from "./workspaces";

/** CA-09: the one policy resolver every consumer calls. */
export const resolveBranchPolicyFor = (workspaceRoot: string) =>
  resolveBranchPolicy(readConfig(), resolveWorkspace(workspaceRoot));
```

Replace `const policy = () => resolveBranchPolicy(readConfig());` in `branch.ts` with `const policy = (root: string) => resolveBranchPolicyFor(root);` and pass `root` at the call site in `docsBranch`. In `packages/workit-opencode/src/tools/repo.ts` replace the commit-gate `branchPolicy()` with `resolveBranchPolicyFor(context.directory)`. In `packages/workit-core/src/core/pr-create.ts:144` replace `resolveBranchPolicy(readConfig())` with `resolveBranchPolicyFor(root)`.

- [ ] **Step 4: Run GREEN**

Run: `bun test test/workit-core/branch-policy.test.ts && bun test test/workit-core/pr-create.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workit-core/src/core/workspaces.ts packages/workit-core/src/core/config.ts packages/workit-core/src/core/branch.ts packages/workit-opencode/src/tools/repo.ts packages/workit-core/src/core/pr-create.ts test/workit-core/branch-policy.test.ts
git commit -m "feat(branch-policy): resolve per-workspace policy through one shared resolver"
```

---

### Task 2: Repo-aware detection and proposal

**Files:**
- Create: `packages/workit-core/src/core/branch-policy.ts`
- Create: `test/workit-core/branch-policy-detect.test.ts`

**Interfaces:**
- Consumes: `BranchPreset`, `PRESETS` (config.ts); `git` via `spawnSync`.
- Produces: `detectBranchPolicy(workspace_root: string): { preset: BranchPreset; developBranch: string | null; integration: IntegrationMode; protected: string[]; allowed: string[]; prefixes: { feature: string; bugfix: string; release: string; hotfix: string } }` — returns the detection-proposal object per the Global Constraints matrix, never throws (missing repo → gitflow defaults with `developBranch: null`).

- [ ] **Step 1: Write the failing detection-matrix test**

`test/workit-core/branch-policy-detect.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { detectBranchPolicy } from "../../packages/workit-core/src/core/branch-policy";

const repoWith = (branches: string[]) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-detect-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q", "-b", branches[0] ?? "main"]);
  run(["config", "user.name", "T"]);
  run(["config", "user.email", "t@t"]);
  writeFileSync(path.join(root, "r.md"), "x");
  run(["add", "r.md"]);
  run(["commit", "-q", "-m", "base"]);
  for (const b of branches.slice(1)) run(["branch", "-q", b]);
  return root;
};

test("CA-02: detection matrix maps branch presence to the proposal", () => {
  const cases: Array<[string[], string, string | null, string]> = [
    [["main", "develop"], "gitflow", "develop", "merge"],
    [["master", "develop"], "gitflow", "develop", "merge"],
    [["main"], "github-flow", null, "pr"],
    [["master"], "trunk-based", null, "pr"],
  ];
  for (const [branches, preset, developBranch, integration] of cases) {
    const root = repoWith(branches);
    try {
      const d = detectBranchPolicy(root);
      expect(d.preset, branches.join(",")).toBe(preset);
      expect(d.developBranch).toBe(developBranch);
      expect(d.integration).toBe(integration);
      if (preset === "gitflow") {
        expect(d.protected).toEqual(expect.arrayContaining(["develop", branches[0]]));
        expect(d.prefixes).toEqual({ feature: "feature/*", bugfix: "bugfix/*", release: "release/*", hotfix: "hotfix/*" });
      } else {
        expect(d.allowed).toEqual(["*"]);
        expect(d.protected).toEqual([branches[0]]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("CA-02: repo with no origin branches falls back to gitflow defaults", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-detect-empty-"));
  try {
    const d = detectBranchPolicy(root);
    expect(d.preset).toBe("gitflow");
    expect(d.developBranch).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run RED**

Run: `bun test test/workit-core/branch-policy-detect.test.ts`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Implement `detectBranchPolicy`**

`packages/workit-core/src/core/branch-policy.ts`:

```ts
import { spawnSync } from "node:child_process";
import type { BranchPreset } from "./config";
import type { IntegrationMode } from "./workspaces";

export const detectBranchPolicy = (workspaceRoot: string) => {
  const branchExists = (name: string): boolean => {
    const r = spawnSync("git", ["branch", "--list", name], { cwd: workspaceRoot, encoding: "utf8" });
    return r.status === 0 && (r.stdout ?? "").trim() !== "";
  };
  const develop = branchExists("develop");
  const main = branchExists("main");
  const master = branchExists("master");
  const root = main ? "main" : master ? "master" : null;

  if (develop && root) {
    return {
      preset: "gitflow" as BranchPreset,
      developBranch: "develop",
      integration: "merge" as IntegrationMode,
      protected: [root, "develop"],
      allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
      prefixes: { feature: "feature/*", bugfix: "bugfix/*", release: "release/*", hotfix: "hotfix/*" },
    };
  }
  if (root === "main") {
    return {
      preset: "github-flow" as BranchPreset,
      developBranch: null,
      integration: "pr" as IntegrationMode,
      protected: [root],
      allowed: ["*"],
      prefixes: { feature: "feature/*", bugfix: "bugfix/*", release: "release/*", hotfix: "hotfix/*" },
    };
  }
  if (root === "master") {
    return {
      preset: "trunk-based" as BranchPreset,
      developBranch: null,
      integration: "pr" as IntegrationMode,
      protected: [root],
      allowed: ["*"],
      prefixes: { feature: "feature/*", bugfix: "bugfix/*", release: "release/*", hotfix: "hotfix/*" },
    };
  }
  return {
    preset: "gitflow" as BranchPreset,
    developBranch: null,
    integration: "merge" as IntegrationMode,
    protected: [],
    allowed: [],
    prefixes: { feature: "feature/*", bugfix: "bugfix/*", release: "release/*", hotfix: "hotfix/*" },
  };
};
```

- [ ] **Step 4: Run GREEN**

Run: `bun test test/workit-core/branch-policy-detect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workit-core/src/core/branch-policy.ts test/workit-core/branch-policy-detect.test.ts
git commit -m "feat(branch-policy): detect repo convention from branch presence"
```

---

### Task 3: Idempotent init action (hosts + core)

**Files:**
- Modify: `packages/workit-core/src/core/init.ts` (`initApplyData` gains `branch_policy`)
- Modify: `packages/workit-core/src/core/setup.ts` (shared workspace write helper, reused by Task 5)
- Modify: `packages/workit-opencode/src/tools/repo.ts` and `packages/workit-cursor/mcp/server.ts` (`workit_init_apply` args + action enum)
- Create: `test/workit-core/branch-policy-init.test.ts`

**Interfaces:**
- Consumes: `detectBranchPolicy(root)` (Task 2), `readWorkspacesResult`, `validateWorkspaceGlob` (workspaces.ts).
- Produces: `applyWorkspaceBranchPolicy({ workspace_root, accept_defaults, name?, develop_branch?, integration?, allowed?, protected? }): { ok, status: "configured" | "already-configured" | "updated", workspace, policy, config_path }` in `setup.ts`; `initApplyData` case `"branch_policy"` returning that result.

- [ ] **Step 1: Write the failing init tests**

`test/workit-core/branch-policy-init.test.ts`:

```ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initApplyData } from "../../packages/workit-core/src/core/init";

const repoWith = (branches: string[]) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-bpi-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q", "-b", branches[0] ?? "main"]);
  run(["config", "user.name", "T"]);
  run(["config", "user.email", "t@t"]);
  writeFileSync(path.join(root, "r.md"), "x");
  run(["add", "r.md"]);
  run(["commit", "-q", "-m", "base"]);
  for (const b of branches.slice(1)) run(["branch", "-q", b]);
  return root;
};

const cfgDir = (root: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-bpi-cfg-"));
  writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify({ workspaces: [] }));
  return dir;
};

test("CA-03: branch_policy init creates the workspace entry idempotently", () => {
  const root = repoWith(["main", "develop"]);
  const cfg = cfgDir(root);
  const prev = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG = cfg;
    const first = initApplyData("branch_policy", { WORKFLOW_WORKSPACE_ROOT: root } as NodeJS.ProcessEnv);
    expect(first.ok).toBe(true);
    expect(first.status).toBe("configured");
    expect(first.policy.preset).toBe("gitflow");
    expect(first.policy.integration).toBe("merge");
    const ws = JSON.parse(readFileSync(path.join(cfg, "workspaces.json"), "utf8"));
    expect(ws.workspaces).toHaveLength(1);
    expect(ws.workspaces[0].glob).toBe(`${root}/**`);
    expect(ws.workspaces[0].branchPolicy.preset).toBe("gitflow");

    const second = initApplyData("branch_policy", { WORKFLOW_WORKSPACE_ROOT: root } as NodeJS.ProcessEnv);
    expect(second.status).toBe("already-configured");

    const edited = initApplyData("branch_policy", {
      WORKFLOW_WORKSPACE_ROOT: root,
      WORKFLOW_BP_INTEGRATION: "pr",
    } as NodeJS.ProcessEnv);
    expect(edited.status).toBe("updated");
    const ws2 = JSON.parse(readFileSync(path.join(cfg, "workspaces.json"), "utf8"));
    expect(ws2.workspaces[0].branchPolicy.integration).toBe("pr");
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run RED**

Run: `bun test test/workit-core/branch-policy-init.test.ts`
Expected: FAIL — `initApplyData` rejects `branch_policy`.

- [ ] **Step 3: Implement the shared apply helper and the init case**

In `packages/workit-core/src/core/setup.ts` add:

```ts
export function applyWorkspaceBranchPolicy(opts: {
  workspace_root: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, any> {
  const { workspace_root, env = process.env } = opts;
  const dir = path.join(env.WORKFLOW_TOOLKIT_CONFIG ?? configDir());
  const { status, path: wsPath, entries } = readWorkspacesResult(dir);
  if (status === "malformed") return { ok: false, error: `malformed workspaces.json: ${wsPath}` };
  const detection = detectBranchPolicy(workspace_root);
  const name = String(env.WORKFLOW_BP_NAME ?? path.basename(workspace_root));
  const integration = (env.WORKFLOW_BP_INTEGRATION as "pr" | "merge") ?? detection.integration;
  const policy = {
    preset: detection.preset,
    developBranch: env.WORKFLOW_BP_DEVELOP ?? detection.developBranch ?? undefined,
    prefixes: detection.prefixes,
    allowed: detection.allowed,
    protected: detection.protected,
    integration,
  };
  const glob = `${workspace_root.replace(/[\\/]+$/, "")}/**`;
  if (!validateWorkspaceGlob(glob).ok) return { ok: false, error: `invalid workspace glob: ${glob}` };
  const idx = entries.findIndex((w) => matchWorkspace(w.glob, workspace_root));
  const existing = idx >= 0 ? entries[idx] : null;
  if (existing?.branchPolicy && JSON.stringify(existing.branchPolicy) === JSON.stringify(policy)) {
    return { ok: true, status: "already-configured", workspace: existing, policy, config_path: wsPath };
  }
  const next = existing
    ? entries.map((w, i) => (i === idx ? { ...w, branchPolicy: policy } : w))
    : [...entries, { name, glob, branchPolicy: policy }];
  writeFileSync(wsPath, JSON.stringify({ workspaces: next }, null, 2) + "\n", "utf8");
  return {
    ok: true,
    status: existing ? "updated" : "configured",
    workspace: existing ? { ...existing, branchPolicy: policy } : { name, glob, branchPolicy: policy },
    policy,
    config_path: wsPath,
  };
}
```

In `packages/workit-core/src/core/init.ts`, add to `initApplyData` (before the `default` case):

```ts
case "branch_policy": {
  const root = String(env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd());
  return applyWorkspaceBranchPolicy({ workspace_root: root, env });
}
```

In `packages/workit-opencode/src/tools/repo.ts` and `packages/workit-cursor/mcp/server.ts`, add `"branch_policy"` to the `action` enum of `workit_init_apply` and pass `WORKFLOW_WORKSPACE_ROOT` + `WORKFLOW_BP_*` env (OpenCode passes `context.directory`; Cursor passes `workspace_root`).

- [ ] **Step 4: Run GREEN**

Run: `bun test test/workit-core/branch-policy-init.test.ts && bun run check`
Expected: PASS; full check green.

- [ ] **Step 5: Commit**

```bash
git add packages/workit-core/src/core/setup.ts packages/workit-core/src/core/init.ts packages/workit-opencode/src/tools/repo.ts packages/workit-cursor/mcp/server.ts test/workit-core/branch-policy-init.test.ts
git commit -m "feat(branch-policy): idempotent per-workspace init action on both hosts"
```

---

### Task 4: Integration `merge` mode in PR create

**Files:**
- Modify: `packages/workit-core/src/core/pr-create.ts` (merge mode branch)
- Modify: `packages/workit-core/src/core/branch.ts` (expose the resolved target helper if needed)
- Test: `test/workit-core/pr-create.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveBranchPolicyFor(root)` (Task 1).
- Produces: merge-mode result shape `{ ok: true, mode: "merge", targetBranch, merged, pushed }`; `prCreate` returns it when `policy.integration === "merge"` and `env.WF_PR_CONFIRMED === "true"`.

- [ ] **Step 1: Write the failing merge-mode test**

Add to `test/workit-core/pr-create.test.ts`:

```ts
test("CA-04: merge integration finishes the feature into the target without a PR", async () => {
  const { root, remote } = repoWithDevelop();
  const prevPath = process.env.PATH;
  try {
    writeFileSync(
      path.join(isolatedConfig, "workit", "workspaces.json"),
      JSON.stringify({
        workspaces: [{ name: "w", glob: `${root}/**`, branchPolicy: { preset: "gitflow", integration: "merge" } }],
      }),
    );
    git(root, ["checkout", "-q", "-b", "feature/merge-mode"]);
    git(root, ["push", "-q", "-u", "origin", "feature/merge-mode"]);
    const p = prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_BODY: "" }, root);
    expect(p.ok, JSON.stringify(p)).toBe(true);
    expect(p.mode).toBe("merge");
    expect(p.targetBranch).toBe("develop");
    // develop contains the feature commit, no glab/gh was invoked
    const log = git(root, ["log", "--oneline", "-1", "develop"]).stdout;
    expect(log).toContain("T");
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run RED**

Run: `bun test test/workit-core/pr-create.test.ts --filter "merge integration"`
Expected: FAIL — `p.ok` false (glab invoked) or `p.mode` undefined.

- [ ] **Step 3: Implement merge mode**

In `pr-create.ts`, after the branch-policy target validation (line ~153), insert:

```ts
const policy = resolveBranchPolicyFor(root);
if (policy.integration === "merge") {
  const finish = (): Record<string, any> => {
    const merge = spawnSync("git", ["merge", "--no-ff", branch, "-m", title], {
      cwd: root, encoding: "utf8",
    });
    if (merge.status !== 0)
      return { error: "merge failed", mode: "merge", targetBranch: target, stderr: (merge.stderr ?? "").slice(0, 800) };
    const push = spawnSync("git", ["push", "origin", target], { cwd: root, encoding: "utf8" });
    if (push.status !== 0)
      return { error: "push failed", mode: "merge", targetBranch: target, stderr: (push.stderr ?? "").slice(0, 800) };
    return { ok: true, mode: "merge", targetBranch: target, merged: true, pushed: true, output: (push.stdout ?? "").trim() };
  };
  const co = spawnSync("git", ["checkout", target], { cwd: root, encoding: "utf8" });
  if (co.status !== 0) return { error: `cannot checkout target ${target}`, mode: "merge", stderr: (co.stderr ?? "").slice(0, 800) };
  const result = finish();
  spawnSync("git", ["checkout", branch], { cwd: root, encoding: "utf8" }); // best-effort return
  return result;
}
```

Skip the `glab`/`gh` CLI selection entirely when the policy is `merge` (move the CLI-missing check after this branch). The target override validation above stays; `skipConfirm`/`squash` flags are ignored in merge mode (document in the returned shape).

- [ ] **Step 4: Run GREEN**

Run: `bun test test/workit-core/pr-create.test.ts`
Expected: PASS (existing PR-mode tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/workit-core/src/core/pr-create.ts test/workit-core/pr-create.test.ts
git commit -m "feat(branch-policy): merge integration finishes the feature into the target"
```

---

### Task 5: CLI wizard parity

**Files:**
- Modify: `packages/workit-cli/src/wizard-state.ts` (screen + draft fields)
- Modify: `packages/workit-cli/src/steps.tsx` (branch-policy screen)
- Modify: `packages/workit-cli/src/logic.ts` (apply path calls the shared `applyWorkspaceBranchPolicy`)
- Create: `test/workit-cli/branch-policy-wizard.test.tsx`

**Interfaces:**
- Consumes: `applyWorkspaceBranchPolicy` (Task 3), `detectBranchPolicy` (Task 2).
- Produces: `WizardScreen` member `"branchPolicy"`; `WizardDraft.values` gains `branchPolicy?: WorkspaceBranchPolicy` + `branchPolicyDetected`; reducer `apply` action emits `applyBranchPolicy` when the screen is active.

- [ ] **Step 1: Write the failing parity test**

`test/workit-cli/branch-policy-wizard.test.tsx` (mirror the workspace-wizard harness in `test/workit-cli/workspace-wizard.test.tsx`):

```tsx
test("CA-06: wizard branch-policy apply equals the host init action write", async () => {
  const root = repoWith(["main", "develop"]);
  const cfg = mkdtempSync(path.join(os.tmpdir(), "wf-bpw-"));
  writeFileSync(path.join(cfg, "workspaces.json"), JSON.stringify({ workspaces: [] }));
  const prev = process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG = cfg;
  process.env.WORKFLOW_WORKSPACE_ROOT = root;
  try {
    // drive the wizard to the branchPolicy screen, accept defaults, apply
    const wizardOut = await runWizard(["branchPolicy", "accept", "apply"]); // existing ink-tty harness
    expect(wizardOut.exitCode).toBe(0);
    const wsFile = readFileSync(path.join(cfg, "workspaces.json"), "utf8");
    const viaTool = initApplyData("branch_policy", {
      WORKFLOW_WORKSPACE_ROOT: root,
      WORKFLOW_TOOLKIT_CONFIG: cfg,
    } as NodeJS.ProcessEnv);
    const wsTool = readFileSync(path.join(cfg, "workspaces.json"), "utf8");
    expect(wsFile).toBe(wsTool);
    expect(viaTool.policy.integration).toBe("merge");
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prev;
    delete process.env.WORKFLOW_WORKSPACE_ROOT;
    rmSync(root, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run RED**

Run: `bun test test/workit-cli/branch-policy-wizard.test.tsx`
Expected: FAIL — no `branchPolicy` screen.

- [ ] **Step 3: Implement the wizard screen**

- `wizard-state.ts`: add `"branchPolicy"` to `WizardScreen`; extend `WizardDraft.values` with `branchPolicy?` and `branchPolicyDetected?`; the `set` reducer accepts branch-policy field keys; the `next` transition inserts `branchPolicy` after `workspaces` when the repo is a git repo.
- `steps.tsx`: new `<BranchPolicyScreen>` rendered for `draft.screen === "branchPolicy"`: on mount calls `detectBranchPolicy(process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd())`, shows the proposal (preset, developBranch, integration, prefixes, protected), one Ink select: Accept defaults / Edit integration / Edit develop / Skip; editing routes through the reducer `set` with prefilled detection values.
- `logic.ts`: the wizard apply step calls `applyWorkspaceBranchPolicy({ workspace_root, env })` and records its `status` in the setup summary (configured/updated/already-configured).

- [ ] **Step 4: Run GREEN**

Run: `bun test test/workit-cli/branch-policy-wizard.test.tsx test/workit-cli/workspace-wizard.test.tsx && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workit-cli/src/wizard-state.ts packages/workit-cli/src/steps.tsx packages/workit-cli/src/logic.ts test/workit-cli/branch-policy-wizard.test.tsx
git commit -m "feat(branch-policy): CLI wizard screen with parity to the host init action"
```

---

### Task 6: AGENTS.md, README, and changelog sync

**Files:**
- Create: `AGENTS.md` (repo root)
- Modify: `README.md`
- Modify: `CHANGELOG.md` (Unreleased section)

**Interfaces:** None (docs only).

- [ ] **Step 1: Write AGENTS.md**

Create `AGENTS.md` with:

```markdown
# Agent Contract

Multi-platform workit: OpenCode, Cursor, and the CLI share one core. Every feature must ship with **feature parity across hosts, implemented the best way each host allows**.

## Host-native adaptation

| Feature | OpenCode | Cursor | CLI |
| --- | --- | --- | --- |
| Approval | native `question` tool receipts | AskQuestion policy-only (`attested: false`) | `--confirm` flags / TTY prompts |
| Handoff | spawns a native OpenCode session | seeds a handoff prompt for the next agent | prints a handoff summary |
| Tools | native plugin tools | MCP server (`workit_*`) | `workit` commands |
| Skills | `skills.paths` + vendored dirs | plugin `skills/` dirs | n/a |
| Branch policy init | `workit_init_apply action=branch_policy` | same MCP tool | wizard screen |

## Parity rules

1. Core logic lives in `packages/workit-core/src/core/`; adapters only map host-native surfaces to it. Never re-implement core logic per host.
2. A new feature adds: the core module, both host adapters, and the CLI surface (command or wizard screen), plus tests proving identical outcomes (parity test).
3. Docs (README), this file, and the CHANGELOG Unreleased section are updated in the same change.

## Workflow contract

- Specs/plans live in `docs/<slug>/`; spec+plan are committed, `sdd/` is gitignored.
- Approval evidence: OpenCode records native-question receipts; Cursor is policy-only by design (never fabricate delegated identity).
- Never use worktrees; use guarded in-place branch setup.
```

- [ ] **Step 2: Update README**

Extend the `## Per-install configuration` table with the `workspaces.json` `branchPolicy` fields and a paragraph: run the init action (or wizard screen) to detect and pin a repo's convention (`develop` present → gitflow/merge; only `main` → github-flow/pr; only `master` → trunk-based/pr); re-running updates it.

- [ ] **Step 3: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added
- Per-workspace branch policy (`workspaces.json` `branchPolicy`) with git-flow-style detection init and `integration: pr|merge` on OpenCode, Cursor, and the CLI wizard.
```

- [ ] **Step 4: Verify**

Run: `bun run check` (format covers README/AGENTS.md) and `bun run verify:release-candidate`.
Expected: all green; 4 tarballs verified.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md README.md CHANGELOG.md
git commit -m "docs: multi-platform contract, per-workspace branch policy docs, changelog"
```

---

### Task 7: Single-resolver gate and full verification

**Files:**
- Create: `test/workit-core/branch-policy-resolver.test.ts`

**Interfaces:** None.

- [ ] **Step 1: Write the failing resolver gate**

```ts
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CORE = path.join(import.meta.dir, "../../packages/workit-core/src/core");
const ADAPTERS = [
  path.join(import.meta.dir, "../../packages/workit-opencode/src"),
  path.join(import.meta.dir, "../../packages/workit-cursor"),
  path.join(import.meta.dir, "../../packages/workit-cli/src"),
];

const tsFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.name.includes("node_modules")) walk(p);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
    }
  };
  walk(dir);
  return out;
};

test("CA-09: consumers never resolve branch policy on their own", () => {
  const offenders: string[] = [];
  for (const dir of [CORE, ...ADAPTERS]) {
    for (const f of tsFiles(dir)) {
      if (f.includes("branch-policy-detect") || f.includes("branch-policy-resolver")) continue;
      const src = readFileSync(f, "utf8");
      if (/\bresolveBranchPolicy\(readConfig\(\)\)/.test(src)) offenders.push(f);
      if (f.includes("config.ts") || f.includes("branch.ts") || f.includes("workspaces.ts")) continue;
      if (/\bresolveBranchPolicy\(/.test(src) && !/resolveBranchPolicyFor\(/.test(src)) offenders.push(f);
    }
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test test/workit-core/branch-policy-resolver.test.ts`
Expected: FAIL listing any consumer still calling `resolveBranchPolicy(readConfig())` directly (Task 1 must have migrated all of them; if any remain, migrate them now).

- [ ] **Step 3: Fix offenders (if any)**

Replace every remaining `resolveBranchPolicy(readConfig())` with `resolveBranchPolicyFor(workspace_root)` and re-run.

- [ ] **Step 4: Run the full gate**

Run: `bun test && bun run check && bun run verify:release-candidate`
Expected: all tests pass (full suite), check green, 4 tarballs verified.

- [ ] **Step 5: Commit**

```bash
git add test/workit-core/branch-policy-resolver.test.ts
git commit -m "test(branch-policy): gate single-resolver usage across adapters"
```

---

## Self-Review notes

- Spec coverage: CA-01 → Task 1; CA-02 → Task 2; CA-03 → Task 3; CA-04/CA-05 → Task 4; CA-06 → Task 5; CA-07/CA-08 → Task 6; CA-09 → Task 7. Goals map 1:1; Non-goals untouched.
- Type consistency: `WorkspaceBranchPolicy`, `IntegrationMode`, `resolveBranchPolicyFor`, `detectBranchPolicy`, `applyWorkspaceBranchPolicy` are defined in Tasks 1-3 and reused verbatim in Tasks 4-5.
- No placeholders; every step has concrete files, signatures, test code, and commands.
