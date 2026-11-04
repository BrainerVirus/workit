// Which assigned worker a native `subagent` launch is for (#640). A launch
// never takes the oldest assignment by default: it binds the worker its
// prompt names (the worker id), else the one whose objective or scope paths
// the prompt carries, else the one its role picks. A launch that fits several
// assignments equally is refused before anything is recorded, naming each
// worker so the lead can put `WORKER: <id>` in the prompt.
import { roleForAgentType } from "@brainervirus/workit-core/src/core/role-models";
import type { TaskRecord } from "@brainervirus/workit-core/src/core";

type Worker = TaskRecord["workers"][number];
type LaunchCandidate = { task: TaskRecord; entry: Worker };

type LaunchMatch =
  | { kind: "bound"; item: LaunchCandidate }
  | { kind: "ambiguous"; items: LaunchCandidate[] }
  | { kind: "named_elsewhere"; workerId: string };

const normalize = (value: string): string => value.toLowerCase().replace(/\s+/gu, " ").trim();

/** Objectives shorter than this are too generic ("review") to identify a brief. */
const MIN_OBJECTIVE = 12;
/** Scope paths that name the whole checkout identify nothing. */
const WHOLE_CHECKOUT = new Set(["", ".", "./", "*", "**", "./**"]);

/** The model role a launch asks for, as a worker role. */
const WORKER_ROLE: Record<string, Worker["data"]["assignment"]["role"]> = {
  implementer: "implementer",
  reviewer: "reviewer",
  verifier: "reviewer",
  decider: "reviewer",
  explore: "investigator",
};

const launchText = (input: unknown): { text: string; agent: unknown; prompt: unknown } => {
  const fields =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const text = [fields.description, fields.prompt]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  return { text, agent: fields.agent, prompt: fields.prompt };
};

/** A scope path as a whole token of the text, not a substring of another word. */
const mentions = (text: string, item: string): boolean => {
  const bound = "[\\s,;:'\"`()\\[\\]]";
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|${bound})${escaped}(?:$|${bound})`, "u").test(text);
};

/** How strongly the launch text carries this assignment: objective and scope paths. */
const strength = (text: string, entry: Worker): number => {
  const { objective, scope } = entry.data.assignment;
  const goal = normalize(objective);
  const paths = scope.paths.map((item) => item.trim()).filter((item) => !WHOLE_CHECKOUT.has(item));
  let score = 0;
  if (goal.length >= MIN_OBJECTIVE && text.includes(goal)) score += 1;
  if (paths.length > 0 && paths.every((item) => mentions(text, item.toLowerCase()))) score += 1;
  return score;
};

const signature = (entry: Worker): string => {
  const { role, objective, scope } = entry.data.assignment;
  return JSON.stringify([role, normalize(objective), [...scope.paths].toSorted()]);
};

/** The same brief assigned twice: the newer assignment supersedes the stale one. */
const newest = (items: LaunchCandidate[]): LaunchCandidate =>
  items.toSorted((a, b) =>
    a.entry.recordedAt === b.entry.recordedAt
      ? a.entry.id < b.entry.id
        ? 1
        : -1
      : a.entry.recordedAt < b.entry.recordedAt
        ? 1
        : -1,
  )[0];

/**
 * Pick the worker this launch is for among the free candidates. `taken` are
 * the coordinator's other workers (already launching or not on this branch's
 * task): a prompt that names one of them is refused, never rebound.
 */
export const matchLaunch = (
  input: unknown,
  free: LaunchCandidate[],
  taken: string[],
): LaunchMatch => {
  const { text: raw, agent, prompt } = launchText(input);
  const named = free.filter(({ entry }) => raw.includes(entry.id));
  if (named.length === 1) return { kind: "bound", item: named[0] };
  if (named.length > 1) return { kind: "ambiguous", items: named };
  const elsewhere = taken.find((id) => raw.includes(id));
  if (elsewhere) return { kind: "named_elsewhere", workerId: elsewhere };
  if (free.length === 1) return { kind: "bound", item: free[0] };
  if (new Set(free.map(({ entry }) => signature(entry))).size === 1)
    return { kind: "bound", item: newest(free) };

  const text = normalize(raw);
  const selector = roleForAgentType(agent, prompt);
  const role = selector ? WORKER_ROLE[selector.role] : undefined;
  const byRole = (items: LaunchCandidate[]): LaunchCandidate[] => {
    const narrowed = role ? items.filter(({ entry }) => entry.data.assignment.role === role) : [];
    return narrowed.length > 0 ? narrowed : items;
  };
  const scored = free.map((item) => ({ item, score: strength(text, item.entry) }));
  const best = Math.max(0, ...scored.map((entry) => entry.score));
  const top = byRole(scored.filter((entry) => entry.score === best).map((entry) => entry.item));
  if (top.length === 1) return { kind: "bound", item: top[0] };
  if (best > 0 && new Set(top.map(({ entry }) => signature(entry))).size === 1)
    return { kind: "bound", item: newest(top) };
  return { kind: "ambiguous", items: top };
};

/** The refusal for a launch that fits several assignments: each worker, and how to name one. */
export const ambiguousLaunch = (items: LaunchCandidate[]): string =>
  `recovery_required: this native subagent launch fits ${items.length} assigned Workit workers and names none of them; put the worker's id in the subagent prompt as a \`WORKER: <id>\` line (or include its objective or scope paths) and launch again: ${items
    .map(
      ({ entry }) =>
        `${entry.id} (${entry.data.assignment.role}: ${entry.data.assignment.objective}; ${entry.data.assignment.scope.paths.join(", ")})`,
    )
    .join("; ")}`;
