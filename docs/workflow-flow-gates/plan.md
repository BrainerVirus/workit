# Workflow Toolkit Flow Gates + TS Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/workflow-flow-gates/spec.md`
**Branch:** `feature/workflow-flow-gates`

**Goal:** Make the spec→plan→approval→post-plan-choice flow tool-enforced (flow.json state + hard-fail gates on both platforms) and consolidate all duplicated JS/bash logic into one TS+zod core.

**Architecture:** A single `src/core/*.ts` TS+zod module holds all logic (flow state, docs validation, branch, plan parsing, SDD, youtrack, present, repo). The OpenCode plugin registers tools in-process (bun imports TS natively); the Cursor MCP server (`server.ts`, executed by bun) imports the same core. Legacy wrappers (`src/legacy/`, `cursor/mcp/lib/`) and the bash/python script layer they shelled out to are deleted. Flow approval is recorded in `docs/superpowers/sdd/<slug>/flow.json`, shared across platforms and sessions.

**Tech Stack:** TypeScript + zod (runtime-validated tool args), `bun test` (single suite), existing `@opencode-ai/plugin` + `@modelcontextprotocol/sdk` (both already installed), `node:fs` only for state I/O. No new production dependencies.

## Global Constraints

- Flow state lives in `docs/superpowers/sdd/<slug>/flow.json`; missing file = `draft` = gates fail closed.
- Status transitions only: `draft → self_reviewed → approved`. No backward transitions.
- `workit_plan_approve` hard-fails unless spec is `approved`.
- `wf-implement` refuses unless plan `approved` AND `menu.presented === true`. `wf-handoff` refuses unless spec AND plan `approved`.
- Post-plan menu options exactly: Subagent-driven, Inline, Handoff (new session only), Review spec first, Review plan first — no stay.
- All tool args validated with zod; write tools keep the `confirmed: true` pattern.
- `docs/superpowers/` is gitignored (working files, never committed); existing tracked docs are `git rm --cached` (files stay on disk).
- No new production dependencies. One test suite: `bun test` (Cursor MCP tests migrate to bun and run against the same core).
- `bun run check` is the release gate.
- Patch version `0.4.0` synchronized on OpenCode `package.json` and Cursor MCP `server.ts`.

---

### Task 1: `src/core/flow-state.ts` — flow state store with transition rules

**Files:**
- Create: `src/core/flow-state.ts`
- Create: `test/flow-state.test.ts`

**Interfaces:**
- Produces:
  - `type FlowStatus = "draft" | "self_reviewed" | "approved"`
  - `type FlowDocState = { path: string; status: FlowStatus }`
  - `type FlowState = { slug: string; spec: FlowDocState; plan: FlowDocState; menu: { presented: boolean; chosen: string }; updated_at: number }`
  - `readFlowState(workspaceRoot: string, slug: string): FlowState` — returns all-`draft`/empty state when `flow.json` missing
  - `writeFlowState(workspaceRoot: string, state: FlowState): void` — writes `docs/superpowers/sdd/<slug>/flow.json`
  - `transitionSpec(workspaceRoot: string, slug: string, specPath: string, confirmed: boolean): { ok: true } | { ok: false, error: string }` — `draft→self_reviewed` or `self_reviewed→approved`; requires `confirmed === true`
  - `transitionPlan(workspaceRoot: string, slug: string, planPath: string, confirmed: boolean): { ok: true } | { ok: false, error: string }` — same rules; fails unless `spec.status === "approved"`
  - `recordMenuChoice(workspaceRoot: string, slug: string, planPath: string, choice: string, confirmed: boolean): { ok: true } | { ok: false, error: string }` — sets `menu.presented = true, menu.chosen = choice`

- [ ] **Step 1: Write the failing test**

Create `test/flow-state.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readFlowState,
  transitionSpec,
  transitionPlan,
  recordMenuChoice,
} from "../src/core/flow-state";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-flow-"));
  return { root, slug: "my-feature" };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

test("missing flow.json reads as draft with no menu", () => {
  const { root, slug } = fixture();
  try {
    const state = readFlowState(root, slug);
    expect(state.spec.status).toBe("draft");
    expect(state.plan.status).toBe("draft");
    expect(state.menu.presented).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("spec transitions draft -> self_reviewed -> approved", () => {
  const { root, slug } = fixture();
  try {
    const first = transitionSpec(root, slug, "docs/superpowers/specs/a-design.md", true);
    expect(first.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("self_reviewed");

    const second = transitionSpec(root, slug, "docs/superpowers/specs/a-design.md", true);
    expect(second.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("confirmed:false never transitions", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionSpec(root, slug, "docs/superpowers/specs/a-design.md", false);
    expect(result.ok).toBe(false);
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("plan approve hard-fails while spec is draft", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionPlan(root, slug, "docs/superpowers/plans/a.md", true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("spec");
    expect(readFlowState(root, slug).plan.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("plan approve requires spec approved", () => {
  const { root, slug } = fixture();
  try {
    transitionSpec(root, slug, "docs/superpowers/specs/a-design.md", true);
    transitionSpec(root, slug, "docs/superpowers/specs/a-design.md", true);
    const first = transitionPlan(root, slug, "docs/superpowers/plans/a.md", true);
    expect(first.ok).toBe(true);
    expect(readFlowState(root, slug).plan.status).toBe("self_reviewed");
    const second = transitionPlan(root, slug, "docs/superpowers/plans/a.md", true);
    expect(second.ok).toBe(true);
    expect(readFlowState(root, slug).plan.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("menu choice records presented + chosen", () => {
  const { root, slug } = fixture();
  try {
    const result = recordMenuChoice(root, slug, "docs/superpowers/plans/a.md", "handoff", true);
    expect(result.ok).toBe(true);
    const state = readFlowState(root, slug);
    expect(state.menu.presented).toBe(true);
    expect(state.menu.chosen).toBe("handoff");
  } finally {
    cleanup(root);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/flow-state.test.ts`
Expected: FAIL — `../src/core/flow-state` module not found.

- [ ] **Step 3: Implement `src/core/flow-state.ts`**

Create `src/core/flow-state.ts`:

