// `workit fanout plan` (G1): the slice registry for parallel work.
//
// A plan names the slices one lead fans out: each has an id, a branch, a base,
// a worktree, a model TIER, its dependencies and a brief (GOAL, SCOPE as a
// file-scope manifest, ACCEPTANCE, VERIFY, FORBIDDEN). The file lives at
// `<store>/fanouts/<name>.json` (D13: under the git common dir, shared by
// every worktree, surviving worktree removal), next to the stacks, and each
// plan appends an observed `fanout.planned` ledger row.
//
// Planning refuses (`invalid_input`) a brief with an empty or placeholder
// field, unknown or cyclic dependencies and malformed scopes, and refuses
// (`blocked`) two slices that may write the same file unless that is
// resolved: exactly one slice lists the file under `owns`, or the slices are
// serialized by a dependency. Overlap is evaluated on the trunk's tracked
// files plus one sample path per glob (`src/new/**` -> `src/new/<any>`), so
// directories nobody has created yet are compared too, and paths differing
// only in case count as one file. Each unresolved overlap carries one
// deterministic suggestion: an owner for known shared files (lockfiles,
// manifests, barrels, CI config), else a dependency that serializes them.
//
// Each slice's `hash` covers what it is (goal, acceptance, verify, forbidden,
// scope, owns, branch, base, dependencies), not how it is briefed (tier,
// timebox, context) or where its worktree goes. A re-plan that changes a
// slice starts a new run for that slice alone: its `hashSince` moves to now,
// and only ledger rows recorded under its hash (worktree rows carry
// `sliceHash`) or since then link a gone branch's merged PR to it or count as
// its worktree. Liveness still reads every row. Its siblings keep their runs.
//
// `fanIn: "integration"` is the one-PR mode: the trunk is an integration
// branch (never origin's default branch), workers merge its tip into their
// branch before reporting, and the lead fast-forwards it.
//
// The CLI never spawns, waits or wakes anything: it only records and checks.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GIT_TIMEOUTS, gitCommonDir, pushRemoteName, resolveRef } from "./git/rev";
import {
  activeStanding,
  appendObserved,
  defaultBase,
  readLedger,
  storeRoot,
  type LedgerActor,
} from "./ledger";
import { stackFileName } from "./stack";

export const FANOUT_VERSION = 1;
export const TIERS = ["mundane", "standard", "hard"] as const;
export type Tier = (typeof TIERS)[number];

export type Slice = {
  id: string;
  branch: string;
  /** The branch it is cut from and diffed against: the trunk, or its single dependency's branch. */
  base: string;
  worktree: string;
  tier: Tier;
  dependsOn: string[];
  /** The file-scope manifest: globs (`*`, `**`, `?`, `{a,b}`) relative to the repo root. */
  scope: string[];
  /** Shared files this slice alone may write, even where another scope matches them. */
  owns: string[];
  goal: string;
  acceptance: string[];
  verify: string[];
  forbidden: string[];
  context: string | null;
  timebox: string | null;
  /** sliceHash of this definition: which run of the slice a ledger row belongs to. */
  hash: string;
  /** When a slice with this hash was first planned: older rows are not its run. */
  hashSince: string;
};

export const FAN_IN_MODES = ["prs", "integration"] as const;
export type FanInMode = (typeof FAN_IN_MODES)[number];

export type FanoutFile = {
  v: number;
  name: string;
  trunk: string;
  /** prs: one PR per slice (default); integration: slices fast-forward one integration branch. */
  fanIn: FanInMode;
  /** Extra shared-file globs on top of DEFAULT_SHARED. */
  shared: string[];
  slices: Slice[];
  createdAt: string;
  updatedAt: string;
};

export type FanoutError = {
  ok: false;
  code: "blocked" | "busy" | "failed" | "unavailable" | "not_found" | "invalid_input";
  error: string;
  unblock?: string;
  data?: Record<string, unknown>;
};
export type FanoutResult<T> = { ok: true; data: T } | FanoutError;

export const fanoutFail = (
  code: FanoutError["code"],
  error: string,
  unblock?: string,
  data?: Record<string, unknown>,
): FanoutError => ({
  ok: false,
  code,
  error,
  ...(unblock ? { unblock } : {}),
  ...(data ? { data } : {}),
});

/** Files that every slice tends to touch; overlap on them is resolved by an owner. */
export const DEFAULT_SHARED: readonly string[] = [
  "**/package.json",
  "**/{package-lock.json,npm-shrinkwrap.json,bun.lock,bun.lockb,pnpm-lock.yaml,pnpm-workspace.yaml,yarn.lock}",
  "**/{Cargo.lock,go.mod,go.sum,poetry.lock,uv.lock,Gemfile.lock,composer.lock}",
  "**/index.{ts,tsx,js,jsx,mjs,cjs}",
  "**/tsconfig.json",
  ".github/**",
  ".gitlab-ci.yml",
  "CHANGELOG.md",
];

// ---------------------------------------------------------------------------
// scope globs

