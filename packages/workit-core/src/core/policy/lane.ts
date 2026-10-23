// Review lanes (#333, ledger decisions mvi7mj28 and mvk5q3io): how much
// review a change needs, computed from its diff. Under the workspace setting
// `verification: proportional` (the default) every verdict gate reads the
// lane: `pr merge`, `stack land`, the Stop hook and `policy assess`.
//
//   none     docs, comment or formatting-only, or generated copies: no verdict
//   self     a small, low-risk behavior change: the author's `--self` verdict
//   focused  a normal behavior change, or any lockfile or binary change: an
//            accepted non-author verdict
//   full     a risk path, a large diff or a high-risk judgment: an accepted
//            non-author verdict (a high-risk task also asks `--kind live`)
//
// The lane fails closed (review finding mvkcoxgb): any doubt about a file
// makes it a behavior change, and a file on a risk path is never below full,
// whatever else it is (cosmetic, generated, docs or a lockfile). Generated
// copies and repo risk paths are read from the base revision only, so a
// change can neither mark its own code generated nor drop a risk path.
//
// The diff sets the floor; a recorded high-risk judgment raises it to full.
// A behavior-change judgment does not move it: the diff already tells docs
// from behavior (Markdown that steers agents counts as behavior).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  diffNumstat,
  diffRaw,
  fileAt,
  mergeBase,
  readBlobs,
  resolveRef,
  treeFilesNamed,
  untrackedFiles,
} from "../../git/rev";
import type { VerificationMode } from "../../autonomy";
import { git } from "../../git/ops";
import { defaultBase, type VerdictCheck } from "../../ledger";
import { generatedByAttributes } from "./attributes";
import { cosmeticChange, hasOpaqueLineBreak } from "./substance";

export const REVIEW_LANES = ["none", "self", "focused", "full"] as const;
export type ReviewLane = (typeof REVIEW_LANES)[number];

/**
 * Every lane threshold, in one place. Lines are added plus deleted lines of
 * files that change behavior (code, tests, agent instructions); docs,
 * cosmetic edits, generated copies and lockfiles never count.
 */
export const LANE_THRESHOLDS = {
  /** Above this a change is not small: self moves to focused (decision mvi7mj28). */
  selfMaxLines: 100,
  /** More behavior files than this is not small either: self moves to focused. */
  selfMaxFiles: 5,
  /** At or above this a diff is large: full. */
  fullMinLines: 500,
} as const;

/**
 * Path tokens that mark a risk path: merge and release gates, hooks, auth,
 * secrets, migrations, CI. A token matches a whole directory name or a
 * `-`/`_`/`.`-separated part of one (`auth`, `oauth-client`, `pre_commit`).
 * Tests and docs never match a token.
 */
export const RISK_TOKENS: ReadonlySet<string> = new Set([
  "auth",
  "authn",
  "authz",
  "oauth",
  "security",
  "permission",
  "permissions",
  "secret",
  "secrets",
  "crypto",
  "gate",
  "gates",
  "policy",
  "policies",
  "hook",
  "hooks",
  "husky",
  "lefthook",
  "release",
  "releases",
  "migration",
  "migrations",
  "migrate",
  "workflows",
]);

/** Exact repo paths (CI definitions, the lane's own inputs) that are risk paths. */
const RISK_FILES = new Set([
  ".gitlab-ci.yml",
  "Jenkinsfile",
  "azure-pipelines.yml",
  ".pre-commit-config.yaml",
  ".workit/risk-paths",
]);
/** File names that are risk paths in any directory: they decide what is generated. */
const RISK_NAMES = new Set([".gitattributes"]);

/** The repo's own risk paths, one glob per line at the base revision (decision B3: they only tighten). */
export const RISK_PATHS_FILE = ".workit/risk-paths";

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
]);

