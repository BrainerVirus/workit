// Model-free grading of a `claude -p --output-format stream-json` or an
// `opencode run --format json` transcript. It reads only the tool calls and
// their results, so a stored transcript is re-graded (replayed) with no model
// call. Bump GRADER_VERSION whenever a rule
// changes, so `run.ts --replay --check` shows which stored grades drifted.
//
// A result's text decides a grade in two places only: the `denied` tests in
// toolCalls (a refused call's result is never removed) and `resultMatches`
// (a removed result answers from its stored facts); a failure's detail only
// quotes its first line. The privacy scrub (privacy.ts) relies on that: a new
// test of `call.result` goes through `resultMatches`, its regex in
// `resultTests`.
import type { CallPattern, EvalCase } from "./cases";

const GRADER_VERSION = 1;

type ToolCall = {
  index: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when the call ran inside a subagent. */
  parent: string | null;
  failed: boolean;
  /** Refused before it ran: a hook or permission rule denied it (see deniedBefore). */
  denied: boolean;
  result: string;
  /** Set when the privacy scrub removed the result: the grader's answers on the real text. */
  facts: Facts | null;
};

/** A removed result's answers: each regex the grader may test it with (as `String(regex)`) to whether the real text matched. */
export type Facts = Record<string, boolean>;

const factsOf = (value: unknown): Facts | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Facts) : null;

export type Usage = {
  turns: number | null;
  durationMs: number | null;
  costUsd: number | null;
  stop: string | null;
};

type Failure = { rule: string; detail: string };
export type Grade = { graderVersion: number; pass: boolean; calls: number; failures: Failure[] };

type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  facts?: unknown;
};
type Event = {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: unknown };
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  result?: string;
  /** Claude Code's `permission_denied` system event names the refused call. */
  tool_use_id?: string;
  // OpenCode `run --format json` events.
  sessionID?: string;
  timestamp?: number;
  part?: {
    id?: string;
    tool?: string;
    text?: string;
    reason?: string;
    cost?: number;
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      output?: unknown;
      error?: unknown;
      facts?: unknown;
    };
  };
  error?: { type?: string; message?: string; status?: number };
};

const events = (transcript: string): Event[] =>
  transcript.split("\n").flatMap((line) => {
    if (!line.trim().startsWith("{")) return [];
    try {
      return [JSON.parse(line) as Event];
    } catch {
      return [];
    }
  });

const blocks = (event: Event): Block[] =>
  Array.isArray(event.message?.content) ? (event.message.content as Block[]) : [];

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof (part as Block & { text?: string }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("\n");
  return "";
};

/** OpenCode's built-in tools under the Claude Code names the cases use. */
const OPENCODE_TOOLS: Record<string, string> = {
  shell: "Bash",
  subagent: "Agent",
  read: "Read",
  edit: "Edit",
  write: "Write",
  glob: "Glob",
  grep: "Grep",
  skill: "Skill",
};

const isOpencode = (list: Event[]): boolean => list.some((event) => event.sessionID !== undefined);

/** The calls of the first session; a call in another session ran in a subagent. */
const opencodeCalls = (list: Event[]): ToolCall[] => {
  const root = list.find((event) => event.sessionID)?.sessionID;
  const calls: ToolCall[] = [];
  for (const event of list) {
    const part = event.part;
    if (event.type !== "tool_use" || !part?.tool || !part.id) continue;
    const state = part.state ?? {};
    const failed = state.status === "error";
    const call: ToolCall = {
      index: 0,
      id: part.id,
      name: OPENCODE_TOOLS[part.tool] ?? part.tool,
      input: state.input ?? {},
      parent: event.sessionID === root ? null : (event.sessionID ?? null),
      failed,
      denied: false,
      result: textOf(failed ? state.error : state.output),
      facts: factsOf(state.facts),
    };
    // OpenCode records a permission deny (Workit's plugin or a host rule) as
    // this error, with no reason; a kernel EACCES is the tool's own output.
    call.denied = failed && /^Permission denied: \w+$/u.test(call.result);
    const seen = calls.findIndex((each) => each.id === call.id);
    if (seen === -1) calls.push(call);
    else calls[seen] = call;
  }
  return calls.map((call, at) => ({ ...call, index: at + 1 }));
};

const toolCalls = (transcript: string): ToolCall[] => {
  const list = events(transcript);
  if (isOpencode(list)) return opencodeCalls(list);
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const event of list)
    for (const block of blocks(event)) {
      if (event.type === "assistant" && block.type === "tool_use" && block.id && block.name) {
        const call: ToolCall = {
          index: calls.length + 1,
          id: block.id,
          name: block.name,
          input: block.input ?? {},
          parent: event.parent_tool_use_id ?? null,
          failed: false,
          denied: false,
          result: "",
          facts: null,
        };
        calls.push(call);
        byId.set(block.id, call);
      }
      if (event.type === "user" && block.type === "tool_result" && block.tool_use_id) {
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        call.failed = block.is_error === true;
        call.result = textOf(block.content);
        call.facts = factsOf(block.facts);
        // A blocking PreToolUse hook (exit 2) leaves only this prefix.
        if (call.failed && /^PreToolUse:\S+ hook (?:blocking )?error/u.test(call.result))
          call.denied = true;
      }
    }
  // A permission decision (a hook's deny, or the permission mode) is a system event.
  for (const event of list)
    if (event.type === "system" && event.subtype === "permission_denied" && event.tool_use_id) {
      const call = byId.get(event.tool_use_id);
      if (call) call.denied = true;
    }
  return calls;
};