const escapeRegExp = (text: string): string => text.replace(/[.+^$()|[\]\\{}*?]/gu, "\\$&");
/** The pattern with `\x` escapes resolved: what a wildcard-free pattern names. */
const unescape = (pattern: string): string => pattern.replace(/\\(.)/gu, "$1");
/** Has an unescaped `*`, `?` or `{`. */
const hasWildcard = (pattern: string): boolean => /[*?{]/u.test(pattern.replace(/\\./gu, ""));

/** Brace alternatives expanded (`src/{a,b}/x` -> `src/a/x`, `src/b/x`), capped. */
function expandBraces(pattern: string, limit = 64): string[] {
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "\\") {
      index += 1;
      continue;
    }
    const close = pattern.indexOf("}", index);
    if (pattern[index] !== "{" || close < index) continue;
    const head = pattern.slice(0, index);
    const tail = pattern.slice(close + 1);
    const out: string[] = [];
    for (const alternative of pattern.slice(index + 1, close).split(","))
      for (const rest of expandBraces(tail, limit)) {
        if (out.length >= limit) return out;
        out.push(`${head}${alternative}${rest}`);
      }
    return out;
  }
  return [pattern];
}

/**
 * Concrete paths the pattern matches, one per brace alternative, standing in
 * for files nobody has created yet: `src/new/**` -> `src/new/<any>`,
 * `src/{a,b}/*.ts` -> `src/a/<any>.ts`, `src/b/<any>.ts`.
 */
export function scopeSamples(pattern: string): string[] {
  // A plain path covers what is below it too, so `src/new` and `src/new/**`
  // overlap through `src/new/<any>` without a second sample.
  if (!hasWildcard(pattern)) return [unescape(pattern)];
  return [...new Set(expandBraces(pattern).map(sampleOne))];
}

function sampleOne(pattern: string): string {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      out += pattern[index + 1];
      index += 1;
    } else if (char === "*" && pattern[index + 1] === "*") {
      const atSegmentStart = index === 0 || pattern[index - 1] === "/";
      if (atSegmentStart && pattern[index + 2] === "/") index += 2;
      else {
        out += "<any>";
        index += 1;
      }
    } else if (char === "*") out += "<any>";
    else if (char === "?") out += "x";
    else out += char;
  }
  return out;
}

function globSource(pattern: string): string {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      out += escapeRegExp(pattern[index + 1]);
      index += 1;
    } else if (char === "*" && pattern[index + 1] === "*") {
      const atSegmentStart = index === 0 || pattern[index - 1] === "/";
      if (atSegmentStart && pattern[index + 2] === "/") {
        out += "(?:[^/]*/)*";
        index += 2;
      } else {
        out += ".*";
        index += 1;
      }
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else if (char === "{" && pattern.indexOf("}", index) > index) {
      // An unclosed brace is a literal `{` (stored plans are not trusted).
      const close = pattern.indexOf("}", index);
      const alternatives = pattern
        .slice(index + 1, close)
        .split(",")
        .map(globSource);
      out += `(?:${alternatives.join("|")})`;
      index = close;
    } else out += escapeRegExp(char);
  }
  return out;
}

const compiled = new Map<string, RegExp>();

/**
 * Does `file` (repo-relative, `/`-separated) fall under `pattern`? Dotfiles
 * match like any other name, the same on every runtime. A pattern without
 * wildcards also covers everything below it, so `src/api` is a directory
 * scope as well as a file.
 */
export function matchesScope(pattern: string, file: string): boolean {
  let regex = compiled.get(pattern);
  if (!regex) {
    regex = new RegExp(`^${globSource(pattern)}$`, "u");
    compiled.set(pattern, regex);
  }
  return regex.test(file) || (!hasWildcard(pattern) && file.startsWith(`${unescape(pattern)}/`));
}

const matchesAny = (patterns: readonly string[], file: string): boolean =>
  patterns.some((pattern) => matchesScope(pattern, file));

/** A scope entry in canonical form, or why it is refused. */
function normalizePattern(raw: string): { pattern: string } | { error: string } {
  // Only `\\[` and `\\]` are escapes (`app/\\[id\\]`); any other backslash is
  // a Windows separator. Where both readings are possible, refuse.
  let pattern = raw.trim();
  if (pattern.includes("\\")) {
    if (/\\[*?{}]/u.test(pattern))
      return {
        error:
          "has \\*, \\?, \\{ or \\}: only \\[ and \\] are escapes; use / as the separator (src/**/*.ts)",
      };
    const brackets = /\\[[\]]/u.test(pattern);
    if (brackets && pattern.replace(/\\[[\]]/gu, "").includes("\\"))
      return {
        error:
          "mixes \\[ or \\] escapes with other backslashes, which is ambiguous: use / as the separator (app/\\[id\\]/page.tsx)",
      };
    if (!brackets) pattern = pattern.replaceAll("\\", "/");
  }
  while (pattern.startsWith("./")) pattern = pattern.slice(2);
  if (pattern === "." || pattern === "") pattern = raw.trim() ? "**" : "";
  if (pattern.endsWith("/")) pattern = `${pattern}**`;
  if (!pattern) return { error: "is empty" };
  if (pattern.startsWith("/") || /^[A-Za-z]:/u.test(pattern))
    return { error: "must be relative to the repository root" };
  if (pattern.split("/").includes("..")) return { error: "must not contain .." };
  const bare = pattern.replace(/\\./gu, "");
  if (/[[\]]/u.test(bare))
    return {
      error:
        'has an unescaped [ or ]: write \\[ and \\] for literal brackets (app/\\[id\\]/page.tsx; in JSON "app/\\\\[id\\\\]/page.tsx")',
    };
  if (bare.startsWith("!")) return { error: "uses ! (negation is not supported)" };
  let depth = 0;
  for (const char of bare) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0 || depth > 1) return { error: "has unbalanced or nested braces" };
  }
  if (depth !== 0) return { error: "has unbalanced or nested braces" };
  return { pattern };
}

