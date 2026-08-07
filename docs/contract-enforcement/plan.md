# Contract Enforcement — Per-turn Reminders + Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/contract-enforcement/spec.md`
**Branch:** `feature/contract-enforcement`

**Goal:** Make contract compliance structural: inject a compact reminder of the key gates on every user turn, and detect post-hoc prose-choice patterns in the assistant's last message with a correction injected into the next turn.

**Architecture:** A pure `src/core/detector.ts` (regex-based, tested) detects prose choices. `src/plugin.ts` `chat.messages.transform` gains two idempotent injections: the per-turn reminder (compiled from the contract + user rules) and the detection correction (reset after use). The existing first-turn bootstrap stays.

**Tech Stack:** TypeScript + zod (existing), `bun test`, existing plugin hook patterns. No new dependencies.

## Global Constraints

- Reminder text ~100 tokens; injected at the top of the first user part on every turn unless already present.
- Detector: ≥2 same-prefix choices (`[A-Da-d][.)]` or `\d+[.)]`, consecutive) AND interrogative (`?`, `¿`, which/choose/want/prefer) → match; else no match.
- Detection correction injected once per detected message; reset after injection.
- Never throw from the hook (try/catch → no-op).
- First-turn full bootstrap unchanged.
- `bun run check` green. Version stays `0.4.0`.

---

### Task 1: `src/core/detector.ts` — prose-choice detector

**Files:**
- Create: `src/core/detector.ts`
- Test: `test/detector.test.ts`

**Interfaces:**
- Produces:
  - `type Detection = { choices: string[]; pattern: "alpha" | "numeric" } | null`
  - `detectProseChoices(text: string): Detection`

- [ ] **Step 1: Write the failing test**

Create `test/detector.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { detectProseChoices } from "../src/core/detector";

test("detects alpha choices with interrogative", () => {
  const d = detectProseChoices("A) install agent-browser\nB) configure lazy chrome\nC) both\nWhich one?");
  expect(d).not.toBeNull();
  if (d) {
    expect(d.pattern).toBe("alpha");
    expect(d.choices.length).toBe(3);
  }
});

test("detects numeric choices", () => {
  const d = detectProseChoices("1. Install\n2. Configure\n3. Both\nChoose one.");
  expect(d).not.toBeNull();
  if (d) expect(d.pattern).toBe("numeric");
});

test("detects the exact failure wrapper style", () => {
  const d = detectProseChoices("¿Quieres que:\n1. instale agent-browser\n2. configure lazy\n3. ambas?");
  expect(d).not.toBeNull();
  if (d) expect(d.pattern).toBe("numeric");
});

test("does not match a plain list without interrogative", () => {
  expect(detectProseChoices("Three considerations: a, b, c.")).toBeNull();
});

test("does not match a single option", () => {
  expect(detectProseChoices("Option A is best.")).toBeNull();
});

test("does not match non-consecutive prefixes", () => {
  expect(detectProseChoices("A) first\nD) fourth\nChoose?")).toBeNull();
});

test("does not match an ordinary sentence with numbers", () => {
  expect(detectProseChoices("We shipped 3 fixes today.")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/detector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/detector.ts`**

```typescript
export type Detection = { choices: string[]; pattern: "alpha" | "numeric" } | null;

const INTERROGATIVE = /[?¿]|which|choose|want|prefer/i;

export const detectProseChoices = (text: string): Detection => {
  if (!INTERROGATIVE.test(text)) return null;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const alpha = lines
    .map((l) => /^([a-dA-D])[.)]\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ letter: m[1].toLowerCase(), choice: m[2] }));

  if (alpha.length >= 2) {
    const letters = alpha.map((a) => a.letter);
    const expected = ["a", "b", "c", "d"].slice(0, alpha.length);
    if (letters.every((l, i) => l === expected[i])) {
      return { choices: alpha.map((a) => a.choice), pattern: "alpha" };
    }
  }

  const numeric = lines
    .map((l) => /^(\d+)[.)]\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ num: Number(m[1]), choice: m[2] }));

  if (numeric.length >= 2) {
    const nums = numeric.map((n) => n.num);
    if (nums.every((n, i) => n === i + 1)) {
      return { choices: numeric.map((n) => n.choice), pattern: "numeric" };
    }
  }

  return null;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/detector.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/detector.ts test/detector.test.ts
git commit -m "feat(core): prose-choice detector for bounded-choice enforcement"
```

