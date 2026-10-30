// Codex hook entry (dist/workit-hook.js, built with code splitting). Codex
// runs it for every tool call and, after every shell call, PostToolUse. Most
// of those calls cannot matter to Workit, so they answer before the Workit
// runtime (a ~1 MB module graph) loads:
//   - PostToolUse: only a raw `git commit` is recorded;
//   - PreToolUse: only a file edit (apply_patch, for the before-write gate),
//     a shell command that names git, gh or glab, or one that may be heavy
//     (the heavy-command gate's cheap pre-check) can be denied or nudged;
//   - unless a standing-order revision this agent has not seen is pending,
//     or the agent is a workit-implementer (worktree confinement).
// The global `process`: under bun, `import process from "node:process"` reads
// an empty stdin when the launcher runs from source (bun 1.3.14).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A Node below this package's own engines minimum cannot load the bundle. The
 * launcher then re-runs itself on a Node that can (core/node-resolve.mjs, loaded
 * only then so a current Node never parses it: $WORKIT_NODE, the node `workit
 * setup` recorded, a version-manager scan), with stdin, stdout, stderr and the
 * exit code passed through; WORKIT_HOOK_REEXEC stops a second hop. With none
 * found it fails open (`{}`, exit 0, one stderr line) and a SessionStart tells
 * the agent once that the hooks are off. WORKIT_HOOK_NODE_VERSION stands in for
 * process.versions.node (tests); an unreadable minimum never blocks. */
const foundNode = process.env.WORKIT_HOOK_NODE_VERSION || process.versions.node;
const nodeFloor = (): { range: string; floor: number[] } | null => {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const range = (
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
        engines?: { node?: string };
      }
    ).engines?.node;
    const min = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(range ?? ""));
    if (!min || !range) return null;
    const floor = [min[1], min[2] ?? 0, min[3] ?? 0].map(Number);
    const have = String(foundNode).replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      const a = have[i] ?? 0;
      if (Number.isNaN(a)) return null;
      if (a !== floor[i]) return a < floor[i] ? { range, floor } : null;
    }
    return null;
  } catch {
    return null;
  }
};

const tooOld = nodeFloor();
if (tooOld) {
  const { handleBelowFloor } = await import("@brainervirus/workit-core/src/core/node-resolve.mjs");
  process.exit(
    await handleBelowFloor({
      host: "Codex",
      ...tooOld,
      found: foundNode,
      script: fileURLToPath(import.meta.url),
      argv: process.argv.slice(2),
      env: process.env,
      isStart: (event) => event === "SessionStart",
      notice: (additionalContext) => ({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
      }),
    }),
  );
}

// Loaded after the floor check: a static import would evaluate the runtime first.
const { maybeHeavy, stateDir } = await import("@brainervirus/workit-core/src/core/heavy-words");
const { standingPending } = await import("@brainervirus/workit-core/src/hooks/standing-signal");
const { recordHookRun } = await import("@brainervirus/workit-core/src/hooks/hook-runs");
// The worker tool-call budget: every PreToolUse counts, quiet or not.
const { observeHookBudget } = await import("@brainervirus/workit-core/src/hooks/budget-signal");

let payload = "";
for await (const chunk of process.stdin) payload += String(chunk);

const SHELL_TOOLS = new Set(["bash", "unified-exec"]);
/** Codex sends apply_patch; Edit and Write are its matcher aliases, kept in case a release sends them. */
const WRITE_TOOLS = new Set(["applypatch", "edit", "write"]);

/** Text that may name the issued-session registries (the guard in write-gate.ts judges it). */
const mentionsIssued = (text: string): boolean => {
  const flat = (value: string) => value.replaceAll("\\", "/").toLowerCase();
  return /issued/i.test(text) || flat(text).includes(flat(stateDir(process.env)));
};

/** The event name when the answer is "no decision" without the runtime, else null. */
const quietEvent = (): string | null => {
  try {
    const value = JSON.parse(payload) as {
      hook_event_name?: unknown;
      session_id?: unknown;
      agent_id?: unknown;
      agent_type?: unknown;
      cwd?: unknown;
      tool_name?: unknown;
      tool_input?: { command?: unknown };
    };
    const event = value.hook_event_name;
    if (event !== "PreToolUse" && event !== "PostToolUse") return null;
    if (typeof value.cwd !== "string" || typeof value.tool_name !== "string") return null;
    if (
      event === "PreToolUse" &&
      typeof value.session_id === "string" &&
      standingPending(
        value.cwd,
        value.session_id,
        typeof value.agent_id === "string" && value.agent_id.trim() ? value.agent_id : null,
      )
    )
      return null;
    const tool = value.tool_name.toLowerCase();
    if (event === "PreToolUse" && WRITE_TOOLS.has(tool.replace(/[_-]/g, ""))) return null;
    // An implementer's shell writes are confined to its Workit worktree (hooks/worktree-confine.ts).
    if (event === "PreToolUse" && value.agent_type === "workit-implementer") return null;
    const shell = SHELL_TOOLS.has(tool);
    const command = value.tool_input?.command;
    const text = Array.isArray(command) ? command.join(" ") : String(command ?? "");
    if (!shell) return event;
    if (!text.trim()) return null;
    if (event === "PostToolUse") return /\bcommit\b/.test(text) ? null : event;
    return /\b(?:git|gh|glab)\b/.test(text) || mentionsIssued(text) || maybeHeavy(text, value.cwd)
      ? null
      : event;
  } catch {
    return null;
  }
};

const quiet = observeHookBudget(payload) ? null : quietEvent();
if (quiet) {
  // The full path records itself (runHookProcess); the quiet path counts here.
  // PostToolUse follows every shell call and tells doctor nothing PreToolUse does not.
  if (quiet === "PreToolUse")
    recordHookRun(
      process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === "Codex Desktop" ||
        process.env.CODEX_ELECTRON_RESOURCES_PATH
        ? "codex_desktop"
        : "codex_cli",
      quiet,
    );
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: quiet } })}\n`);
} else {
  const { runCodexHook } = await import("./workit-hook");
  await runCodexHook([payload]);
}
