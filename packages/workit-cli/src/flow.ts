import { createInterface } from "node:readline/promises";
import path from "node:path";
import {
  assertSddControlGates,
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
import { sddAppendAdvisory, sddReviewPackage } from "@brainervirus/workit-core/src/core/sdd";
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

const FLOW_ACTIONS = ["status", "pause", "resume", "complete", "review-package", "append-advisory"] as const;
type FlowAction = (typeof FLOW_ACTIONS)[number];
type MutationAction = "pause" | "resume" | "complete";

// Single source of truth for the command surface: FLOW_COMMANDS (usage errors)
// and the index.tsx HELP text are both derived from COMMANDS so the exact
// command strings cannot drift.
export const COMMANDS = {
  status: "workit flow status --plan <path>",
  pause: "workit flow pause --plan <path> [--confirm]",
  resume: "workit flow resume --plan <path> [--confirm]",
  complete: "workit flow complete --plan <path> [--confirm]",
  "review-package":
    "workit flow review-package --plan <path> --base <sha> --head <sha> [--confirm]",
  "append-advisory":
    "workit flow append-advisory --plan <path> --task <id> --text <text> [--confirm]",
  handoff: "workit handoff --message <text>",
} as const;

const FLOW_COMMANDS: Record<FlowAction, string> = {
  status: COMMANDS.status,
  pause: COMMANDS.pause,
  resume: COMMANDS.resume,
  complete: COMMANDS.complete,
  "review-package": COMMANDS["review-package"],
  "append-advisory": COMMANDS["append-advisory"],
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

type ParsedFlow = { plan: string; confirm: boolean; base?: string; head?: string; task?: string; text?: string };

const VALUE_FLAGS = ["--plan", "--base", "--head", "--task", "--text"] as const;

function parseFlowFlags(
  action: FlowAction,
  argv: string[],
  err: { write: (chunk: string) => void },
): { ok: true; parsed: ParsedFlow } | { ok: false } {
  const parsed: Partial<ParsedFlow> = {};
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((VALUE_FLAGS as readonly string[]).includes(token)) {
      if (token !== "--plan" && action !== "review-package" && action !== "append-advisory") {
        usage(err, `usage: ${FLOW_COMMANDS[action]} — unknown flag: ${token}`);
        return { ok: false };
      }
      if ((token === "--base" || token === "--head") && action !== "review-package") {
        usage(err, `usage: ${FLOW_COMMANDS[action]} — unknown flag: ${token}`);
        return { ok: false };
      }
      if ((token === "--task" || token === "--text") && action !== "append-advisory") {
        usage(err, `usage: ${FLOW_COMMANDS[action]} — unknown flag: ${token}`);
        return { ok: false };
      }
      const value = argv[i + 1];
      if (value === undefined || value.trim() === "") {
        const label = token === "--plan" ? "path" : "value";
        usage(err, `usage: ${FLOW_COMMANDS[action]} — ${token} requires a non-empty ${label}`);
        return { ok: false };
      }
      if (value.startsWith("--")) {
        usage(err, `usage: ${FLOW_COMMANDS[action]} — unknown flag: ${value}`);
        return { ok: false };
      }
      const existing =
        token === "--plan"
          ? parsed.plan
          : token === "--base"
            ? parsed.base
            : token === "--head"
              ? parsed.head
              : token === "--task"
                ? parsed.task
                : parsed.text;
      if (existing !== undefined) {
        usage(err, `usage: ${FLOW_COMMANDS[action]} — duplicate ${token} flag`);
        return { ok: false };
      }
      if (token === "--plan") parsed.plan = value;
      else if (token === "--base") parsed.base = value;
      else if (token === "--head") parsed.head = value;
      else if (token === "--task") parsed.task = value;
      else parsed.text = value;
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
  if (parsed.plan === undefined) {
    usage(err, `usage: ${FLOW_COMMANDS[action]} — --plan <path> required`);
    return { ok: false };
  }
  if (action === "review-package") {
    if (parsed.base === undefined) {
      usage(err, `usage: ${FLOW_COMMANDS[action]} — --base <sha> required`);
      return { ok: false };
    }
    if (parsed.head === undefined) {
      usage(err, `usage: ${FLOW_COMMANDS[action]} — --head <sha> required`);
      return { ok: false };
    }
  }
  if (action === "append-advisory") {
    if (parsed.task === undefined) {
      usage(err, `usage: ${FLOW_COMMANDS[action]} — --task <id> required`);
      return { ok: false };
    }
    if (parsed.text === undefined) {
      usage(err, `usage: ${FLOW_COMMANDS[action]} — --text <text> required`);
      return { ok: false };
    }
  }
  return { ok: true, parsed: { plan: parsed.plan, confirm, base: parsed.base, head: parsed.head, task: parsed.task, text: parsed.text } };
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

function reviewPackageCommand(
  root: string,
  parsed: ParsedFlow,
  out: { write: (chunk: string) => void },
  err: { write: (chunk: string) => void },
): number {
  const resolved = resolveCanonicalLayout({ workspace_root: root, plan_path: parsed.plan });
  if (!resolved.ok) return domainFail(err, "path_invalid", resolved.error);
  // CLI port wrapper: call the shared core guard, never a re-implementation of
  // the empty-range check (parity with OpenCode/Cursor adapters).
  const result = sddReviewPackage({
    sdd_dir: path.posix.join("docs", resolved.layout.slug, "sdd"),
    base_sha: parsed.base as string,
    head_sha: parsed.head as string,
    workspace_root: root,
  });
  if ("diff_path" in result) {
    writeJSON(out, {
      ok: true,
      diff_path: result.diff_path,
      base_sha: result.base_sha,
      head_sha: result.head_sha,
    });
    return 0;
  }
  return domainFail(err, result.code ?? "review_package_failed", result.error);
}

function appendAdvisoryCommand(
  root: string,
  parsed: ParsedFlow,
  out: { write: (chunk: string) => void },
  err: { write: (chunk: string) => void },
): number {
  const resolved = resolveCanonicalLayout({ workspace_root: root, plan_path: parsed.plan });
  if (!resolved.ok) return domainFail(err, "path_invalid", resolved.error);
  const slug = resolved.layout.slug;
  const controlGate = assertSddControlGates(root, slug, { requireMenu: true, requireDocs: true });
  if (!controlGate.ok) return domainFail(err, controlGate.code, controlGate.error);
  // Numeric-looking argv becomes a number so core validates safe-integer and
  // fractional cases; anything else stays a string and fails advisory_task_invalid.
  const trimmed = (parsed.task as string).trim();
  const taskId: unknown = /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed;
  const result = sddAppendAdvisory({
    advisories_path: path.posix.join("docs", slug, "sdd", "advisories.md"),
    task_id: taskId,
    text: parsed.text as string,
    workspace_root: root,
  });
  if ("error" in result) {
    return domainFail(err, result.code ?? "advisory_failed", result.error);
  }
  writeJSON(out, { ok: true, advisories_path: result.advisories_path, advisory: result.advisory });
  return 0;
}

export async function runFlowCommand(argv: string[], deps: FlowCliDeps = {}): Promise<number> {
  const out = outStream(deps);
  const err = errStream(deps);
  const [action, ...rest] = argv;
  if (!action || !(FLOW_ACTIONS as readonly string[]).includes(action)) {
    return usage(
      err,
      "usage: workit flow <status|pause|resume|complete|review-package|append-advisory> --plan <path> [--confirm]",
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
  if (flowAction === "review-package") {
    return reviewPackageCommand(root, parsed.parsed, out, err);
  }
  if (flowAction === "append-advisory") {
    return appendAdvisoryCommand(root, parsed.parsed, out, err);
  }
  return mutateCommand(root, parsed.parsed.plan, flowAction as MutationAction, evidence, deps, out, err);
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