---

### Task 2: Per-turn reminder + detection wiring in the plugin hook

**Files:**
- Modify: `src/plugin.ts` (`chat.messages.transform` gains reminder + detection)
- Modify: `src/core/rules.ts` or new `src/core/reminder.ts` (reminder text source)
- Test: `test/enforcement-hook.test.ts`

**Interfaces:**
- Consumes: `detectProseChoices` (Task 1), existing `getWorkflowBootstrap`
- Produces:
  - `REMINDER_TEXT` constant (or compiled from rules): the compact gate reminder
  - Hook behavior: on every turn, ensure reminder in first user part; detect prose choices in last assistant message → inject `<workflow-detection>` correction (once, then reset)

- [ ] **Step 1: Write the failing test**

Create `test/enforcement-hook.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../src/plugin";
import { REMINDER_TEXT } from "../src/core/reminder";
import { detectProseChoices } from "../src/core/detector";

const userMessage = (text: string) => ({
  info: { role: "user" as const, id: "u", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [{ type: "text" as const, text, id: "p", messageID: "u", sessionID: "s", time: { created: 0, updated: 0 } }],
});

const assistantMessage = (text: string) => ({
  info: { role: "assistant" as const, id: "a", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [{ type: "text" as const, text, id: "p", messageID: "a", sessionID: "s", time: { created: 0, updated: 0 } }],
});

test("reminder is injected on every user turn (not duplicated)", async () => {
  const hooks = await plugin({ directory: "/repo", worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
  const output = { messages: [userMessage("hello")] };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const firstText = output.messages[0].parts.find((p: any) => p.type === "text")!.text;
  expect(firstText).toContain(REMINDER_TEXT);

  // second turn: not duplicated
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const parts = output.messages[0].parts.filter((p: any) => p.type === "text");
  expect(parts.length).toBe(1);
});

test("detection injects correction when assistant used prose choices", async () => {
  const hooks = await plugin({ directory: "/repo", worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
  const output = {
    messages: [
      assistantMessage("1. install\n2. configure\n3. both\nWhich one?"),
      userMessage("continue"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const userText = output.messages[1].parts.find((p: any) => p.type === "text")!.text;
  expect(userText).toContain("workflow-detection");
});

test("no correction when assistant did not use prose choices", async () => {
  const hooks = await plugin({ directory: "/repo", worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
  const output = {
    messages: [
      assistantMessage("I updated the config."),
      userMessage("continue"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const userText = output.messages[1].parts.find((p: any) => p.type === "text")!.text;
  expect(userText).not.toContain("workflow-detection");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/enforcement-hook.test.ts`
Expected: FAIL — `REMINDER_TEXT` not exported; hook not injecting.

- [ ] **Step 3: Create `src/core/reminder.ts`**

```typescript
export const REMINDER_TEXT = `<workflow-contract-reminder>
- Bounded user choices → call the native \`question\` tool (never A/B/C or 1/2/3 lists in prose).
- After a plan is approved → native \`question\` menu with exactly: Subagent-driven, Inline, Handoff (new session only), Review spec first, Review plan first.
- Tools with \`confirmed\` → call them; never fabricate their result.
</workflow-contract-reminder>`;