/** The slice may write `file`: its scope or owns matches, and no other slice owns it. */
export function inScope(plan: FanoutFile, slice: Slice, file: string): boolean {
  if (matchesAny(slice.owns, file)) return true;
  if (!matchesAny(slice.scope, file)) return false;
  return !plan.slices.some((other) => other.id !== slice.id && matchesAny(other.owns, file));
}

// ---------------------------------------------------------------------------
// parse (input and stored file; D17: unknown keys are ignored)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PLACEHOLDER = /^(?:<[^>]*>|tbd|todo|fixme|\?+|\.\.\.|…)$/iu;
const filled = (text: string): boolean => text.trim() !== "" && !PLACEHOLDER.test(text.trim());

/** A string or list of strings; null when absent or of another type. */
const textList = (value: unknown): string[] | null => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return null;
};

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export type PlanDefaults = {
  trunk: string;
  /** The main checkout: a relative `worktree` is resolved against it at plan time. */
  root: string;
  /** Where default worktrees go: `<repo>-wt/` next to the main checkout. */
  worktreeRoot: string;
};

type Parsed = { ok: true; plan: FanoutFile } | { ok: false; problems: string[] };

/**
 * Validate a plan document. Every problem is reported at once, so one edit
 * fixes them all; the brief fields GOAL, SCOPE, ACCEPTANCE, VERIFY and
 * FORBIDDEN must be non-empty and not a template placeholder.
 */
export function parsePlan(raw: unknown, defaults: PlanDefaults, name?: string | null): Parsed {
  const problems: string[] = [];
  if (!isRecord(raw)) return { ok: false, problems: ["the plan must be a JSON object"] };
  const planName = name ?? (typeof raw.name === "string" ? raw.name.trim() : "");
  if (!planName || planName.length > 200 || /\p{Cc}/u.test(planName))
    problems.push('name: pass --name or set a 1-200 character "name"');
  const trunk =
    typeof raw.trunk === "string" && raw.trunk.trim() ? raw.trunk.trim() : defaults.trunk;
  const shared: string[] = [];
  for (const entry of textList(raw.shared ?? []) ?? ["<not a list>"]) {
    const normalized = normalizePattern(entry);
    if ("error" in normalized) problems.push(`shared "${entry}" ${normalized.error}`);
    else shared.push(normalized.pattern);
  }
  const fanIn = raw.fanIn ?? "prs";
  if (!(FAN_IN_MODES as readonly unknown[]).includes(fanIn))
    problems.push(`fanIn must be one of ${FAN_IN_MODES.join(", ")}`);
  if (!Array.isArray(raw.slices) || raw.slices.length === 0)
    return { ok: false, problems: [...problems, "slices: list at least one slice"] };

  const slices: Slice[] = [];
  const seenIds = new Set<string>();
  const seenBranches = new Map<string, string>();
  raw.slices.forEach((item, index) => {
    const where =
      isRecord(item) && typeof item.id === "string" ? `slice ${item.id}` : `slice #${index + 1}`;
    if (!isRecord(item)) {
      problems.push(`${where}: must be an object`);
      return;
    }
    const id = typeof item.id === "string" ? item.id : "";
    if (!ID.test(id)) problems.push(`${where}: id must match ${ID.source}`);
    else if (seenIds.has(id)) problems.push(`${where}: duplicate id`);
    seenIds.add(id);
    const branch = typeof item.branch === "string" ? item.branch.trim() : "";
    if (!branch) problems.push(`${where}: branch is empty`);
    else if (seenBranches.has(branch))
      problems.push(`${where}: branch ${branch} is also slice ${seenBranches.get(branch)}'s`);
    else seenBranches.set(branch, id);
    if (branch === trunk) problems.push(`${where}: branch must not be the trunk ${trunk}`);

    const goal = typeof item.goal === "string" ? item.goal.trim() : "";
    if (!filled(goal)) problems.push(`${where}: goal is empty`);
    const brief = (field: string): string[] => {
      const list = textList(item[field]);
      const kept = (list ?? []).map((entry) => entry.trim()).filter(filled);
      if (kept.length === 0) problems.push(`${where}: ${field} is empty`);
      return kept;
    };
    const acceptance = brief("acceptance");
    const verify = brief("verify");
    const forbidden = brief("forbidden");
    const scope: string[] = [];
    const owns: string[] = [];
    for (const [field, out] of [
      ["scope", scope],
      ["owns", owns],
    ] as const) {
      const list = textList(item[field] ?? []);
      if (list === null) {
        problems.push(`${where}: ${field} must be a list of globs`);
        continue;
      }
      for (const entry of list.filter(filled)) {
        const normalized = normalizePattern(entry);
        if ("error" in normalized)
          problems.push(`${where}: ${field} "${entry}" ${normalized.error}`);
        else out.push(normalized.pattern);
      }
    }
    if (scope.length === 0 && textList(item.scope ?? []) !== null)
      problems.push(`${where}: scope is empty`);
    const tier = item.tier;
    if (typeof tier !== "string" || !(TIERS as readonly string[]).includes(tier))
      problems.push(`${where}: tier must be one of ${TIERS.join(", ")}`);
    const dependsOn = textList(item.dependsOn ?? []);
    if (dependsOn === null) problems.push(`${where}: dependsOn must be a list of slice ids`);
    const optional = (field: string): string | null =>
      typeof item[field] === "string" && filled(item[field]) ? item[field].trim() : null;
    slices.push({
      id,
      branch,
      base: optional("base") ?? "",
      worktree: path.resolve(
        defaults.root,
        optional("worktree") ?? path.join(defaults.worktreeRoot, id),
      ),
      tier: tier as Tier,
      dependsOn: [...new Set(dependsOn ?? [])],
      scope,
      owns,
      goal,
      acceptance,
      verify,
      forbidden,
      context: optional("context"),
      timebox: optional("timebox"),
      hash: "",
      hashSince: "",
    });
  });

  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const byBranch = new Map(slices.map((slice) => [slice.branch, slice]));
  for (const slice of slices) {
    for (const dep of slice.dependsOn) {
      if (dep === slice.id) problems.push(`slice ${slice.id}: depends on itself`);
      else if (!byId.has(dep)) problems.push(`slice ${slice.id}: depends on unknown slice ${dep}`);
    }
    const explicitBase = slice.base;
    if (explicitBase) {
      const parent = byBranch.get(explicitBase);
      if (parent && !slice.dependsOn.includes(parent.id))
        problems.push(
          `slice ${slice.id}: base ${explicitBase} is slice ${parent.id}'s branch; add "${parent.id}" to its dependsOn`,
        );
    } else {
      const single = slice.dependsOn.length === 1 ? byId.get(slice.dependsOn[0]) : undefined;
      slice.base = single ? single.branch : trunk;
    }
  }
  const cycle = findCycle(slices);
  if (cycle) problems.push(`dependency cycle: ${cycle.join(" -> ")}`);
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    plan: {
      v: FANOUT_VERSION,
      name: planName,
      trunk,
      fanIn: fanIn as FanInMode,
      shared,
      slices,
      createdAt: "",
      updatedAt: "",
    },
  };
}

