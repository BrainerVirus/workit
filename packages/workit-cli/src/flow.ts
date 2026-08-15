import { createInterface } from "node:readline/promises";
import path from "node:path";
import {
  readEffectiveFlowState,
  transitionExecution,
  type CliConfirmation,
  type LifecycleEvidence,
} from "@brainervirus/workit-core/src/core/flow-state";
import { buildHandoffPrompt } from "@brainervirus/workit-core/src/core/handoff-tools";
import {
  markHandoffDestination,
  slugFromPath,
} from "@brainervirus/workit-core/src/core/flow-state";
import { resolveCanonicalLayout } from "@brainervirus/workit-core/src/core/docs-layout";
import type { runVerifyProject } from "@brainervirus/workit-core/src/core/verify-project";

// Task 6 (CA-19/CA-21): the CLI flow/handoff surface. index.tsx stays a thin
// dispatcher; every command here maps host-native argv + a TTY/--confirm
// confirmation seam to the shared core — readEffectiveFlowState for status,
// transitionExecution for lifecycle mutations, buildHandoffPrompt +
// markHandoffDestination for handoff. Nothing is re-implemented: prerequisites,
// ledger parsing, verification, transitions, and contract generation all stay
// in core. Exit contract: 0 success, 1 domain/verification failure, 2 usage or
// missing non-TTY confirmation.

export type FlowCliDeps = {
  stdinIsTTY?: () => boolean;
  confirm?: () => Promise<boolean>;
  verifyProject?: typeof runVerifyProject;
  cwd?: string;
  out?: { write: (chunk: string) => void };
  err?: { write: (chunk: string) => void };
};

const FLOW_ACTIONS = ["status", "pause", "resume", "complete"] as const;
type FlowAction = (typeof FLOW_ACTIONS)[number];
type MutationAction = Exclude<FlowAction, "status">;

// Single source of truth for the command surface: FLOW_COMMANDS (usage errors)
// and the index.tsx HELP text are both derived from COMMANDS so the exact
// command strings cannot drift.
export const COMMANDS = {
  status: "workit flow status --plan <path>",
  pause: "workit flow pause --plan <path> [--confirm]",
  resume: "workit flow resume --plan <path> [--confirm]",
  complete: "workit flow complete --plan <path> [--confirm]",
  handoff: "workit handoff --message <text>",
} as const;

const FLOW_COMMANDS: Record<FlowAction, string> = {
  status: COMMANDS.status,
  pause: COMMANDS.pause,
  resume: COMMANDS.resume,
  complete: COMMANDS.complete,
};

const CLI_FLAG_EVIDENCE: CliConfirmation = { host: "cli", attested: false, confirmation: "flag" };
const CLI_TTY_EVIDENCE: CliConfirmation = { host: "cli", attested: false, confirmation: "tty" };

const defaultIsTTY = (): boolean => process.stdin.isTTY === true;

