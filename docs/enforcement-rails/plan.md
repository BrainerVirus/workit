# Enforcement Rails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/enforcement-rails/spec.md`
**Branch:** `feature/enforcement-rails`

**Goal:** Five per-turn rails (verification, TDD, brainstorm, debugging, receiving-review) mirroring the vendored superpowers Iron Laws — reminder+detector+hook, conservative, idempotent.

## Global Constraints

- Rail constants in `src/core/reminder.ts` alongside the existing five; wording mirrors the vendored skills (read them first: vendor/superpowers/skills/{verification-before-completion,test-driven-development,brainstorming,systematic-debugging,receiving-code-review}/SKILL.md).
- Detectors in `src/core/detector.ts` — assistant-text signals only, conservative (no-op over noise), no file reads.
- Hook in `src/plugin.ts` `chat.messages.transform` — distinct tags, idempotent, fail-closed, composes with existing rails.
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: Rail constants + detectors

- [ ] **Step 1:** `src/core/reminder.ts`: add `VERIFICATION_TEXT`, `TDD_TEXT`, `BRAINSTORM_TEXT`, `DEBUG_TEXT`, `REVIEW_RECEPTION_TEXT` (block style like the existing rails; each names the skill and carries its core rule — verification: no completion claim without fresh check evidence; TDD: write the test first, watch it fail; brainstorm: no implementation until a design is presented and approved; debugging: no fix without root-cause investigation; receiving: verify review feedback before implementing). Add `shouldInject*` helpers (marker-based idempotency).
- [ ] **Step 2:** `src/core/detector.ts`: five `detect*` fns on assistant text:
  - `detectVerificationClaim(text)`: claims done/fixed/passing/green/complete WITHOUT a check-command output in the same text (conservative: if the text contains "bun run check" or "workit_verify" or a command output block, do NOT fire).
  - `detectUntestedImplementation(text)`: implementation signals (edits/commits/diff) without a preceding failing-test mention ("failing test", "test failed", "watch it fail", "TDD").
  - `detectImplementationWithoutDesign(text)`: implementation signals without a design presentation ("design", "spec", "brainstorm", "approved").
  - `detectFixWithoutRootCause(text)`: fix proposal ("fixed", "fix", "patch") without root-cause evidence ("root cause", "caused by", "reproduced", "trace").
  - `detectBlindReviewAcceptance(text)`: review acceptance ("agreed", "makes sense", "will implement", "good point") without verification wording ("verified", "checked", "reproduced", "tested").
  Keep each as a simple regex/heuristic — conservative bias.
- [ ] **Step 3:** Tests `test/enforcement-rails.test.ts`: for each detector — canonical positive signal fires; clean message does NOT fire; the verification detector does NOT fire when a check command appears in the text; reminder texts contain the skill name + rule (CA-01, CA-02).

**Criteria:** CA-01, CA-02.

| Status | Task |
| --- | --- |
| pending | 1: Rail constants + detectors |

### Task 2: Hook injections + composition

- [ ] **Step 1:** `src/plugin.ts`: after the existing rails, five injection blocks — when `detectX(assistantText)` && `shouldInjectX(currentText)` → unshift with tags `"vf"`, `"tdd"`, `"br"`, `"db"`, `"rc"`. All inside the existing try/catch.
- [ ] **Step 2:** Tests in `test/plugin-reminder.test.ts` (or the rails test file): each rail fires once on its signal; absent signal → no injection; idempotent; multiple rails on one turn (compose 2-3 signals in one assistant text → all markers present, distinct ids); fail-closed (CA-03, CA-04).

**Criteria:** CA-03, CA-04.

| Status | Task |
| --- | --- |
| pending | 1: Rail constants + detectors |
| pending | 2: Hook injections + composition |

### Task 3: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (detector conservativeness, false-positive risk on real messages, wording vs vendored skills, tag distinctness, idempotency, fail-closed).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/enforcement-rails`, create PR, wait for CI (3 OS), merge, delete branch.

**Criteria:** Review findings addressed; CI pass on all 3 OS; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: Rail constants + detectors |
| pending | 2: Hook injections + composition |
| pending | 3: Final gate — review + PR |
