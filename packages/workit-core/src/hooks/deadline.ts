// The hook's own deadline (issue #309). A host kills a hook past its timeout
// and discards its output; under machine load that silently drops the Workit
// context and gates. Past this deadline, below every host timeout, the hook
// answers a minimal valid result naming the skip and records it for doctor.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../core/logger";
import { dispatchHook } from "./handle";
import type { HookDecision, HookEventKind, HostAdapter, RenderedHook } from "./protocol";

export const HOOK_SKIP_TEXT = "workit context skipped: host under load";

/** For a host without its own row; Claude Code's prompt/tool/subagent value. */
export const HOOK_DEADLINE_MS = 8_000;

/**
 * Per host, by native event ("" for the rest): a margin below the host's own
 * timeout, left for a dispatch that started in time. Claude Code registers
 * 15 s (20 s for SessionStart and Stop); Codex defaults to 600 s and Workit
 * registers 20 s for Stop; Cursor defaults to 60 s.
 */
export const HOST_DEADLINES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  claude_code: { "": 8_000, SessionStart: 16_000, Stop: 16_000 },
  codex_cli: { "": 45_000, Stop: 16_000 },
  codex_desktop: { "": 45_000, Stop: 16_000 },
  cursor: { "": 45_000 },
};

/** One JSON HookSkip per line; `workit doctor` (hook_deadline) reads it. */
export const HOOK_SKIPS_FILE = "hook-skips.jsonl";

/** `skip`: the hook answered the minimal result; `late`: it answered in full, past the deadline. */
export type HookSkip = {
  at: string;
  host: string;
  event: HookEventKind | null;
  outcome: "skip" | "late";
  stage: "input" | "dispatch" | "done";
  elapsedMs: number;
};

export type HookDeadline = {
  /** Milliseconds from `startedAt`; by default WORKIT_HOOK_DEADLINE_MS, else HOST_DEADLINES. */
  deadlineMs?: number;
  /**
   * Epoch ms the budget counts from; the call by default. A hook-process
   * entry passes PROCESS_START so its start-up and module load count too.
   */
  startedAt?: number;
  now?: () => number;
  /** The handler step; dispatchHook unless a host handles the event itself. */
  dispatch?: (
    adapter: HostAdapter,
    raw: unknown,
    env: NodeJS.ProcessEnv,
  ) => (RenderedHook & { error: string | null }) | Promise<RenderedHook & { error: string | null }>;
  record?: (skip: HookSkip) => void;
};

export type DeadlineResult = RenderedHook & { error: string | null; skipped: boolean };

const override = (env: NodeJS.ProcessEnv): number | null => {
  const value = Number(env.WORKIT_HOOK_DEADLINE_MS);
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** The deadline for one native event; `native` undefined gives the host's shortest. */
export const hookDeadlineMs = (env: NodeJS.ProcessEnv, host = "", native?: string): number => {
  const row = HOST_DEADLINES[host];
  return (
    override(env) ??
    (row
      ? native === undefined
        ? Math.min(...Object.values(row))
        : (row[native] ?? row[""])
      : HOOK_DEADLINE_MS)
  );
};

const skipsFile = (stateDir: string) => path.join(stateDir, HOOK_SKIPS_FILE);

/** Best effort: a read-only state dir never changes the hook's answer. */
export const recordHookSkip = (skip: HookSkip, stateDir: string = resolveStateDir()): void => {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(skipsFile(stateDir), `${JSON.stringify(skip)}\n`);
  } catch {
    // The skip still reached the host; only the doctor count is lost.
  }
};

const QUIET: ReadonlySet<HookEventKind | null> = new Set([
  "stop",
  "subagent.stop",
  "shell.post",
  "compact.pre",
  "prompt.submit",
  null,
]);

/** The minimal answer: the skip named where the event has a model channel, else no decision. */
const skipDecision = (event: HookEventKind | null): HookDecision =>
  QUIET.has(event) ? { kind: "none" } : { kind: "context", text: HOOK_SKIP_TEXT };

const TIMED_OUT = Symbol("timed out");

