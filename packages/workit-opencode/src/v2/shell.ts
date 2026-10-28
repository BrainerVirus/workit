// OpenCode V2 shell calls: before one runs, rewrite one simple heavy command
// to run under the machine-wide heavy-check lease (`workit check --heavy --
// <cmd>`; the tool's input is mutable in execute.before) once every Workit
// gate passed on the original and no OpenCode permission rule names it, note
// HEAD (and the workdir for the permission hook); after it, record a raw `git commit` for the session
// and append the raw-git nudge to the tool output (OpenCode's permission
// hook can only deny, so a nudge rides on the result the model reads).
import path from "node:path";
import {
  callKey,
  heavyGate,
  liveOwner,
  noteRawCommit,
  rawGitPost,
  rawGitPre,
  shellGate,
  shellNudge,
  shellPolicy,
  type HookInput,
} from "@brainervirus/workit-core/hooks";
import {
  repeatedCliFailure,
  type FailureMemo,
} from "@brainervirus/workit-core/src/hooks/repeat-failure";

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

/**
 * The lease rewrite of a simple heavy command, or null: only when the gates
 * the permission hook runs (branch policy, the raw-git deny, the write and
 * live-session gates) all pass on the original command.
 */
const leaseRewrite = (input: HookInput): string | null => {
  if (input.event.kind !== "shell.pre") return null;
  const { command } = input.event;
  // The plan first: it has no side effects, and most commands stop here. The
  // gates run only for a heavy one (shellGate claims the checkout for the
  // session, as the permission hook does for every command it allows).
  const plan = heavyGate(input.cwd, command, { host: "opencode" });
  if (plan.kind !== "rewrite") return null;
  if (shellPolicy(input.cwd, command, "posix").kind === "deny") return null;
  if (rawGitPre(input, command, { nudge: false }).kind === "deny") return null;
  const owner = liveOwner(
    { host: "opencode", session: { id: input.session.id, parentId: null } },
    "in-process-plugin",
  );
  if (shellGate(input.cwd, command, owner).kind === "deny") return null;
  return plan.command;
};

/**
 * Before the shell tool runs: rewrite a heavy command through the lease,
 * remember its workdir and note HEAD for a raw commit. Runs before the
 * shell-session correlation notes the call, so that keys on the command
 * `create.before` will see.
 */
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
    const original = hookInput(root, sessionID, String(event.id), shell);
    const heavy = leaseRewrite(original);
    if (heavy) {
      (event.input as { command: string }).command = heavy;
      shell.command = heavy;
    }
    const input = hookInput(root, sessionID, String(event.id), shell);
    workdirs.set(sessionID, input.cwd);
    if (workdirs.size > 256) workdirs.delete(workdirs.keys().next().value!);
    noteRawCommit(input, shell.command, callKey(String(event.id), shell.command));
  } catch {
    // Fail open.
  }
};

const outputText = (content: ShellResult["content"]): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n")
      : "";

const appendText = (result: ShellResult, text: string): ShellResult =>
  typeof result.content === "string"
    ? { ...result, content: `${result.content}\n\n${text}` }
    : Array.isArray(result.content)
      ? { ...result, content: [...result.content, { type: "text", text }] }
      : result;

/**
 * The OpenCode shell tool's completed result: record a noted raw commit and
 * nudge, and escalate a `workit …` command that failed the same way twice in
 * a row (`failures`, per session). Never throws.
 */
export const observeShellResult = (
  root: string,
  event: ShellAfterEvent,
  failures: FailureMemo = new Map(),
): void => {
  try {
    if (event.tool !== "shell" || event.status !== "completed") return;
    const shell = commandOf(event.input);
    if (!shell) return;
    const input = hookInput(root, String(event.sessionID), String(event.id), shell);
    rawGitPost(input, shell.command, callKey(String(event.id), shell.command));
    const nudge = shellNudge(input, shell.command);
    const result = event.result;
    if (!result) return;
    const repeated = repeatedCliFailure(
      failures,
      String(event.sessionID),
      shell.command,
      outputText(result.content),
    );
    const extra = [nudge.kind === "context" ? nudge.text : null, repeated].filter(
      (text): text is string => text !== null,
    );
    if (extra.length > 0) event.result = appendText(result, extra.join("\n\n"));
  } catch {
    // Fail open: observation never breaks the tool result.
  }
};
