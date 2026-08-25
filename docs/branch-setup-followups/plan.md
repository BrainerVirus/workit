# Branch Setup Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/branch-setup-followups/spec.md`
**Branch:** `bugfix/branch-setup-hardening-followups`

**Goal:** Make the branch-setup mutation window diagnosable (journal), collision-proof (unique roots + GC), and documented (README).

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.
- The final task ends execution with `workit_plan_complete` (or the CLI `workit flow complete`) once the SDD ledger is complete and repository verification passes — a run never finishes while the plan is still `active`.
- No new runtime dependencies (CA-07); Node built-ins only.
- TDD mandatory for every behavior change; all new tests cross-platform safe (repo-local `core.autocrlf=false` in fixtures, no POSIX-only permission injection without a win32 guard — patterns already established in `test/workit-core/branch.test.ts`).

---

### Task 1: Mutation-window journal

**Files:**
- Modify: `packages/workit-core/src/core/branch.ts`
- Modify: `packages/workit-opencode/src/tools/repo.ts` (pass diagnostic logger)
- Modify: `packages/workit-cursor/mcp/server.ts` (pass logger equivalent, parity)
- Test: `test/workit-core/branch.test.ts`

**Interfaces:**
- Consumes: `branchSetup` from #78; plugin `setDiagnosticLogger` instance in repo.ts tool wrapper.
- Produces: optional `log?: (message: string) => void` on the `branchSetup` options object. All journal lines prefixed `flow-guard:`. When `log` is absent the function is byte-for-byte behaviorally identical to today.

- [ ] **Step 1: Write the failing tests**

```ts
test("CA-01: journal emits ordered checkpoints when a logger is injected", () => { /* collect lines via array fn; assert order + flow-guard: prefix */ });
test("CA-03: mid-window deletion is pinpointable between two adjacent checkpoints", () => { /* reuse post-checkout hook deletion pattern; assert journal shows present-before/missing-after adjacency */ });
test("absent logger preserves today's exact return values and side effects", () => { });
```

- [ ] **Step 2: Run to verify RED**

Run: `bun test test/workit-core/branch.test.ts`
Expected: FAIL — no `log` option / no journal lines.

- [ ] **Step 3: Minimal implementation**

Add `log?: (message: string) => void` to options; internal `journal = (m: string) => log?.(`flow-guard: ${m}`)`. Emit checkpoints at: entry (resolved target/base), after snapshot (count + per-file short hash), after stash push, immediately after checkout/create (re-stat each captured file: present/missing), before pop (reapply), after pop, after restore (restored-count/skipped). Wire repo.ts tool wrapper to pass `(m) => logger.info(m)` from the diagnostic logger; mirror in the Cursor MCP server for parity.

- [ ] **Step 4: Run to verify GREEN**

Run: `bun test test/workit-core/branch.test.ts && bunx tsc --noEmit`
Expected: PASS, types clean.

- [ ] **Step 5: Commit**

```bash
git add packages/workit-core/src/core/branch.ts packages/workit-opencode/src/tools/repo.ts packages/workit-cursor/mcp/server.ts test/workit-core/branch.test.ts
git commit -m "feat(branch): flow-guard journal across the mutation window"
```

---

### Task 2: Unique snapshot roots + stale GC

**Files:**
- Modify: `packages/workit-core/src/core/branch.ts`
- Test: `test/workit-core/branch.test.ts`

**Interfaces:**
- Consumes: `snapshotFlowState`/`restoreFlowSnapshot` from #78.
- Produces: unique-per-invocation roots (hash + pid + hrtime suffix); `purgeStaleFlowGuardRoots(now: number)` purging prefix-matched roots with mtime older than 24h, called at snapshot time.

- [ ] **Step 1: Write the failing tests**

```ts
test("CA-04: concurrent invocations get distinct roots and never corrupt each other", () => { });
test("CA-05: roots older than 24h are purged; fresh foreign roots survive", () => { });
```

- [ ] **Step 2: Run to verify RED**

Run: `bun test test/workit-core/branch.test.ts`
Expected: FAIL — roots currently deterministic per workspace.

- [ ] **Step 3: Minimal implementation**

Suffix root dir with `.${process.pid}.${process.hrtime.bigint()}`; export `purgeStaleFlowGuardRoots` scanning `tmpdir()` for the `workit-flow-guard-` prefix and `rmSync(..., { recursive: true, force: true })` when `mtimeMs < now - 24*3600_000`; call it inside `snapshotFlowState`. Restore must locate its own root via the returned path (already does).

- [ ] **Step 4: Run to verify GREEN**

Run: `bun test test/workit-core/branch.test.ts`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add packages/workit-core/src/core/branch.ts test/workit-core/branch.test.ts
git commit -m "fix(branch): unique flow-guard snapshot roots with 24h GC"
```

---

### Task 3: README + full verification

**Files:**
- Modify: `README.md` (workflow/branch-setup section)

**Interfaces:**
- Consumes: Tasks 1–2.

- [ ] **Step 1: README**

In the workflow section covering branch setup, append one paragraph documenting: failed setups restore the working tree and previous branch; `docs/*/sdd/flow.json` is snapshotted and restored if lost during mutations; successful results may carry `warnings` when automatic restoration was not possible; mutation windows emit `flow-guard:` diagnostics.

- [ ] **Step 2: Full verification**

Run: `bun run check` (expect exit 0; if the known wrapper-flaky typescript-parity trio appears, isolate-rerun and report both honestly). Run `workit_verify` (expected green baseline). Run `workit_docs_validate` on this spec/plan pair (ok expected).

- [ ] **Step 3: Commit and complete**

Commit tracked changes (`docs(branch-setup): document hardening and diagnostics`), append ledger lines for all tasks, call `workit_plan_complete`.

---
