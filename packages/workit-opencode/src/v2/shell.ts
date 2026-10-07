// OpenCode V2 shell results: record a raw `git commit` for the session and
// append the raw-git nudge to the tool output (OpenCode's permission hook can
// only deny, so a nudge rides on the result the model reads).
import path from "node:path";
import { rawGitPost, rawGitPre, type HookInput } from "@brainervirus/workit-core/hooks";

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

/** The OpenCode shell tool's completed result: observe and nudge. Never throws. */
export const observeShellResult = (root: string, event: ShellAfterEvent): void => {
  try {
    if (event.tool !== "shell" || event.status !== "completed") return;
    const shell = commandOf(event.input);
    if (!shell) return;
    const input: HookInput = {
      host: "opencode",
      cwd: shell.workdir ? path.resolve(root, shell.workdir) : root,
      session: { id: String(event.sessionID), agentId: null, agentType: null, parentId: null },
      permissionMode: null,
      transcriptPath: null,
      event: {
        kind: "shell.post",
        command: shell.command,
        stdout: "",
        exitCode: null,
        toolUseId: String(event.id),
      },
    };
    rawGitPost(input, shell.command, null);
    const nudge = rawGitPre(input, shell.command, { pending: false });
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