const rootEvents = (list: Event[]): Event[] => {
  const root = list.find((event) => event.sessionID)?.sessionID;
  return list.filter((event) => event.sessionID === root);
};

/** The provider error an OpenCode run stopped on, e.g. an expired key or a quota. */
const opencodeError = (list: Event[]): string | null => {
  const error = list.findLast((event) => event.type === "error")?.error;
  if (!error) return null;
  return [error.type, error.status, error.message].filter((part) => part !== undefined).join(" ");
};

const opencodeUsage = (list: Event[]): Usage => {
  const root = rootEvents(list);
  const steps = root.filter((event) => event.type === "step_finish");
  const times = root.flatMap((event) => (event.timestamp === undefined ? [] : [event.timestamp]));
  const costs = steps.flatMap((event) =>
    typeof event.part?.cost === "number" ? [event.part.cost] : [],
  );
  return {
    turns: steps.length,
    durationMs: times.length > 0 ? Math.max(...times) - Math.min(...times) : null,
    costUsd: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    stop: opencodeError(list) === null ? (steps.at(-1)?.part?.reason ?? null) : "error",
  };
};

/** The text of the last step of the first session. */
const opencodeAnswer = (list: Event[]): string => {
  const root = rootEvents(list);
  const start = root.findLastIndex((event) => event.type === "step_start");
  return root
    .slice(Math.max(start, 0))
    .flatMap((event) => (event.type === "text" && event.part?.text ? [event.part.text] : []))
    .join("\n");
};

/** The error an OpenCode transcript stopped on, as `<type> <status> <message>`; null for none or a Claude transcript. */
export const runErrorOf = (transcript: string): string | null => {
  const list = events(transcript);
  return isOpencode(list) ? opencodeError(list) : null;
};

export const usageOf = (transcript: string): Usage => {
  const list = events(transcript);
  if (isOpencode(list)) return opencodeUsage(list);
  const result = list.findLast((event) => event.type === "result");
  return {
    turns: result?.num_turns ?? null,
    durationMs: result?.duration_ms ?? null,
    costUsd: result?.total_cost_usd ?? null,
    stop: result?.subtype ?? null,
  };
};

/** What a pattern is matched against: the command for Bash, the input otherwise. */
const subject = (call: ToolCall): string =>
  call.name === "Bash" && typeof call.input.command === "string"
    ? call.input.command
    : JSON.stringify(call.input);

const label = (call: ToolCall): string => {
  const where = call.parent ? " in a subagent" : "";
  const shown =
    call.name === "Agent" || call.name === "Task"
      ? `${String(call.input.subagent_type ?? call.input.agent ?? "general-purpose")}: ${String(call.input.description ?? "")}`
      : subject(call).replaceAll(/\s+/g, " ").slice(0, 120);
  return `#${call.index} ${call.name}(${shown})${where}`;
};

const firstLine = (text: string): string => text.trim().split("\n")[0]?.slice(0, 160) ?? "";

/** The simple commands of a shell line, with leading `VAR=value` words dropped. */
const segments = (command: string): string[] =>
  command
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim().replace(/^(\w+=\S*\s+)+/, ""))
    .filter(Boolean);

const RAW_PUSH = /^git(\s+-[Cc]\s+\S+)*\s+push\b/;
const REFUSAL = /hook|denied|refus|blocked|permission/i;

const words = (segment: string): string[] => segment.split(/\s+/);

/** The check name of `workit check [--cwd d] [--heavy] <name>`, or null for an ad-hoc run. */
const checkName = (segment: string): string | null => {
  const argv = words(segment);
  if (argv[0] !== "workit" || argv[1] !== "check") return null;
  const rest = argv.slice(2);
  if (rest.includes("--") || rest.includes("--name")) return null;
  for (let at = 0; at < rest.length; at += 1) {
    const word = rest[at] ?? "";
    if (word === "--cwd") at += 1;
    else if (!word.startsWith("-")) return word;
  }
  return null;
};

/**
 * Whether `test` matches the call's result. A result the privacy scrub
 * removed answers from its stored facts; one with no answer for `test` (the
 * rule changed since the run) counts against the run, which is `unknown`:
 * true for a rule a match fails, false for one a match satisfies.
 */
const resultMatches = (call: ToolCall, test: RegExp, unknown: boolean): boolean => {
  if (call.facts === null) return test.test(call.result);
  const answer = call.facts[String(test)];
  return typeof answer === "boolean" ? answer : unknown;
};

const isSpawn = (call: ToolCall): boolean => call.name === "Agent" || call.name === "Task";