function findCycle(slices: readonly Slice[]): string[] | null {
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const state = new Map<string, "open" | "done">();
  const trail: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "open") return [...trail.slice(trail.indexOf(id)), id];
    state.set(id, "open");
    trail.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep) || dep === id) continue;
      const found = visit(dep);
      if (found) return found;
    }
    trail.pop();
    state.set(id, "done");
    return null;
  };
  for (const slice of slices) {
    const found = visit(slice.id);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ordering

/** Dependencies first; among the ready ones, the order the plan lists them. */
export function landingOrder(slices: readonly Slice[]): string[] {
  const order: string[] = [];
  const placed = new Set<string>();
  const known = new Set(slices.map((slice) => slice.id));
  while (order.length < slices.length) {
    const next = slices.find(
      (slice) =>
        !placed.has(slice.id) && slice.dependsOn.every((dep) => placed.has(dep) || !known.has(dep)),
    );
    if (!next) break;
    order.push(next.id);
    placed.add(next.id);
  }
  return order;
}

/** Slices that can run at the same time: wave n waits only for waves before it. */
export function waves(slices: readonly Slice[]): string[][] {
  const level = new Map<string, number>();
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  for (const id of landingOrder(slices)) {
    const deps = byId.get(id)?.dependsOn ?? [];
    level.set(id, deps.length ? Math.max(...deps.map((dep) => level.get(dep) ?? 0)) + 1 : 0);
  }
  const out: string[][] = [];
  for (const slice of slices) (out[level.get(slice.id) ?? 0] ??= []).push(slice.id);
  return out.filter(Boolean);
}

/** Every slice `id` waits for, directly or through another dependency. */
function ancestors(slices: readonly Slice[]): Map<string, Set<string>> {
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const out = new Map<string, Set<string>>();
  for (const id of landingOrder(slices)) {
    const set = new Set<string>();
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      set.add(dep);
      for (const deeper of out.get(dep) ?? []) set.add(deeper);
    }
    out.set(id, set);
  }
  return out;
}

// ---------------------------------------------------------------------------
// overlap

export type Overlap = {
  path: string;
  slices: string[];
  resolution: "owner" | "serialized";
  owner?: string;
};

type OwnerSuggestion = { kind: "owner"; slice: string; paths: string[]; text: string };
type Suggestion =
  | OwnerSuggestion
  | { kind: "serialize"; edges: Array<{ slice: string; dependsOn: string }>; text: string };

