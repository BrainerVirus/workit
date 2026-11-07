// Model-free grading of a `claude -p --output-format stream-json` transcript.
// It reads only the tool calls and their results, so a stored transcript is
// re-graded (replayed) with no model call. Bump GRADER_VERSION whenever a rule
// changes, so `run.ts --replay --check` shows which stored grades drifted.
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
  result: string;
};

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
};
type Event = {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: unknown };
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
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

const toolCalls = (transcript: string): ToolCall[] => {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const event of events(transcript))
    for (const block of blocks(event)) {
      if (event.type === "assistant" && block.type === "tool_use" && block.id && block.name) {
        const call: ToolCall = {
          index: calls.length + 1,
          id: block.id,
          name: block.name,
          input: block.input ?? {},
          parent: event.parent_tool_use_id ?? null,
          failed: false,
          result: "",
        };
        calls.push(call);
        byId.set(block.id, call);
      }
      if (event.type === "user" && block.type === "tool_result" && block.tool_use_id) {
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        call.failed = block.is_error === true;
        call.result = textOf(block.content);
      }
    }
  return calls;
};

export const usageOf = (transcript: string): Usage => {
  const result = events(transcript).findLast((event) => event.type === "result");
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
      ? `${String(call.input.subagent_type ?? "general-purpose")}: ${String(call.input.description ?? "")}`
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

const matches = (call: ToolCall, want: CallPattern): boolean =>
  (want.tool === undefined || want.tool === call.name) &&
  new RegExp(want.pattern).test(subject(call));

export const grade = (transcript: string, spec: EvalCase): Grade => {
  const calls = toolCalls(transcript);
  const failures: Failure[] = [];

  for (const call of calls)
    if ((call.name === "Agent" || call.name === "Task") && call.failed && REFUSAL.test(call.result))
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
    if (!calls.some((call) => matches(call, want)))
      failures.push({ rule: "require", detail: `no call matches /${want.pattern}/: ${want.why}` });

  for (const want of spec.expect?.forbid ?? [])
    for (const call of calls.filter((each) => matches(each, want)))
      failures.push({
        rule: "forbid",
        detail: `${label(call)} matches /${want.pattern}/: ${want.why}`,
      });

  return {
    graderVersion: GRADER_VERSION,
    pass: failures.length === 0,
    calls: calls.length,
    failures,
  };
};
