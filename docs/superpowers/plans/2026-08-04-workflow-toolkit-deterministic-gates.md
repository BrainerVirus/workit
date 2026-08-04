# Workflow Toolkit Deterministic Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-04-workflow-toolkit-deterministic-gates-design.md`
**Branch:** `feature/workflow-toolkit-deterministic-gates`

**Goal:** Make workflow gates tool-deterministic across OpenCode and Cursor so review loops, post-plan choice, Arguments rendering, branch policy, docs validation, and PR preview behave the same for every agent/model.

**Architecture:** Shared scripts under `scripts/` own validation and branch policy; OpenCode tools and Cursor MCP expose them; skills/contracts only call tools and map native questions. No Superpowers fork, no new dependencies, no review-round service.

**Tech Stack:** Bun tests, Node `node:test` (Cursor MCP), bash/Python stdlib scripts, existing `@opencode-ai/plugin` + MCP server patterns.

## Global Constraints

- Tools own ground truth; skills never invent branch names, task order, or PR bodies when a tool result exists.
- Hard-fail only for docs validation — no warn-and-continue.
- New branches only from up-to-date `develop`; never create `feature|bugfix` from `main`/`master`.
- Keep current branch when HEAD is already `feature/*` or `bugfix/*`.
- Post-plan options exactly: Subagent-driven, Inline, Handoff (new session only), Review spec first, Review plan first — no stay.
- Review: max 2 blocker rounds; Minor/style/YAGNI accumulate and roll up only after implementation finishes.
- PR: draft → show title/body → confirm → `workflow_pr_create`.
- No new production dependencies; bun + `node:test` only.
- Patch version `0.3.19` synchronized on OpenCode `package.json`, Cursor `plugin.json`, and MCP `server.js`.
- `bun run check` is the release gate.

---

### Task 1: `workflow_docs_validate` script + OpenCode tool

**Files:**
- Create: `scripts/lib/docs-validate.sh`
- Create: `scripts/lib/docs-validate.py`
- Create: `test/docs-validate.test.ts`
- Modify: `src/tools/sdd.ts`
- Modify: `src/tools/index.ts` (only if tool is registered outside `createSddTools`; prefer registering inside `createSddTools`)

**Interfaces:**
- Consumes: existing `scripts/lib/parse-plan-tasks.sh --format=json`
- Produces: CLI JSON on stdout:
  - success: `{"ok":true,"spec":"<path>","plan":"<path>","branch":"feature|bugfix/...","task_count":N}`
  - failure: `{"ok":false,"errors":[{"code":"<code>","message":"<text>","path":"<optional>"}]}`
- Produces tool: `workflow_docs_validate` with args `{ spec_path: string, plan_path: string }` returning the toolkit `{ ok, data, error }` envelope via existing `ok()`/`fail()` helpers

- [ ] **Step 1: Write the failing OpenCode test**

Create `test/docs-validate.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSddTools } from "../src/tools/sdd";
import { WorkflowStateStore } from "../src/state";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-docs-validate-"));
  mkdirSync(path.join(root, "docs/superpowers/specs"), { recursive: true });
  mkdirSync(path.join(root, "docs/superpowers/plans"), { recursive: true });
  const spec = "docs/superpowers/specs/2026-08-04-gates-design.md";
  const plan = "docs/superpowers/plans/2026-08-04-gates.md";
  writeFileSync(path.join(root, spec), `# Gates\n\n**Branch:** \`feature/gates\`\n`);
  writeFileSync(path.join(root, plan), `# Gates Plan\n\n**Spec:** \`${spec}\`\n**Branch:** \`feature/gates\`\n\n### Task 1: One\n\n- [ ] **Step 1: Do it**\n\n### Task 2: Two\n\n- [ ] **Step 1: Do it**\n`);
  return { root, spec, plan };
};

