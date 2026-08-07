# Spec: Per-turn contract enforcement — reminders + post-hoc detection

**Branch:** `feature/contract-enforcement`

## Context

The toolkit contract is injected once, on the first user turn, via `experimental.chat.messages.transform` (plugin.ts). It is prose, and models can ignore prose on later turns. Concretely, the agent presented bounded choices (1/2/3 in markdown) for the agent-browser/lazy-chrome decision while the HARD-GATE "Use OpenCode's native `question` for every bounded user choice" was present in context and the `question` tool was available. The failure was agent discipline, not infrastructure — but prose-only gates cannot be relied on.

Goal: make contract compliance structural, not just textual: (1) re-inject a compact reminder of the key gates on every user turn; (2) detect post-hoc prose-choice patterns in the assistant's last message and inject a correction into the next turn.

## Goals

1. **Per-turn reminder**: `chat.messages.transform` injects a compact `<workflow-contract-reminder>` block on every user turn (not just the first). Content: bounded choices → native `question`; post-plan menu → native question with the 5 options; `confirmed` tools → call the tool, never invent results. ~100 tokens.
2. **Post-hoc detection + correction**: scan the assistant's last message for clear prose-choice patterns (`A)`, `B)`, `C)` or `1.`, `2.`, `3.` with ≥2 options + interrogative context). If detected and the turn contains no `question`-tool result, inject a `<workflow-detection>` correction into the next input.
3. **Idempotent**: never duplicate the reminder if already present; never double-inject corrections for the same detection.
4. **Low false positives**: the detector requires ≥2 same-prefix options + interrogative phrase (`?`, "which", "choose", "want", "prefer") — plain lists (e.g. "consider these three things") do not match.
5. **Configurable**: the reminder text is derived from the canonical rules (Spec 6) + the repo contract, so users can override lines via `~/.config/workflow-toolkit/rules/`.
6. Works in OpenCode (this hook set). Cursor gets the same reminder via its session-start hook text (prose) — the detection hook is OpenCode-only (Cursor has no equivalent output hook); note this asymmetry.

## Non-goals

- Hard enforcement (blocking/replacing model output) — rejected: opencode has no reliable output-intercept hook and it risks breaking legitimate responses.
- Detecting every contract violation (only bounded-choice prose patterns; the highest-impact case).
- Cursor-side detection (no hook equivalent).

## Architecture

### 1. Per-turn reminder injection (plugin.ts, `chat.messages.transform`)

The existing hook already runs on every user turn (it currently checks `isWorkflowBootstrap` to inject once). Extend it:

- Keep the full bootstrap on the first turn (existing behavior).
- On every turn, ensure a compact reminder block is present at the top of the first user part (unless the same reminder text is already present in that part — idempotent).

Reminder text (compiled from repo + user canonical rules; default):

```markdown
<workflow-contract-reminder>
- Bounded user choices → call the native `question` tool (never A/B/C or 1/2/3 lists in prose).
- After a plan is approved → native `question` menu with exactly: Subagent-driven, Inline, Handoff (new session only), Review spec first, Review plan first.
- Tools with `confirmed` → call them; never fabricate their result.
</workflow-contract-reminder>
```

### 2. Post-hoc detection (plugin.ts, same hook or `chat.message`)

Inspect the last assistant message in the incoming messages array:

- Extract its text parts.
- Detect prose-choice pattern: ≥2 lines starting with the same prefix from `[A-Da-d][.)]` or `\d+[.)]`, AND the message contains an interrogative (`?`, "which", "choose", "want", "prefer").
- If detected AND no `part.type === "tool"` with `tool === "question"` exists in that message → set a flag.
- Inject the correction into the next user part (once; reset after injection).

Correction text:

```markdown
<workflow-detection>
Your previous message presented choices as a numbered/bulleted list in prose.
That is a bounded user choice — use the native `question` tool instead (re-ask with `question` if still relevant).
</workflow-detection>
```

### 3. Detector module (`src/core/detector.ts`)

Pure, testable function:

```typescript
export type Detection = { choices: string[]; pattern: "alpha" | "numeric" } | null;
export const detectProseChoices(text: string): Detection;
```

- `alpha`: `/^[A-Da-d][.)]\s/` lines, ≥2 distinct letters, consecutive from A/a.
- `numeric`: `/^\d+[.)]\s/` lines, ≥2, consecutive from 1.
- Interrogative: `/[?¿]|which|choose|want|prefer/i` anywhere in the text.
- Also detect the wrapper style "¿Quieres que: 1. ... 2. ... 3. ..." (interrogative + numeric list).

### 4. Wiring

- `src/plugin.ts`: `chat.messages.transform` gains reminder injection + detection (both idempotent).
- `src/bootstrap.ts`: unchanged (full contract still first turn).
- Rules override: `compiledOpenCodeSections()` (Spec 6) feeds lines into the reminder; user rules can append/override reminder lines by name (e.g. a rule named `contract-reminder` replaces the default block).

## Data flow

1. Turn N: user sends message → hook runs → reminder present (if absent) + detection from assistant message at turn N-1 (if any) → both injected.
2. Model receives user part with reminder (+ correction when detected).
3. Model calls `question` tool for bounded choices (reminder enforces); if it still emits prose choices, turn N+1's detection fires again.

## Error handling

- Reminder/detection injection must never throw (wrap in try/catch; on error, fall back to no-op).
- Duplicate injection: guard by string-includes before injecting.
- Empty assistant text: no detection.
- Detector false positive mitigation: interrogative requirement + consecutive prefix requirement.

## Verification

- Detector tests: matches "A) x B) y C) z", "1. a 2. b", "¿Quieres que: 1. x 2. y"; does not match plain lists ("three considerations: a, b, c"), single option, non-consecutive prefixes.
- Hook tests: reminder present on turn 2+ (not duplicated); detection injects once and resets; first-turn full bootstrap still present.
- Regression: existing plugin/bootstrap tests green.
- `bun run check` green.

## Compatibility

- Existing sessions unaffected (reminder is additive, small).
- Cursor: reminder text is added to the session-start hook context (one line); detection is OpenCode-only (documented asymmetry).
- User rules can override the reminder (Spec 6 mechanism).

## Out of scope (tracked separately)

- Hard output enforcement.
- Detection of other contract violations.
- Cursor-side detection.