/** Docs are told by extension only: code under `docs/` is code. */
const DOC_EXT = /\.(?:md|mdx|markdown|rst|adoc|txt)$/iu;
const DOC_NAMES = /^(?:license|licence|notice|authors|changelog|changes|contributors)$/iu;
/** Markdown that steers agents is behavior, not docs. */
const INSTRUCTIONS =
  /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|SKILL)\.md$|(?:^|\/)(?:skills|agents|commands|rules|prompts)\/[^/]+/iu;
const TEST_PATH =
  /(?:^|\/)(?:test|tests|__tests__|spec|specs|fixtures)\/|\.(?:test|spec)\.[^/]+$/iu;

export type ChangedFile = {
  path: string;
  added: number;
  deleted: number;
  binary?: boolean;
  /** Only whitespace, blank-line or comment changes. */
  cosmetic?: boolean;
  /** Marked `linguist-generated` by the base revision's `.gitattributes`. */
  generated?: boolean;
};

export type LaneInput = {
  files: readonly ChangedFile[];
  /** The task judgment's riskTier, when one is recorded (high raises to full). */
  riskTier?: "trivial" | "normal" | "high" | null;
  /** Extra risk-path globs (`**`, `*`, `?`); they only tighten. */
  riskPaths?: readonly string[];
};

export type LaneAssessment = {
  lane: ReviewLane;
  /** Why, most decisive first. */
  reasons: string[];
  /** Counted lines (see LANE_THRESHOLDS). */
  lines: number;
  /** Files that change behavior. */
  files: number;
  riskFiles: string[];
};

type FileKind = "doc" | "cosmetic" | "generated" | "lockfile" | "test" | "behavior";

const basename = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

/** Prose for people: a doc extension (or a bare LICENSE-style name), not agent instructions. */
const isDoc = (file: string): boolean =>
  !INSTRUCTIONS.test(file) && (DOC_EXT.test(file) || DOC_NAMES.test(basename(file)));

/** What a file off risk paths is; risk paths are decided before (see computeLane). */
function kindOf(file: ChangedFile): FileKind {
  if (file.binary) return "behavior";
  if (file.generated) return "generated";
  if (LOCKFILES.has(basename(file.path))) return "lockfile";
  if (isDoc(file.path)) return "doc";
  if (file.cosmetic) return "cosmetic";
  return TEST_PATH.test(file.path) ? "test" : "behavior";
}

const globCache = new Map<string, RegExp>();
/** `**` spans directories, `*` and `?` stay within one. */
function globMatch(pattern: string, file: string): boolean {
  let regex = globCache.get(pattern);
  if (!regex) {
    let source = "";
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];
      if (char === "*" && pattern[index + 1] === "*") {
        source += pattern[index + 2] === "/" ? "(?:[^/]*/)*" : ".*";
        index += pattern[index + 2] === "/" ? 2 : 1;
      } else if (char === "*") source += "[^/]*";
      else if (char === "?") source += "[^/]";
      else source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
    regex = new RegExp(`^${source}$`, "u");
    globCache.set(pattern, regex);
  }
  return regex.test(file) || file.startsWith(`${pattern.replace(/\/$/u, "")}/`);
}

/**
 * A risk path: a configured glob (any file, tests and docs included), a CI
 * definition, a `.gitattributes`, `.workit/risk-paths`, or a path with a
 * risk token (never a test or a doc).
 */
export function isRiskPath(file: string, extra: readonly string[] = []): boolean {
  if (extra.some((pattern) => globMatch(pattern, file))) return true;
  if (RISK_FILES.has(file) || RISK_NAMES.has(basename(file))) return true;
  if (TEST_PATH.test(file) || isDoc(file)) return false;
  return file
    .split("/")
    .map((segment, index, all) =>
      index === all.length - 1 ? segment.replace(/\.[^.]+$/u, "") : segment,
    )
    .some((segment) =>
      segment
        .toLowerCase()
        .split(/[-_.]/u)
        .some((token) => RISK_TOKENS.has(token)),
    );
}

