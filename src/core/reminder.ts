export const REMINDER_TEXT = `<workflow-contract-reminder>
- Bounded user choices → call the native \`question\` tool (never A/B/C or 1/2/3 lists in prose).
- After a plan is approved → native \`question\` menu with exactly: Subagent-driven, Inline, Handoff (new session only), Review spec first, Review plan first.
- Tools with \`confirmed\` → call them; never fabricate their result.
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
An approved plan is subagent-driven — execute it via \`wf-implement\` / \`task\` delegation. Never implement the approved plan inline in the main session.
</workflow-sdd-reminder>`;

export const DOC_RENDER_TEXT = `<workflow-doc-render>
When delivering a spec or plan, by default render the full markdown content of the doc in chat (headings, tables, mermaid fences preserved) — NOT a backtick-wrapped raw block.
If the doc exceeds the render threshold (150+ lines, or 8KB+, or 3+ mermaid diagrams), deliver only the clickable link \`[spec.md](docs/<slug>/spec.md)\` + a 3-5 bullet summary.
On an explicit raw request ("raw", "para copiar", "sin render"), show the full fenced block instead.
</workflow-doc-render>`;

export const CONFIG_GUARD_TEXT = `<workflow-config-guard>
A tool failed with a config-gap error (\`workflow config missing\`). Never configure without asking — ask with the native \`question\` tool, exactly three options: (1) configure only what's missing (guided, via the /wf-init skill flow for those actions), (2) run the full wizard (\`npx flowkit init\`), (3) skip — report the final error naming the missing items and how to configure them.
</workflow-config-guard>`;

export const shouldInjectDocRender = (currentText: string): boolean =>
  !currentText.includes(DOC_RENDER_TEXT);

export const shouldInjectSddReminder = (currentText: string): boolean =>
  !currentText.includes(SDD_REMINDER_TEXT);

export const shouldInjectConfigGuard = (currentText: string): boolean =>
  !currentText.includes(CONFIG_GUARD_TEXT);