export type OverlapConflict = {
  slices: string[];
  paths: string[];
  /** Every path is a known shared file (lockfile, manifest, barrel, CI config). */
  shared: boolean;
  reason: "overlap" | "several_owners";
  suggestion: Suggestion;
  alternative?: Suggestion;
};

const quoteList = (items: readonly string[]): string => items.map((item) => `"${item}"`).join(", ");

const ownerSuggestion = (slice: string, paths: string[]): OwnerSuggestion => ({
  kind: "owner",
  slice,
  paths,
  text: `add ${quoteList(paths)} to "owns" of slice ${slice}`,
});

const serializeSuggestion = (ids: readonly string[]): Suggestion => {
  const edges = ids.slice(1).map((slice, index) => ({ slice, dependsOn: ids[index] }));
  return {
    kind: "serialize",
    edges,
    text: edges
      .map((edge) => `add "${edge.dependsOn}" to "dependsOn" of slice ${edge.slice}`)
      .join("; "),
  };
};

/**
 * Which files more than one slice may write, given the candidate paths.
 * Resolved overlaps (one owner, or every pair serialized by a dependency)
 * are listed; the rest are conflicts grouped by the slices involved.
 */
export function analyzeOverlap(
  plan: FanoutFile,
  candidates: Iterable<string>,
): { overlaps: Overlap[]; conflicts: OverlapConflict[] } {
  const shared = [...DEFAULT_SHARED, ...plan.shared];
  const before = ancestors(plan.slices);
  const related = (a: string, b: string): boolean =>
    Boolean(before.get(a)?.has(b) || before.get(b)?.has(a));
  const overlaps: Overlap[] = [];
  const groups = new Map<string, OverlapConflict & { members: Slice[] }>();
  // Paths that differ only in case are one file on case-insensitive checkouts.
  const byCase = new Map<string, string[]>();
  for (const file of [...new Set(candidates)].toSorted())
    (
      byCase.get(file.toLowerCase()) ?? byCase.set(file.toLowerCase(), []).get(file.toLowerCase())
    )?.push(file);
  for (const spellings of byCase.values()) {
    const file = spellings.join(" ~ ");
    const any = (patterns: readonly string[]) =>
      spellings.some((spelling) => matchesAny(patterns, spelling));
    const matching = plan.slices.filter((slice) => any(slice.scope) || any(slice.owns));
    if (matching.length < 2) continue;
    const ids = matching.map((slice) => slice.id);
    const owners = matching.filter((slice) => any(slice.owns));
    if (owners.length === 1) {
      overlaps.push({ path: file, slices: ids, resolution: "owner", owner: owners[0].id });
      continue;
    }
    if (
      owners.length === 0 &&
      matching.every((a, i) => matching.slice(i + 1).every((b) => related(a.id, b.id)))
    ) {
      overlaps.push({ path: file, slices: ids, resolution: "serialized" });
      continue;
    }
    const members = owners.length > 1 ? owners : matching;
    const reason = owners.length > 1 ? "several_owners" : "overlap";
    const isShared = any(shared);
    const key = `${reason}|${isShared}|${members.map((slice) => slice.id).join(",")}`;
    const group = groups.get(key);
    if (group) group.paths.push(file);
    else
      groups.set(key, {
        slices: members.map((slice) => slice.id),
        paths: [file],
        shared: isShared,
        reason,
        members,
        suggestion: ownerSuggestion(members[0].id, []),
      });
  }
  const conflicts = [...groups.values()].map(({ members, ...group }) => {
    // The owner: the first slice (plan order) that names one of the paths
    // literally, else the first slice. Serializing keeps plan order.
    const literal = members.find((slice) =>
      slice.scope.some((pattern) => group.paths.includes(pattern)),
    );
    const owner = ownerSuggestion((literal ?? members[0]).id, group.paths);
    if (group.reason === "several_owners")
      return {
        ...group,
        suggestion: {
          ...owner,
          text: `keep ${quoteList(group.paths)} in "owns" of slice ${owner.slice} only`,
        },
      };
    const serialize = serializeSuggestion(group.slices);
    return group.shared
      ? { ...group, suggestion: owner, alternative: serialize }
      : { ...group, suggestion: serialize, alternative: owner };
  });
  return { overlaps, conflicts };
}

// ---------------------------------------------------------------------------
// case-only collisions with the trunk

export type CaseCollision = { slice: string; path: string; trunk: string };

/** Trunk paths (files and the directories above them) by lower case. */
export function caseIndex(files: Iterable<string>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const file of files) {
    const parts = file.split("/");
    for (let end = 1; end <= parts.length; end += 1) {
      const prefix = parts.slice(0, end).join("/");
      const key = prefix.toLowerCase();
      (index.get(key) ?? index.set(key, new Set()).get(key))?.add(prefix);
    }
  }
  return index;
}

/**
 * The shallowest part of `file` (a directory or the file itself) that the
 * trunk spells differently only in case: one path on macOS and Windows
 * checkouts, two in git. Null when there is none.
 */
