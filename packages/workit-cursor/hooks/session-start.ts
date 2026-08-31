import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@brainervirus/workit-core/src/core/logger";
import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import { setDiagnosticLogger } from "@brainervirus/workit-core/src/core/config";
import { reminderTextFor } from "@brainervirus/workit-core/src/core/reminder";
import { findMarkedDestinations } from "@brainervirus/workit-core/src/core/menu";

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
const marker = path.join(pluginDir, ".workit-root");

setDiagnosticLogger(logger);
logger.info(EVENT.initialization, { host: "cursor-hook", hook_dir: hookDir });

const resolveRepoRoot = (): string => {
  if (
    process.env.WORKFLOW_TOOLKIT_ROOT &&
    existsSync(path.join(process.env.WORKFLOW_TOOLKIT_ROOT, "templates"))
  ) {
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

// The Cursor sessionStart hook input (via stdin JSON) carries the workspace
// roots. Destination classification is host-neutral (CA-07/CA-08): the persisted
// `handoff_destination` flag set by markHandoffDestination after a genuine
// generated destination prompt — never session or parent IDs. A workspace with
// no marked destination (including a Cursor inline implementer, which never
// marks flow state) keeps the ordinary five-choice reminder.
type HookInput = { workspace_roots?: unknown };

// Bounded stdin read (advisory D7): a host that opens the sessionStart pipe but
// writes nothing must not hang the hook. Read with a short timeout and treat
// silence like empty input (ordinary source wording). Tests inject a short
// timeout via WORKFLOW_HOOK_READ_TIMEOUT_MS. 2s bounds a broken host below the
// packed-artifact runtime gate (5s default test timeout) while leaving real
// hosts — which write the workspace JSON promptly — plenty of time.
const HOOK_READ_TIMEOUT_MS = Number(process.env.WORKFLOW_HOOK_READ_TIMEOUT_MS ?? "2000");

const readHookInput = (timeoutMs: number): Promise<HookInput> => {
  if (process.stdin.isTTY) return Promise.resolve({});
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => settle({}), timeoutMs);
    const onData = (chunk: string | Buffer) => {
      buffer += String(chunk);
      const text = buffer.trim();
      if (!text) return;
      try {
        const parsed: unknown = JSON.parse(text);
        settle(typeof parsed === "object" && parsed !== null ? (parsed as HookInput) : {});
      } catch {
        // Partial chunk — keep waiting for the rest or the timeout.
      }
    };
    const onEnd = () => settle({});
    function settle(value: HookInput) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      resolve(value);
    }
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
};

const isDestination = (input: HookInput): boolean => {
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  return roots.some((root) => typeof root === "string" && findMarkedDestinations(root).length > 0);
};

const main = async (): Promise<void> => {
  // Select the core five/four reminder wording from the destination flag (CA-08):
  // a marked destination gets the four-choice reminder that never offers Handoff
  // and carries the marker; ordinary sessions keep the source five-choice wording.
  const reminder = reminderTextFor(isDestination(await readHookInput(HOOK_READ_TIMEOUT_MS)));

  const context = `<workit-askquestion-hard-gate>
HARD-GATE: Any user choice with options → call Cursor AskQuestion directly with workflow-specific copy. NEVER A/B/C in chat. Overrides Superpowers brainstorming conversational options.
</workit-askquestion-hard-gate>

<workit-visual-companion>
HARD-GATE: NEVER offer Superpowers visual companion or open a browser tab. For UI wireframes use workit_present_ascii; for flows use workit_present_flow. Overrides Superpowers brainstorming visual companion offer.
</workit-visual-companion>

<workit-no-worktrees>
HARD-GATE: NEVER using-git-worktrees or git worktree. In-place feature/* or bugfix/* checkout only via workit_resolve_branch + workit_branch_setup. Dirty tree → native AskQuestion before checkout.
</workit-no-worktrees>

<workit-sdd-path>
HARD-GATE: NEVER .superpowers/sdd. ALWAYS workit_sdd_context with plan_path first — resolves canonical docs/<slug>/sdd/ and creates nothing (no empty ledger; progress.md appears only on the first confirmed append). workit_sdd_task_brief, workit_sdd_review_package, workit_sdd_append_progress only.
</workit-sdd-path>

<workit-todowrite>
HARD-GATE: After workit_sdd_context, call Cursor TodoWrite with returned todos (merge: false). SDD ledger is persistence — TodoWrite is the native task list UI. Keep in_progress/completed in sync each task.
</workit-todowrite>

<workit-superpowers-doc-contract>
${body}
</workit-superpowers-doc-contract>

<workit-reminder>
HARD-GATE: Bounded user choices → call Cursor AskQuestion directly (never A/B/C or 1/2/3 lists in prose).

${reminder}
</workit-reminder>`;

  process.stdout.write(JSON.stringify({ additional_context: context }, null, 2) + "\n");
  process.exit(0);
};

void main().catch((err) => {
  // Fail-open on an unexpected async error: never hang or corrupt the host
  // protocol (DG-04/DG-05) — report a sanitized event and exit empty.
  logger.error(EVENT.hooks, { boundary: "session-start", ...errorDetail(err) });
  process.stdout.write("{}\n");
  process.exit(0);
});
