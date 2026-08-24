# Branch Setup Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/branch-setup-hardening/spec.md`
**Branch:** `bugfix/branch-setup-hardening`

**Goal:** Make `branchSetup` failure-safe (no stranded stashes) and flow-state-loss-proof (snapshot/restore of `docs/*/sdd/flow.json` across stash/checkout mutations).

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.
- The final task ends execution with `workit_plan_complete` (or the CLI `workit flow complete`) once the SDD ledger is complete and repository verification passes — a run never finishes while the plan is still `active`.
- No new runtime dependencies anywhere (CA-06); Node built-ins and existing deps only.
- TDD is mandatory for every behavior change: failing check first, minimal implementation, passing focused check.

---

### Task 1: Failure-safe setup (no stranded stashes)

**Files:**
- Modify: `packages/workit-core/src/core/branch.ts`
- Test: `test/workit-core/branch.test.ts` (extend the existing suite file that covers `branchSetup`; locate it via `grep -rl branchSetup test/`)

**Interfaces:**
- Consumes: existing `branchSetup({action, sdd_dir, target_branch, stash, workspace_root})` signature — unchanged.
- Produces: identical return shapes; only failure-path behavior changes per CA-01/CA-02.

- [ ] **Step 1: Write the failing tests**

Two regression cases in the existing `branchSetup` describe block:

```ts
test("failed base resolution after stash leaves tree intact (no stranded stash)", () => { /* CA-01 */ });
test("policy/base resolution runs before any stash push", () => { /* CA-02 */ });
```

Fixture shape: temp repo cloned from a bare origin whose only branch is `main`, with a workspace/VCS configuration that makes `baseBranch` resolve to a missing remote branch (e.g. `develop`) so `ensureBaseBranch` fails late — mirror however existing tests in this file isolate workspace policy resolution (reuse their established mocking/fixture pattern; do not invent a new one). Dirty the tree with a tracked modification plus one untracked doc file before calling `branchSetup({ action: "setup", target_branch: "bugfix/x", stash: "yes" })`.

Assertions: result contains the structured error; `git stash list` is empty; the tracked modification is present again in the working tree; the untracked file survived.

- [ ] **Step 2: Run to verify RED**

Run: `bun test test/workit-core/branch.test.ts`
Expected: FAIL — currently the stash stays stranded and the manifest is never written.

- [ ] **Step 3: Minimal implementation**

In `packages/workit-core/src/core/branch.ts` inside `branchSetup`:
1. Hoist base resolution (`baseBranch(cwd)` + `ensureBaseBranch(cwd, base)` when the target branch does not exist) to BEFORE the dirty/stash block, so resolution failures return before any mutation (CA-02).
2. After any successful stash push, wrap every remaining fallible step so an error path performs best-effort `git stash pop <ref>` (restoring the tree) before returning `{ error }` (CA-01); clear `stash_ref` after a successful pop.
3. Keep the success path byte-for-byte compatible with today's manifest write.

- [ ] **Step 4: Run to verify GREEN**

Run: `bun test test/workit-core/branch.test.ts`
Expected: PASS including both new cases and all pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add packages/workit-core/src/core/branch.ts test/workit-core/branch.test.ts
git commit -m "fix(branch): leave working tree intact when setup fails after stash"
```

| Status | Task |
| --- | --- |
| pending | 1: Failure-safe setup |

---

### Task 2: Flow-state snapshot/restore around mutations

**Files:**
- Modify: `packages/workit-core/src/core/branch.ts`
- Test: `test/workit-core/branch.test.ts`

**Interfaces:**
- Consumes: `branchSetup` mutation points identified in Task 1.
- Produces: internal helpers (exported for tests) `snapshotFlowState(cwd: string): string` returning the snapshot dir, and `restoreFlowSnapshot(snapDir: string, cwd: string): void` implementing restore-if-missing per CA-03/CA-04/CA-05. `setup` snapshots before the stash push and restores+cleans after the successful checkout; `reapply_stash` snapshots before `stash pop` and restores+cleans after it.

- [ ] **Step 1: Write the failing tests**

Unit-level cases against the exported helpers (fixtures built with `fs` directly):

```ts
test("snapshot captures every docs/*/sdd/flow.json outside the repository", () => { /* CA-03, CA-05 */ });
test("restore recreates missing flow.json byte-identical and never overwrites newer files", () => { /* CA-04 */ });
```

Integration wiring case: run `branchSetup` `setup(stash=yes)` on a fixture containing a committed `.gitignore` (`docs/*/sdd/`), an approved-shaped `docs/<slug>/sdd/flow.json`, and untracked spec docs; assert after setup that `flow.json` is byte-identical (CA-03) and no snapshot directory remains under the OS tempdir prefix `workit-flow-guard-`.

- [ ] **Step 2: Run to verify RED**

Run: `bun test test/workit-core/branch.test.ts`
Expected: FAIL — helpers do not exist / wiring absent.

- [ ] **Step 3: Minimal implementation**

In `packages/workit-core/src/core/branch.ts`:
1. `snapshotFlowState`: scan `<cwd>/docs/*/sdd/flow.json`, copy each into `${tmpdir()}/workit-flow-guard-${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16)}/<relative path>` preserving directory structure; return the snapshot root. Missing dirs → snapshot of zero files still returns the root.
2. `restoreFlowSnapshot`: walk snapshot root; for each captured file, create parent dirs and write ONLY if the working-tree counterpart is absent; then remove the snapshot root (CA-04). On restore failure keep the snapshot root (retained-on-failure).
3. Wire: `setup` calls snapshot before the stash push and restore after the successful checkout/manifest write; `reapply_stash` calls snapshot before `stash pop` and restore after it (D-03).

- [ ] **Step 4: Run to verify GREEN**

Run: `bun test test/workit-core/branch.test.ts`
Expected: PASS (new + pre-existing cases).

- [ ] **Step 5: Commit**

```bash
git add packages/workit-core/src/core/branch.ts test/workit-core/branch.test.ts
git commit -m "fix(branch): guard SDD flow state across stash and checkout windows"
```

| Status | Task |
| --- | --- |
| pending | 2: Flow-state snapshot/restore |

---

### Task 3: Document and verify

**Files:**
- Modify: `CHANGELOG.md` (Unreleased)

**Interfaces:**
- Consumes: completed Tasks 1–2.

- [ ] **Step 1: CHANGELOG**

Under `## [Unreleased]` add a `### Fixed` section entry:

"- Branch setup no longer strands the pre-checkout stash when base/checkout resolution fails — the working tree is restored exactly as it was. SDD flow state (`docs/*/sdd/flow.json`) is snapshotted before stash/checkout mutations and restored if lost."

- [ ] **Step 2: Full local verification**

Run: `bun run check`
Expected: build, lint, format, full suite, typecheck — all exit 0.

- [ ] **Step 3: Repository verification**

Run: `workit_verify` — expected green per project baseline. Run `workit_docs_validate` on this spec/plan pair — expected ok, no quality findings.

- [ ] **Step 4: Commit and complete**

Commit any tracked verification artifacts as this task's non-empty range (`chore(branch): document setup hardening`), append ledger lines for all tasks, then call `workit_plan_complete`. Expected final execution status: `completed`.

| Status | Task |
| --- | --- |
| pending | 3: Document and verify |
