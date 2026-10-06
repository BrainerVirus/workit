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
export async function askOrCancel(io: Io, ask: () => Promise<string>): Promise<string | null> {
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
