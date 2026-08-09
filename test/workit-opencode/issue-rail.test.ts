import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "../../packages/workit-opencode/src/plugin";
import { detectInstructionOption } from "../../packages/workit-core/src/core/detector";
import { ISSUE_RAIL_TEXT, shouldInjectIssueRail } from "../../packages/workit-core/src/core/reminder";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const userMessage = (text: string) => ({
  info: { role: "user" as const, id: "u", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [{ type: "text" as const, text, id: "p", messageID: "u", sessionID: "s", time: { created: 0, updated: 0 } }],
});

const questionPart = (input: unknown) => ({
  type: "tool" as const,
  id: "q",
  sessionID: "s",
  messageID: "a",
  callID: "c",
  tool: "question",
  state: { status: "completed", input, output: "x", title: "t", metadata: {}, time: { start: 0, end: 1 } },
});

const assistantMessageWithQuestion = (input: unknown) => ({
  info: { role: "assistant" as const, id: "a", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [questionPart(input)],
});

const withLabel = (label: string) => ({ questions: [{ header: "q", options: [{ label }] }] });

test("CA-01: fires on instruction-labeled question options", () => {
  expect(detectInstructionOption(withLabel("Type the issue URL/ID"))).toBe(true);
  expect(detectInstructionOption(withLabel("Provide the issue ID"))).toBe(true);
  expect(detectInstructionOption(withLabel("Paste the URL"))).toBe(true);
  expect(detectInstructionOption(withLabel("Enter the issue number"))).toBe(true);
  expect(detectInstructionOption(withLabel("Type my notes"))).toBe(true);
  expect(detectInstructionOption(withLabel("Give me the issue text"))).toBe(true);
  expect(detectInstructionOption(withLabel("Write the URL"))).toBe(true);
});

test("CA-01: does NOT fire on real choices", () => {
  expect(detectInstructionOption(withLabel("Use IRPT-12"))).toBe(false);
  expect(detectInstructionOption(withLabel("Use session facts"))).toBe(false);
  expect(detectInstructionOption(withLabel("No time"))).toBe(false);
  expect(detectInstructionOption(withLabel("Skip"))).toBe(false);
  expect(detectInstructionOption(withLabel("Type your own answer"))).toBe(false);
  expect(detectInstructionOption(withLabel(""))).toBe(false);
  expect(detectInstructionOption({ questions: [{ options: [{ label: null }] }] })).toBe(false);
});

test("CA-01: fires when any option in any question matches", () => {
  const input = {
    questions: [
      { header: "a", options: [{ label: "Skip" }, { label: "Post anyway" }] },
      { header: "b", options: [{ label: "Yes" }, { label: "Paste the URL" }] },
    ],
  };
  expect(detectInstructionOption(input)).toBe(true);
  expect(detectInstructionOption({
    questions: [{ header: "a", options: [{ label: "Skip" }, { label: "No time" }] }],
  })).toBe(false);
});

test("CA-01: accepts both input shapes — array and { questions }", () => {
  expect(detectInstructionOption([{ options: [{ label: "Enter the issue number" }] }])).toBe(true);
  expect(detectInstructionOption({ questions: [{ options: [{ label: "Enter the issue number" }] }] })).toBe(true);
});

test("CA-03: fail-closed — malformed input → false, no throw", () => {
  expect(detectInstructionOption(null)).toBe(false);
  expect(detectInstructionOption(undefined)).toBe(false);
  expect(detectInstructionOption({})).toBe(false);
  expect(detectInstructionOption([])).toBe(false);
  expect(detectInstructionOption({ questions: null })).toBe(false);
  expect(detectInstructionOption({ questions: [{ options: "not-array" }] })).toBe(false);
  expect(detectInstructionOption({ questions: "nope" })).toBe(false);
  expect(detectInstructionOption({ questions: [{ options: [{ label: 42 }] }] })).toBe(false);
  expect(detectInstructionOption("nope")).toBe(false);
});

test("CA-04: ISSUE_RAIL_TEXT mirrors the skill wording (label literal + plain prose)", () => {
  expect(ISSUE_RAIL_TEXT).toContain("workflow-issue-rail");
  expect(ISSUE_RAIL_TEXT).toContain("label literal");
  expect(ISSUE_RAIL_TEXT).toContain("plain prose");
  expect(ISSUE_RAIL_TEXT).toContain("custom answer field");
});

test("CA-04: shouldInjectIssueRail is marker-based idempotent", () => {
  expect(shouldInjectIssueRail("plain message")).toBe(true);
  expect(shouldInjectIssueRail(ISSUE_RAIL_TEXT)).toBe(false);
  expect(shouldInjectIssueRail(`msg with ${ISSUE_RAIL_TEXT} marker`)).toBe(false);
});

test("CA-02: question part input feeds the detector (state.input shape)", () => {
  const input = (questionPart({ questions: [{ header: "q", options: [{ label: "Type the issue URL/ID" }] }] }) as { state?: { input?: unknown } }).state?.input;
  expect(detectInstructionOption(input)).toBe(true);
  expect(detectInstructionOption((questionPart([{ options: [{ label: "Enter the issue number" }] }]) as { state?: { input?: unknown } }).state?.input)).toBe(true);
  expect(detectInstructionOption((questionPart({ questions: [{ options: [{ label: "Skip" }] }] }) as { state?: { input?: unknown } }).state?.input)).toBe(false);
  expect(detectInstructionOption((questionPart(null) as { state?: { input?: unknown } }).state?.input)).toBe(false);
});

test("CA-02: hook injects the rail when the previous assistant used an instruction-labeled question option", async () => {
  const hooks = await plugin({ directory: "/repo", worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
  const output = {
    messages: [
      userMessage("start"),
      assistantMessageWithQuestion({ questions: [{ header: "h", options: [{ label: "Type the issue URL/ID" }] }] }),
      userMessage("continue"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const currentText = output.messages[2].parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  expect(currentText).toContain("workflow-issue-rail");
});

test("CA-02: no injection without an instruction-labeled option, or when the marker is already present", async () => {
  const hooks = await plugin({ directory: "/repo", worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
  const clean = {
    messages: [
      assistantMessageWithQuestion({ questions: [{ header: "h", options: [{ label: "Skip" }, { label: "Use session facts" }] }] }),
      userMessage("continue"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, clean as never);
  const cleanText = clean.messages[1].parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  expect(cleanText).not.toContain("workflow-issue-rail");

  const twice = {
    messages: [
      userMessage("start"),
      assistantMessageWithQuestion({ questions: [{ header: "h", options: [{ label: "Paste the URL" }] }] }),
      userMessage("continue"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, twice as never);
  const afterFirst = twice.messages[2].parts.length;
  await hooks["experimental.chat.messages.transform"]?.({} as never, twice as never);
  expect(twice.messages[2].parts.length).toBe(afterFirst);
});

test("CA-02: 'ir' tag is present and unique across makePart tags in plugin.ts", () => {
  const src = readFileSync(path.join(root, "packages", "workit-opencode", "src", "plugin.ts"), "utf8");
  const tags = [...src.matchAll(/makePart\([^,]+(?:,\s*"([^"]+)")?\)/g)]
    .map((m) => m[1] ?? "r");
  expect(tags).toContain("ir");
  expect(new Set(tags).size).toBe(tags.length);
});
