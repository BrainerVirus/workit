// Step feedback for slow CLI verbs: a spinner on stderr with the step label and
// elapsed seconds, one finished line per step. It draws only on a TTY and never
// under --json, CI=true, or a non-TTY stream (an agent host), so stdout and
// piped stderr stay byte-identical to a run without it. Dependency-free.

export type StepStatus = "done" | "failed" | "skipped";
type ProgressMode = "spinner" | "plain" | "off";
export type ProgressStep = {
  /** Change the label the spinner shows (e.g. the checks still pending). */
  label: (text: string) => void;
  /** Finish the step: clear the spinner line, leave one status line. */
  end: (status: StepStatus, note?: string) => void;
};
export type Progress = {
  readonly mode: ProgressMode;
  start: (label: string) => ProgressStep;
  /** An async step; a throw ends it as failed and rethrows. */
  run: <T>(label: string, fn: () => Promise<T>, classify?: (value: T) => StepStatus) => Promise<T>;
  /**
   * A step around synchronous work. A timer cannot tick while the thread is
   * blocked, so it shows one static line instead of an animation.
   */
  runSync: <T>(label: string, fn: () => T, classify?: (value: T) => StepStatus) => T;
};
export type ProgressOptions = {
  stream?: { isTTY?: boolean; columns?: number; write: (text: string) => unknown };
  env?: NodeJS.ProcessEnv;
  json?: boolean;
  now?: () => number;
  setInterval?: (tick: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
};

const FRAMES = ["·", "✢", "✳", "∗", "✻", "✽"];
const FRAME_MS = 120;
const CLEAR = "\r\x1b[2K";

const truthy = (value: string | undefined): boolean =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

const modeFor = (options: ProgressOptions, env: NodeJS.ProcessEnv): ProgressMode => {
  if (options.json || !options.stream?.isTTY || truthy(env.CI)) return "off";
  if (truthy(env.NO_COLOR) || env.TERM === "dumb") return "plain";
  return "spinner";
};

const NOOP_STEP: ProgressStep = { label: () => {}, end: () => {} };

export function createProgress(options: ProgressOptions = {}): Progress {
  const env = options.env ?? process.env;
  const mode = modeFor(options, env);
  const stream = options.stream;
  const now = options.now ?? Date.now;
  const every = options.setInterval ?? ((tick, ms) => setInterval(tick, ms));
  const stop = options.clearInterval ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const ascii = env.TERM === "dumb";
  const glyphs: Record<StepStatus, string> =
    mode === "spinner"
      ? { done: "\x1b[32m✓\x1b[0m", failed: "\x1b[31m✗\x1b[0m", skipped: "–" }
      : ascii
        ? { done: "ok", failed: "x", skipped: "-" }
        : { done: "✓", failed: "✗", skipped: "–" };

  const start = (initial: string): ProgressStep => {
    if (mode === "off" || !stream) return NOOP_STEP;
    let text = initial;
    let finished = false;
    const began = now();
    let frame = 0;
    const draw = () => {
      const seconds = Math.floor((now() - began) / 1000);
      let line = `${FRAMES[frame % FRAMES.length]} ${text} (${seconds}s)`;
      if (stream.columns && line.length >= stream.columns)
        line = `${line.slice(0, Math.max(1, stream.columns - 2))}…`;
      stream.write(`${CLEAR}${line}`);
    };
    let timer: unknown;
    if (mode === "spinner") {
      draw();
      timer = every(() => {
        frame += 1;
        draw();
      }, FRAME_MS);
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
        stream.write(
          `${mode === "spinner" ? CLEAR : ""}${glyphs[status]} ${text}${note ? `: ${note}` : ""}\n`,
        );
      },
    };
  };

  return {
    mode,
    start,
    async run(label, fn, classify) {
      const step = start(label);
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
      const step = start(label);
      try {
        const value = fn();
        step.end(classify ? classify(value) : "done");
        return value;
      } catch (error) {
        step.end("failed");
        throw error;
      }
    },
  };
}