export function caseClash(
  index: ReadonlyMap<string, ReadonlySet<string>>,
  file: string,
): { path: string; trunk: string } | null {
  const parts = file.split("/");
  for (let end = 1; end <= parts.length; end += 1) {
    const prefix = parts.slice(0, end).join("/");
    if (prefix.includes("<any>")) return null;
    const spellings = index.get(prefix.toLowerCase());
    if (spellings && !spellings.has(prefix))
      return { path: prefix, trunk: [...spellings].toSorted()[0] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// git

type GitRun = { ok: boolean; status: number | null; stdout: string; stderr: string };

export const gitRun = (
  cwd: string,
  args: string[],
  timeoutMs: number = GIT_TIMEOUTS.local,
): GitRun => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANGUAGE: "C" },
  });
  return {
    ok: run.status === 0,
    status: run.status,
    stdout: run.stdout ?? "",
    stderr: run.error ? String(run.error.message) : (run.stderr ?? ""),
  };
};

export const nulList = (text: string): string[] => text.split("\0").filter(Boolean);

/** The commit a branch name points at: the local branch, else its remote-tracking ref. */
export function branchRef(cwd: string, branch: string): string | null {
  if (!branch || branch.startsWith("-")) return null;
  const local = resolveRef(cwd, `refs/heads/${branch}`);
  if (local) return local;
  const remote = pushRemoteName(cwd) ?? "origin";
  return resolveRef(cwd, `refs/remotes/${remote}/${branch}`);
}

/** The trunk as the forge sees it (remote-tracking ref) when known, else the local branch. */
export function trunkRef(cwd: string, trunk: string): string | null {
  if (!trunk || trunk.startsWith("-")) return null;
  const remote = pushRemoteName(cwd) ?? "origin";
  for (const ref of [`refs/remotes/${remote}/${trunk}`, `refs/heads/${trunk}`, trunk])
    if (resolveRef(cwd, ref)) return ref;
  return null;
}

/** The trunk name when the plan does not give one: origin's default branch, else main. */
export function defaultTrunk(cwd: string): string {
  const base = defaultBase(cwd);
  return base ? base.replace(/^origin\//u, "") : "main";
}

/** The main checkout (beside `.git`), else `cwd`. */
export function mainCheckout(cwd: string): string {
  const common = gitCommonDir(cwd);
  return common && path.basename(common) === ".git" ? path.dirname(common) : path.resolve(cwd);
}

/** `<repo>-wt/` beside the main checkout. */
export function worktreeRoot(cwd: string): string {
  const main = mainCheckout(cwd);
  return path.join(path.dirname(main), `${path.basename(main)}-wt`);
}

/**
 * sha256 (16 hex) of the slice's definition. Brief-only fields (tier,
 * timebox, context) and the worktree path are left out, so fixing a typo in
 * them never re-dispatches landed work.
 */
export function sliceHash(slice: Slice): string {
  const {
    worktree: _worktree,
    hash: _hash,
    hashSince: _since,
    tier: _tier,
    timebox: _timebox,
    context: _context,
    ...definition
  } = slice;
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// store

export function fanoutsDir(cwd: string): FanoutResult<string> {
  const root = storeRoot(cwd);
  if (!root.ok) return fanoutFail(root.code, root.error, root.unblock);
  return { ok: true, data: path.join(root.value.root, "fanouts") };
}

/**
 * Tolerant read (D17) that still re-validates what the checks rely on: every
 * glob normalizes, every dependency is a known slice, no cycle. A file that
 * fails is "not a valid plan", never half-trusted.
 */
function parseStored(raw: unknown): FanoutFile | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.trunk !== "string") return null;
  if (!Array.isArray(raw.slices)) return null;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  let globsValid = true;
  const globs = (value: unknown): string[] =>
    list(value).map((entry) => {
      const normalized = normalizePattern(entry);
      if ("error" in normalized) {
        globsValid = false;
        return entry;
      }
      return normalized.pattern;
    });
  const slices: Slice[] = [];
  for (const item of raw.slices) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.branch !== "string")
      return null;
    slices.push({
      id: item.id,
      branch: item.branch,
      base: text(item.base) || raw.trunk,
      worktree: text(item.worktree),
      tier: (TIERS as readonly unknown[]).includes(item.tier) ? (item.tier as Tier) : "standard",
      dependsOn: list(item.dependsOn),
      scope: globs(item.scope),
      owns: globs(item.owns),
      goal: text(item.goal),
      acceptance: list(item.acceptance),
      verify: list(item.verify),
      forbidden: list(item.forbidden),
      context: typeof item.context === "string" ? item.context : null,
      timebox: typeof item.timebox === "string" ? item.timebox : null,
      hash: text(item.hash),
      // A plan written before slice hashes: its run began at createdAt.
      hashSince: text(item.hashSince) || text(raw.createdAt),
    });
  }
  for (const slice of slices) slice.hash ||= sliceHash(slice);
  const shared = globs(raw.shared);
  const ids = new Set(slices.map((slice) => slice.id));
  if (
    !globsValid ||
    ids.size !== slices.length ||
    slices.some((slice) => slice.dependsOn.some((dep) => dep === slice.id || !ids.has(dep))) ||
    findCycle(slices)
  )
    return null;
  const fanIn = raw.fanIn === "integration" ? "integration" : "prs";
  const createdAt = text(raw.createdAt);
  return {
    v: typeof raw.v === "number" ? raw.v : FANOUT_VERSION,
    name: raw.name,
    trunk: raw.trunk,
    fanIn,
    shared,
    slices,
    createdAt,
    updatedAt: text(raw.updatedAt),
  };
}

