# Issue Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/issue-rail/spec.md`
**Branch:** `feature/issue-rail`

**Goal:** Post-hoc rail catching the instruction-labeled `question` option anti-pattern — detector + one-shot reminder.

## Global Constraints

- Detector in `src/core/detector.ts`, reminder in `src/core/reminder.ts`, hook in `src/plugin.ts` — same pattern as the enforcement rails.
- The detector inspects `question` TOOL-CALL input (the questions array), not prose — this is what distinguishes it from DETECTION_TEXT.
- Conservative regex (instruction verbs + free-text nouns), one constant for tuning.
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: Detector + reminder

- [ ] **Step 1:** `src/core/detector.ts`: `detectInstructionOption(questions: unknown): boolean` — accepts the question tool-call input (array or `{ questions: [...] }`); for each question, inspect `options[].label`; fire when any label matches the instruction pattern (conservative regex: `^(type|provide|paste|enter|write|give me)\b.*\b(url|id|issue|text|notes|number)\b` case-insensitive — version the regex as a named constant). Tolerate malformed input (null, non-array, missing options → false, no throw).
- [ ] **Step 2:** `src/core/reminder.ts`: `ISSUE_RAIL_TEXT` (`<workflow-issue-rail>` block) mirroring the skill's wording: a clickable `question` option whose label is an instruction (e.g. "Type the issue URL/ID") returns the label literal when clicked, not free text — ask for free text in prose with the custom answer field enabled. Add `shouldInjectIssueRail(currentText)` marker helper.
- [ ] **Step 3:** Tests `test/issue-rail.test.ts`: fires on "Type the issue URL/ID", "Provide the issue ID", "Paste the URL", "Enter the issue number"; does NOT fire on "Use IRPT-12", "Use session facts", "No time", "Skip", "Type my notes" (wait — "Type my notes" starts with Type but the noun is notes... decide and document: the pattern requires an instruction verb AND a free-text noun — "Type my notes" has notes → FIRES (it IS the anti-pattern); "Use IRPT-12" no). Malformed inputs (null, {}, [], missing options) → false no throw; CA-04 text assertion on the reminder.

**Criteria:** CA-01, CA-03, CA-04.

| Status | Task |
| --- | --- |
| pending | 1: Detector + reminder |

### Task 2: Hook injection

- [ ] **Step 1:** `src/plugin.ts`: in `chat.messages.transform`, after the enforcement rails — inspect the previous assistant message's parts for `tool === "question"` calls (the parts already available as `lastAssistant.parts`); for each, run `detectInstructionOption(part.input ?? part.state?.input)` (check the actual shape of question tool parts in the hook — the tool call part carries the input); if any fires && `shouldInjectIssueRail(currentText)` → unshift `ISSUE_RAIL_TEXT` with tag `"ir"`. In try/catch, idempotent.
- [ ] **Step 2:** Tests: extend `test/issue-rail.test.ts` (or plugin-reminder) — a mocked question part with an instruction option → shouldInjectIssueRail true; marker present → false; no question calls → false; malformed part → no crash (CA-02, CA-03).

**Criteria:** CA-02, CA-03.

| Status | Task |
| --- | --- |
| pending | 1: Detector + reminder |
| pending | 2: Hook injection |

### Task 3: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (regex conservativeness — false positives on real question options across the toolkit's own questions, part-shape handling, tag distinctness, idempotency).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/issue-rail`, create PR, wait for CI (3 OS), merge, delete branch.

**Criteria:** Review findings addressed; CI pass on all 3 OS; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: Detector + reminder |
| pending | 2: Hook injection |
| pending | 3: Final gate — review + PR |
