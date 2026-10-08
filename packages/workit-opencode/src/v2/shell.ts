// OpenCode V2 shell calls: before one runs, note HEAD (and the workdir for
// the permission hook); after it, record a raw `git commit` for the session
// and append the raw-git nudge to the tool output (OpenCode's permission
// hook can only deny, so a nudge rides on the result the model reads).
import path from "node:path";
import {
  callKey,
  noteRawCommit,
  rawGitPost,
  rawGitPre,
  type HookInput,
} from "@brainervirus/workit-core/hooks";

type Content = { type: string; text?: string };
type ShellResult = { content?: string | ReadonlyArray<Content> } & Record<string, unknown>;

export type ShellAfterEvent = {
  tool: string;
  sessionID: string;
  id: string;
  input: unknown;
  status: "completed" | "error";
  result?: ShellResult;
};

const commandOf = (input: unknown): { command: string; workdir: string | null } | null => {
  if (input === null || typeof input !== "object") return null;
  const { command, workdir } = input as { command?: unknown; workdir?: unknown };
  return typeof command === "string" && command.trim()
    ? { command, workdir: typeof workdir === "string" && workdir.trim() ? workdir : null }
    : null;
};

/** The shell tool's working directory per session, for the permission hook
 * (OpenCode's permission event carries the command but not its workdir). */
export type ShellWorkdirs = Map<string, string>;

const hookInput = (
  root: string,
  sessionID: string,
  id: string,
  shell: { command: string; workdir: string | null },
): HookInput => ({
  host: "opencode",
  cwd: shell.workdir ? path.resolve(root, shell.workdir) : root,
  session: { id: sessionID, agentId: null, agentType: null, parentId: null },
  permissionMode: null,
  transcriptPath: null,
  event: { kind: "shell.pre", command: shell.command, toolUseId: id },
});

export type ShellBeforeEvent = { tool: string; sessionID: string; id: string; input: unknown };

/** Before the shell tool runs: remember its workdir and note HEAD for a raw commit. */
export const observeShellBefore = (
  root: string,
  event: ShellBeforeEvent,
  workdirs: ShellWorkdirs,
): void => {
  try {
    if (event.tool !== "shell") return;
    const shell = commandOf(event.input);
    if (!shell) return;
    const sessionID = String(event.sessionID);
    const input = hookInput(root, sessionID, String(event.id), shell);
    workdirs.set(sessionID, input.cwd);
    if (workdirs.size > 256) workdirs.delete(workdirs.keys().next().value!);
    noteRawCommit(input, shell.command, callKey(String(event.id), shell.command));
  } catch {
    // Fail open.
  }
};

/** The OpenCode shell tool's completed result: record a noted raw commit and nudge. Never throws. */
export const observeShellResult = (root: string, event: ShellAfterEvent): void => {
  try {
    if (event.tool !== "shell" || event.status !== "completed") return;
    const shell = commandOf(event.input);
    if (!shell) return;
    const input = hookInput(root, String(event.sessionID), String(event.id), shell);
    rawGitPost(input, shell.command, callKey(String(event.id), shell.command));
    const nudge = rawGitPre(input, shell.command);
    const result = event.result;
    if (nudge.kind !== "context" || !result) return;
    if (typeof result.content === "string")
      event.result = { ...result, content: `${result.content}\n\n${nudge.text}` };
    else if (Array.isArray(result.content))
      event.result = {
        ...result,
        content: [...result.content, { type: "text", text: nudge.text }],
      };
  } catch {
    // Fail open: observation never breaks the tool result.
  }
};