/** Resolves to `work`'s value, or TIMED_OUT when `ms` passes first. */
export const within = async <T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
    timer.unref?.();
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
};

export const isTimedOut = (value: unknown): value is typeof TIMED_OUT => value === TIMED_OUT;

type Budget = Required<Pick<HookDeadline, "now" | "record">> & {
  startedAt: number;
  /** The host's shortest until the payload names its event. */
  deadlineMs: number;
  /** The host whose HOST_DEADLINES row refines it per event; null when the caller fixed it. */
  host: string | null;
};

/** Epoch ms this process started. */
export const PROCESS_START = performance.timeOrigin;

export const hookBudget = (
  env: NodeJS.ProcessEnv,
  options: HookDeadline = {},
  host = "",
): Budget => {
  const now = options.now ?? Date.now;
  return {
    now,
    record: options.record ?? ((skip) => recordHookSkip(skip)),
    startedAt: options.startedAt ?? now(),
    deadlineMs: options.deadlineMs ?? hookDeadlineMs(env, host),
    host: options.deadlineMs === undefined ? host : null,
  };
};

/** Reads the whole payload, or null when the deadline passes first. */
export const readWithin = async (
  stdin: AsyncIterable<unknown> | Iterable<unknown>,
  budget: Budget,
): Promise<string | null> => {
  const read = (async () => {
    let text = "";
    for await (const chunk of stdin) text += String(chunk);
    return text;
  })();
  const text = await within(read, budget.startedAt + budget.deadlineMs - budget.now());
  return isTimedOut(text) ? null : text;
};

/** Records one outcome; returns the parsed native event name for rendering. */
const note = (
  adapter: HostAdapter,
  raw: unknown,
  env: NodeJS.ProcessEnv,
  budget: Budget,
  outcome: HookSkip["outcome"],
  stage: HookSkip["stage"],
): { native: string | null; event: HookEventKind | null } => {
  const parsed = raw === undefined ? null : adapter.parse(raw, env);
  const event = parsed ? (parsed.ok ? parsed.input.event.kind : parsed.event) : null;
  budget.record({
    at: new Date(budget.now()).toISOString(),
    host: adapter.descriptor.host,
    event,
    outcome,
    stage,
    elapsedMs: Math.round(budget.now() - budget.startedAt),
  });
  return { native: parsed?.native ?? null, event };
};

/** The minimal result for a skipped hook, rendered in the host's own shape. */
export const skippedHook = (
  adapter: HostAdapter,
  raw: unknown,
  env: NodeJS.ProcessEnv,
  budget: Budget,
  stage: HookSkip["stage"],
): DeadlineResult => {
  const { native, event } = note(adapter, raw, env, budget, "skip", stage);
  return {
    ...adapter.render(skipDecision(event), native),
    error: `${HOOK_SKIP_TEXT} (past the ${budget.deadlineMs} ms hook deadline)`,
    skipped: true,
  };
};

/**
 * dispatchHook under the deadline: a hook already past it answers the
 * minimal result without running the handler, and a handler that overruns
 * it is abandoned. A synchronous handler cannot be interrupted once started;
 * one that finishes late answers in full and is recorded as late.
 */
export const dispatchWithin = async (
  adapter: HostAdapter,
  raw: unknown,
  env: NodeJS.ProcessEnv,
  budget: Budget,
  dispatch: NonNullable<HookDeadline["dispatch"]> = dispatchHook,
): Promise<DeadlineResult> => {
  const native = (raw as { hook_event_name?: unknown } | null)?.hook_event_name;
  if (budget.host !== null && typeof native === "string")
    budget.deadlineMs = hookDeadlineMs(env, budget.host, native);
  const remaining = () => budget.startedAt + budget.deadlineMs - budget.now();
  const result =
    remaining() > 0
      ? await within(
          Promise.resolve().then(() => dispatch(adapter, raw, env)),
          remaining(),
        )
      : TIMED_OUT;
  if (isTimedOut(result)) return skippedHook(adapter, raw, env, budget, "dispatch");
  if (remaining() < 0) note(adapter, raw, env, budget, "late", "done");
  return { ...result, skipped: false };
};
