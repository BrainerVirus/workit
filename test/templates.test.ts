import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (name: string) => readFileSync(path.join(import.meta.dir, "../templates", name), "utf8");

const REQUIRED_SPEC_SECTIONS = ["## Context", "## Goals", "## Non-goals", "## Architecture", "## Acceptance criteria"];

test("spec template contains all required sections", () => {
  const tpl = read("spec-template.md");
  for (const section of REQUIRED_SPEC_SECTIONS) {
    expect(tpl).toContain(section);
  }
});

test("spec template mandates mermaid and ascii fences", () => {
  const tpl = read("spec-template.md");
  expect(tpl).toContain("```mermaid");
  expect(tpl).toContain("```text");
});

test("spec template mandates CA-XX list and tables", () => {
  const tpl = read("spec-template.md");
  expect(tpl).toMatch(/CA-\d+/);
  expect(tpl).toContain("| ");
});

test("plan template contains task criteria and status table", () => {
  const tpl = read("plan-template.md");
  expect(tpl).toMatch(/### Task \d/);
  expect(tpl).toMatch(/criteri/i);
  expect(tpl).toContain("| ");
});
