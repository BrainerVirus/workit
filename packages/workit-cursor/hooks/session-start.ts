import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@brainervirus/workit-core/src/core/logger";
import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import { setDiagnosticLogger } from "@brainervirus/workit-core/src/core/config";

// Secret-safe diagnostic logger (DG-01-DG-03, DG-05, DG-10). Sink injection
// only: session-start summaries mirror to stderr; the JSON contract on stdout
// stays protocol-only.
export const logger = createLogger({
  stderr: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
});

// Node-compatible TS sessionStart entry (RL-09): resolves the toolkit root and
// injects the workflow contract into Cursor's session context. Performs NO
// network I/O and NO implicit runtime update — a missing contract or runtime
// state is reported without pretending success. Replaces hooks/session-start.

const hookDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(hookDir, "..");
const marker = path.join(pluginDir, ".workflow-toolkit-root");

setDiagnosticLogger(logger);
logger.info(EVENT.initialization, { host: "cursor-hook", hook_dir: hookDir });

const resolveRepoRoot = (): string => {
  if (process.env.WORKFLOW_TOOLKIT_ROOT && existsSync(path.join(process.env.WORKFLOW_TOOLKIT_ROOT, "templates"))) {
    return process.env.WORKFLOW_TOOLKIT_ROOT;
  }
  if (existsSync(marker)) {
    return readFileSync(marker, "utf8").replace(/\n+$/, "");
  }
  // Packaged install: contract ships under the plugin's own assets root.
  const ownAssets = path.join(pluginDir, "assets");
  if (existsSync(path.join(ownAssets, "templates"))) {
    return ownAssets;
  }
  // Live monorepo: workit-cursor/hooks → packages/workit-core (workspace sibling).
  return path.resolve(hookDir, "../../workit-core");
};

// Fail-open: an unreadable contract (missing file or directory where the file
// should be) is a bounded sanitized stderr event; the session still starts with
// an empty context so the host protocol is never corrupted (DG-04, DG-05).
let body: string | null = null;
const repoRoot = resolveRepoRoot();
try {
  const contract = path.join(repoRoot, "templates", "superpowers-doc-contract.md");
  if (existsSync(contract)) body = readFileSync(contract, "utf8");
} catch (err) {
  logger.error(EVENT.hooks, { boundary: "session-start", root: repoRoot, ...errorDetail(err) });
  body = null;
}

if (body === null) {
  process.stdout.write("{}\n");
  process.exit(0);
}

const context = `<workflow-toolkit-askquestion-hard-gate>
HARD-GATE: Any user choice with options → call Cursor AskQuestion directly with workflow-specific copy. NEVER A/B/C in chat. Overrides Superpowers brainstorming conversational options.
</workflow-toolkit-askquestion-hard-gate>

<workflow-toolkit-visual-companion>
HARD-GATE: NEVER offer Superpowers visual companion or open a browser tab. For UI wireframes use workflow_present_ascii; for flows use workflow_present_flow. Overrides Superpowers brainstorming visual companion offer.
</workflow-toolkit-visual-companion>

<workflow-toolkit-no-worktrees>
HARD-GATE: NEVER using-git-worktrees or git worktree. In-place feature/* or bugfix/* checkout only via workflow_resolve_branch + workflow_branch_setup. Dirty tree → native AskQuestion before checkout.
</workflow-toolkit-no-worktrees>

<workflow-toolkit-sdd-path>
HARD-GATE: NEVER .superpowers/sdd. ALWAYS workflow_sdd_context with plan_path first — resolves canonical docs/<slug>/sdd/ and creates nothing (no empty ledger; progress.md appears only on the first confirmed append). workflow_sdd_task_brief, workflow_sdd_review_package, workflow_sdd_append_progress only.
</workflow-toolkit-sdd-path>

<workflow-toolkit-todowrite>
HARD-GATE: After workflow_sdd_context, call Cursor TodoWrite with returned todos (merge: false). SDD ledger is persistence — TodoWrite is the native task list UI. Keep in_progress/completed in sync each task.
</workflow-toolkit-todowrite>

<workflow-toolkit-superpowers-doc-contract>
${body}
</workflow-toolkit-superpowers-doc-contract>

<workflow-toolkit-reminder>
HARD-GATE: Bounded user choices → call Cursor AskQuestion directly (never A/B/C or 1/2/3 lists in prose). After a plan is approved → AskQuestion menu with: Subagent-driven, Inline, Handoff (new session only), Review spec first, Review plan first. Tools with confirmed → call them; never fabricate results.
Delivering docs → clickable markdown link (docs/<slug>/spec.md) + 3-5 bullet summary.
</workflow-toolkit-reminder>`;

process.stdout.write(JSON.stringify({ additional_context: context }, null, 2) + "\n");
process.exit(0);
