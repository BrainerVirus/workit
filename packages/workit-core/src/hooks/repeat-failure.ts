// A repeated identical failing Workit call (#435): the second failure in a row
// of the same tool and args (or the same `workit …` command) in a session ends
// with one line naming the exact corrected next call, instead of the same error.
import { createHash } from "node:crypto";

export const SAME_CALL_FAILED = "Same call failed twice:";

/** The last failing call's hash per session, in the host plugin's own state. */
export type FailureMemo = Map<string, string>;

const MAX_SESSIONS = 256;

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).toSorted(([a], [b]) => a.localeCompare(b)))
      : entry,
  ) ?? "null";

const hashOf = (call: string): string =>
  createHash("sha256").update(call).digest("hex").slice(0, 32);

/**
 * Record this call's outcome for the session. A success clears the memo; a
 * failure returns the escalation line when the previous call failed the same
 * way and a corrected call is known.
 */
const record = (
  memo: FailureMemo,
  sessionId: string,
  call: string,
  failed: boolean,
  next: string | null,
): string | null => {
  const previous = memo.get(sessionId);
  memo.delete(sessionId);
  if (!failed) return null;
  const hash = hashOf(call);
  memo.set(sessionId, hash);
  if (memo.size > MAX_SESSIONS) memo.delete(memo.keys().next().value!);
  return previous === hash && next ? `${SAME_CALL_FAILED} ${next}` : null;
};

type Failed = { ok: false; error: string; details?: { guidance?: unknown } };

const isFailure = (result: unknown): result is Failed =>
  result !== null &&
  typeof result === "object" &&
  (result as { ok?: unknown }).ok === false &&
  typeof (result as { error?: unknown }).error === "string";

/** A failed tool result's corrected payload: its `Example:` or, failing that, its guidance. */
const correctedPayload = (tool: string, result: Failed): string | null => {
  const example = /Example: (\{.*\})\s*$/.exec(result.error)?.[1];
  if (example) return `${tool} ${example}`;
  const guidance = result.details?.guidance;
  return typeof guidance === "string" && guidance ? guidance : null;
};

/**
 * A Workit tool result, with the escalation line appended to its error when
 * the same tool and args failed on the session's previous call too.
 */
export const escalateToolFailure = <T>(
  memo: FailureMemo,
  sessionId: string,
  tool: string,
  input: unknown,
  result: T,
): T => {
  const failed = isFailure(result);
  const line = record(
    memo,
    sessionId,
    `tool\0${tool}\0${stable(input)}`,
    failed,
    failed ? correctedPayload(tool, result) : null,
  );
  return line && failed ? { ...result, error: `${result.error}\n${line}` } : result;
};

const WORKIT_COMMAND = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*workit\s/;

const unblockOf = (output: string): string | null => {
  const human = /^\s*unblock: (.+)$/m.exec(output)?.[1];
  if (human) return human.trim();
  const json = /"unblock":("(?:[^"\\]|\\.)*")/.exec(output)?.[1];
  if (!json) return null;
  try {
    return JSON.parse(json) as string;
  } catch {
    return null;
  }
};

/**
 * The escalation line for a finished `workit …` shell command, or null: a
 * failed run is one whose output carries the CLI's error envelope.
 */
export const repeatedCliFailure = (
  memo: FailureMemo,
  sessionId: string,
  command: string,
  output: string,
): string | null => {
  if (!WORKIT_COMMAND.test(command)) return null;
  const failed = /^workit: /m.test(output) || /"ok":\s*false/.test(output);
  return record(
    memo,
    sessionId,
    `cli\0${command.trim()}`,
    failed,
    failed ? unblockOf(output) : null,
  );
};