export const DETECTION_TEXT = `<workflow-detection>
Your previous message presented choices as a numbered/bulleted list in prose.
That is a bounded user choice — use the native \`question\` tool instead (re-ask with \`question\` if still relevant).
</workflow-detection>`;
```

- [ ] **Step 4: Extend `chat.messages.transform` in `src/plugin.ts`**

Replace the existing hook body with:

```typescript
"experimental.chat.messages.transform": async (_input, output) => {
  try {
    if (!output.messages.length) return;

    // First turn: full bootstrap (existing behavior)
    const bootstrap = getWorkflowBootstrap();
    const firstUser = output.messages.find((m) => m.info.role === "user");
    if (!firstUser?.parts.length) return;

    let injectables: { id: string; sessionID: string; messageID: string; text: string }[] = [];

    if (bootstrap && !firstUser.parts.some((p) => p.type === "text" && isWorkflowBootstrap(p.text))) {
      injectables.push({ ...anchorFields(firstUser), text: bootstrap });
    }

    // Every turn: reminder (idempotent)
    if (!firstUser.parts.some((p) => p.type === "text" && p.text.includes(REMINDER_TEXT))) {
      injectables.push({ ...anchorFields(firstUser), text: REMINDER_TEXT });
    }

    // Detection: last assistant message before this user turn
    const lastAssistant = [...output.messages].reverse().find((m) => m.info.role === "assistant");
    if (lastAssistant) {
      const assistantText = lastAssistant.parts.filter((p) => p.type === "text").map((p) => (p as any).text).join("\n");
      const detection = detectProseChoices(assistantText);
      const usedQuestionTool = lastAssistant.parts.some((p) => (p as any).type === "tool" && (p as any).tool === "question");
      if (detection && !usedQuestionTool && !firstUser.parts.some((p) => p.type === "text" && p.text.includes("workflow-detection"))) {
        injectables.push({ ...anchorFields(firstUser), text: DETECTION_TEXT });
      }
    }

    if (injectables.length) {
      for (const inj of injectables) {
        firstUser.parts.unshift({ ...inj, type: "text" });
      }
    }
  } catch {
    // never break the session from a hook
  }
},
```

Where `anchorFields` mirrors the existing anchor logic:

```typescript
const anchorFields = (message: { id: string; sessionID: string; parts: { id: string; messageID: string; sessionID: string }[] }) => {
  const anchor = message.parts.find((p) => p.type === "text") ?? message.parts[0];
  return { id: anchor.id, sessionID: anchor.sessionID, messageID: anchor.messageID };
};
```

- [ ] **Step 5: Run tests**

Run: `bun test test/enforcement-hook.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/plugin.ts src/core/reminder.ts test/enforcement-hook.test.ts
git commit -m "feat(plugin): per-turn contract reminder + prose-choice detection correction"
```

---

### Task 3: Cursor session-start reminder line

**Files:**
- Modify: `cursor/hooks/session-start` (add the reminder line to the injected context)
- Modify: `test/contracts.test.ts` (assert the reminder line present)

**Interfaces:**
- Consumes: `REMINDER_TEXT` (Task 2)
- Produces: Cursor sessions see the reminder text in the session-start context (prose; detection is OpenCode-only by design)

- [ ] **Step 1: Write the failing test**

Append to `test/contracts.test.ts`:

```typescript
test("cursor session-start includes the contract reminder", () => {
  const hook = readFileSync(path.resolve(import.meta.dir, "../cursor/hooks/session-start"), "utf8");
  expect(hook).toContain("Bounded user choices");
  expect(hook).toContain("never A/B/C or 1/2/3 lists in prose");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/contracts.test.ts -t "cursor session-start"`
Expected: FAIL — reminder not in the hook.

- [ ] **Step 3: Add the reminder to `cursor/hooks/session-start`**

In the `context=$'...'` string, after the `workflow-toolkit-superpowers-doc-contract` block, add:

```bash
<workflow-toolkit-reminder>
HARD-GATE: Bounded user choices → call Cursor AskQuestion directly (never A/B/C or 1/2/3 lists in prose). After a plan is approved → AskQuestion menu with: Subagent-driven, Inline, Handoff (new session only), Review spec first, Review plan first. Tools with confirmed → call them; never fabricate results.
</workflow-toolkit-reminder>
```

- [ ] **Step 4: Run tests**

Run: `bun test test/contracts.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cursor/hooks/session-start test/contracts.test.ts
git commit -m "feat(cursor): session-start contract reminder"
```

---

## Post-plan checklist

- [ ] `bun run check` green after each task.
- [ ] `src/core/detector.ts` exported and tested (7 tests: matches/negatives).
- [ ] `REMINDER_TEXT`/`DETECTION_TEXT` in `src/core/reminder.ts`.
- [ ] Hook injects reminder every turn (idempotent) and correction on detection (once).
- [ ] First-turn bootstrap unchanged.
- [ ] Cursor session-start includes the reminder.
- [ ] Hook never throws.
