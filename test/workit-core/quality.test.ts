import { expect, test } from "bun:test";
import { qualitySpec } from "../../packages/workit-core/src/core/docs-validate";

const GOOD = `# Spec

**Branch:** \`feature/x\`

## Context

Needs a thing.

## Goals

- Do the thing

## Non-goals

- Skip the other

## Architecture

\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`

\`\`\`text
┌────┐
│ UI │
└────┘
\`\`\`

## Data flow / contracts

| Term | Meaning |
| --- | --- |
| x | y |

## Acceptance criteria

- CA-01 works
- CA-02 also works

## Decisions

- D-01 chose it
`;

test("complete spec has no findings", () => {
  expect(qualitySpec(GOOD)).toEqual([]);
});

test("missing sections are hard findings", () => {
  const findings = qualitySpec("# Spec\n\n**Branch:** `feature/x`\n\n## Context\n\nx\n");
  const hard = findings.filter((f) => f.severity === "hard");
  expect(hard.map((f) => f.code)).toEqual(expect.arrayContaining(["missing_section"]));
  expect(findings.some((f) => f.code === "missing_acceptance_criteria")).toBe(true);
});

test("UI mention without ascii fence is a warning", () => {
  const noFence = GOOD.replace("```text\n┌────┐\n│ UI │\n└────┘\n```", "");
  const withUiText = noFence.replace("Needs a thing.", "Needs a thing with a UI screen.");
  const findings = qualitySpec(withUiText);
  expect(findings.some((f) => f.code === "missing_ascii_for_ui" && f.severity === "warning")).toBe(true);
});

test("flow mention without mermaid is a warning", () => {
  const findings = qualitySpec(GOOD.replace("```mermaid\nflowchart TD\n  A --> B\n```", ""));
  expect(findings.some((f) => f.code === "missing_mermaid_for_flow" && f.severity === "warning")).toBe(true);
});

test("glossary section without table is a warning", () => {
  const withGlossaryNoTable = GOOD.replace("| Term | Meaning |\n| --- | --- |\n| x | y |", "");
  const findings = qualitySpec(withGlossaryNoTable);
  expect(findings.some((f) => f.code === "missing_table" && f.severity === "warning")).toBe(true);
});

test("CA-XX bullets are detected as enumerable criteria", () => {
  const findings = qualitySpec(GOOD);
  expect(findings.some((f) => f.code === "missing_acceptance_criteria")).toBe(false);
});

test("fenced template copy does not satisfy the checks (fence blindness)", () => {
  const quoted = `# Spec

**Branch:** \`feature/x\`

\`\`\`markdown
## Context
x

## Goals
- y

## Non-goals
- z

## Architecture

\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`

## Acceptance criteria

- CA-01 works
\`\`\`
`;
  const findings = qualitySpec(quoted);
  expect(findings.some((f) => f.code === "missing_section")).toBe(true);
  expect(findings.some((f) => f.code === "missing_acceptance_criteria")).toBe(true);
});

test("prose mentioning workflow/format/scope does not false-positive", () => {
  const prose = `# Spec

**Branch:** \`feature/x\`

## Context

Extends the workit and its code formatting rules; out of scope items are listed below.

## Goals

- Add a thing

## Non-goals

- Skip

## Architecture

No flow here.

## Acceptance criteria

- CA-01 done
`;
  const findings = qualitySpec(prose);
  expect(findings.some((f) => f.code === "missing_ascii_for_ui")).toBe(false);
  expect(findings.some((f) => f.code === "missing_mermaid_for_flow")).toBe(false);
  expect(findings.some((f) => f.code === "missing_table")).toBe(false);
});

test("architecture section alone does not force a mermaid warning", () => {
  const noFlow = `# Spec

**Branch:** \`feature/x\`

## Context

Bumps a dependency.

## Goals

- Bump

## Non-goals

- Nothing

## Architecture

Single module, no pipeline.

## Acceptance criteria

- CA-01 bump is applied
`;
  const findings = qualitySpec(noFlow);
  expect(findings.some((f) => f.code === "missing_mermaid_for_flow")).toBe(false);
});