export function readFanout(cwd: string, name: string): FanoutResult<FanoutFile | null> {
  const dir = fanoutsDir(cwd);
  if (!dir.ok) return dir;
  const file = path.join(dir.data, stackFileName(name));
  let parsed: FanoutFile | null = null;
  try {
    parsed = parseStored(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, data: null };
    parsed = null;
  }
  return parsed
    ? { ok: true, data: parsed }
    : fanoutFail(
        "failed",
        `fanout file ${file} is not a valid plan`,
        `workit fanout plan <plan.json> --name ${name}  # rewrite it`,
      );
}

function listFanouts(cwd: string): FanoutResult<FanoutFile[]> {
  const dir = fanoutsDir(cwd);
  if (!dir.ok) return dir;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir.data).filter((entry) => entry.endsWith(".json"));
  } catch {
    return { ok: true, data: [] };
  }
  const out: FanoutFile[] = [];
  for (const entry of names) {
    let parsed: FanoutFile | null = null;
    try {
      parsed = parseStored(JSON.parse(fs.readFileSync(path.join(dir.data, entry), "utf8")));
    } catch {
      parsed = null;
    }
    if (parsed && stackFileName(parsed.name) === entry) out.push(parsed);
  }
  return { ok: true, data: out.toSorted((a, b) => a.name.localeCompare(b.name)) };
}

/** The plan `name`, else the one with the current branch as a slice, else the only one. */
export function selectFanout(
  cwd: string,
  name: string | null,
  current: string | null,
): FanoutResult<FanoutFile> {
  if (name) {
    const read = readFanout(cwd, name);
    if (!read.ok) return read;
    return read.data
      ? { ok: true, data: read.data }
      : fanoutFail("not_found", `no fanout plan named ${name}`, "workit fanout plan <plan.json>");
  }
  const all = listFanouts(cwd);
  if (!all.ok) return all;
  const holding = all.data.filter((plan) => plan.slices.some((slice) => slice.branch === current));
  if (holding.length === 1) return { ok: true, data: holding[0] };
  if (all.data.length === 1) return { ok: true, data: all.data[0] };
  return all.data.length === 0
    ? fanoutFail("not_found", "no fanout plan is recorded here", "workit fanout plan <plan.json>")
    : fanoutFail(
        "invalid_input",
        `several fanout plans match; pick one (${all.data.map((plan) => plan.name).join(", ")})`,
        "pass --name <plan>",
      );
}

function writeFanout(cwd: string, plan: FanoutFile): FanoutResult<string> {
  const dir = fanoutsDir(cwd);
  if (!dir.ok) return dir;
  const file = path.join(dir.data, stackFileName(plan.name));
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir.data, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(plan, null, 2)}\n`);
    fs.renameSync(temp, file);
    return { ok: true, data: file };
  } catch (error) {
    fs.rmSync(temp, { force: true });
    return fanoutFail("unavailable", `cannot write ${file}: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// plan

export type PlanOutcome = {
  name: string;
  trunk: string;
  fanIn: FanInMode;
  file: string;
  created: boolean;
  slices: Array<
    Pick<Slice, "id" | "branch" | "base" | "worktree" | "tier" | "dependsOn" | "scope" | "owns">
  >;
  overlaps: Overlap[];
  waves: string[][];
  landingOrder: string[];
  notes: string[];
  /** A new plan under a name that still has standing orders in force (an earlier run's?). */
  warnings: string[];
};

/** Above this many slices in one wave, the lead queues the rest (4-6 in flight). */
export const IN_FLIGHT_CAP = 6;