/** The globs of a risk-paths file: one per line, `#` comments and blank lines skipped. */
export const parseRiskPaths = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/^\//u, ""));

/** The review lane for a set of changed files (pure; thresholds in LANE_THRESHOLDS). */
export function computeLane(input: LaneInput): LaneAssessment {
  // A risk path is decided first and overrides every other kind.
  const riskFiles = input.files
    .filter((file) => isRiskPath(file.path, input.riskPaths))
    .map((file) => file.path);
  const risky = new Set(riskFiles);
  const kinds = input.files.map((file) => ({
    file,
    kind: risky.has(file.path) ? ("behavior" as const) : kindOf(file),
  }));
  const behavior = kinds.filter(
    (entry) => entry.kind === "behavior" || entry.kind === "test" || entry.kind === "lockfile",
  );
  const lines = behavior
    .filter((entry) => entry.kind !== "lockfile")
    .reduce((sum, entry) => sum + entry.file.added + entry.file.deleted, 0);
  const opaque = behavior.filter((entry) => entry.kind === "lockfile" || entry.file.binary);
  const result = (lane: ReviewLane, reasons: string[]): LaneAssessment => ({
    lane,
    reasons,
    lines,
    files: behavior.length,
    riskFiles,
  });
  const { selfMaxLines, selfMaxFiles, fullMinLines } = LANE_THRESHOLDS;
  if (input.riskTier === "high") return result("full", ["the task judgment records high risk"]);
  if (riskFiles.length)
    return result("full", [
      `touches a risk path: ${riskFiles.slice(0, 3).join(", ")}${riskFiles.length > 3 ? ", …" : ""}`,
    ]);
  if (!behavior.length)
    return result("none", [
      input.files.length
        ? "only docs, comments, formatting or generated copies changed"
        : "no changes",
    ]);
  if (lines >= fullMinLines)
    return result("full", [`large diff: ${lines} lines (≥ ${fullMinLines})`]);
  if (lines > selfMaxLines)
    return result("focused", [`${lines} lines changed (> ${selfMaxLines})`]);
  if (behavior.length > selfMaxFiles)
    return result("focused", [`${behavior.length} behavior files changed (> ${selfMaxFiles})`]);
  // A lockfile or a binary has no lines to read: the author cannot vouch for it alone.
  if (opaque.length)
    return result("focused", [
      `a lockfile or binary changed: ${opaque
        .slice(0, 3)
        .map((entry) => entry.file.path)
        .join(", ")}${opaque.length > 3 ? ", …" : ""}`,
    ]);
  return result("self", [
    `small change: ${lines} line${lines === 1 ? "" : "s"} in ${behavior.length} file${behavior.length === 1 ? "" : "s"}, no risk path`,
  ]);
}

/** Lines of an untracked file; binary (or unreadable) when it holds a NUL byte. */
function untrackedStat(cwd: string, file: string): ChangedFile {
  try {
    const bytes = readFileSync(path.join(cwd, file));
    if (bytes.includes(0)) return { path: file, added: 0, deleted: 0, binary: true };
    const text = bytes.toString("utf8");
    if (hasOpaqueLineBreak(text)) return { path: file, added: 0, deleted: 0, binary: true };
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return { path: file, added: lines, deleted: 0 };
  } catch {
    return { path: file, added: 0, deleted: 0, binary: true };
  }
}

const REGULAR = new Set(["100644", "100755"]);
const ABSENT = /^0+$/u;

/**
 * The files of `fork..head` (or the working tree) whose change is cosmetic:
 * a regular file on both sides, same mode, and equal substance (comments
 * and insignificant whitespace aside; see substance.ts). A file git lists
 * but this cannot read is not cosmetic.
 */
