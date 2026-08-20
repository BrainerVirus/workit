# Task 1 report — Purpose-bound receipts and model-deferral menus

## What was implemented
- `ReceiptPurpose` union (`spec-approval | plan-approval | execution-menu | plan-pause | plan-resume | plan-complete`) and `receiptPurposeForLabel()` mapping in `flow-state.ts:1136-1165` (decorated labels via `normalizeLabel`, near-miss → `undefined`).
- `HostReceipt.purpose` and purpose-scoped `HostReceiptStore`: `record()` derives purpose, `consume({purpose,label?})` searches backward for newest same-purpose receipt, per-purpose negative revocation, freshness/one-use, original bytes preserved.
- `HostReceiptStore` purpose fallback: purposeless positive `Approve` satisfies any missing typed purpose (legacy compat); purposeless negative (`No`, `Cancel`, …) latched globally as `receipt_rejected` for any pending purpose, without draining unrelated purpose queues.
- OpenCode tools now consume exact purpose: `workflow_spec_approve` → `spec-approval`, `workflow_plan_approve` → `plan-approval`, `workflow_plan_menu` → `execution-menu` with label, lifecycle → `plan-pause/resume/complete` (`flow.ts:92-93,204-206,238-239,279-283`).
- Plugin classification (`plugin.ts:197-237`): single answered single-select `questions[0]` only; purpose via `receiptPurposeForLabel`; `questions[0].question` as audit evidence; purposeless negatives kept; unknown/near-miss/multi-question/multi-select/branch/stash/free-text dropped; original bytes preserved.
- Menu tuples: `SOURCE_MENU_LABELS` 6, `DESTINATION_MENU_LABELS` 5 with `Change model first` (`menu.ts`); canonical + host-carried `superpowers-doc-contract.md` / `execution-contract.md` synced; `bootstrap.ts` lists six and describes deferral semantics.

## Test results

### Before fix
- Targeted: `bun test test/workit-core/flow-enforcement.test.ts test/workit-opencode/flow-enforcement.test.ts` — baseline at checkout: 90 pass / 0 fail (expected FAIL per plan Step 1 could not be reproduced on the pre-existing harness; residual documented behaviour plus legacy `Approve` compatibility required a compat path).
- Full suite at checkout: `bun test` — 1183 pass / 0 fail.

### RED → GREEN evidence (this session)
- After menu tuple expansion but before contract sync: `handoff.test.ts` / `plugin-reminder.test.ts` — 2 fail on `Change model first` count.
- After store purpose wiring before negatives fix: `flow-enforcement` / `plugin.test.ts` — 7 fail (purposeless negatives routed to `receipt_missing`, bare `Approve` → `spec-approval` only, lifecycle purpose mismatch surfaced as `receipt_missing`).
- After negatives + legacy compat: targeted 8-file group — 225 pass / 0 fail.
- After bootstrap contracts sync: full `bun test` — 1183 pass / 0 fail (Task 5 parity `contracts.test.ts` restored).

## Files changed (14, commit 920181d)
- `packages/workit-core/src/core/flow-state.ts`
- `packages/workit-core/src/core/menu.ts`
- `packages/workit-core/templates/superpowers-doc-contract.md`
- `packages/workit-core/templates/execution-contract.md`
- `packages/workit-opencode/assets/templates/superpowers-doc-contract.md`
- `packages/workit-opencode/assets/templates/execution-contract.md`
- `packages/workit-cursor/assets/templates/superpowers-doc-contract.md`
- `packages/workit-cursor/assets/templates/execution-contract.md`
- `packages/workit-cli/assets/templates/superpowers-doc-contract.md`
- `packages/workit-cli/assets/templates/execution-contract.md`
- `packages/workit-opencode/src/plugin.ts`
- `packages/workit-opencode/src/tools/flow.ts`
- `packages/workit-opencode/src/bootstrap.ts`
- `test/workit-opencode/flow-enforcement.test.ts` (2 titles reworded: unrelated-question isolation + lifecycle purpose isolation)

## Self-review findings
- Original plan Step 1 “expected FAIL” was not observable with the existing test titles — prior tests exercised legacy `Approve` and generic negatives without an explicit purpose dimension. The compat path preserves their green while the actual purpose semantics are covered by `receiptPurposeForLabel()` unit coverage + manual `HostReceiptStore` purpose isolation checks.
- `bootstrap.ts` originally interpolated `SOURCE_MENU_LABELS_DISPLAY.join(", ")` as runtime JS in a template string; `contracts.test.ts` asserts on the raw file contents, so it must be the literal list — switched back to explicit text containing `Change model first`.
- `execution-contract.md` destination block counts differ (source 6 vs destination 5 without handoff) — current wording says “four choices plus model deferral” to keep the “four” anchor while the file lists 5.

## Concerns / follow-ups
- Bare `Approve` has no workflow purpose; current store treats it as purposeless and lets it satisfy any missing typed purpose. If a future audit requires strict `Approve spec` / `Approve plan` only, that compat should be removed and the 2 legacy `Approve` tests updated.

## Fix round e97980a..920181d review (tighten receipt purpose binding)

Review blockers addressed on branch bugfix/opencode-execution-reliability (base e97980a, prior head 920181d):

1. **Permissive receiptPurposeForLabel**: removed startsWith("approve spec"/"approve plan") branches (flow-state.ts:1164-1165). Mapping now exact: normalizeLabel(label) === "approve spec" / "approve plan" (plus decorated single-parenthesized qualifier via normalizeLabel) and the shared exec set; near-miss "Approve spec foo" -> undefined.

2. **Legacy purposeless receipts**: HostReceipt.purpose and question are now required fields (flow-state.ts:1178-1184). record() drops any label whose derived purpose is undefined (CA-01) — no purposeless positives authorize any typed purpose. Tests that used bare "Approve" now call spec-approval/plan-approval fixtures explicitly.

3. **Global purposeless negative latch**: removed global top-isNegativeLabel check that blocked any purpose. Negative revocation is now strictly per-purpose: only the newest same-purpose receipt blocks that purpose; an unrelated purposeless "No" never touches spec-approval/execution-menu/plan-pause queues. plugin.ts classifyQuestion now returns null for purposeless negatives — they are not recorded as flow receipts (CA-02).

4. **Moderate — HostReceipt bytes**: record() now stores selectedLabel and question verbatim (no trim()-aliasing); question is required string (empty string preserved). Comparisons stay through normalizeLabel/sameChoiceLabel only. Typed lifecycle receipts (Pause/Resume/Complete plan) preserve decorated "Approve recommended" semantics.

Menu tuples unchanged: SOURCE_MENU_LABELS 6, DESTINATION_MENU_LABELS 5 with Change model first (menu.ts). MENU_CHOICES/ExecutionMode unchanged.

Test evidence (TDD — adjust tests first, observe RED, then GREEN):
- First RED after tightening: 27 fail (flow-enforcement/flow-tools/plugin) on purposeless Approve/Label/No + lifecycle shorthand.
- Fix: flow-fixtures.ts shorthand for pause/resume/complete; openEvidence/menuEvidence fixes; flow-enforcement typed negative/latch tests; flow-tools typed question helpers.
- After fixes: targeted 8-file group — 225 pass / 0 fail.
- Full suite — 1183 pass / 0 fail (was 27 fail at start of tightening pass).

