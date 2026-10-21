// The hook's own deadline (issue #309). A host kills a hook past its timeout
// and discards its output; under machine load that silently drops the Workit
// context and gates. Past this deadline, below every host timeout, the hook
// answers a minimal valid result naming the skip and records it for doctor.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../core/logger";
import { dispatchHook } from "./handle";
import type { HookDecision, HookEventKind, HostAdapter, RenderedHook } from "./protocol";

export const HOOK_SKIP_TEXT = "workit context skipped: host under load";

/**
 * Below the shortest host timeout Workit registers (Codex Stop, 10 s; Claude
 * Code 15 s and 20 s), with room left for a dispatch that started in time.
 */
export const HOOK_DEADLINE_MS = 8_000;

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
  /** Milliseconds from `startedAt`; WORKIT_HOOK_DEADLINE_MS overrides. */
  deadlineMs?: number;
  /**
   * Epoch ms the budget counts from; the call by default. A hook-process
   * entry passes PROCESS_START so its start-up and module load count too.
   */
  startedAt?: number;
  now?: () => number;
  /** The handler step (test seam). */
  dispatch?: (
    adapter: HostAdapter,
    raw: unknown,
    env: NodeJS.ProcessEnv,
  ) => (RenderedHook & { error: string | null }) | Promise<RenderedHook & { error: string | null }>;
  record?: (skip: HookSkip) => void;
};

export type DeadlineResult = RenderedHook & { error: string | null; skipped: boolean };

export const hookDeadlineMs = (env: NodeJS.ProcessEnv): number => {
  const value = Number(env.WORKIT_HOOK_DEADLINE_MS);
  return Number.isFinite(value) && value > 0 ? value : HOOK_DEADLINE_MS;
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

/** Skips and late answers recorded since `since` (epoch ms). */
export const countHookSkips = (stateDir: string, since: number): { skip: number; late: number } => {
  const counts = { skip: 0, late: 0 };
  let text = "";
  try {
    text = readFileSync(skipsFile(stateDir), "utf8");
  } catch {
    return counts;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Partial<HookSkip>;
      const at = Date.parse(String(row.at));
      if (!(at >= since)) continue;
      if (row.outcome === "skip") counts.skip += 1;
      else if (row.outcome === "late") counts.late += 1;
    } catch {
      // A torn line from a concurrent append is not a skip.
    }
  }
  return counts;
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
  deadlineMs: number;
};

/** Epoch ms this process started. */
export const PROCESS_START = performance.timeOrigin;

export const hookBudget = (env: NodeJS.ProcessEnv, options: HookDeadline = {}): Budget => {
  const now = options.now ?? Date.now;
  return {
    now,
    record: options.record ?? ((skip) => recordHookSkip(skip)),
    startedAt: options.startedAt ?? now(),
    deadlineMs: options.deadlineMs ?? hookDeadlineMs(env),
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

/** The minimal result for a skipped hook, rendered in the host's own shape. */
export const skippedHook = (
  adapter: HostAdapter,
  raw: unknown,
  env: NodeJS.ProcessEnv,
  budget: Budget,
  stage: HookSkip["stage"],
): DeadlineResult => {
  let native: string | null = null;
  let event: HookEventKind | null = null;
  if (raw !== undefined) {
    const parsed = adapter.parse(raw, env);
    native = parsed.native;
    event = parsed.ok ? parsed.input.event.kind : parsed.event;
  }
  budget.record({
    at: new Date(budget.now()).toISOString(),
    host: adapter.descriptor.host,
    event,
    outcome: "skip",
    stage,
    elapsedMs: Math.round(budget.now() - budget.startedAt),
  });
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
  const remaining = () => budget.startedAt + budget.deadlineMs - budget.now();
  if (remaining() <= 0) return skippedHook(adapter, raw, env, budget, "dispatch");
  const result = await within(
    Promise.resolve().then(() => dispatch(adapter, raw, env)),
    remaining(),
  );
  if (isTimedOut(result)) return skippedHook(adapter, raw, env, budget, "dispatch");
  if (remaining() < 0) {
    const parsed = raw === undefined ? null : adapter.parse(raw, env);
    budget.record({
      at: new Date(budget.now()).toISOString(),
      host: adapter.descriptor.host,
      event: parsed ? (parsed.ok ? parsed.input.event.kind : parsed.event) : null,
      outcome: "late",
      stage: "done",
      elapsedMs: Math.round(budget.now() - budget.startedAt),
    });
  }
  return { ...result, skipped: false };
};
