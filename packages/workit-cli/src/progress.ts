// Step feedback for slow CLI verbs: a spinner on stderr with the step label and
// elapsed seconds, one finished line per step. It draws only on a TTY and never
// under --json, CI=true, or a non-TTY stream (an agent host), so stdout and
// piped stderr stay byte-identical to a run without it. Dependency-free.

import { spawn } from "node:child_process";
import path from "node:path";
import { SPINNER_FRAMES, SPINNER_FRAME_MS, spinnerPaint, terminalMode } from "./style";

export type StepStatus = "done" | "failed" | "skipped";
type ProgressMode = ReturnType<typeof terminalMode>;
export type ProgressStep = {
  /** Change the label the spinner shows (e.g. the checks still pending). */
  label: (text: string) => void;
  /** Finish the step: clear the spinner line, leave one status line. */
  end: (status: StepStatus, note?: string) => void;
};
export type RunOptions = { signals?: boolean };
export type Progress = {
  readonly mode: ProgressMode;
  start: (label: string) => ProgressStep;
  /**
   * An async step; a throw ends it as failed and rethrows. `signals: true`
   * keeps a SIGINT/SIGTERM handler that clears the frame and re-raises: only
   * for work that never blocks in a spawnSync, which would defer the signal.
   */
  run: <T>(
    label: string,
    fn: () => Promise<T>,
    classify?: (value: T) => StepStatus,
    options?: RunOptions,
  ) => Promise<T>;
  /**
   * A step around synchronous work. A timer cannot tick while the thread is
   * blocked, so on the real stderr a helper process draws the frames; on any
   * other stream it shows one static line.
   */
  runSync: <T>(label: string, fn: () => T, classify?: (value: T) => StepStatus) => T;
};
export type ProgressOptions = {
  stream?: {
    isTTY?: boolean;
    columns?: number;
    write: (text: string) => unknown;
  };
  env?: NodeJS.ProcessEnv;
  json?: boolean;
  now?: () => number;
  setInterval?: (tick: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  /** Draws the spinner while synchronous work blocks this thread (default: a helper process on the real stderr). */
  spawnTicker?: (label: string, began: number) => { stop: () => void } | undefined;
  /** Process seam for interrupt cleanup (default: the real process). */
  proc?: ProgressProcess;
  /**
   * On a color TTY, a step that ends done or skipped clears its line instead of
   * leaving one: for a verb whose final report already lists every outcome.
   * A failed step still leaves its line.
   */
  transient?: boolean;
};
type ProgressProcess = {
  pid: number;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  off: (event: string, listener: (...args: any[]) => void) => unknown;
  kill: (pid: number, signal: string) => unknown;
};

const FRAMES = SPINNER_FRAMES;
const FRAME_MS = SPINNER_FRAME_MS;
const CLEAR = "\r\x1b[2K";

// The helper redraws the same line as `draw` below from its own process, so the
// frames keep moving while the parent thread sits in a spawnSync. It ends with
// its parent (a vanished ppid) and after ten minutes, so it can never linger.
const TICKER_SOURCE = `
const frames = ${JSON.stringify(FRAMES)};
const { WORKIT_TICK_LABEL: label, WORKIT_TICK_BEGAN: began, WORKIT_TICK_COLS: cols } = process.env;
const spinnerPaint = ${spinnerPaint.toString()};
const parent = process.ppid;
let frame = 0;
const timer = setInterval(() => {
  let alive = process.ppid === parent;
  if (alive) try { process.kill(parent, 0); } catch { alive = false; }
  if (!alive || Date.now() - Number(began) > 600000) process.exit(0);
  frame += 1;
  const seconds = Math.floor((Date.now() - Number(began)) / 1000);
  let line = label + " (" + seconds + "s)";
  if (Number(cols) && line.length + 2 >= Number(cols)) line = line.slice(0, Math.max(1, Number(cols) - 4)) + "…";
  process.stderr.write(${JSON.stringify(CLEAR)} + spinnerPaint(Date.now() - Number(began), process.env, frames[frame % frames.length]) + " " + line);
}, ${FRAME_MS});
`;

const defaultTicker = (
  label: string,
  began: number,
  stream: NonNullable<ProgressOptions["stream"]>,
): { stop: () => void } | undefined => {
  if (stream !== process.stderr) return undefined;
  if (!/^(?:node|nodejs|bun)(?:\.exe)?$/i.test(path.basename(process.execPath))) return undefined;
  try {
    const child = spawn(process.execPath, ["-e", TICKER_SOURCE], {
      env: {
        ...process.env,
        WORKIT_TICK_LABEL: label,
        WORKIT_TICK_BEGAN: String(began),
        WORKIT_TICK_COLS: String(stream.columns ?? 0),
      },
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    return { stop: () => void child.kill("SIGKILL") };
  } catch {
    return undefined;
  }
};

const NOOP_STEP: ProgressStep = { label: () => {}, end: () => {} };

export function createProgress(options: ProgressOptions = {}): Progress {
  const env = options.env ?? process.env;
  const mode = terminalMode({ ...options, env });
  const stream = options.stream;
  const now = options.now ?? Date.now;
  const every = options.setInterval ?? ((tick, ms) => setInterval(tick, ms));
  const stop = options.clearInterval ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const proc: ProgressProcess = options.proc ?? process;
  const ascii = env.TERM === "dumb";
  const glyphs: Record<StepStatus, string> =
    mode === "spinner"
      ? { done: "\x1b[32m✓\x1b[0m", failed: "\x1b[31m✗\x1b[0m", skipped: "–" }
      : ascii
        ? { done: "ok", failed: "x", skipped: "-" }
        : { done: "✓", failed: "✗", skipped: "–" };

  const start = (initial: string, signals = true): ProgressStep => {
    if (mode === "off" || !stream) return NOOP_STEP;
    let text = initial;
    let finished = false;
    const began = now();
    let frame = 0;
    const draw = () => {
      const seconds = Math.floor((now() - began) / 1000);
      let line = `${text} (${seconds}s)`;
      if (stream.columns && line.length + 2 >= stream.columns)
        line = `${line.slice(0, Math.max(1, stream.columns - 4))}…`;
      const glyph = spinnerPaint(now() - began, env, FRAMES[frame % FRAMES.length] ?? "");
      stream.write(`${CLEAR}${glyph} ${line}`);
    };
    let timer: unknown;
    if (mode === "spinner") {
      draw();
      timer = every(() => {
        frame += 1;
        draw();
      }, FRAME_MS);
    }
    // A frame left on screen by an interrupt would sit before the shell prompt:
    // clear it, drop our handlers, then end the way the process would have.
    const handlers: [string, (...args: any[]) => void][] = [];
    const release = () => {
      for (const [event, handler] of handlers) proc.off(event, handler);
      handlers.length = 0;
    };
    if (mode === "spinner" && signals) {
      const onSignal = (signal: string) => () => {
        if (!finished) {
          finished = true;
          if (timer !== undefined) stop(timer);
          stream.write(CLEAR);
        }
        release();
        proc.kill(proc.pid, signal);
      };
      handlers.push(["SIGINT", onSignal("SIGINT")], ["SIGTERM", onSignal("SIGTERM")]);
    }
    if (mode === "spinner") {
      const onExit = () => {
        if (!finished) stream.write(CLEAR);
      };
      handlers.push(["exit", onExit]);
      for (const [event, handler] of handlers) proc.on(event, handler);
    }
    return {
      label: (next) => {
        text = next;
        if (mode === "spinner" && !finished) draw();
      },
      end: (status, note) => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) stop(timer);
        release();
        if (mode === "spinner" && options.transient && status !== "failed") {
          stream.write(CLEAR);
          return;
        }
        stream.write(
          `${mode === "spinner" ? CLEAR : ""}${glyphs[status]} ${text}${note ? `: ${note}` : ""}\n`,
        );
      },
    };
  };

  return {
    mode,
    start,
    async run(label, fn, classify, runOptions) {
      // By default, as runSync: the work may block in a spawnSync between
      // awaits, so no handler may defer Ctrl-C; the default action ends the
      // process at once. A caller whose work never blocks opts in to the clear.
      const step = start(label, runOptions?.signals === true);
      try {
        const value = await fn();
        step.end(classify ? classify(value) : "done");
        return value;
      } catch (error) {
        step.end("failed");
        throw error;
      }
    },
    runSync(label, fn, classify) {
      // No signal handler here: one would hold Ctrl-C until the blocking call
      // returns, and the verb would report its killed child as a failure. The
      // default action ends the process at once, as it does without a spinner.
      const step = start(label, false);
      const ticker =
        mode === "spinner" && stream
          ? (options.spawnTicker ?? ((text, began) => defaultTicker(text, began, stream)))(
              label,
              now(),
            )
          : undefined;
      try {
        const value = fn();
        ticker?.stop();
        step.end(classify ? classify(value) : "done");
        return value;
      } catch (error) {
        ticker?.stop();
        step.end("failed");
        throw error;
      }
    },
  };
}

/**
 * The spinner for a verb's waits, on the process's own stderr only: an Io whose
 * stderr is captured (a test, an agent wrapper) or --json gets no frames.
 */
export const progressFor = (io: {
  json: boolean;
  env: NodeJS.ProcessEnv;
  terminals?: { stderr?: { isTTY?: boolean; columns?: number; write?: (text: string) => unknown } };
}): Progress => {
  const stderr = io.terminals?.stderr;
  // Pass the stream itself: runSync's helper process draws only on the real stderr.
  const stream = stderr?.write ? (stderr as NonNullable<ProgressOptions["stream"]>) : undefined;
  return createProgress({ json: io.json, env: io.env, ...(stream ? { stream } : {}) });
};
