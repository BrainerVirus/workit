// What the Codex hook entry (launcher.ts) answers when it cannot run: loaded
// only then, so the entry stays tiny. SessionStart, UserPromptSubmit and
// SubagentStart get a systemMessage and additionalContext naming the cause and
// the fix; every other event gets `{}`. Each failure records a hook-runs
// failure row that `workit doctor` reads.
import { handleBelowFloor } from "@brainervirus/workit-core/src/core/node-resolve.mjs";
import { recordHookFailure } from "@brainervirus/workit-core/src/hooks/hook-runs";

const LOUD_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "SubagentStart"]);
const SUBAGENT_NOTE =
  " This subagent got no Workit session: a verifier or reviewer cannot record a verdict (it fails with no_session) until the hook runs; fix the hook, run `workit doctor`, then spawn a fresh one.";

export const isLoudEvent = (event: unknown): boolean =>
  typeof event === "string" && LOUD_EVENTS.has(event);

/** The answer a hook that could not run gives `event`. */
export const failedAnswer = (event: unknown, text: string): object => {
  if (typeof event !== "string" || !LOUD_EVENTS.has(event)) return {};
  const message = event === "SubagentStart" ? `${text}${SUBAGENT_NOTE}` : text;
  return {
    systemMessage: message,
    hookSpecificOutput: { hookEventName: event, additionalContext: message },
  };
};

export const recordFailure = (host: string, event: unknown, cause: string): void =>
  recordHookFailure(host, typeof event === "string" ? event : null, cause);

/** A runtime that threw on import or while answering: stderr line, failure row, answer. */
export const answerRuntimeFailure = (host: string, payload: string, error: unknown): void => {
  const reason = `could not run (${error instanceof Error ? error.message : String(error)})`;
  process.stderr.write(`[workit] Codex hook unavailable: ${reason}\n`);
  let event: unknown;
  try {
    event = (JSON.parse(payload) as { hook_event_name?: unknown }).hook_event_name;
  } catch {
    event = undefined;
  }
  recordFailure(host, event, reason);
  process.stdout.write(
    `${JSON.stringify(
      failedAnswer(
        event,
        `Workit hooks are off: the Codex hook ${reason}. Branch policy, task context and verifier sessions are off until it does. Run \`workit upgrade\` to reinstall the plugin, then \`workit doctor\` (check hook_node runs each installed hook).`,
      ),
    )}\n`,
  );
};

/** A Node below the floor: re-run on a Node that can (node-resolve.mjs), else fail loud. */
export const belowFloor = async (
  host: string,
  node: { range: string; floor: number[]; found: string },
  script: string,
): Promise<number> => {
  const cause = `needs Node ${node.range}, found ${node.found}`;
  let floorEvent: unknown;
  return handleBelowFloor({
    host: "Codex",
    ...node,
    script,
    argv: process.argv.slice(2),
    env: process.env,
    isStart: (event) => {
      floorEvent = event;
      recordFailure(host, event, cause);
      return isLoudEvent(event);
    },
    notice: (text) => failedAnswer(floorEvent, text),
  });
};
