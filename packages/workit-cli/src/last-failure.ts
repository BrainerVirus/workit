// Each session's last failing verb and its exit text (#916 item 6), so
// `workit feedback` fills `--verb` and the exit text in by itself. One file
// per session in `<state>/last-failure/<session>.json` (mode 0600), keyed by
// WORKIT_SESSION_ID, else `terminal`; the next failure in that session
// replaces it. Kept raw on the machine: feedback redacts it into the draft.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir as workitStateDir } from "@workit-dev/core/src/core/workit-paths.mjs";
import type { Io } from "./output";

export type LastFailure = { at: number; verb: string; exit: number; text: string };

/** The exit text kept: its last characters, where the error and unblock lines are. */
const TEXT_LIMIT = 4_000;
const VERB_LIMIT = 500;
/** An older failure is not the one the agent is reporting. */
export const FRESH_MS = 24 * 60 * 60 * 1000;

const sessionKey = (env: NodeJS.ProcessEnv): string =>
  (env.WORKIT_SESSION_ID?.trim() || "terminal").replaceAll(/[^\w.:-]+/gu, "_").slice(0, 120);

const fileFor = (env: NodeJS.ProcessEnv): string =>
  path.join(workitStateDir(env), "last-failure", `${sessionKey(env).replaceAll(":", "_")}.json`);

/** `workit <argv>`, each word with spaces or quotes shell-quoted. */
export const verbLine = (argv: readonly string[]): string =>
  ["workit", ...argv]
    .map((word) => (/^[\w./:=@%+,-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`))
    .join(" ")
    .slice(0, VERB_LIMIT);

/**
 * Run `run`, keeping what it writes; on a non-zero exit record it as this
 * session's last failure. Recording never fails the verb.
 */
export async function recordingFailure(
  io: Io,
  argv: readonly string[],
  run: (io: Io) => Promise<number>,
  now: () => number = Date.now,
): Promise<number> {
  let text = "";
  const keep = (chunk: string) => {
    text = (text + chunk).slice(-TEXT_LIMIT);
  };
  const code = await run({
    ...io,
    stdout: (chunk) => {
      keep(chunk);
      io.stdout(chunk);
    },
    stderr: (chunk) => {
      keep(chunk);
      io.stderr(chunk);
    },
  });
  if (code !== 0) {
    const record: LastFailure = { at: now(), verb: verbLine(argv), exit: code, text };
    try {
      const file = fileFor(io.env);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // A read-only or missing state dir only loses the hint.
    }
  }
  return code;
}

/** This session's last failure when it is under a day old, else null. */
export function readLastFailure(
  env: NodeJS.ProcessEnv,
  now: () => number = Date.now,
): LastFailure | null {
  try {
    const value = JSON.parse(readFileSync(fileFor(env), "utf8")) as Partial<LastFailure>;
    if (
      typeof value.at !== "number" ||
      typeof value.verb !== "string" ||
      typeof value.exit !== "number" ||
      typeof value.text !== "string" ||
      now() - value.at > FRESH_MS
    )
      return null;
    return value as LastFailure;
  } catch {
    return null;
  }
}
