export const REMINDER_TEXT = `<workflow-contract-reminder>
- Bounded user choices → call the native \`question\` tool (never A/B/C or 1/2/3 lists in prose).
- After a plan is approved → native \`question\` menu with exactly: Subagent-driven, Inline, Handoff (new session only), Review spec first, Review plan first.
- Tools with \`confirmed\` → call them; never fabricate their result.
- Before the first \`workflow_spec_approve\`/\`workflow_plan_approve\` (self-review) run the superpowers writing-plans Self-Review checklist: spec coverage (every spec requirement maps to a task), placeholder scan, type consistency; fix findings inline.
- Delivering docs → clickable markdown link \`[spec.md](docs/<slug>/spec.md)\` + 3-5 bullet summary.
</workflow-contract-reminder>`;

export const DETECTION_TEXT = `<workflow-detection>
Your previous message presented choices as a numbered/bulleted list in prose.
That is a bounded user choice — use the native \`question\` tool instead (re-ask with \`question\` if still relevant).
</workflow-detection>`;

export const DOC_DELIVERY_TEXT = `<workflow-doc-delivery>
You referenced a doc with a backtick-only path. Deliver docs with a clickable markdown link \`[spec.md](docs/<slug>/spec.md)\` and a 3-5 bullet summary of the content.
</workflow-doc-delivery>`;

export const SDD_REMINDER_TEXT = `<workflow-sdd-reminder>
An approved plan is subagent-driven — execute it via \`wk-implement\` / \`task\` delegation. Never implement the approved plan inline in the main session.
</workflow-sdd-reminder>`;

export const DOC_RENDER_TEXT = `<workflow-doc-render>
When delivering a spec or plan, by default render the full markdown content of the doc in chat (headings, tables, mermaid fences preserved) — NOT a backtick-wrapped raw block.
If the doc exceeds the render threshold (more than 150 lines, over 8KB, or more than 3 mermaid diagrams), deliver only the clickable link \`[spec.md](docs/<slug>/spec.md)\` + a 3-5 bullet summary.
On an explicit raw request ("raw", "para copiar", "sin render"), show the full fenced block instead.
Platform note: always use the standard \`\`\`mermaid fence — Cursor CLI renders it as an ASCII diagram, editors/GitHub render it natively; OpenCode TUI shows it as code text (renderer limitation, not a defect). Inline markdown links are not clickable in the OpenCode TUI.
</workflow-doc-render>`;

export const ISSUE_RAIL_TEXT = `<workflow-issue-rail>
A clickable \`question\` option whose label is an instruction (e.g. "Type the issue URL/ID") returns the label literal when clicked, not free text — ask for free text in plain prose with the custom answer field enabled instead.
</workflow-issue-rail>`;

export const CONFIG_GUARD_TEXT = `<workflow-config-guard>
A tool failed with a config-gap error (\`workflow config missing\`). Never configure without asking — ask with the native \`question\` tool, exactly three options: (1) configure only what's missing (guided, via the /wk-init skill flow for those actions), (2) run the full wizard (\`npx workit init\`), (3) skip — report the final error naming the missing items and how to configure them.
</workflow-config-guard>`;

export const VERIFICATION_TEXT = `<workflow-verification-rail>
Skill: verification-before-completion. NO completion claims without fresh verification evidence — run the check command (e.g. \`bun run check\` / \`workflow_verify\`) and show its output before claiming done/fixed/passing. If you haven't run the verification command in this message, you cannot claim it passes.
</workflow-verification-rail>`;

export const TDD_TEXT = `<workflow-tdd-rail>
Skill: test-driven-development. NO production code without a failing test first — write the test, watch it fail, then write the minimal code to pass.
</workflow-tdd-rail>`;

export const BRAINSTORM_TEXT = `<workflow-brainstorm-rail>
Skill: brainstorming. NO implementation until a design is presented and approved — explore intent, ask clarifying questions one at a time, present the design, and get user approval before writing any code.
</workflow-brainstorm-rail>`;

export const DEBUG_TEXT = `<workflow-debug-rail>
Skill: systematic-debugging. NO fixes without root cause investigation first — read the error, reproduce consistently, find the root cause, then fix. Symptom fixes are failure.
</workflow-debug-rail>`;

export const REVIEW_RECEPTION_TEXT = `<workflow-review-reception-rail>
Skill: receiving-code-review. Verify before implementing — evaluate review feedback against codebase reality (read, restate, verify) before accepting or acting on it.
</workflow-review-reception-rail>`;

export const shouldInjectVerification = (currentText: string): boolean =>
  !currentText.includes(VERIFICATION_TEXT);

export const shouldInjectTdd = (currentText: string): boolean =>
  !currentText.includes(TDD_TEXT);

export const shouldInjectBrainstorm = (currentText: string): boolean =>
  !currentText.includes(BRAINSTORM_TEXT);

export const shouldInjectDebug = (currentText: string): boolean =>
  !currentText.includes(DEBUG_TEXT);

export const shouldInjectReviewReception = (currentText: string): boolean =>
  !currentText.includes(REVIEW_RECEPTION_TEXT);

export const shouldInjectDocRender = (currentText: string): boolean =>
  !currentText.includes(DOC_RENDER_TEXT);

export const shouldInjectSddReminder = (currentText: string): boolean =>
  !currentText.includes(SDD_REMINDER_TEXT);

export const shouldInjectConfigGuard = (currentText: string): boolean =>
  !currentText.includes(CONFIG_GUARD_TEXT);

export const shouldInjectIssueRail = (currentText: string): boolean =>
  !currentText.includes(ISSUE_RAIL_TEXT);
