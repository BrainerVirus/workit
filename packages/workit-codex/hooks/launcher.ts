// Codex hook entry (dist/workit-hook.js, built with code splitting). Codex
// runs it for every tool call and, after every shell call, PostToolUse. Most
// of those calls cannot matter to Workit, so they answer before the Workit
// runtime (a ~1 MB module graph) loads:
//   - PostToolUse: only a raw `git commit` is recorded;
//   - PreToolUse: only a file edit (apply_patch, for the before-write gate)
//     or a shell command that names git, gh or glab can be denied or nudged.
import process from "node:process";

let payload = "";
for await (const chunk of process.stdin) payload += String(chunk);

const SHELL_TOOLS = new Set(["bash", "unified-exec"]);
/** Codex sends apply_patch; Edit and Write are its matcher aliases, kept in case a release sends them. */
const WRITE_TOOLS = new Set(["applypatch", "edit", "write"]);

/** The event name when the answer is "no decision" without the runtime, else null. */
const quietEvent = (): string | null => {
  try {
    const value = JSON.parse(payload) as {
      hook_event_name?: unknown;
      cwd?: unknown;
      tool_name?: unknown;
      tool_input?: { command?: unknown };
    };
    const event = value.hook_event_name;
    if (event !== "PreToolUse" && event !== "PostToolUse") return null;
    if (typeof value.cwd !== "string" || typeof value.tool_name !== "string") return null;
    const tool = value.tool_name.toLowerCase();
    if (event === "PreToolUse" && WRITE_TOOLS.has(tool.replace(/[_-]/g, ""))) return null;
    const shell = SHELL_TOOLS.has(tool);
    const command = value.tool_input?.command;
    const text = Array.isArray(command) ? command.join(" ") : String(command ?? "");
    if (!shell) return event;
    if (!text.trim()) return null;
    if (event === "PostToolUse") return /\bcommit\b/.test(text) ? null : event;
    return /\b(?:git|gh|glab)\b/.test(text) ? null : event;
  } catch {
    return null;
  }
};

const quiet = quietEvent();
if (quiet)
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: quiet } })}\n`);
else {
  const { runCodexHook } = await import("./workit-hook");
  await runCodexHook([payload]);
}
