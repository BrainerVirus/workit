// Shared CLI conventions (design §2.0): one output envelope, one exit-code
// table, `--json` for machines and plain lines for humans. Every verb under
// verbs/ reports through `emit` so agents can rely on the same shape and the
// same exit codes everywhere. Kept dependency-free: the router loads it on the
// cold path.

import { createStyle, type TerminalStream } from "./style";

export type EnvelopeCode =
  | "ok"
  | "failed"
  | "blocked"
  | "busy"
  | "invalid_input"
  | "unavailable"
  | "not_found"
  | "pending"
  | "not_implemented";

export type Envelope<T = Record<string, unknown>> = {
  ok: boolean;
  code: EnvelopeCode;
  data: T;
  error?: string;
  /** The exact command or user action that clears a `blocked`/`unavailable`. */
  unblock?: string;
  /** Things that went through but deserve attention (also printed on stderr). */
  warnings?: string[];
};

/** 0 ok · 1 failed · 2 usage · 3 blocked · 4 busy/pending · 5 unavailable. */
const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  blocked: 3,
  busy: 4,
  unavailable: 5,
} as const;

const EXIT_BY_CODE: Record<EnvelopeCode, number> = {
  ok: EXIT.ok,
  failed: EXIT.failed,
  not_found: EXIT.failed,
  invalid_input: EXIT.usage,
  // A planned verb is a usage error today, not a failure of the user's code.
  not_implemented: EXIT.usage,
  blocked: EXIT.blocked,
  busy: EXIT.busy,
  pending: EXIT.busy,
  unavailable: EXIT.unavailable,
};

const exitCodeFor = (code: EnvelopeCode): number => EXIT_BY_CODE[code];

/** What a verb gets besides its argv: resolved global flags and the streams. */
export type Io = {
  /** `--json` was passed anywhere on the command line. */
  json: boolean;
  /** `--cwd <dir>` resolved to an absolute path (default: process.cwd()). */
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * The real streams behind stdout/stderr, when they are the process's own:
   * human output colors only for a terminal. Absent (a capture, a test) = plain.
   */
  terminals?: { stdout?: TerminalStream; stderr?: TerminalStream };
};

export type Verb = { run: (argv: string[], io: Io) => Promise<number> };

export const ok = <T>(data: T): Envelope<T> => ({ ok: true, code: "ok", data });

export const fail = <T = Record<string, unknown>>(
  code: Exclude<EnvelopeCode, "ok">,
  error: string,
  extra: { data?: T; unblock?: string } = {},
): Envelope<T> => ({
  ok: false,
  code,
  data: (extra.data ?? {}) as T,
  error,
  ...(extra.unblock ? { unblock: extra.unblock } : {}),
});

/**
 * Print an envelope and return its exit code. `--json` prints the envelope as
 * one JSON document on stdout. Human mode prints `human(data)` on success and
 * `error` plus the unblock hint on stderr otherwise.
 */
export function emit<T>(
  io: Io,
  envelope: Envelope<T>,
  human?: (data: T) => string | readonly string[],
): number {
  if (io.json) {
    io.stdout(`${JSON.stringify(envelope)}\n`);
  } else if (envelope.ok) {
    const text = human?.(envelope.data);
    const lines = typeof text === "string" ? [text] : (text ?? []);
    for (const value of lines) io.stdout(`${value}\n`);
  } else {
    io.stderr(`workit: ${envelope.error ?? envelope.code}\n`);
    if (envelope.unblock) io.stderr(`  unblock: ${envelope.unblock}\n`);
  }
  return exitCodeFor(envelope.code);
}

const EXIT_NAMES: Record<number, EnvelopeCode> = {
  1: "failed",
  2: "invalid_input",
  3: "blocked",
  4: "busy",
  5: "unavailable",
};

/**
 * Run a verb so that a non-zero exit always prints a line naming it (#533).
 * With an `outcome` (a delivery verb: "PR not merged"), every non-zero exit,
 * refused before the verb ran or inside it, ends with
 * `workit: error: <outcome> (<reason>, exit N)`: agents filter output with
 * `grep -E '^merged|error'`, and a refusal such as `workit: not_ready: …`
 * slipped through and read as a silent no-op. Without one, a verb that fails
 * without writing anything still leaves `workit: error: <command> failed (exit N)`.
 */
export async function withFailureLine(
  io: Io,
  command: string,
  run: (io: Io) => Promise<number>,
  outcome?: string,
): Promise<number> {
  let wrote = false;
  let reason: string | null = null;
  const code = await run({
    ...io,
    stdout: (text) => {
      wrote ||= text.length > 0;
      io.stdout(text);
    },
    stderr: (text) => {
      wrote ||= text.length > 0;
      reason ??= /^workit: ([a-z][a-z_]*):/u.exec(text)?.[1] ?? null;
      io.stderr(text);
    },
  });
  if (code === 0) return code;
  const red = createStyle({ stream: io.terminals?.stderr, env: io.env, json: io.json }).fail;
  if (outcome)
    io.stderr(
      `${red(`workit: error: ${outcome} (${reason ?? EXIT_NAMES[code] ?? "failed"}, exit ${code})`)}\n`,
    );
  else if (!wrote) io.stderr(`${red(`workit: error: ${command} failed (exit ${code})`)}\n`);
  return code;
}

type Flushable = {
  write: (chunk: string, done: (error?: Error | null) => void) => boolean;
};

/**
 * Resolve once everything queued on `streams` is handed to the OS, so a
 * `process.exit` after it loses no output when stdout or stderr is a pipe.
 * A stream that never drains (its reader gone) is given up after `timeoutMs`.
 */
export const flushStreams = async (
  streams: readonly Flushable[] = [process.stdout, process.stderr],
  timeoutMs = 2_000,
): Promise<void> => {
  await Promise.all(
    streams.map(
      (stream) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          try {
            stream.write("", done);
          } catch {
            done();
          }
        }),
    ),
  );
};