// The confirm prompt is routed through the injected `out` stream (falling back
// to process.stdout) so injected-confirm tests capture the same TTY prompt a
// real terminal sees, instead of writing to the process stdout directly.
const defaultConfirm = async (out?: { write: (chunk: string) => void }): Promise<boolean> => {
  const rl = createInterface({
    input: process.stdin,
    output: (out ?? process.stdout) as NodeJS.WritableStream,
  });
  try {
    const answer = await rl.question("Proceed? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};

const outStream = (deps: FlowCliDeps) => deps.out ?? process.stdout;
const errStream = (deps: FlowCliDeps) => deps.err ?? process.stderr;

const write = (stream: { write: (chunk: string) => void }, text: string) =>
  stream.write(text.endsWith("\n") ? text : `${text}\n`);

const writeJSON = (stream: { write: (chunk: string) => void }, value: unknown) =>
  write(stream, JSON.stringify(value, null, 2));

const isTTY = (deps: FlowCliDeps): boolean =>
  deps.stdinIsTTY === undefined ? defaultIsTTY() : deps.stdinIsTTY();

const workspaceRoot = (deps: FlowCliDeps): string =>
  process.env.WORKFLOW_WORKSPACE_ROOT ?? deps.cwd ?? process.cwd();

// Domain/verification failures (exit 1) mirror the core FlowError fields so a
// caller can act on the exact code/details without re-deriving them.
const domainFail = (
  err: { write: (chunk: string) => void },
  code: string,
  error: string,
  details?: Record<string, unknown>,
): number => {
  writeJSON(err, { ok: false, error, code, ...(details ? { details } : {}) });
  return 1;
};

const usage = (err: { write: (chunk: string) => void }, text: string): number => {
  write(err, text);
  return 2;
};

type ParsedFlow = { plan: string; confirm: boolean };

function parseFlowFlags(
  action: FlowAction,
  argv: string[],
  err: { write: (chunk: string) => void },
): { ok: true; parsed: ParsedFlow } | { ok: false } {
  let plan: string | undefined;
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--plan") {
      if (plan !== undefined) {
        usage(err, `usage: ${FLOW_COMMANDS[action]} — duplicate --plan flag`);
        return { ok: false };
      }
      const value = argv[i + 1];
      if (value === undefined || value.trim() === "") {
        usage(err, `usage: ${FLOW_COMMANDS[action]} — --plan requires a non-empty path`);
        return { ok: false };
      }
      if (value.startsWith("--")) {
        usage(err, `usage: ${FLOW_COMMANDS[action]} — unknown flag: ${value}`);
        return { ok: false };
      }
      plan = value;
      i += 1;
    } else if (token === "--confirm") {
      if (action === "status") {
        usage(
          err,
          `usage: ${FLOW_COMMANDS[action]} — status is read-only and accepts no --confirm`,
        );
        return { ok: false };
      }
      if (confirm) {
        usage(err, `usage: ${FLOW_COMMANDS[action]} — duplicate --confirm flag`);
        return { ok: false };
      }
      confirm = true;
    } else {
      usage(err, `usage: ${FLOW_COMMANDS[action]} — unknown flag: ${token}`);
      return { ok: false };
    }
  }
  if (plan === undefined) {
    usage(err, `usage: ${FLOW_COMMANDS[action]} — --plan <path> required`);
    return { ok: false };
  }
  return { ok: true, parsed: { plan, confirm } };
}

/**
 * TTY confirmation seam (CA-19, CA-21): `--confirm` supplies the exact flag
 * constant in every mode; otherwise non-TTY stdin fails with the exact message
 * and TTY stdin asks one yes/no question. Only an affirmative answer produces
 * the `"tty"` constant; a negative answer is a declined mutation (exit 2).
 */
async function resolveConfirmation(
  deps: FlowCliDeps,
  confirmFlag: boolean,
  out: { write: (chunk: string) => void },
  err: { write: (chunk: string) => void },
): Promise<CliConfirmation | null> {
  if (confirmFlag) return CLI_FLAG_EVIDENCE;
  if (!isTTY(deps)) {
    usage(err, "--confirm required when stdin is not a TTY");
    return null;
  }
  const answered = deps.confirm ? await deps.confirm() : await defaultConfirm(out);
  if (!answered) {
    usage(err, "cancelled — no confirmation");
    return null;
  }
  return CLI_TTY_EVIDENCE;
}

function statusCommand(
  root: string,
  plan: string,
  out: { write: (chunk: string) => void },
  err: { write: (chunk: string) => void },
): number {
  const resolved = resolveCanonicalLayout({ workspace_root: root, plan_path: plan });
  if (!resolved.ok) return domainFail(err, "path_invalid", resolved.error);
  const effective = readEffectiveFlowState(root, resolved.layout.slug);
  if (!effective.ok) return domainFail(err, effective.code, effective.error, effective.details);
  const { state, drift } = effective;
  writeJSON(out, {
    ok: true,
    slug: state.slug,
    spec: state.spec,
    plan: state.plan,
    menu: state.menu,
    execution: state.execution,
    handoff_destination: state.handoff_destination,
    drift,
    flow_path: path.posix.join("docs", state.slug, "sdd", "flow.json"),
  });
  return 0;
}

function mutateCommand(
  root: string,
  plan: string,
  action: MutationAction,
  evidence: LifecycleEvidence,
  deps: FlowCliDeps,
  out: { write: (chunk: string) => void },
  err: { write: (chunk: string) => void },
): number {
  const resolved = resolveCanonicalLayout({ workspace_root: root, plan_path: plan });
  if (!resolved.ok) return domainFail(err, "path_invalid", resolved.error);
  const result = transitionExecution(
    root,
    resolved.layout.slug,
    plan,
    action,
    evidence,
    undefined,
    deps.verifyProject ? { verifyProject: deps.verifyProject } : undefined,
  );
  if (!result.ok) return domainFail(err, result.code, result.error, result.details);
  const effective = readEffectiveFlowState(root, resolved.layout.slug);
  if (!effective.ok) return domainFail(err, effective.code, effective.error, effective.details);
  writeJSON(out, {
    ok: true,
    plan,
    execution: effective.state.execution,
    drift: effective.drift,
  });
  return 0;
}

export async function runFlowCommand(argv: string[], deps: FlowCliDeps = {}): Promise<number> {
  const out = outStream(deps);
  const err = errStream(deps);
  const [action, ...rest] = argv;
  if (!action || !(FLOW_ACTIONS as readonly string[]).includes(action)) {
    return usage(
      err,
      "usage: workit flow <status|pause|resume|complete> --plan <path> [--confirm]",
    );
  }
  const flowAction = action as FlowAction;
  const parsed = parseFlowFlags(flowAction, rest, err);
  if (!parsed.ok) return 2;
  const root = workspaceRoot(deps);
  if (flowAction === "status") {
    return statusCommand(root, parsed.parsed.plan, out, err);
  }
  const evidence = await resolveConfirmation(deps, parsed.parsed.confirm, out, err);
  if (evidence === null) return 2;
  return mutateCommand(root, parsed.parsed.plan, flowAction, evidence, deps, out, err);
}

export async function runHandoffCommand(argv: string[], deps: FlowCliDeps = {}): Promise<number> {
  const out = outStream(deps);
  const err = errStream(deps);
  const [flag, value, ...rest] = argv;
  if (flag !== "--message" || value === undefined || value.trim() === "" || rest.length > 0) {
    return usage(err, `usage: ${COMMANDS.handoff}`);
  }
  const root = workspaceRoot(deps);
  // Build the core destination prompt first; a validation failure exits 1
  // without marking. Mark the destination only after generation succeeds, then
  // print the prompt unchanged (CA-07).
  const built = buildHandoffPrompt(root, value.trim());
  if ("error" in built) {
    // Core buildHandoffPrompt returns only { error }; the CLI adds the
    // structured code so a caller can branch on it without re-deriving it
    // (consumes core, never re-implements validation).
    writeJSON(err, { ok: false, error: built.error, code: "handoff_build_failed" });
    return 1;
  }
  // buildHandoffPrompt already validated the plan path, so the slug derives
  // from it directly — no second resolveCanonicalLayout pass (markHandoffDestination
  // re-validates via resolveDoc anyway).
  const marked = markHandoffDestination(root, slugFromPath(built.plan), built.plan);
  if (!marked.ok) return domainFail(err, marked.code, marked.error, marked.details);
  write(out, built.prompt);
  return 0;
}
