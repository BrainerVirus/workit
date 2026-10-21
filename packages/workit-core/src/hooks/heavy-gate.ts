// The heavy-command gate (issue #325, ruling mvid5onk): after every Workit
// gate passed on the original command, a raw heavy command (tests, builds,
// lint, typecheck, installs; core/heavy.ts) runs under the machine-wide
// heavy-check lease:
//   - one simple heavy command: rewritten to `workit check --heavy -- <cmd>`
//     where the host can replace it (Claude Code, OpenCode, Pi), else denied
//     with that exact command (Codex, Cursor);
//   - a chain with heavy parts: denied, naming each part's lease command
//     (never `bash -c`);
//   - a command a host permission rule names, or one whose wrapper only an
//     allow for `workit` would let through: left alone, with a note.
import {
  claudeRules,
  codexRules,
  cursorRules,
  opencodeRules,
  type RuleRead,
} from "../core/heavy-rules";
import { heavyPlan, workitOnPath, type HeavyPlan } from "../core/heavy";
import { maybeHeavy } from "../core/heavy-words";
import type { HookDecision, HostId } from "./protocol";
import type { ShellDialect } from "./shell-words";

/** The host's readable permission rules (null where it keeps none the hook could read). */
const rulesFor = (host: HostId, cwd: string, env: NodeJS.ProcessEnv): RuleRead | null => {
  switch (host) {
    case "claude_code":
      return claudeRules(cwd, env);
    case "opencode":
      return opencodeRules(cwd, env);
    case "codex_cli":
    case "codex_desktop":
      return codexRules(cwd, env);
    case "cursor":
      return cursorRules(cwd, env);
    case "pi":
      return null;
  }
};

export type GateOptions = {
  host: HostId;
  dialect?: ShellDialect;
  /** Claude `permission_mode`: bypassPermissions skips the allowlist check. */
  permissionMode?: string | null;
  /** The host shell tool's timeout (ms): the lease wait stays below it. */
  toolTimeoutMs?: number | null;
  env?: NodeJS.ProcessEnv;
};

/** Seconds left for the lease wait inside a tool call of `timeoutMs`. */
const waitFor = (timeoutMs: number | null | undefined): number =>
  Math.max(10, Math.floor((timeoutMs && timeoutMs > 0 ? timeoutMs : 120_000) / 1000) - 20);

/**
 * The gate's plan for `command`, run after the Workit gates allowed it.
 * Nothing when no `workit` is on PATH (the wrapper could not run) or the
 * host sets WORKIT_HEAVY_GATE=0. Never throws.
 */
export function heavyGate(cwd: string, command: string, options: GateOptions): HeavyPlan {
  const env = options.env ?? process.env;
  try {
    // The launchers' cheap word check first: most commands stop here.
    if (env.WORKIT_HEAVY_GATE === "0" || !maybeHeavy(command, cwd, env) || !workitOnPath(env))
      return { kind: "none" };
    // Hosts that rewrite cap the wait below their tool timeout; a deny names
    // the plain command.
    const rewrites = options.host === "claude_code" || options.host === "opencode";
    return heavyPlan(command, {
      cwd,
      env,
      dialect: options.dialect ?? "posix",
      rules: rulesFor(options.host, cwd, env),
      bypass: options.permissionMode === "bypassPermissions",
      waitS: rewrites ? waitFor(options.toolTimeoutMs) : null,
    });
  } catch {
    return { kind: "none" };
  }
}

/** The model-visible line after a rewrite. */
export const rewriteNote = (plan: Extract<HeavyPlan, { kind: "rewrite" }>): string =>
  `workit: this heavy command (${plan.reason}) runs under the machine-wide heavy-check lease as \`${plan.command}\`: it waits while another heavy check holds the lease (\`workit lock status\` shows who). Run heavy commands that way yourself; \`workit help lock\` explains the lease.`;

/** The deny on hosts that cannot rewrite: the exact command to run instead. */
export const heavyDenial = (
  original: string,
  plan: Extract<HeavyPlan, { kind: "rewrite" }>,
): HookDecision => ({
  kind: "deny",
  reason: `heavy_command: \`${original.trim()}\` is heavy (${plan.reason}) and must run under the machine-wide heavy-check lease, so parallel agents cannot exhaust this machine's memory and CPU. Run exactly: ${plan.command}`,
  unblock: plan.command,
});

/** The deny for a chain with heavy parts. */
export const splitDenial = (plan: Extract<HeavyPlan, { kind: "split" }>): HookDecision => ({
  kind: "deny",
  reason: plan.reason,
  unblock: plan.unblock,
});