```typescript
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export type FlowStatus = "draft" | "self_reviewed" | "approved";
export type FlowDocState = { path: string; status: FlowStatus };
export type FlowState = {
  slug: string;
  spec: FlowDocState;
  plan: FlowDocState;
  menu: { presented: boolean; chosen: string };
  updated_at: number;
};

const flowPath = (root: string, slug: string) =>
  path.join(root, "docs/superpowers/sdd", slug, "flow.json");

export const readFlowState = (root: string, slug: string): FlowState => {
  const file = flowPath(root, slug);
  if (!existsSync(file)) {
    return {
      slug,
      spec: { path: "", status: "draft" },
      plan: { path: "", status: "draft" },
      menu: { presented: false, chosen: "" },
      updated_at: Date.now(),
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as FlowState;
    return {
      slug: parsed.slug ?? slug,
      spec: { path: parsed.spec?.path ?? "", status: parsed.spec?.status ?? "draft" },
      plan: { path: parsed.plan?.path ?? "", status: parsed.plan?.status ?? "draft" },
      menu: { presented: Boolean(parsed.menu?.presented), chosen: parsed.menu?.chosen ?? "" },
      updated_at: parsed.updated_at ?? Date.now(),
    };
  } catch {
    return {
      slug,
      spec: { path: "", status: "draft" },
      plan: { path: "", status: "draft" },
      menu: { presented: false, chosen: "" },
      updated_at: Date.now(),
    };
  }
};

export const writeFlowState = (root: string, state: FlowState) => {
  const file = flowPath(root, state.slug);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
};

type Result = { ok: true } | { ok: false; error: string };

const nextStatus = (current: FlowStatus, confirmed: boolean): Result => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  if (current === "draft") return { ok: true as const, next: "self_reviewed" as const } as Result;
  if (current === "self_reviewed") return { ok: true as const, next: "approved" as const } as Result;
  return { ok: false, error: "already approved; no further transitions" };
};

export const transitionSpec = (
  root: string,
  slug: string,
  specPath: string,
  confirmed: boolean,
): Result => {
  const state = readFlowState(root, slug);
  const step = nextStatus(state.spec.status, confirmed);
  if (!step.ok) return { ok: false, error: step.error };
  const updated: FlowState = {
    ...state,
    spec: { path: specPath, status: step.next },
    updated_at: Date.now(),
  };
  writeFlowState(root, updated);
  return { ok: true };
};

export const transitionPlan = (
  root: string,
  slug: string,
  planPath: string,
  confirmed: boolean,
): Result => {
  const state = readFlowState(root, slug);
  if (state.spec.status !== "approved") {
    return { ok: false, error: "spec must be approved before the plan can be approved" };
  }
  const step = nextStatus(state.plan.status, confirmed);
  if (!step.ok) return { ok: false, error: step.error };
  const updated: FlowState = {
    ...state,
    plan: { path: planPath, status: step.next },
    updated_at: Date.now(),
  };
  writeFlowState(root, updated);
  return { ok: true };
};

export const recordMenuChoice = (
  root: string,
  slug: string,
  planPath: string,
  choice: string,
  confirmed: boolean,
): Result => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  const state = readFlowState(root, slug);
  const updated: FlowState = {
    ...state,
    plan: state.plan.path ? state.plan : { path: planPath, status: state.plan.status },
    menu: { presented: true, chosen: choice },
    updated_at: Date.now(),
  };
  writeFlowState(root, updated);
  return { ok: true };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/flow-state.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/flow-state.ts test/flow-state.test.ts
git commit -m "feat(core): flow state store with spec/plan approval transitions"
```

---

### Task 2: Flow tools registered on the OpenCode plugin

**Files:**
- Create: `src/tools/flow.ts`
- Modify: `src/tools/index.ts`
- Test: `test/flow-tools.test.ts`

**Interfaces:**
- Consumes: `readFlowState`, `transitionSpec`, `transitionPlan`, `recordMenuChoice` from `src/core/flow-state.ts`
- Produces (registered tools, all returning the toolkit `{ ok, data, error }` envelope):
  - `workit_flow_status({ spec_path?, plan_path? })` — resolves slug from plan basename (or spec basename); returns `{ spec, plan, menu, flow_path }`
  - `workit_spec_approve({ confirmed, spec_path })` — slug from spec basename; `transitionSpec`
  - `workit_plan_approve({ confirmed, plan_path })` — slug from plan basename; `transitionPlan`
  - `workit_plan_menu({ confirmed, plan_path, choice })` — `choice` enum `["subagent-driven","inline","handoff","review-spec","review-plan"]`; `recordMenuChoice`

- [ ] **Step 1: Write the failing test**

Create `test/flow-tools.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowTools } from "../src/tools/flow";
import { WorkflowStateStore } from "../src/state";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-flowtools-"));
  const tools = createFlowTools(new WorkflowStateStore());
  const ctx = { directory: root } as any;
  return { root, tools, ctx };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const run = (tools: any, name: string, args: any, ctx: any) =>
  tools[name].execute(args, ctx).then((raw: string) => JSON.parse(raw));

test("flow_status returns draft when no state exists", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const out = await run(tools, "workit_flow_status", {
      plan_path: "docs/superpowers/plans/2026-08-06-x.md",
    }, ctx);
    expect(out.ok).toBe(true);
    expect(out.data.spec.status).toBe("draft");
    expect(out.data.menu.presented).toBe(false);
    expect(out.data.flow_path).toContain("docs/superpowers/sdd/2026-08-06-x/flow.json");
  } finally {
    cleanup(root);
  }
});

test("spec_approve without confirmed fails", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const out = await run(tools, "workit_spec_approve", {
      confirmed: false,
      spec_path: "docs/superpowers/specs/2026-08-06-x-design.md",
    }, ctx);
    expect(out.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("full flow: spec approve x2 -> plan approve x2 -> menu", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const spec = "docs/superpowers/specs/2026-08-06-x-design.md";
    const plan = "docs/superpowers/plans/2026-08-06-x.md";
    await run(tools, "workit_spec_approve", { confirmed: true, spec_path: spec }, ctx);
    await run(tools, "workit_spec_approve", { confirmed: true, spec_path: spec }, ctx);
    const planFirst = await run(tools, "workit_plan_approve", { confirmed: true, plan_path: plan }, ctx);
    expect(planFirst.ok).toBe(true);
    const planSecond = await run(tools, "workit_plan_approve", { confirmed: true, plan_path: plan }, ctx);
    expect(planSecond.ok).toBe(true);
    const menu = await run(tools, "workit_plan_menu", {
      confirmed: true, plan_path: plan, choice: "handoff",
    }, ctx);
    expect(menu.ok).toBe(true);
    const status = await run(tools, "workit_flow_status", { plan_path: plan }, ctx);
    expect(status.data.spec.status).toBe("approved");
    expect(status.data.plan.status).toBe("approved");
    expect(status.data.menu).toEqual({ presented: true, chosen: "handoff" });
  } finally {
    cleanup(root);
  }
});

test("plan_approve hard-fails while spec is draft", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const plan = "docs/superpowers/plans/2026-08-06-x.md";
    const out = await run(tools, "workit_plan_approve", { confirmed: true, plan_path: plan }, ctx);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("spec");
  } finally {
    cleanup(root);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/flow-tools.test.ts`
