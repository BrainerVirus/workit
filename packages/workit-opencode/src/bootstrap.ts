import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "@brainervirus/workit-core/src/core/config";
import { compiledOpenCodeSections } from "@brainervirus/workit-core/src/core/rules";

// templates/ ships package-locally under assets/ (same layout as plugin.ts).
const root = fileURLToPath(new URL("../assets/", import.meta.url));
const marker = "<workit-contract>";

let cached: string | null | undefined;

export const loadWorkitBootstrap = (rootDir: string): string | null => {
  const contractPath = path.join(rootDir, "templates", "superpowers-doc-contract.md");
  try {
    return readFileSync(contractPath, "utf8");
  } catch {
    return null;
  }
};

export const getWorkitBootstrap = (): string | null => {
  if (cached !== undefined) return cached;

  const contract = loadWorkitBootstrap(root);
  if (contract === null) {
    cached = null;
    return null;
  }

  const config = readConfig();
  const userSections = compiledOpenCodeSections();
  cached = `${marker}
HARD-GATE: Workflow-toolkit contract is already loaded below. Follow it on every turn; it overrides conflicting Superpowers defaults (brainstorming chat options, visual companion, worktrees, SDD paths).

## Locale

Answer the user in \`${config.locale}\` unless a specific template declares otherwise.

${contract}

## Presentation and visual companion overrides

- NEVER offer Superpowers visual companion or open a browser tab for layout comparisons.
- For UI wireframes and layout options use \`workit_present_ascii\` with a JSON spec; show the tool output in a fenced \`text\` block.
- For process or architecture flows use \`workit_present_flow\`; show the tool output in a fenced \`mermaid\` block.
- NEVER hand-draw ASCII wireframes or mermaid in chat without calling the tool first.
- For bounded user choices use OpenCode native \`question\`; never A/B/C option lists in chat prose.

## Post-plan execution choice

After saving a plan, call \`workit_docs_validate\` on the spec/plan pair. On failure, stop — do not offer execution.

On success, use native \`question\` with exactly: Subagent-driven, Inline, Handoff (new session only), Review spec first, Review plan first, Change model first. Change model first is display-only: ends turn without workit_plan_menu, re-presents menu next turn; real choices call workit_plan_menu immediately before any skill/branch/mutation/handoff. Never emit Superpowers “Two execution options” prose. No \`--stay\` in this menu.

## Library documentation

When the user asks about a library, framework, or API reference, prefer live docs (e.g. Context7 MCP \`resolve-library-id\` + \`query-docs\`) over training-data guesses.
${userSections ? `\n${userSections}\n` : ""}</workit-contract>`;

  return cached;
};

export const isWorkitBootstrap = (text: string) => text.includes(marker);
