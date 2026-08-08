# Doc Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/doc-rendering/spec.md`
**Branch:** `feature/doc-rendering`

**Goal:** Docs are delivered rendered by default (markdown/mermaid/tables), raw only on explicit request, with an automatic size threshold that degrades to link + summary.

## Global Constraints

- Reuse the existing rail patterns: reminder constants in `src/core/reminder.ts`, detectors in `src/core/detector.ts`, hook in `src/plugin.ts` (try/catch, idempotent, fail-closed).
- Threshold constants live in a testable core module (e.g. `src/core/doc-render.ts`).
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: shouldRenderDoc threshold helper + reminder text

- [ ] **Step 1:** New `src/core/doc-render.ts`: `MAX_LINES = 150`, `MAX_BYTES = 8192`, `MAX_MERMAID = 3`; `shouldRenderDoc(text: string): boolean` — true only when ALL bounds within (line count ≤ 150, byte length ≤ 8192, mermaid fence count ≤ 3; count fences by regex `^```mermaid` lines). Empty text → true (nothing to render).
- [ ] **Step 2:** `src/core/reminder.ts`: add `DOC_RENDER_TEXT` (block style): by default deliver the full rendered markdown content of spec/plan (headings, tables, mermaid fences preserved, not a backtick-wrapped raw block); when the doc exceeds the size threshold (150 lines / 8KB / 3+ mermaid), deliver only the clickable link + 3-5 bullet summary; on explicit raw request ("raw"/"para copiar"), show the full fenced block. Add `shouldInjectDocRender(text)` helper (idempotency marker).
- [ ] **Step 3:** Tests `test/doc-render.test.ts`: threshold boundary cases (short doc → true; >150 lines → false; >8KB → false; 4 mermaid fences → false; empty → true), mermaid counting correctness, reminder text contains the three rules (render/threshold/raw).

**Criteria:** CA-01, CA-02, CA-03 (helper + text tests).

| Status | Task |
| --- | --- |
| pending | 1: shouldRenderDoc threshold helper + reminder text |

### Task 2: Hook injection + docs delivery rule update

- [ ] **Step 1:** `src/core/detector.ts`: add `detectDocDelivery(text): boolean` — true when the assistant text shows a doc being delivered as a raw block (e.g. contains a long fenced block starting with a doc path or `# Spec`/`# Plan` heading inside a fence) — OR reuse the simpler signal: the assistant already delivered a doc (backtick refs exist). Design decision: keep it minimal — detect when the assistant text contains `docs/<slug>/spec.md` or `plan.md` in a fenced raw block without the render marker. Document the choice in the code comment.
- [ ] **Step 2:** `src/plugin.ts` `chat.messages.transform`: after the DOC_DELIVERY_TEXT block, when `detectDocDelivery(assistantText)` is true and the current turn lacks the marker, unshift `DOC_RENDER_TEXT` (distinct tag `"dr"`). Idempotent, in try/catch.
- [ ] **Step 3:** Update `src/core/reminder.ts` `DOC_DELIVERY_TEXT` (or add a note in DOC_RENDER_TEXT) so the two rails compose: clickable link always + render-by-default + threshold + raw escape.
- [ ] **Step 4:** Tests in `test/plugin-reminder.test.ts` (or doc-render test): marker present → injected once; absent → no inject; idempotent; fail-closed on empty env.

**Criteria:** CA-03, CA-04.

| Status | Task |
| --- | --- |
| pending | 1: shouldRenderDoc threshold helper + reminder text |
| pending | 2: Hook injection + docs delivery rule update |

### Task 3: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (threshold semantics, mermaid counting, reminder wording, hook wiring, no regression on DOC_DELIVERY_TEXT).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/doc-rendering`, create PR, wait for CI (3 OS), merge, delete branch.

**Criteria:** Review findings addressed; CI pass on all 3 OS; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: shouldRenderDoc threshold helper + reminder text |
| pending | 2: Hook injection + docs delivery rule update |
| pending | 3: Final gate — review + PR |
