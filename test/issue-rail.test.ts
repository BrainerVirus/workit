import { expect, test } from "bun:test";
import { detectInstructionOption } from "../src/core/detector";
import { ISSUE_RAIL_TEXT, shouldInjectIssueRail } from "../src/core/reminder";

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