export function planFanout(
  cwd: string,
  input: { raw: unknown; name: string | null; trunk: string | null; actor: LedgerActor },
  now: Date = new Date(),
): FanoutResult<PlanOutcome> {
  const dir = fanoutsDir(cwd);
  if (!dir.ok) return dir;
  const parsed = parsePlan(
    input.trunk && isRecord(input.raw) ? { ...input.raw, trunk: input.trunk } : input.raw,
    {
      trunk: input.trunk ?? defaultTrunk(cwd),
      root: mainCheckout(cwd),
      worktreeRoot: worktreeRoot(cwd),
    },
    input.name,
  );
  if (!parsed.ok)
    return fanoutFail(
      "invalid_input",
      `the plan is incomplete: ${parsed.problems[0]}${parsed.problems.length > 1 ? ` (+${parsed.problems.length - 1} more)` : ""}`,
      "fill every listed field, then run workit fanout plan again",
      { problems: parsed.problems },
    );
  const plan = parsed.plan;
  if (plan.fanIn === "integration" && plan.trunk === defaultTrunk(cwd))
    return fanoutFail(
      "invalid_input",
      `fanIn "integration" needs an integration branch as the trunk, not ${plan.trunk}`,
      `workit git branch <integration-branch> --base ${plan.trunk}, then plan with --trunk <integration-branch>`,
    );
  const badBranches = plan.slices
    .filter((slice) => !gitRun(cwd, ["check-ref-format", "--branch", slice.branch]).ok)
    .map((slice) => `slice ${slice.id}: ${slice.branch} is not a valid branch name`);
  if (badBranches.length)
    return fanoutFail("invalid_input", badBranches[0], "rename the branch in the plan", {
      problems: badBranches,
    });

  const ref = trunkRef(cwd, plan.trunk);
  const tracked = ref
    ? nulList(gitRun(cwd, ["ls-tree", "-r", "-z", "--name-only", ref]).stdout)
    : [];
  const samples = plan.slices.flatMap((slice) =>
    [...slice.scope, ...slice.owns].flatMap(scopeSamples),
  );
  const { overlaps, conflicts } = analyzeOverlap(plan, [...tracked, ...samples]);
  if (conflicts.length)
    return fanoutFail(
      "blocked",
      `${conflicts.length} file-scope overlap${conflicts.length === 1 ? "" : "s"} between slices: ${conflicts[0].slices.join(" and ")} on ${conflicts[0].paths[0]}${conflicts[0].paths.length > 1 ? ` (+${conflicts[0].paths.length - 1})` : ""}`,
      conflicts[0].suggestion.text,
      { name: plan.name, conflicts, overlaps },
    );

  const trunkCase = caseIndex(tracked);
  const clashes: CaseCollision[] = [];
  for (const slice of plan.slices) {
    const seen = new Set<string>();
    for (const sample of [...slice.scope, ...slice.owns].flatMap(scopeSamples)) {
      const clash = caseClash(trunkCase, sample);
      if (clash && !seen.has(clash.path)) {
        seen.add(clash.path);
        clashes.push({ slice: slice.id, ...clash });
      }
    }
  }
  if (clashes.length)
    return fanoutFail(
      "blocked",
      `slice ${clashes[0].slice} names ${clashes[0].path}, which differs only in case from ${plan.trunk}'s ${clashes[0].trunk} (one path on macOS and Windows)`,
      `use ${plan.trunk}'s spelling ${clashes[0].trunk} in slice ${clashes[0].slice}'s scope, then workit fanout plan again`,
      { name: plan.name, caseCollisions: clashes, overlaps },
    );

  const existing = readFanout(cwd, plan.name);
  const previous = existing.ok ? existing.data : null;
  plan.createdAt = previous?.createdAt || now.toISOString();
  plan.updatedAt = now.toISOString();
  // Per slice: the same definition continues its run; a changed one starts anew.
  for (const slice of plan.slices) {
    slice.hash = sliceHash(slice);
    const before = previous?.slices.find((old) => old.id === slice.id);
    slice.hashSince =
      before && before.hash === slice.hash ? before.hashSince || plan.updatedAt : plan.updatedAt;
  }
  const written = writeFanout(cwd, plan);
  if (!written.ok) return written;
  appendObserved(cwd, {
    type: "fanout.planned",
    actor: input.actor,
    fanout: plan.name,
    trunk: plan.trunk,
    fanIn: plan.fanIn,
    slices: plan.slices.length,
    ids: plan.slices.slice(0, 20).map((slice) => slice.id),
  });

  const grouped = waves(plan.slices);
  const notes: string[] = [];
  const warnings: string[] = [];
  if (previous === null) {
    const ledger = readLedger(cwd);
    const inForce = ledger.ok ? activeStanding(ledger.value.rows, plan.name) : [];
    if (inForce.length)
      warnings.push(
        `${inForce.length} standing order${inForce.length === 1 ? " is" : "s are"} already in force for fanout ${plan.name}, and every brief will carry ${inForce.length === 1 ? "it" : "them"}: ${inForce.map((row) => `"${String(row.what)}"`).join("; ")}. From an earlier run? workit ledger standing clear --fanout ${plan.name}`,
      );
  }
  if (!ref)
    notes.push(
      `trunk ${plan.trunk} does not resolve here; only sample paths of each glob were compared`,
    );
  grouped.forEach((wave, index) => {
    if (wave.length > IN_FLIGHT_CAP)
      notes.push(
        `wave ${index + 1} has ${wave.length} slices; keep 4-${IN_FLIGHT_CAP} in flight and queue the rest`,
      );
  });
  for (const slice of plan.slices)
    if (slice.dependsOn.length > 1 && slice.base === plan.trunk)
      notes.push(
        `slice ${slice.id} depends on ${slice.dependsOn.join(", ")}: start it from ${plan.trunk} after they land`,
      );
  return {
    ok: true,
    data: {
      name: plan.name,
      trunk: plan.trunk,
      fanIn: plan.fanIn,
      file: written.data,
      created: previous === null,
      slices: plan.slices.map(({ id, branch, base, worktree, tier, dependsOn, scope, owns }) => ({
        id,
        branch,
        base,
        worktree,
        tier,
        dependsOn,
        scope,
        owns,
      })),
      overlaps,
      waves: grouped,
      landingOrder: landingOrder(plan.slices),
      notes,
      warnings,
    },
  };
}