function cosmeticFiles(
  cwd: string,
  fork: string,
  head: string | null,
): { cosmetic: Set<string>; opaque: Set<string> } | null {
  const raw = diffRaw(cwd, fork, head);
  if (!raw) return null;
  const candidates = raw.filter(
    (entry) =>
      REGULAR.has(entry.oldMode) &&
      entry.oldMode === entry.newMode &&
      !ABSENT.test(entry.oldBlob) &&
      (head === null || !ABSENT.test(entry.newBlob)),
  );
  const blobs = readBlobs(
    cwd,
    candidates.flatMap((entry) => [entry.oldBlob, entry.newBlob]),
  );
  if (!blobs) return null;
  const out = new Set<string>();
  const opaque = new Set<string>();
  for (const entry of candidates) {
    const before = blobs.get(entry.oldBlob);
    let after = blobs.get(entry.newBlob);
    if (!after && head === null && ABSENT.test(entry.newBlob))
      try {
        after = readFileSync(path.join(cwd, entry.path));
      } catch {
        after = undefined;
      }
    if (before && after && cosmeticChange(entry.path, before, after)) out.add(entry.path);
    // A lone CR, U+2028 or U+2029 ends a line for some readers and not for
    // others: such a file is read as opaque, like a binary.
    else if ([before, after].some((bytes) => bytes && hasOpaqueLineBreak(bytes.toString("utf8"))))
      opaque.add(entry.path);
  }
  return { cosmetic: out, opaque };
}

/** Of `paths`, those the `.gitattributes` files at `fork` mark generated (none when unreadable). */
function generatedAt(cwd: string, fork: string, paths: readonly string[]): Set<string> {
  const files = treeFilesNamed(cwd, fork, ".gitattributes");
  const blobs = files?.size ? readBlobs(cwd, [...files.values()]) : null;
  if (!files || !blobs) return new Set();
  const texts = new Map<string, string>();
  for (const [file, id] of files) {
    const bytes = blobs.get(id);
    if (bytes) texts.set(file, bytes.toString("utf8"));
  }
  return generatedByAttributes(texts, paths);
}

/** The fork point of `head` (or HEAD for the working tree) from `base`. */
const forkOf = (cwd: string, base: string, head: string | null): string | null =>
  mergeBase(cwd, base, head ?? "HEAD");

function laneFiles(cwd: string, fork: string, head: string | null): ChangedFile[] | null {
  const stats = diffNumstat(cwd, fork, head);
  const cosmetic = stats ? cosmeticFiles(cwd, fork, head) : null;
  if (!stats || !cosmetic) return null;
  const files: ChangedFile[] = [
    ...stats.map((entry) => ({
      ...entry,
      ...(cosmetic.opaque.has(entry.path) ? { binary: true } : {}),
      cosmetic: !entry.binary && cosmetic.cosmetic.has(entry.path),
    })),
    ...(head === null ? untrackedFiles(cwd).map((file) => untrackedStat(cwd, file)) : []),
  ];
  const generated = generatedAt(
    cwd,
    fork,
    files.map((entry) => entry.path),
  );
  return files.map((entry) => ({
    ...entry,
    generated: generated.has(entry.path),
  }));
}

/**
 * The changed files of `merge-base(base, head)..head`, or with `head` null
 * of the working tree (tracked changes plus untracked files) since
 * `merge-base(base, HEAD)`. Null when git cannot read them.
 */
export function changedFiles(cwd: string, base: string, head: string | null): ChangedFile[] | null {
  const fork = forkOf(cwd, base, head);
  return fork ? laneFiles(cwd, fork, head) : null;
}

export type BranchLane = LaneAssessment & {
  base: string | null;
  head: string | null;
};

/**
 * The lane of `head` against `base` (a branch name; `origin/<base>` is
 * preferred, then the local branch, then the repository default). The repo's
 * risk paths come from `.workit/risk-paths` at the fork point. When the diff
 * cannot be read the lane is focused (an independent verdict, as before
 * lanes), or full under a high-risk judgment.
 */