Expected: FAIL — `../src/tools/flow` module not found.

- [ ] **Step 3: Implement `src/tools/flow.ts`**

Create `src/tools/flow.ts`:

```typescript
import { tool } from "@opencode-ai/plugin";
import path from "node:path";
import { fail, ok } from "../core";
import {
  readFlowState,
  transitionSpec,
  transitionPlan,
  recordMenuChoice,
} from "../core/flow-state";

const output = (value: unknown) => JSON.stringify(value, null, 2);

const slugFrom = (p: string) => path.basename(p, ".md").replace(/-design$/, "");

export function createFlowTools() {
  return {
    workit_flow_status: tool({
      description: "Read the spec/plan approval flow state for a workflow",
      args: {
        plan_path: tool.schema.string().optional(),
        spec_path: tool.schema.string().optional(),
      },
      execute: async ({ plan_path, spec_path }, context) => {
        try {
          const slug = slugFrom(plan_path ?? spec_path ?? "");
          if (!slug) return output(fail("plan_path or spec_path required"));
          const state = readFlowState(context.directory, slug);
          return output(ok({
            slug,
            spec: state.spec,
            plan: state.plan,
            menu: state.menu,
            flow_path: path.posix.join("docs/superpowers/sdd", slug, "flow.json"),
          }));
        } catch (error) {
          return output(fail(error instanceof Error ? error.message : "flow status failed"));
        }
      },
    }),
    workit_spec_approve: tool({
      description: "Advance spec status: first call self_reviewed, second call approved (after user approval)",
      args: {
        confirmed: tool.schema.boolean(),
        spec_path: tool.schema.string(),
      },
      execute: async ({ confirmed, spec_path }, context) => {
        const slug = slugFrom(spec_path);
        const result = transitionSpec(context.directory, slug, spec_path, confirmed);
        return output(result.ok ? ok({ spec: spec_path, status: readFlowState(context.directory, slug).spec.status }) : fail(result.error));
      },
    }),
    workit_plan_approve: tool({
      description: "Advance plan status: first call self_reviewed, second call approved. Requires approved spec.",
      args: {
        confirmed: tool.schema.boolean(),
        plan_path: tool.schema.string(),
      },
      execute: async ({ confirmed, plan_path }, context) => {
        const slug = slugFrom(plan_path);
        const result = transitionPlan(context.directory, slug, plan_path, confirmed);
        return output(result.ok ? ok({ plan: plan_path, status: readFlowState(context.directory, slug).plan.status }) : fail(result.error));
      },
    }),
    workit_plan_menu: tool({
      description: "Record the answered post-plan choice menu (called after native question)",
      args: {
        confirmed: tool.schema.boolean(),
        plan_path: tool.schema.string(),
        choice: tool.schema.enum(["subagent-driven", "inline", "handoff", "review-spec", "review-plan"]),
      },
      execute: async ({ confirmed, plan_path, choice }, context) => {
        const slug = slugFrom(plan_path);
        const result = recordMenuChoice(context.directory, slug, plan_path, choice, confirmed);
        return output(result.ok ? ok({ menu: { presented: true, chosen: choice } }) : fail(result.error));
      },
    }),
  };
}
```

- [ ] **Step 4: Register in `src/tools/index.ts`**

Read `src/tools/index.ts`, then modify so `createTools` includes the flow tools:

```typescript
import { createFlowTools } from "./flow";
// inside createTools(...):
const flowTools = createFlowTools();
return { ...flowTools, ...otherToolGroups };
```

