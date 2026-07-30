import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marker = "<workflow-toolkit-contract>";

let cached: string | null | undefined;

export const getWorkflowBootstrap = (): string | null => {
  if (cached !== undefined) return cached;

  const contractPath = path.join(root, "templates", "superpowers-doc-contract.md");
  let contract: string;
  try {
    contract = readFileSync(contractPath, "utf8");
  } catch {
    cached = null;
    return null;
  }

  cached = `${marker}
HARD-GATE: Workflow-toolkit contract is already loaded below. Follow it on every turn; it overrides conflicting Superpowers defaults (brainstorming chat options, visual companion, worktrees, SDD paths).

${contract}

## Presentation and visual companion overrides

- NEVER offer Superpowers visual companion or open a browser tab for layout comparisons.
- For UI wireframes and layout options use \`workflow_present_ascii\` with a JSON spec; show the tool output in a fenced \`text\` block.
- For process or architecture flows use \`workflow_present_flow\`; show the tool output in a fenced \`mermaid\` block.
- NEVER hand-draw ASCII wireframes or mermaid in chat without calling the tool first.
- For bounded user choices use OpenCode native \`question\`; never A/B/C option lists in chat prose.

## Library documentation

When the user asks about a library, framework, or API reference, prefer live docs (e.g. Context7 MCP \`resolve-library-id\` + \`query-docs\`) over training-data guesses.
</workflow-toolkit-contract>`;

  return cached;
};

export const isWorkflowBootstrap = (text: string) => text.includes(marker);
