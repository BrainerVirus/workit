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
