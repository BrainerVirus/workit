import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type Tier = "smoke" | "full";

/** A regex one tool call must (require) or must not (forbid) match. */
export type CallPattern = { tool?: string; pattern: string; why: string };

export type EvalCase = {
  id: string;
  /** The real failure this case replays: a retro item, issue or behaviour case. */
  source: string;
  tier: Tier;
  /** `{{root}}` and `{{worktree}}` are replaced with the scaffold paths. */
  prompt: string;
  scaffold?: {
    /** Branch the repo is on; `main` when absent. */
    branch?: string;
    /** Committed on `main` before the branch is made. */
    files?: Record<string, string>;
    /** Left uncommitted: in the worktree when there is one, else in the repo. */
    dirty?: Record<string, string>;
    /** `.workit/checks.json` checks, name to argv. */
    checks?: Record<string, string[]>;
    /** A second git worktree on `worktree-branch`, outside the repo dir. */
    worktree?: string;
    /** A bare `origin` remote the branch can be pushed to. */
    remote?: boolean;
    /** Committed in order on the case's branch, after `files`. */
    commits?: { message: string; files: Record<string, string> }[];
  };
  maxTurns?: number;
  permissionMode?: string;
  allowedTools?: string[];
  expect?: {
    /** Some Bash call runs `workit check <a configured check name>`. */
    configuredCheck?: boolean;
    require?: CallPattern[];
    forbid?: CallPattern[];
    /** Regexes the final answer must match. */
    answer?: { pattern: string; flags?: string; why: string }[];
  };
};

export const loadCases = (dir: string): EvalCase[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) => {
      const spec = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as EvalCase;
      if (`${spec.id}.json` !== name) throw new Error(`${name}: id must match the file name`);
      if (spec.tier !== "smoke" && spec.tier !== "full")
        throw new Error(`${name}: tier must be smoke or full`);
      if (!spec.prompt || !spec.source) throw new Error(`${name}: prompt and source are required`);
      return spec;
    });

/** `smoke` runs the smoke cases; `full` runs every case. `ids` narrows either. */
export const selectCases = (cases: EvalCase[], tier: Tier, ids: string[] = []): EvalCase[] => {
  const unknown = ids.filter((id) => !cases.some((spec) => spec.id === id));
  if (unknown.length > 0) throw new Error(`unknown case: ${unknown.join(", ")}`);
  return cases.filter(
    (spec) =>
      (tier === "full" || spec.tier === "smoke") && (ids.length === 0 || ids.includes(spec.id)),
  );
};