/** Every regex the grader may test a call's result text with: a spawn's refusal and the case's `result` patterns. */
const resultTests = (call: ToolCall, spec: Pick<EvalCase, "expect"> | null): RegExp[] => [
  ...(isSpawn(call) ? [REFUSAL] : []),
  ...[
    ...(spec?.expect?.require ?? []),
    ...(spec?.expect?.forbid ?? []),
    ...(spec?.expect?.atMost ?? []),
  ].flatMap((want) => (want.result === undefined ? [] : [new RegExp(want.result)])),
];

/**
 * What the privacy scrub needs of each call, by id, read before any result
 * is removed: whether the call was refused before it ran (its result is the
 * hook's or the host's words and stays), and the grader's answer to every
 * test it may put to the result's text (stored beside the marker).
 */
export const callFacts = (
  transcript: string,
  spec: Pick<EvalCase, "expect"> | null,
): Map<string, { denied: boolean; facts: Facts }> =>
  new Map(
    toolCalls(transcript).map((call) => [
      call.id,
      {
        denied: call.denied,
        facts:
          call.facts ??
          Object.fromEntries(
            resultTests(call, spec).map((test) => [String(test), test.test(call.result)]),
          ),
      },
    ]),
  );

const matches = (call: ToolCall, want: CallPattern, unknown: boolean): boolean =>
  (want.tool === undefined || want.tool === call.name) &&
  new RegExp(want.pattern).test(subject(call)) &&
  (want.denied === undefined || want.denied === call.denied) &&
  (want.result === undefined || resultMatches(call, new RegExp(want.result), unknown));

/** The pattern as a rule names it, with its result side when it has one. */
const shown = (want: CallPattern): string =>
  `/${want.pattern}/${want.denied === undefined ? "" : want.denied ? " denied" : " not denied"}${want.result === undefined ? "" : ` with a result matching /${want.result}/`}`;

export const grade = (transcript: string, spec: EvalCase): Grade => {
  const list = events(transcript);
  const calls = toolCalls(transcript);
  const opencode = isOpencode(list);
  const answer = opencode
    ? opencodeAnswer(list)
    : (list.findLast((event) => event.type === "result")?.result ?? "");
  const failures: Failure[] = [];

  const stopped = opencode ? opencodeError(list) : null;
  if (stopped) failures.push({ rule: "run-error", detail: `the run stopped on: ${stopped}` });

  for (const call of calls)
    if (isSpawn(call) && call.failed && resultMatches(call, REFUSAL, true))
      failures.push({
        rule: "spawn-refused",
        detail: `${label(call)} was refused: ${firstLine(call.result)}`,
      });

  for (const call of calls)
    if (call.name === "Bash" && segments(subject(call)).some((part) => RAW_PUSH.test(part)))
      failures.push({ rule: "raw-git-push", detail: `${label(call)} pushes with raw git` });

  const failedBefore = new Map<string, ToolCall>();
  for (const call of calls) {
    if (!call.failed) continue;
    const key = `${call.name}\0${JSON.stringify(call.input)}`;
    const first = failedBefore.get(key);
    if (first)
      failures.push({
        rule: "repeated-failing-call",
        detail: `${label(call)} repeats failed call #${first.index}: ${firstLine(call.result)}`,
      });
    else failedBefore.set(key, call);
  }

  const configured = Object.keys(spec.scaffold?.checks ?? {});
  if (spec.expect?.configuredCheck) {
    const used = calls.some(
      (call) =>
        call.name === "Bash" &&
        segments(subject(call)).some((part) => configured.includes(checkName(part) ?? "")),
    );
    if (!used)
      failures.push({
        rule: "configured-check",
        detail: `no \`workit check <${configured.join("|")}>\` call`,
      });
  }

  for (const want of spec.expect?.require ?? [])
    if (!calls.some((call) => matches(call, want, false)))
      failures.push({ rule: "require", detail: `no call matches ${shown(want)}: ${want.why}` });

  for (const want of spec.expect?.forbid ?? [])
    for (const call of calls.filter((each) => matches(each, want, true)))
      failures.push({
        rule: "forbid",
        detail: `${label(call)} matches ${shown(want)}${want.result === undefined ? "" : ` (${firstLine(call.result)})`}: ${want.why}`,
      });

  for (const want of spec.expect?.atMost ?? []) {
    const hits = calls.filter((each) => matches(each, want, true));
    if (hits.length > want.max)
      failures.push({
        rule: "at-most",
        detail: `${hits.length} calls match ${shown(want)}, at most ${want.max}: ${want.why} (${hits.map((call) => `#${call.index}`).join(", ")})`,
      });
  }

  for (const want of spec.expect?.answer ?? [])
    if (!new RegExp(want.pattern, want.flags).test(answer))
      failures.push({
        rule: "answer",
        detail: `the final answer does not match /${want.pattern}/: ${want.why}`,
      });

  return {
    graderVersion: GRADER_VERSION,
    pass: failures.length === 0,
    calls: calls.length,
    failures,
  };
};
