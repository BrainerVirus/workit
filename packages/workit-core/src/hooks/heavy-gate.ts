// The heavy-command gate (issue #325): a raw heavy command (tests, builds,
// lint, typecheck, installs; core/heavy.ts) runs under the machine-wide
// heavy-check lease. Hosts that can rewrite a shell call (Claude Code,
// OpenCode, Pi) run it as `workit check --heavy -- <cmd>` in the same turn;
// the others (Codex, Cursor) deny it with that exact command.
import { heavyCommand, leaseRewrite, workitOnPath } from "../core/heavy";
import type { HookDecision } from "./protocol";
import type { ShellDialect } from "./shell-words";

export type HeavyGate = {
  /** The command that runs the original under the lease. */
  command: string;
  /** Why it is heavy (the catalog entry or the pattern). */
  reason: string;
};

const quote = (text: string) => `\`${text}\``;

/**
 * The lease rewrite for a heavy `command`, or null for a light one. Null as
 * well when no `workit` is on PATH (the rewrite could not run) or the gate is
 * off for this process (WORKIT_HEAVY_GATE=0). Never throws.
 */
export function heavyGate(
  cwd: string,
  command: string,
  dialect: ShellDialect = "posix",
  env: NodeJS.ProcessEnv = process.env,
): HeavyGate | null {
  try {
    if (env.WORKIT_HEAVY_GATE === "0") return null;
    const match = heavyCommand(command, { cwd, env, dialect });
    if (!match || !workitOnPath(env)) return null;
    return { command: leaseRewrite(command, dialect), reason: match.reason };
  } catch {
    return null;
  }
}

/** The model-visible line after a rewrite. */
export const rewriteNote = (gate: HeavyGate): string =>
  `workit: this heavy command (${gate.reason}) runs under the machine-wide heavy-check lease as ${quote(gate.command)}: it waits while another heavy check holds the lease (\`workit lock status\` shows who). Run heavy commands that way yourself; \`workit help lock\` explains the lease.`;

/** The deny on hosts that cannot rewrite: the exact command to run instead. */
export const heavyDenial = (original: string, gate: HeavyGate): HookDecision => ({
  kind: "deny",
  reason: `heavy_command: ${quote(original.trim())} is heavy (${gate.reason}) and must run under the machine-wide heavy-check lease, so parallel agents cannot exhaust this machine's memory and CPU. Run exactly: ${gate.command}`,
  unblock: gate.command,
});