Verify `index.ts` exports `createTools` that merges `flowTools` with existing groups (match the file's existing merge pattern).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/flow-tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/tools/flow.ts src/tools/index.ts test/flow-tools.test.ts
git commit -m "feat(plugin): register workit_flow_status/spec_approve/plan_approve/plan_menu"
```

---

### Task 3: Hard-fail gates in implement and handoff paths

**Files:**
- Modify: `src/tools/handoff.ts`
- Modify: `templates/execution-contract.md`
- Create: `test/gates.test.ts`

**Interfaces:**
- Consumes: `readFlowState` from `src/core/flow-state.ts`; `slugFrom` logic (reuse by importing `slugFrom` — export it from `src/tools/flow.ts`)
- Produces: gate-check helper `assertFlowGates(workspaceRoot, planPath, { requireMenu: boolean })` exported from `src/core/flow-state.ts`

- [ ] **Step 1: Add the gate helper to `src/core/flow-state.ts`**

Append to `src/core/flow-state.ts`:

```typescript
export const slugFromPath = (p: string) =>
  path.basename(p, ".md").replace(/-design$/, "");

export const assertFlowGates = (
  root: string,
  planPath: string,
  opts: { requireMenu?: boolean } = {},
): Result => {
  const slug = slugFromPath(planPath);
  const state = readFlowState(root, slug);
  if (state.spec.status !== "approved") {
    return { ok: false, error: `spec not approved (status: ${state.spec.status}). Run workit_spec_approve after the user's approval.` };
  }
  if (state.plan.status !== "approved") {
    return { ok: false, error: `plan not approved (status: ${state.plan.status}). Run workit_plan_approve after the user's approval.` };
  }
  if (opts.requireMenu && !state.menu.presented) {
    return { ok: false, error: "post-plan menu not presented. Ask the native question menu (Subagent-driven/Inline/Handoff/Review spec/Review plan) and record the answer with workit_plan_menu." };
  }
  return { ok: true };
};
```

Update the test file `test/flow-state.test.ts` — append:

```typescript
import { assertFlowGates, slugFromPath } from "../src/core/flow-state";

test("slugFromPath strips -design suffix", () => {
  expect(slugFromPath("docs/superpowers/plans/2026-08-06-x.md")).toBe("2026-08-06-x");
  expect(slugFromPath("docs/superpowers/specs/2026-08-06-x-design.md")).toBe("2026-08-06-x");
});

test("assertFlowGates fails without approvals", () => {
  const { root, slug } = fixture();
  try {
    const result = assertFlowGates(root, `docs/superpowers/plans/${slug}.md`);
    expect(result.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("assertFlowGates requires menu when requested", () => {
  const { root, slug } = fixture();
  try {
    transitionSpec(root, slug, `docs/superpowers/specs/${slug}-design.md`, true);
    transitionSpec(root, slug, `docs/superpowers/specs/${slug}-design.md`, true);
    transitionPlan(root, slug, `docs/superpowers/plans/${slug}.md`, true);
    transitionPlan(root, slug, `docs/superpowers/plans/${slug}.md`, true);
    const withoutMenu = assertFlowGates(root, `docs/superpowers/plans/${slug}.md`, { requireMenu: true });
    expect(withoutMenu.ok).toBe(false);
    recordMenuChoice(root, slug, `docs/superpowers/plans/${slug}.md`, "inline", true);
    const withMenu = assertFlowGates(root, `docs/superpowers/plans/${slug}.md`, { requireMenu: true });
    expect(withMenu.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/flow-state.test.ts`
Expected: FAIL — `assertFlowGates` / `slugFromPath` not exported.

- [ ] **Step 3: Wire the gate into `src/tools/handoff.ts`**

Read `src/tools/handoff.ts`. In the `workit_handoff_session` execute path (before creating the session), add:

```typescript
import { assertFlowGates } from "../core/flow-state";

// at the top of the execute body, after resolving plan_path:
const gate = assertFlowGates(context.directory, planPath);
if (!gate.ok) return output(fail(gate.error));
```

Apply the same gate in any handoff path that resolves `plan_path` (match the file's existing flow; if handoff receives only a `message`, resolve the most recent linked pair under `docs/superpowers/` as it already does, then gate).

- [ ] **Step 4: Update `templates/execution-contract.md`**

Read the file. Add after the existing contract text:

```markdown
## Flow gates (HARD)

- `wf-implement` refuses to run unless the plan is `approved` (flow.json) and the post-plan menu was presented.
- `wf-handoff` refuses to run unless both spec and plan are `approved`.
- Sequence is enforced by tools: `workit_spec_approve` (×2), `workit_plan_approve` (×2), `workit_plan_menu` — never skip a step.
```

- [ ] **Step 5: Run full suite**

Run: `bun test`
Expected: all existing + new tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/flow-state.ts src/tools/handoff.ts templates/execution-contract.md test/flow-state.test.ts
git commit -m "feat(gates): hard-fail implement/handoff without approved spec+plan and menu"
```

---

### Task 4: Port `docs-validate` to TS (`src/core/docs-validate.ts`)

**Files:**
- Create: `src/core/docs-validate.ts`
- Delete: `scripts/lib/docs-validate.sh`, `scripts/lib/docs-validate.py`
- Modify: `src/tools/sdd.ts` (import from `src/core/docs-validate.ts` instead of `../legacy/docs-validate.js`)
- Test: `test/docs-validate.test.ts` (existing — update imports to point at the new module)

**Interfaces:**
- Consumes: `parsePlanTasks` from `src/core/plan-tasks.ts` (Task 5) — for this task, implement `parsePlanTasks` port first inside this task OR keep the existing call for one step; cleanest: port `plan-tasks` inline here as `parseTasksFromPlan(planText)` since docs-validate needs the section scan.
- Produces: `docsValidate({ spec_path, plan_path, workspace_root }): { ok: true, spec, plan, branch, task_count } | { ok: false, errors: { code, message, path? }[] }` — same contract as the existing wrapper (see `test/docs-validate.test.ts` for exact expectations)

- [ ] **Step 1: Port the logic to TS**

Create `src/core/docs-validate.ts` translating `scripts/lib/docs-validate.py` 1:1 to TS:

```typescript
import { readFileSync } from "node:fs";
import path from "node:path";

type DocError = { code: string; message: string; path?: string };

const BRANCH_RE = /^\s*\*+Branch:\*+\s*`?((?:feature|bugfix)\/[^`\s|]+)`?\s*$/im;
const SPEC_LINK_RE = /^\s*\*+Spec:\*+\s*(?:`([^`]+)`|(\S+))\s*$/im;
const TASK_RE = /^###\s+Task\s+(\d+):\s*(.*)$/i;

const err = (code: string, message: string, path?: string): DocError => {
  const item: DocError = { code, message };
  if (path) item.path = path;
  return item;
};

const readBranch = (text: string, label: string): [string | null, DocError | null] => {
  const match = text.match(BRANCH_RE);
  if (!match) return [null, err("missing_branch", `**Branch:** feature/* or bugfix/* required in ${label}`)];
  return [match[1].trim().replace(/`/g, ""), null];
};

const scanTaskHeadings = (planText: string): [number[], string[], DocError | null] => {
  const ids: number[] = [];
  const titles: string[] = [];
  let inFence = false;
  for (const line of planText.split("\n")) {
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = line.match(TASK_RE);
    if (match) { ids.push(Number(match[1])); titles.push(match[2].trim()); }
  }
  if (ids.length === 0) return [ids, titles, err("task_order", "no ### Task N sections found outside fences")];
  const expected = ids.map((_, i) => i + 1);
  const sorted = [...ids].sort((a, b) => a - b);
  if (JSON.stringify(sorted) !== JSON.stringify(expected) || new Set(ids).size !== ids.length) {
    return [ids, titles, err("task_order", `task headings must be contiguous from 1..${ids.length}; found ${ids}`)];
  }
  return [ids, titles, null];
};

export const docsValidate = ({
  spec_path,
  plan_path,
  workspace_root,
}: {
  spec_path: string;
  plan_path: string;
  workspace_root: string;
}): { ok: true; spec: string; plan: string; branch: string; task_count: number } | { ok: false; errors: DocError[] } => {
  const cwd = path.resolve(workspace_root);
  const specAbs = path.isAbsolute(spec_path) ? spec_path : path.join(cwd, spec_path);
  const planAbs = path.isAbsolute(plan_path) ? plan_path : path.join(cwd, plan_path);
  const errors: DocError[] = [];

  const read = (p: string): string | null => {
    try { return readFileSync(p, "utf8"); } catch { return null; }
  };

  const specText = read(specAbs);
  const planText = read(planAbs);
  if (specText === null) errors.push(err("missing_file", `spec not found: ${spec_path}`, spec_path));
  if (planText === null) errors.push(err("missing_file", `plan not found: ${plan_path}`, plan_path));
  if (errors.length) return { ok: false, errors };
  const specText_ = specText!;
  const planText_ = planText!;

  const [specBranch, specErr] = readBranch(specText_, "spec");
  if (specErr) errors.push(specErr);
  const [planBranch, planErr] = readBranch(planText_, "plan");
  if (planErr) errors.push(planErr);

  const linkMatch = planText_.match(SPEC_LINK_RE);
  if (!linkMatch) {
    errors.push(err("missing_spec_link", "**Spec:** link required in plan", plan_path));
  } else {
    const linked = (linkMatch[1] ?? linkMatch[2] ?? "").trim();
    const linkedAbs = path.isAbsolute(linked) ? linked : path.join(cwd, linked);
    if (path.resolve(linkedAbs) !== path.resolve(specAbs)) {
      errors.push(err("spec_mismatch", `plan **Spec:** ${linked} does not match spec_path ${spec_path}`, plan_path));
    }
  }

  if (specBranch && planBranch && specBranch !== planBranch) {
    errors.push(err("branch_mismatch", `spec branch ${JSON.stringify(specBranch)} != plan branch ${JSON.stringify(planBranch)}`, plan_path));
  }

  const [, , taskErr] = scanTaskHeadings(planText_);
  if (taskErr) errors.push(taskErr);

  if (errors.length) return { ok: false, errors };

  // plan parse cross-check: section text per task (port of parse-plan-tasks.sh JSON mode)
  const tasks = parseTasksFromPlan(planText_);
  const [headingIds, headingTitles, headingErr] = scanTaskHeadings(planText_);
  if (headingErr) return { ok: false, errors: [headingErr] };
  if (tasks.length !== headingIds.length) {
    return { ok: false, errors: [err("task_order", `parse count ${tasks.length} != heading count ${headingIds.length}`, plan_path)] };
  }
  for (let i = 0; i < tasks.length; i++) {
    if (String(tasks[i].id) !== String(headingIds[i]) || tasks[i].title.trim() !== headingTitles[i]) {
      return { ok: false, errors: [err("task_order", `task mismatch at position ${i + 1}`, plan_path)] };
    }
  }

  const relSpec = path.isAbsolute(spec_path) ? path.relative(cwd, specAbs) : spec_path;
  const relPlan = path.isAbsolute(plan_path) ? path.relative(cwd, planAbs) : plan_path;
  return { ok: true, spec: relSpec, plan: relPlan, branch: specBranch!, task_count: tasks.length };
};

// Port of scripts/lib/parse-plan-tasks.sh (JSON mode) — exported for Task 5 reuse
export const parseTasksFromPlan = (planText: string): { id: number; title: string; section_text: string }[] => {
  const tasks: { id: number; title: string; section_text: string }[] = [];
  let current: { id: number; title: string; body: string[] } | null = null;
  let inFence = false;
  for (const line of planText.split("\n")) {
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = line.match(TASK_RE);
    if (match) {
      if (current) tasks.push({ id: current.id, title: current.title, section_text: current.body.join("\n") });
      current = { id: Number(match[1]), title: match[2].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) tasks.push({ id: current.id, title: current.title, section_text: current.body.join("\n") });
  return tasks;
};
```

- [ ] **Step 2: Update `src/tools/sdd.ts` imports**

In `src/tools/sdd.ts`, replace:

```typescript
import { docsValidate } from "../legacy/docs-validate.js";
```

with:

```typescript
import { docsValidate } from "../core/docs-validate";
```

(The `workit_docs_validate` tool keeps its exact args/behavior — the envelope logic in `invoke()` is unchanged.)

- [ ] **Step 3: Run existing docs-validate tests**

Run: `bun test test/docs-validate.test.ts`
Expected: PASS (existing tests now exercise the TS port; if any expectation differs, adjust the port, not the test).

- [ ] **Step 4: Delete the python/bash implementations**

```bash
git rm scripts/lib/docs-validate.sh scripts/lib/docs-validate.py
```

- [ ] **Step 5: Run full suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): port docs-validate + plan task parsing to pure TS; delete scripts"
```

---

### Task 5: Port branch + git to TS (`src/core/branch.ts`, `src/core/git.ts`)

**Files:**
- Create: `src/core/git.ts`
- Create: `src/core/branch.ts`
- Delete: `src/legacy/branch-resolve.js`, `src/legacy/git-context.js`, `src/legacy/docs-branch.js`, `scripts/lib/resolve-docs-branch.sh`, `scripts/lib/resolve-handoff-branch.sh`, `scripts/lib/ensure-develop-base.sh`, `scripts/branch/setup-branch.sh`
- Modify: `src/tools/sdd.ts` (import from `../core/branch.ts`)
- Test: `test/branch-policy.test.ts` (existing — update imports)

**Interfaces:**
- Produces:
  - `gitContext(cwd): { branch: string; status_short: string }` (port of `git-context.js`)
  - `resolveBranch({ spec_path, plan_path, workspace_root })` — port of `resolve-handoff-branch.sh` + wrapper: returns `{ branch, source, current_branch, dirty, needs_checkout }`
  - `docsBranch({ plan_path, kind, workspace_root })` — port of `resolve-docs-branch.sh` + wrapper
  - `branchSetup({ action, sdd_dir, target_branch, stash, workspace_root })` — port of `setup-branch.sh`

- [ ] **Step 1: Port `git-context.js` to `src/core/git.ts`**

Read `src/legacy/git-context.js` and port 1:1 to TS:

```typescript
import { execFileSync } from "node:child_process";

export const gitContext = (cwd: string): { branch: string; status_short: string } => {
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  return {
    branch: run(["branch", "--show-current"]),
    status_short: run(["status", "--short"]),
  };
};
```

- [ ] **Step 2: Port branch resolution to `src/core/branch.ts`**

Read `scripts/lib/resolve-handoff-branch.sh` and `scripts/lib/resolve-docs-branch.sh`, then port both to TS (preserve exact semantics: protected branch list `{main, develop, master, prod, production}`, `use-current` marker, normalization `[^\w.-]+ → -`, collapse double dashes, `feature|bugfix/<slug>` pattern). Replace the subprocess python with a `readFileSync` scan + `gitContext`:

```typescript
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gitContext } from "./git";

const PROTECTED = new Set(["main", "develop", "master", "prod", "production"]);
const DECLARE_RE = /^\s*\*+Branch:\*+\s*`?((?:feature|bugfix)\/[^`\s|]+)`?\s*$/im;
const USE_CURRENT_RE = /^\s*\*+Branch:\*+\s*use-current\s*$/im;
const BRANCH_PAT = /^(feature|bugfix)\/[a-z0-9][a-z0-9._/-]*$/i;

const readSafe = (p: string): string | null => {
  try { return readFileSync(p, "utf8"); } catch { return null; }
};

const normalizeBranch = (name: string): string | null => {
  let n = name.trim().replace(/`/g, "").replace(/\.+$/, "");
  if (PROTECTED.has(n.toLowerCase())) return null;
  if (!BRANCH_PAT.test(n)) return null;
  const [kind, ...restParts] = n.split("/");
  const rest = restParts.join("/").toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  if (!rest) return null;
  return `${kind.toLowerCase()}/${rest}`;
};

export const resolveBranch = ({
  spec_path, plan_path, workspace_root,
}: { spec_path: string; plan_path: string; workspace_root: string }) => {
  const cwd = path.resolve(workspace_root);
  const abs = (p: string) => path.isAbsolute(p) ? p : path.join(cwd, p);
  const spec = abs(spec_path);
  const plan = abs(plan_path);
  const git = gitContext(cwd);
  const current = git.branch;
  for (const file of [spec, plan]) {
    const text = readSafe(file);
    if (!text) continue;
    if (USE_CURRENT_RE.test(text)) {
      if (!current) return { error: "use-current requested but HEAD is detached" };
      return { branch: current, source: "use-current", current_branch: current, dirty: Boolean(git.status_short.trim()), needs_checkout: false };
    }
  }
  // declared branch wins (spec first, then plan)
  for (const file of [spec, plan]) {
    const text = readSafe(file);
    const match = text?.match(DECLARE_RE);
    if (match) {
      const normalized = normalizeBranch(match[1]);
      if (!normalized) return { error: `invalid branch declaration: ${match[1]}` };
      return { branch: normalized, source: "declared", current_branch: current, dirty: Boolean(git.status_short.trim()), needs_checkout: current !== normalized };
    }
  }
  // derive from plan slug
  const slug = path.basename(plan, ".md");
  const derived = normalizeBranch(`feature/${slug}`);
  return { branch: derived!, source: "derived", current_branch: current, dirty: Boolean(git.status_short.trim()), needs_checkout: current !== derived };
};

export const docsBranch = ({
  plan_path, kind, workspace_root,
}: { plan_path?: string; kind?: string; workspace_root: string }) => {
  const cwd = path.resolve(workspace_root);
  const git = gitContext(cwd);
  const current = git.branch;
  if (current.startsWith("feature/") || current.startsWith("bugfix/")) {
    return { branch: current, source: "keep", dirty: Boolean(git.status_short.trim()) };
  }
  if (plan_path) {
    const text = readSafe(path.isAbsolute(plan_path) ? plan_path : path.join(cwd, plan_path));
    const match = text?.match(DECLARE_RE);
    if (match) return { branch: normalizeBranch(match[1])!, source: "declared", dirty: Boolean(git.status_short.trim()) };
  }
  return { branch: "", source: "create_from_develop", dirty: Boolean(git.status_short.trim()) };
};

export const branchSetup = ({
  action, sdd_dir, target_branch, stash, workspace_root,
}: { action?: string; sdd_dir?: string; target_branch?: string; stash?: string; workspace_root: string }) => {
  // Port of scripts/branch/setup-branch.sh — preserve: protected-branch check,
  // dirty-tree stash flow, worktree-lock error, ensure-develop-base before -b,
  // manifest.json write (branch/previous_branch/stash_ref).
  const cwd = path.resolve(workspace_root);
  const exec = (args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const current = gitContext(cwd).branch;
  if (!current) return { error: "not in a git repository" };
  const sdd = sdd_dir ?? "docs/superpowers/sdd";
  const manifestPath = path.join(cwd, sdd, "manifest.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  const readManifest = (): Record<string, unknown> => {
    try { return JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return {}; }
  };
  const writeManifest = (data: Record<string, unknown>) =>
    writeFileSync(manifestPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  if (action === "reapply_stash") {
    const manifest = readManifest();
    const ref = manifest.stash_ref;
    if (!ref) return { error: "no stash_ref in manifest" };
    try { exec(["stash", "pop", String(ref)]); } catch (error) {
      return { error: error instanceof Error ? error.message : "stash pop failed" };
    }
    delete manifest.stash_ref;
    delete manifest.stash_created_at;
    writeManifest(manifest);
    return { action: "reapply_stash", ok: true };
  }

  const target = target_branch ?? "";
  if (!target) return { error: "target branch required" };
  if (/^(main|master|develop|prod|production)$/.test(target)) return { error: `protected branch ${target}` };
  if (!/^(feature|bugfix)\//.test(target)) return { error: `target must be feature/* or bugfix/* — got ${target}` };

  let stash_ref: string | undefined;
  if (current !== target) {
    const dirty = Boolean(gitContext(cwd).status_short.trim());
    if (dirty) {
      if (stash !== "yes") {
        return { error: "dirty working tree — ask with native question, then call workit_branch_setup with stash=yes" };
      }
      try { exec(["stash", "push", "-u", "-m", `workflow-toolkit: pre-checkout ${target}`]); } catch (error) {
        return { error: error instanceof Error ? error.message : "stash push failed" };
      }
      stash_ref = "stash@{0}";
    }
    try {
      exec(["checkout", target]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "checkout failed";
      if (/worktree/i.test(message)) {
        return { error: `branch ${target} is locked by an existing git worktree — remove it first (we do not use worktrees)` };
      }
      // branch does not exist yet: base it on develop (or main when develop is missing locally)
      try {
        const base = gitContext(cwd).branch;
        if (/^(main|master)$/.test(base)) {
          try { exec(["checkout", "develop"]); } catch { /* no local develop; stay */ }
        }
        exec(["checkout", "-b", target]);
      } catch (createError) {
        return { error: createError instanceof Error ? createError.message : "branch create failed" };
      }
    }
  }

  const manifest = readManifest();
  manifest.branch = target;
  manifest.previous_branch = current;
  if (stash_ref) {
    manifest.stash_ref = stash_ref;
    manifest.stash_created_at = new Date().toISOString();
  }
  writeManifest(manifest);
  return { action: "setup", ok: true, branch: target, previous_branch: current, stash_ref: stash_ref ?? null, manifest: manifestPath };
};
```

**Note:** read `scripts/branch/setup-branch.sh` fully and translate its exact sequence (develop sync, stash on/off, checkout) before marking the step done. Do not leave the `throw` in the final code.

- [ ] **Step 3: Update `src/tools/sdd.ts` imports**

Replace:

```typescript
import { resolveBranch } from "../legacy/branch-resolve.js";
import { docsBranch } from "../legacy/docs-branch.js";
```

with:

```typescript
import { resolveBranch, docsBranch, branchSetup } from "../core/branch";
```

- [ ] **Step 4: Run existing branch tests**

Run: `bun test test/branch-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Delete legacy wrappers and scripts**

```bash
git rm src/legacy/branch-resolve.js src/legacy/git-context.js src/legacy/docs-branch.js \
  scripts/lib/resolve-docs-branch.sh scripts/lib/resolve-handoff-branch.sh \
  scripts/lib/ensure-develop-base.sh scripts/branch/setup-branch.sh
```

- [ ] **Step 6: Run full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(core): port branch + git resolution to pure TS; delete bash wrappers"
```

---

### Task 6: Port SDD context to TS (`src/core/sdd.ts`)

**Files:**
- Create: `src/core/sdd.ts`
- Delete: `src/legacy/sdd-context.js`, `scripts/sdd/sdd-workspace.sh`, `scripts/sdd/parse-progress.sh`, `scripts/sdd/task-brief.sh`, `scripts/sdd/review-package.sh`, `scripts/sdd/append-progress.sh`
- Modify: `src/tools/sdd.ts` (import from `../core/sdd`)
- Test: `test/sdd.test.ts` (existing — update imports)

**Interfaces:**
- Produces (ports preserving exact names/signatures used by `src/tools/sdd.ts`):
  - `slugFromPlan(planPath)`, `todosFromTasks(tasks, completedTaskIds?)`
  - `sddContext({ slug?, plan_path?, workspace_root })` — includes flow-gate status via `readFlowState` (adds `flow: { spec, plan, menu }` to the response)
  - `sddTaskBrief({ sdd_dir, task_id, section_text, workspace_root })`
  - `sddReviewPackage({ sdd_dir, base_sha, head_sha, workspace_root })` (uses `git diff` via `execFileSync`)
  - `sddAppendProgress({ progress_path, line, workspace_root })` (port of the python regex validation `^Task\s+\d+:\s+complete\s+\(commits\s+[0-9a-f]{7,40}\.\.[0-9a-f]{7,40},`)

- [ ] **Step 1: Port `sdd-context.js` + sdd scripts to `src/core/sdd.ts`**

Read `src/legacy/sdd-context.js` and all `scripts/sdd/*.sh`, translate 1:1 to TS (replace `runScriptJson`/`runScript` with direct `readFileSync`/`writeFileSync`/`execFileSync`). Use `execFileSync("git", ["diff", base, head], { cwd, encoding: "utf8" })` for the review package. Keep every exported function name above. In `sddContext`, after building the response, add:

```typescript
import { readFlowState } from "./flow-state";
// inside sddContext, after progress/manifest handling:
const flow = readFlowState(cwd, resolvedSlug);
data.flow = { spec: flow.spec, plan: flow.plan, menu: flow.menu };
```

- [ ] **Step 2: Update `src/tools/sdd.ts` imports**

Replace:

```typescript
import {
  sddAppendProgress, sddContext, sddReviewPackage, sddTaskBrief,
} from "../legacy/sdd-context.js";
```

with:

```typescript
import { sddAppendProgress, sddContext, sddReviewPackage, sddTaskBrief } from "../core/sdd";
```

- [ ] **Step 3: Run existing SDD tests**

Run: `bun test test/sdd.test.ts`
Expected: PASS.

- [ ] **Step 4: Delete legacy + scripts**

```bash
git rm src/legacy/sdd-context.js scripts/sdd/sdd-workspace.sh scripts/sdd/parse-progress.sh \
  scripts/sdd/task-brief.sh scripts/sdd/review-package.sh scripts/sdd/append-progress.sh
```

- [ ] **Step 5: Run full suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): port SDD context to pure TS with flow status"
```

---

### Task 7: Port remaining legacy modules to `src/core/*.ts`

**Files:**
- Create: `src/core/youtrack.ts` (port of `src/legacy/youtrack.js` — 202 lines)
- Create: `src/core/present.ts` (port of `src/legacy/present.js` — 29 lines)
- Create: `src/core/repo.ts` (port of `src/legacy/repo-tool.js` + `resolve-workspace-root.js` + `plugin-root.js`)
- Create: `src/core/parse-sections.ts` (port of `src/legacy/parse-sections.js` — 24 lines)
- Create: `src/core/changelog.ts` (port of `src/legacy/changelog-apply.js` — 117 lines)
- Create: `src/core/verify.ts` (port of `src/legacy/verify-parse.js` — 27 lines)
- Create: `src/core/init.ts` (port of `src/legacy/init.js` — 54 lines)
- Delete: all of `src/legacy/`
- Modify: `src/tools/present.ts`, `src/tools/repo.ts`, `src/tools/youtrack.ts` (imports → `../core/*`)
- Test: existing `test/youtrack.test.ts`, `test/repo.test.ts`, `test/core.test.ts`, `test/handoff.test.ts`, `test/contracts.test.ts`, `test/bootstrap.test.ts`, `test/plugin.test.ts` (update imports; behavior unchanged)

**Interfaces:**
- Ports are 1:1 TS translations preserving every exported function name and signature currently imported by `src/tools/*.ts` and `src/plugin.ts`. `resolveWorkspaceRoot` and `PLUGIN_ROOT` move into `src/core/repo.ts`; update the remaining import sites in `src/tools/*` and `src/plugin.ts`.

- [ ] **Step 1: Port each legacy module 1:1 to TS**

For each file in `src/legacy/*.js`, create the corresponding `src/core/<name>.ts` (drop `.js`), translating to TS. Replace every `runScriptJson("lib/...", args, cwd)` / `runScript("...", args, cwd)` call with the equivalent direct implementation from the target shell script (read the `.sh` under `scripts/` and inline its logic). Keep exports identical. Remove the `run-script.js` subprocess layer entirely.

- [ ] **Step 2: Update all import sites**

Use grep to find remaining `../legacy/` imports in `src/tools/*.ts` and `src/plugin.ts`; rewrite each to `../core/<name>`. Verify none remain:

```bash
grep -rn "legacy" src/ || echo "no legacy imports remain"
```

- [ ] **Step 3: Delete `src/legacy/`**

```bash
git rm -r src/legacy
```

- [ ] **Step 4: Run full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS. Fix any behavioral drift against existing tests (tests are the contract — do not weaken them).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(core): port remaining legacy modules to TS; delete src/legacy"
```

---

### Task 8: Cursor MCP server imports `src/core` (bun runtime)

**Files:**
- Create: `cursor/mcp/server.ts` (TS port of `cursor/mcp/server.js`, importing from `../../src/core/*`)
- Modify: `cursor/mcp/run-server.sh` (execute `bun server.ts` instead of `node server.js`)
- Delete: `cursor/mcp/server.js`, `cursor/mcp/lib/` (entire duplicate lib)
- Modify: `cursor/mcp/package.json` (add `"bun": ">=1.0"` engines note; keep `@modelcontextprotocol/sdk` + `zod`)
- Test: `cursor/mcp/test/regressions.test.js` → migrate to `test/mcp-regressions.test.ts` at repo root (same assertions, bun runner, imports from `src/core/*`)

**Interfaces:**
- Consumes: every function currently imported by `server.js` from `./lib/*.js` (same names, now from `../../src/core/*`)
- Produces: identical MCP tool surface (`workflow-*` names, zod schemas, `jsonResult` envelope) — the MCP client contract does not change

- [ ] **Step 1: Port `server.js` to `server.ts`**

Read `cursor/mcp/server.js` (full file). Port to TS, replacing:

```typescript
import { runScript } from "./lib/run-script.js";
// ... all ./lib/* imports
```

with:

```typescript
import { docsValidate } from "../../src/core/docs-validate";
import { resolveBranch, branchSetup, docsBranch } from "../../src/core/branch";
import { sddContext, sddTaskBrief, sddReviewPackage, sddAppendProgress } from "../../src/core/sdd";
import { readFlowState, transitionSpec, transitionPlan, recordMenuChoice } from "../../src/core/flow-state";
// ... remaining imports from ../../src/core/*
```

Add the four flow tools to the MCP server registration (`workit_flow_status`, `workit_spec_approve`, `workit_plan_approve`, `workit_plan_menu`) with the same zod schemas as Task 2, and wire the hard-fail gate into `workit_handoff_session`/implement paths using `assertFlowGates`. Bump the `version` string to `0.4.0`.

- [ ] **Step 2: Update `run-server.sh`**

In `cursor/mcp/run-server.sh`, replace the last line:

```bash
exec node "${MCP_DIR}/server.js"
```

with:

```bash
BUN_BIN="${BUN:-}"
if [ -z "$BUN_BIN" ]; then
  for candidate in "$HOME/.bun/bin/bun" /usr/local/bin/bun /usr/bin/bun; do
    [ -x "$candidate" ] && BUN_BIN="$candidate" && break
  done
fi
if [ -z "$BUN_BIN" ]; then
  echo "workflow-toolkit: bun not found (required for MCP server)" >&2
  exit 1
fi
exec "$BUN_BIN" "${MCP_DIR}/server.ts"
```

- [ ] **Step 3: Migrate the cursor MCP regression tests**

Read `cursor/mcp/test/regressions.test.js`. Move its assertions into `test/mcp-regressions.test.ts` at repo root (bun test), importing the same functions from `src/core/*`. Delete `cursor/mcp/test/` and the `test:cursor` script.

- [ ] **Step 4: Update `package.json` scripts**

In root `package.json`, replace:

```json
"test:cursor": "npm --prefix cursor/mcp test",
"check": "bun test && tsc --noEmit && npm --prefix cursor/mcp ci && npm --prefix cursor/mcp test"
```

with:

```json
"check": "bun test && bunx tsc --noEmit"
```

- [ ] **Step 5: Delete duplicates**

```bash
git rm -r cursor/mcp/lib cursor/mcp/server.js cursor/mcp/test
```

- [ ] **Step 6: Run full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS (includes migrated MCP regression assertions).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(mcp): Cursor MCP imports shared src/core via bun; delete duplicate lib"
```

---

### Task 9: Gitignore docs/superpowers, untrack old docs, version bump, final check

**Files:**
- Modify: `.gitignore` (add `docs/superpowers/`)
- Modify: `package.json` (version `0.4.0`)
- Modify: `cursor/mcp/package.json` (version `0.4.0`)

**Interfaces:**
- Produces: release-ready `bun run check` green; no workflow docs tracked in git

- [ ] **Step 1: Ensure `.gitignore` covers workflow docs**

Verify `.gitignore` contains (add if missing):

```gitignore
# Superpowers workflow docs are working files, not versioned
docs/superpowers/
```

- [ ] **Step 2: Untrack already-committed workflow docs (files stay on disk)**

```bash
git rm -r --cached docs/superpowers
```

Verify `git status` shows the docs as deleted-from-index only, and `docs/superpowers/specs/2026-08-06-workflow-flow-gates-design.md` still exists on disk.

- [ ] **Step 3: Version bump**

In `package.json` set `"version": "0.4.0"`. In `cursor/mcp/package.json` set `"version": "0.4.0"`. Confirm `cursor/mcp/server.ts` reports `version: "0.4.0"` (set in Task 8).

- [ ] **Step 4: Final release gate**

Run: `bun run check`
Expected: all tests + typecheck PASS, exit 0.

- [ ] **Step 5: Smoke-test the real plugin**

Run the toolkit's existing smoke script if present (`test/smoke.ts`), or launch `bunx tsx src/plugin.ts` dry-import to confirm the plugin loads without legacy imports:

```bash
bun -e "import('./src/plugin.ts').then(() => console.log('plugin loads OK'))"
```

Expected: `plugin loads OK`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: gitignore workflow docs, untrack legacy docs, bump to 0.4.0"
```

---

## Post-plan checklist

- [ ] `bun run check` green after each task.
- [ ] No imports of `src/legacy`, `cursor/mcp/lib`, `scripts/lib`, `scripts/sdd` remain (`grep -rn "legacy\|scripts/lib\|scripts/sdd" src cursor test` returns nothing).
- [ ] `docs/superpowers/` untracked and present on disk.
- [ ] Both platform tool surfaces expose `workit_flow_status`, `workit_spec_approve`, `workit_plan_approve`, `workit_plan_menu`.
- [ ] `wf-implement` / `wf-handoff` refuse without approved state (verified by tests in Task 3).
