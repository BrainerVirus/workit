// One terminal question for the CLI's confirmation prompts (grant raises,
// doctor --fix-lock --force). Ctrl+C or Ctrl+D while a readline question is
// pending rejects with an AbortError; that is the user cancelling, not a
// crash, so it surfaces as `Cancelled.` with the conventional SIGINT exit code
// instead of an uncaught_failure log.
import { createInterface } from "node:readline/promises";
// Type-only import: this module also runs under plain Node (cli-prompt.test.ts).
import type { Envelope, Io } from "./output";

/** 128 + SIGINT: the exit code shells use for an interrupted command. */
const CANCELLED_EXIT = 130;

/** The rejection readline/promises (and AbortSignal) use for an interrupted question. */
export const isPromptAbort = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ((error as { name?: unknown }).name === "AbortError" ||
    (error as { code?: unknown }).code === "ABORT_ERR");

/** What the single-key prompts read and write: the process's own terminal by default. */
export type KeyStreams = {
  input: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => unknown };
  output: NodeJS.WritableStream;
};
const terminal = (): KeyStreams => ({ input: process.stdin, output: process.stdout });

const abortError = (): Error =>
  Object.assign(new Error("The prompt was aborted."), { name: "AbortError" });

/**
 * Read single keypresses until `step` returns a value. Raw mode, so no Enter is
 * needed; Ctrl+C or Ctrl+D rejects with the AbortError askOrCancel turns into
 * `Cancelled.`. Keys `step` does not accept are ignored.
 */
function readKeys<T>(
  { input, output }: KeyStreams,
  start: () => void,
  step: (key: string) => { value: T; echo: string } | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (settle: () => void) => {
      input.removeListener("data", onData);
      input.setRawMode?.(false);
      input.pause();
      settle();
    };
    const onData = (chunk: Buffer | string) => {
      const key = String(chunk);
      if (key === "\x03" || key === "\x04") {
        output.write("\n");
        return finish(() => reject(abortError()));
      }
      const done = step(key);
      if (done) {
        output.write(done.echo);
        finish(() => resolve(done.value));
      }
    };
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
    start();
  });
}

/**
 * A scoped y/N at the terminal: y proceeds, n or Enter declines (the default is
 * No), every other key is ignored. Callers gate it on an interactive terminal.
 */
export function confirmKey(question: string, streams: KeyStreams = terminal()): Promise<boolean> {
  return readKeys<boolean>(
    streams,
    () => streams.output.write(`${question} [y/N] `),
    (key) =>
      /^[yY]$/.test(key)
        ? { value: true, echo: "yes\n" }
        : /^[nN]$|^[\r\n]+$/.test(key)
          ? { value: false, echo: "no\n" }
          : undefined,
  );
}

/**
 * An arrow-key select for more than two choices: up/down (or k/j) move, Enter
 * picks, a digit jumps to that choice. Resolves to the picked index.
 */
export function selectKey(
  question: string,
  choices: readonly string[],
  streams: KeyStreams = terminal(),
): Promise<number> {
  let at = 0;
  const draw = (redraw: boolean) =>
    streams.output.write(
      `${redraw ? `\x1b[${choices.length}A\r\x1b[J` : ""}${choices
        .map((choice, index) => `${index === at ? ">" : " "} ${choice}\n`)
        .join("")}`,
    );
  return readKeys<number>(
    streams,
    () => {
      streams.output.write(`${question}\n`);
      draw(false);
    },
    (key) => {
      if (key === "\r" || key === "\n") return { value: at, echo: "" };
      const move = key === "\x1b[A" || key === "k" ? -1 : key === "\x1b[B" || key === "j" ? 1 : 0;
      const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
      if (move) at = (at + move + choices.length) % choices.length;
      else if (digit >= 0 && digit < choices.length) at = digit;
      else return undefined;
      draw(true);
      return undefined;
    },
  );
}

/** Ask one question on the terminal and return the typed line. */
export async function askLine(
  question: string,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

/**
 * Run a prompt; an interrupted question resolves to `null` after telling the
 * user on stderr. Every other error propagates.
 */
export async function askOrCancel<T = string>(io: Io, ask: () => Promise<T>): Promise<T | null> {
  try {
    return await ask();
  } catch (error) {
    if (!isPromptAbort(error)) throw error;
    io.stderr("\nCancelled.\n");
    return null;
  }
}

/**
 * Finish a cancelled command: exit 130, and under --json one envelope
 * (`failed`, data.reason "cancelled") so stdout stays a single JSON document.
 */
export function cancelled(io: Io): number {
  if (io.json) {
    const envelope: Envelope = {
      ok: false,
      code: "failed",
      data: { reason: "cancelled" },
      error: "cancelled",
    };
    io.stdout(`${JSON.stringify(envelope)}\n`);
  }
  return CANCELLED_EXIT;
}