test("workflow_docs_validate accepts a contiguous linked pair", async () => {
  const { root, spec, plan } = fixture();
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      { spec_path: spec, plan_path: plan },
      { directory: root, worktree: root, sessionID: "t" } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    expect(result.data.task_count).toBe(2);
    expect(result.data.branch).toBe("feature/gates");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_docs_validate hard-fails on task number gap", async () => {
  const { root, spec, plan } = fixture();
  writeFileSync(path.join(root, plan), `# Gates Plan\n\n**Spec:** \`${spec}\`\n**Branch:** \`feature/gates\`\n\n### Task 1: One\n\n- [ ] **Step 1: x**\n\n### Task 3: Skip\n\n- [ ] **Step 1: x**\n`);
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      { spec_path: spec, plan_path: plan },
      { directory: root, worktree: root, sessionID: "t" } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/task/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_docs_validate hard-fails on Spec link or branch mismatch", async () => {
  const { root, spec, plan } = fixture();
  writeFileSync(path.join(root, plan), `# Gates Plan\n\n**Spec:** \`docs/superpowers/specs/other-design.md\`\n**Branch:** \`feature/other\`\n\n### Task 1: One\n\n- [ ] **Step 1: x**\n`);
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      { spec_path: spec, plan_path: plan },
      { directory: root, worktree: root, sessionID: "t" } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/cristhofer-pincetti/Documents/projects/personal/workflow-toolkit && bun test test/docs-validate.test.ts`
Expected: FAIL — `workflow_docs_validate` missing / not a function

- [ ] **Step 3: Implement validator script**

Create `scripts/lib/docs-validate.py` that:
1. Reads `spec_path` and `plan_path` argv (absolute or cwd-relative).
2. Errors with codes `missing_file`, `missing_branch`, `missing_spec_link`, `spec_mismatch`, `branch_mismatch`, `task_order`, `parse_failed`.
3. Requires `**Branch:** \`feature|bugfix/...\`` in both files (same regex family as `resolve-handoff-branch.sh`).
4. Requires plan `**Spec:**` path to resolve to the same inode/realpath as `spec_path`.
5. Scans non-fence lines for `### Task N:`; requires ids `1..N` contiguous unique.
6. Invokes `parse-plan-tasks.sh --format=json` via subprocess; requires `task_count` and titles to match heading scan.
7. Prints a single JSON object to stdout; exit 0 when `ok:true`, exit 1 when `ok:false`.

Create `scripts/lib/docs-validate.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
SPEC="${1:-}"
PLAN="${2:-}"
[ -n "$SPEC" ] && [ -n "$PLAN" ] || { echo '{"ok":false,"errors":[{"code":"usage","message":"spec_path and plan_path required"}]}'; exit 1; }
python3 "$ROOT/scripts/lib/docs-validate.py" "$SPEC" "$PLAN" "$ROOT/scripts/lib/parse-plan-tasks.sh"
```

Make executable: `chmod +x scripts/lib/docs-validate.sh`

- [ ] **Step 4: Register OpenCode tool**

In `src/tools/sdd.ts`, add:

```typescript
workflow_docs_validate: tool({
  description: "Hard-fail validate spec/plan headers, link, branch, and task order",
  args: {
    spec_path: tool.schema.string(),
    plan_path: tool.schema.string(),
  },
  execute: async ({ spec_path, plan_path }, context) => {
    relativePath(context.directory, spec_path);
    relativePath(context.directory, plan_path);
    // run scripts/lib/docs-validate.sh via existing run()/runScriptJson pattern used elsewhere
    // on ok:false → fail(joined error messages) or fail(JSON errors)
    // on ok:true → ok(parsed data without nesting ok)
  },
}),
```

Follow the same `run` / `resolveInside` patterns already used in `src/tools/sdd.ts` and `src/legacy/run-script.js`. Prefer returning `fail(errors.map(e => e.message).join("; "))` so skills see a clear `error` string while still including structured `errors` in `data` when useful.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/docs-validate.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/docs-validate.sh scripts/lib/docs-validate.py src/tools/sdd.ts test/docs-validate.test.ts
git commit -m "feat(validate): add workflow_docs_validate hard-fail gate"
```

---

### Task 2: Wire validate into handoff preflight + Cursor MCP

**Files:**
- Modify: `scripts/collect-handoff-context.sh` (after paths resolved, before prompt build)
- Modify: `src/tools/handoff.ts` (optional extra guard if script already fails — keep single failure path via script)
- Modify: `cursor/mcp/server.js`
- Modify: `cursor/mcp/lib/sdd-context.js` or add `cursor/mcp/lib/docs-validate.js` thin wrapper
- Modify: `cursor/mcp/test/regressions.test.js`
- Modify: `test/handoff.test.ts` (add failing-pair case if not covered by script test)

**Interfaces:**
- Consumes: `scripts/lib/docs-validate.sh` from Task 1
- Produces: handoff context exit nonzero with validate errors; MCP tool `workflow_docs_validate`; Cursor handoff prompt path refuses invalid pairs

- [ ] **Step 1: Write failing Cursor regression + OpenCode handoff failure test**

In `cursor/mcp/test/regressions.test.js` add a test that writes a temp repo with a task gap, runs `scripts/lib/docs-validate.sh`, asserts exit 1 and `ok:false`.

In `test/handoff.test.ts`, add a case where `collect-handoff-context.sh` (or `workflow_handoff_session` with a fake runtime) receives a broken pair and returns failure **before** `handoffSession` create — assert no session create call.

- [ ] **Step 2: Run targeted tests — expect FAIL**

Run: `bun test test/handoff.test.ts` and `npm --prefix cursor/mcp test -- --test-name-pattern='docs.validate|docs-validate'`
Expected: new assertions fail

- [ ] **Step 3: Call validate from `collect-handoff-context.sh`**

Immediately after `resolve_paths` and existing file checks, before branch/prompt generation:

```bash
VALIDATE_JSON=$(bash "$PLUGIN_ROOT/scripts/lib/docs-validate.sh" "$SPEC" "$PLAN") || {
  printf 'ERROR: docs validation failed\n%s\n' "$VALIDATE_JSON" >&2
  exit 1
}
echo "$VALIDATE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True'
```

If validate prints JSON on stdout even on failure, capture stdout/stderr consistently — prefer: script prints JSON always; shell checks `ok` field.

- [ ] **Step 4: Register Cursor MCP `workflow_docs_validate`**

Mirror OpenCode args/description; execute via `runScriptJson`/`run-script.js` against `lib/docs-validate.sh`. Also call validate inside Cursor `workflow_handoff_prompt` path after pair resolution (same as OpenCode collect script if that script is shared — prefer one script call site).

- [ ] **Step 5: Re-run tests — expect PASS**

Run: `bun test test/handoff.test.ts test/docs-validate.test.ts && npm --prefix cursor/mcp test`
Expected: PASS for new cases; existing handoff task-row test still green

- [ ] **Step 6: Commit**

```bash
git add scripts/collect-handoff-context.sh src/tools/handoff.ts cursor/mcp/server.js cursor/mcp/lib cursor/mcp/test/regressions.test.js test/handoff.test.ts
git commit -m "feat(handoff): hard-fail when docs validation fails"
```

---

### Task 3: Branch policy — keep-current + create only from develop

**Files:**
- Create: `scripts/lib/ensure-develop-base.sh`
- Modify: `scripts/branch/setup-branch.sh`
- Create: `scripts/lib/resolve-docs-branch.sh` (or extend `resolve-handoff-branch.sh` with mode)
- Modify: `src/legacy/branch-resolve.js` + `cursor/mcp/lib/branch-resolve.js`
- Modify: `src/tools/sdd.ts` / `src/tools/repo.ts` as needed for `workflow_docs_branch`
- Modify: `cursor/mcp/server.js`
- Create/Modify: `test/repo.test.ts` (branch cases) and/or `test/branch-policy.test.ts`
- Modify: `templates/superpowers-doc-contract.md` (docs must use tool-returned branch)

**Interfaces:**
- Produces: `workflow_docs_branch` → `{ branch, action: "keep"|"create_from_develop", current_branch, base: "develop" }`
- Produces: `workflow_branch_setup` creates new branches only after fetch/ff `develop`; from `main|master` switches to develop first; errors if `origin/develop` missing
- Produces: keep-current when HEAD already `feature|bugfix` (docs writers write returned `branch`)

- [ ] **Step 1: Write failing branch-policy tests**

```typescript
// test/branch-policy.test.ts — outline
// 1) repo on feature/x + docs declaring feature/x → docs_branch action keep, branch feature/x
// 2) repo on main without origin/develop → setup/create errors with develop missing
// 3) repo with origin/develop, HEAD main, setup target feature/y → ends on feature/y whose merge-base is develop tip (not main-only commit)
// 4) creating feature/y must not use `git checkout -b` while HEAD is main
```

Use temp git repos with a bare remote containing `develop` and `main`, as existing `test/repo.test.ts` patterns do.

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test test/branch-policy.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `ensure-develop-base.sh`**

```bash
#!/usr/bin/env bash
# Ensure local develop tracks origin/develop and is fast-forwarded. Never use main as base.
set -euo pipefail
git fetch origin develop --prune
if ! git show-ref --verify --quiet refs/remotes/origin/develop; then
  echo 'ERROR: origin/develop missing — create and push develop before branching' >&2
  exit 1
fi
if git show-ref --verify --quiet refs/heads/develop; then
  git checkout develop
  git merge --ff-only origin/develop
else
  git checkout -b develop --track origin/develop
fi
```

- [ ] **Step 4: Change `setup-branch.sh` create path**

When `TARGET` does not exist locally:
1. Record whether working tree is dirty / stash as today.
2. Call `ensure-develop-base.sh` (must leave HEAD on `develop`).
3. `git checkout -b "$TARGET"` from that develop tip.
4. Write manifest as today.

When `TARGET` exists: checkout target as today (no rebased recreate).

Never `git checkout -b "$TARGET"` while HEAD is `main`/`master`.

- [ ] **Step 5: Add `workflow_docs_branch`**

Script `resolve-docs-branch.sh`:
- HEAD matches `feature|bugfix` → JSON `{branch:HEAD, action:"keep", current_branch:HEAD}`
- HEAD `develop|main|master` → require `kind`+`slug` args (or derive slug), return `{branch:"$kind/$slug", action:"create_from_develop", current_branch:HEAD, base:"develop"}`
- else error

Expose as OpenCode + Cursor tool. Update `templates/superpowers-doc-contract.md`:

```markdown
Before writing **Branch:** into a new spec/plan, call `workflow_docs_branch`.
Write the returned `branch` verbatim. When `action` is `create_from_develop`, create it later only via `workflow_branch_setup` (which bases on develop).
```

- [ ] **Step 6: Tests PASS + commit**

Run: `bun test test/branch-policy.test.ts test/repo.test.ts`
```bash
git add scripts/lib/ensure-develop-base.sh scripts/branch/setup-branch.sh scripts/lib/resolve-docs-branch.sh src/legacy/branch-resolve.js cursor/mcp/lib/branch-resolve.js src/tools templates/superpowers-doc-contract.md test/branch-policy.test.ts cursor/mcp/server.js
git commit -m "feat(branch): keep feature branches; create only from develop"
```

---

### Task 4: Command templates — no empty `Arguments:`

**Files:**
- Modify: every file under `commands/wf-*.md`
- Modify: `src/plugin.ts` (if registration must strip/normalize)
- Modify: `test/contracts.test.ts`
- Modify: `test/handoff.test.ts` fixtures that currently use `"Load the wf-handoff skill and follow it. Arguments:"` — update expectations to the new prompt shape

**Interfaces:**
- Produces: command text `Load the wf-<name> skill and follow it.` with no `Arguments:` suffix when OpenCode expands empty `$ARGUMENTS`
- When user supplies args, OpenCode still appends them; prefer template:

```text
Load the wf-handoff skill and follow it.
$ARGUMENTS
```

So an empty expansion leaves at most a blank line, never `Arguments:`.

- [ ] **Step 1: Write failing contract test**

```typescript
test("wf commands never emit a bare Arguments: label", () => {
  const dir = path.join(import.meta.dir, "..", "commands");
  for (const file of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, file), "utf8");
    expect(text).not.toMatch(/Arguments:\s*\$ARGUMENTS/);
    expect(text).not.toMatch(/Arguments:\s*$/m);
  }
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test test/contracts.test.ts`
Expected: FAIL on `Arguments: $ARGUMENTS`

- [ ] **Step 3: Rewrite all `commands/wf-*.md`**

Each file becomes exactly two lines (or one if no args placeholder needed):

```text
Load the wf-NAME skill and follow it.
$ARGUMENTS
```

Update handoff tests that assert the old `"Arguments:"` string to assert the new load line instead.

- [ ] **Step 4: Tests PASS + commit**

Run: `bun test test/contracts.test.ts test/handoff.test.ts`
```bash
git add commands test/contracts.test.ts test/handoff.test.ts
git commit -m "fix(commands): drop empty Arguments: suffix from wf prompts"
```

---

### Task 5: Post-plan choice override (both platforms)

**Files:**
- Modify: `templates/superpowers-doc-contract.md`
- Modify: `src/bootstrap.ts`
- Modify: `cursor/rules/ask-question-only.mdc`
- Modify: `cursor/hooks/session-start` (if it inlines plan-execution copy — keep consistent)
- Modify: `test/contracts.test.ts`
- Modify: `cursor/mcp/test/regressions.test.js` (assert rule text)

**Interfaces:**
- Produces: fixed five options after plan save + validate; forbids Superpowers “Two execution options” in toolkit overrides

- [ ] **Step 1: Failing contract assertions**

```typescript
test("post-plan override lists five fixed options and forbids two-option prose", () => {
  const surfaces = [
    readFileSync(path.join(import.meta.dir, "..", "templates", "superpowers-doc-contract.md"), "utf8"),
    readFileSync(path.join(import.meta.dir, "..", "src", "bootstrap.ts"), "utf8"),
    readFileSync(path.join(import.meta.dir, "..", "cursor", "rules", "ask-question-only.mdc"), "utf8"),
  ].join("\n");
  for (const label of [
    "Subagent-driven",
    "Inline",
    "Handoff",
    "Review spec first",
    "Review plan first",
  ]) {
    expect(surfaces).toContain(label);
  }
  expect(surfaces).not.toContain("Two execution options");
  expect(surfaces).not.toContain("--stay"); // post-plan menu must not offer stay
  expect(surfaces).toContain("workflow_docs_validate");
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Update contract + Cursor rule + bootstrap**

Add a dedicated section to `templates/superpowers-doc-contract.md`:

```markdown
## Post-plan execution choice

After saving a plan, call `workflow_docs_validate` on the spec/plan pair. On failure, stop and fix docs — do not offer execution.

On success, use native `question` / Cursor `AskQuestion` with exactly these options (no stay, no A/B/C prose duplicate):

1. Subagent-driven → load `wf-implement`
2. Inline → execute in this session
3. Handoff → load `wf-handoff` (new session only)
4. Review spec first
5. Review plan first

Never emit Superpowers text beginning “Two execution options”.
```

Update `cursor/rules/ask-question-only.mdc` Superpowers override section to the same five options (replace stale `plan_execution` / handoff-stay wording). Mirror a HARD-GATE line in `src/bootstrap.ts`.

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "fix(contract): post-plan five-option choice with validate gate"
```

---

### Task 6: Review-loop caps + end-of-implement advisory roll-up

**Files:**
- Modify: `skills/wf-implement/SKILL.md`
- Modify: `cursor/skills/wf-implement/SKILL.md`
- Modify: `templates/execution-contract.md`
- Modify: `test/contracts.test.ts`
- Optional create: `templates/doc-review-calibration.md` only if needed to keep prompts DRY — prefer editing existing skill/contract text first (YAGNI)

**Interfaces:**
- Produces: max two blocker review rounds; advisories never pause loop; after final verify, present advisory roll-up via native question

- [ ] **Step 1: Failing contract test**

Assert OpenCode implement skill + execution-contract contain:
- `max 2` or `at most two` blocker review rounds
- `Critical` / `Important` / `spec-compliance` as blockers
- `advisory` accumulated / not pausing the loop
- end roll-up after implementation / final verify before addressing Minor/style/YAGNI

Assert Cursor `cursor/skills/wf-implement/SKILL.md` contains the same policy (or explicitly defers to execution-contract loaded verbatim).

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Rewrite review sections**

Replace “repeat both reviews until clean” with:

```markdown
Blocking findings: Critical, Important, or spec-compliance. At most two fix+re-review rounds per task.
Advisory findings: Minor, style, YAGNI, taste — never pause the loop; append to `<SDD_DIR>/advisories.md` (create if missing) with task id + text.
After all tasks and `workflow_verify`, present the full advisories file once and use native question to choose which items to fix, discuss, or discard. Do not auto-fix advisories.
Further blocker rounds only if the user explicitly requests another pass.
```

Mirror in Cursor implement skill / ensure contract load picks it up.

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "fix(implement): cap blocker reviews and defer advisories to end"
```

---

### Task 7: PR show-before-create + implement validate preflight

**Files:**
- Modify: `skills/wf-pr/SKILL.md`
- Modify: `cursor/skills/wf-pr/SKILL.md`
- Modify: `skills/wf-implement/SKILL.md`
- Modify: `cursor/skills/wf-implement/SKILL.md`
- Modify: `templates/execution-contract.md` (setup step 0: validate)
- Modify: `src/tools/sdd.ts` (`workflow_sdd_context` and/or `workflow_plan_tasks` call validate when spec+plan known)
- Modify: `test/contracts.test.ts`
- Modify: `cursor/mcp/test/regressions.test.js`
- Modify: `test/sdd.test.ts` (context fails on bad docs)

**Interfaces:**
- Produces: PR skills ordered draft→show→confirm→create
- Produces: implement/sdd context hard-fails when validate fails

- [ ] **Step 1: Failing contracts**

```typescript
test("PR skills show title and body before create confirmation", () => {
  for (const file of [
    path.join(import.meta.dir, "..", "skills", "wf-pr", "SKILL.md"),
    path.join(import.meta.dir, "..", "cursor", "skills", "wf-pr", "SKILL.md"),
  ]) {
    const text = readFileSync(file, "utf8");
    const showIdx = text.search(/Show title|\*\*Show\*\*|Title:\s*\n/i);
    const createQ = text.search(/Create the reviewed|create this MR\/PR|Create MR\/PR now/i);
    const createTool = text.indexOf("workflow_pr_create");
    expect(showIdx).toBeGreaterThanOrEqual(0);
    expect(createQ).toBeGreaterThan(showIdx);
    expect(createTool).toBeGreaterThan(createQ);
    expect(text).not.toMatch(/after you review the title and body\?[\s\S]{0,200}Step 3 — Draft/i);
  }
});
```

Add sdd test: broken plan → `workflow_sdd_context` / plan_tasks path returns `ok:false` mentioning validation.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Fix PR skills**

OpenCode `skills/wf-pr/SKILL.md` become:

```markdown
1. Load skill via `skill` tool.
2. `workflow_pr_context` then `workflow_verify`; draft title and body from facts.
3. Show the exact Title and Body in chat.
4. Native `question`: create the reviewed MR/PR? (allow custom edits in chat first)
5. Only after approval: `workflow_pr_create` with `confirmed: true` and reviewed fields.
```

Cursor skill: remove Step 2 AskQuestion-before-draft; reorder to gather → draft → show → AskQuestion create → tool. Keep provider/squash rules.

- [ ] **Step 4: Implement preflight validate**

In `workflow_sdd_context` (legacy `sdd-context.js` and OpenCode wrapper), after resolving spec/plan paths, run `docs-validate.sh`; on failure return `{ error: "..." }` without creating SDD dirs beyond what's already required — prefer fail before mutations.

Update execution-contract Setup to call `workflow_docs_validate` before todos/branch setup.

- [ ] **Step 5: PASS + commit**

```bash
git commit -m "fix(pr,implement): show PR before create; validate before SDD start"
```

---

### Task 8: Version bump + full check

**Files:**
- Modify: `package.json` (`0.3.19`)
- Modify: `cursor/.cursor-plugin/plugin.json` (`0.3.19`)
- Modify: `cursor/mcp/server.js` (`version: "0.3.19"`)
- Modify: `README.md` version table if it pins `0.3.18`

**Interfaces:**
- Produces: synchronized versions; green `bun run check`

- [ ] **Step 1: Failing version sync test already exists**

Run: `npm --prefix cursor/mcp test -- --test-name-pattern='versions are synchronized'`
Expected: FAIL once package.json bumped alone — use TDD by asserting desired version in a new/extended test expecting `0.3.19`, or bump all three together then run full check.

Preferred: update all three version strings, then run existing sync test expecting equality at `0.3.19`.

- [ ] **Step 2: Bump to 0.3.19 in all three manifests**

- [ ] **Step 3: Full gate**

Run: `bun run check`
Expected: all bun tests, `tsc`, and Cursor MCP regressions PASS

- [ ] **Step 4: Commit**

```bash
git add package.json cursor/.cursor-plugin/plugin.json cursor/mcp/server.js README.md
git commit -m "chore: release workflow-toolkit 0.3.19 deterministic gates"
```

---

## Spec coverage self-check

| Spec requirement | Task |
| --- | --- |
| `workflow_docs_validate` hard-fail | 1 |
| Handoff preflight validate | 2 |
| Keep feature/bugfix; create from develop; main→develop; missing develop errors | 3 |
| Empty Arguments: gone | 4 |
| Post-plan five options; no stay; no two-option prose | 5 |
| Max 2 blocker rounds; end advisory roll-up | 6 |
| PR show-before-create; implement validate | 7 |
| 0.3.19 + `bun run check` | 8 |