export function branchLane(
  cwd: string,
  options: {
    base?: string | null;
    /** The commit to assess; null with `workingTree` reads the working tree instead. */
    head: string | null;
    workingTree?: boolean;
    judgment?: { riskTier: "trivial" | "normal" | "high" } | null;
    riskPaths?: readonly string[];
  },
): BranchLane {
  const candidates = options.base ? [`origin/${options.base}`, options.base] : [];
  const base = candidates.find((ref) => resolveRef(cwd, ref) !== null) ?? defaultBase(cwd) ?? null;
  const head = options.workingTree ? null : options.head;
  const fork = base && (options.workingTree || options.head) ? forkOf(cwd, base, head) : null;
  const files = fork ? laneFiles(cwd, fork, head) : null;
  const riskTier = options.judgment?.riskTier ?? null;
  if (!fork || !files) {
    const high = riskTier === "high";
    return {
      lane: high ? "full" : "focused",
      reasons: [
        `the diff of ${options.head?.slice(0, 12) ?? "(no head)"} against ${base ?? "(no base)"} cannot be read`,
        ...(high ? ["the task judgment records high risk"] : []),
      ],
      lines: 0,
      files: 0,
      riskFiles: [],
      base,
      head: options.head,
    };
  }
  const repoRisk = parseRiskPaths(fileAt(cwd, fork, RISK_PATHS_FILE) ?? "");
  return {
    ...computeLane({
      files,
      riskTier,
      riskPaths: [...repoRisk, ...(options.riskPaths ?? [])],
    }),
    base,
    head: options.head,
  };
}

/**
 * A warning when `.workit/risk-paths` sits in the working tree but is not
 * tracked: the lane reads it from the base revision only, so it applies once
 * it is committed there. Null when there is nothing to warn about.
 */
export function untrackedRiskPathsWarning(cwd: string): string | null {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = top.ok ? top.stdout.trim() : "";
  if (!root || !existsSync(path.join(root, RISK_PATHS_FILE))) return null;
  const tracked = git(root, ["ls-files", "--error-unmatch", "--", RISK_PATHS_FILE]);
  return tracked.ok
    ? null
    : `${RISK_PATHS_FILE} is not committed: it does not apply until it is committed on the base branch`;
}

/** What a verdict gate asks for in a lane under `verification: proportional`. */
export type LaneNeed = "none" | "self" | "non-author";
export const laneNeed = (lane: ReviewLane): LaneNeed =>
  lane === "none" ? "none" : lane === "self" ? "self" : "non-author";

export type LaneGate = {
  /** What the gate asks: nothing, the author's own `--self` verdict, or a non-author one. */
  need: LaneNeed;
  satisfied: boolean;
  /** The verdict that satisfies it (null under lane none, or when unmet). */
  verdictId: string | null;
  review: "verified" | "self-reviewed" | "none";
};

/**
 * One verdict gate for `pr merge`, `stack land` and the Stop hook. Under
 * `verification: proportional` with a lane, the lane decides; under `self`
 * or `independent` (or without a lane) an accepted non-author verdict is
 * needed, as before lanes. A current independent failure or a tampered
 * ledger always blocks. The caller still checks the verdict's head.
 */
export function laneGate(
  check: Pick<VerdictCheck, "accepted" | "selfVerdict">,
  verification: VerificationMode,
  lane: Pick<LaneAssessment, "lane"> | null,
): LaneGate {
  const need: LaneNeed =
    verification === "proportional" && lane ? laneNeed(lane.lane) : "non-author";
  const blocked = check.accepted.reasons.some(
    (reason) => reason === "failing_verdict" || reason === "ledger_tampered",
  );
  if (check.accepted.accepted && check.accepted.verdict)
    return {
      need,
      satisfied: true,
      verdictId: String(check.accepted.verdict.id),
      review: "verified",
    };
  if (need === "self" && check.selfVerdict && !blocked)
    return {
      need,
      satisfied: true,
      verdictId: String(check.selfVerdict.id),
      review: "self-reviewed",
    };
  return { need, satisfied: need === "none" && !blocked, verdictId: null, review: "none" };
}
