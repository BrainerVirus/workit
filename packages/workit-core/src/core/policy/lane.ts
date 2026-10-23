// Review lanes (#333, ledger decisions mvi7mj28 and mvk5q3io): how much
// review a change needs, computed from its diff. Under the workspace setting
// `verification: proportional` (the default) every verdict gate reads the
// lane: `pr merge`, `stack land`, the Stop hook and `policy assess`.
//
//   none     docs, comment or formatting-only, or generated copies: no verdict
//   self     a small, low-risk behavior change: the author's `--self` verdict
//   focused  a normal behavior change: an accepted non-author verdict
//   full     a risk path, a large diff or a high-risk judgment: an accepted
//            non-author verdict (a high-risk task also asks `--kind live`)
//
// The diff sets the floor; a recorded high-risk judgment raises it to full.
// A behavior-change judgment does not move it: the diff already tells docs
// from behavior (Markdown that steers agents counts as behavior).
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  diffNumstat,
  diffSubstance,
  generatedPaths,
  resolveRef,
  untrackedFiles,
} from "../../git/rev";
import type { VerificationMode } from "../../autonomy";
import { defaultBase, type VerdictCheck } from "../../ledger";

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
 * Tests and docs never count as risk paths.
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

/** Exact repo paths (CI definitions) that are risk paths regardless of tokens. */
const RISK_FILES = new Set([
  ".gitlab-ci.yml",
  "Jenkinsfile",
  "azure-pipelines.yml",
  ".pre-commit-config.yaml",
]);

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

const DOC_EXT = /\.(?:md|mdx|markdown|rst|adoc)$/iu;
const DOC_NAMES = /^(?:license|licence|notice|authors|changelog|changes|contributors)(?:\.|$)/iu;
/** Markdown that steers agents is behavior, not docs. */
const INSTRUCTIONS =
  /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|SKILL)\.md$|(?:^|\/)(?:skills|agents|commands|rules|prompts)\/[^/]+/iu;
const TEST_PATH =
  /(?:^|\/)(?:test|tests|__tests__|spec|specs|fixtures)\/|\.(?:test|spec)\.[^/]+$/iu;
const GENERATED_PATH = /(?:^|\/)(?:generated|__generated__)\/|\.generated\.[^/]+$/iu;

/** Comment markers by extension: a changed line starting with one is a comment. */
const SLASH = ["//", "/*", "*/", "* ", "*"];
const HASH = ["#"];
const COMMENT_MARKERS: Record<string, readonly string[]> = Object.fromEntries([
  ...[
    "ts",
    "tsx",
    "mts",
    "cts",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "java",
    "kt",
    "go",
    "rs",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "swift",
    "scala",
    "php",
    "css",
    "scss",
    "less",
  ].map((ext) => [ext, SLASH]),
  ...["py", "sh", "bash", "zsh", "rb", "yml", "yaml", "toml", "pl", "r"].map((ext) => [ext, HASH]),
  ...["sql", "lua", "hs"].map((ext) => [ext, ["--"]]),
  ...["html", "xml", "svg", "vue"].map((ext) => [ext, ["<!--", "-->"]]),
]);

export type ChangedFile = {
  path: string;
  added: number;
  deleted: number;
  binary?: boolean;
  /** Only whitespace, blank-line or comment changes. */
  cosmetic?: boolean;
  /** Marked `linguist-generated` in `.gitattributes`. */
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

function kindOf(file: ChangedFile): FileKind {
  if (file.generated || GENERATED_PATH.test(file.path)) return "generated";
  if (LOCKFILES.has(basename(file.path))) return "lockfile";
  if (
    /(?:^|\/)docs\//u.test(file.path) ||
    (!INSTRUCTIONS.test(file.path) &&
      (DOC_EXT.test(file.path) || DOC_NAMES.test(basename(file.path))))
  )
    return "doc";
  if (file.cosmetic && !file.binary) return "cosmetic";
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

/** A built-in risk path: a CI file, `.github/workflows`, or a path with a risk token. */
export function isRiskPath(file: string, extra: readonly string[] = []): boolean {
  if (extra.some((pattern) => globMatch(pattern, file))) return true;
  if (TEST_PATH.test(file)) return false;
  if (RISK_FILES.has(file)) return true;
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

/** The review lane for a set of changed files (pure; thresholds in LANE_THRESHOLDS). */
export function computeLane(input: LaneInput): LaneAssessment {
  const kinds = input.files.map((file) => ({ file, kind: kindOf(file) }));
  const behavior = kinds.filter(
    (entry) => entry.kind === "behavior" || entry.kind === "test" || entry.kind === "lockfile",
  );
  const lines = behavior
    .filter((entry) => entry.kind !== "lockfile")
    .reduce((sum, entry) => sum + entry.file.added + entry.file.deleted, 0);
  const riskFiles = behavior
    .filter((entry) => isRiskPath(entry.file.path, input.riskPaths))
    .map((entry) => entry.file.path);
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
  return result("self", [
    `small change: ${lines} line${lines === 1 ? "" : "s"} in ${behavior.length} file${behavior.length === 1 ? "" : "s"}, no risk path`,
  ]);
}

const extension = (file: string): string => {
  const name = basename(file);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/**
 * Files whose whitespace-insensitive diff changes something other than
 * comments, from `git diff -U0 -w --ignore-blank-lines` output. A file
 * absent from that diff changed only whitespace.
 */
export function substantiveFiles(diff: string): Set<string> {
  const out = new Set<string>();
  let file: string | null = null;
  let headerPath: string | null = null;
  let markers: readonly string[] | null = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice("diff --git ".length);
      // No renames: `a/<p> b/<p>`, so the path is half of what is left.
      headerPath = rest.slice(2, 2 + (rest.length - 5) / 2);
      file = null;
      markers = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      const side = line.slice(4);
      if (side !== "/dev/null") file = side.slice(2);
      file ??= headerPath;
      markers = file ? (COMMENT_MARKERS[extension(file)] ?? null) : null;
      continue;
    }
    if (
      !inHunk &&
      (line.startsWith("old mode") ||
        line.startsWith("new mode") ||
        line.startsWith("Binary files"))
    ) {
      if (headerPath) out.add(headerPath);
      continue;
    }
    if (!(line.startsWith("+") || line.startsWith("-")) || !file) continue;
    const text = line.slice(1).trim();
    if (!text) continue;
    const comment = markers?.some((marker) =>
      marker === "*" ? text === "*" : text.startsWith(marker),
    );
    if (!comment) out.add(file);
  }
  return out;
}

/** Lines of an untracked file; binary (or unreadable) when it holds a NUL byte. */
function untrackedStat(cwd: string, file: string): ChangedFile {
  try {
    const bytes = readFileSync(path.join(cwd, file));
    if (bytes.includes(0)) return { path: file, added: 0, deleted: 0, binary: true };
    const text = bytes.toString("utf8");
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return { path: file, added: lines, deleted: 0 };
  } catch {
    return { path: file, added: 0, deleted: 0, binary: true };
  }
}

/**
 * The changed files of `merge-base(base, head)..head`, or with `head` null
 * of the working tree (tracked changes plus untracked files) since
 * `merge-base(base, HEAD)`. Null when git cannot read them.
 */
export function changedFiles(cwd: string, base: string, head: string | null): ChangedFile[] | null {
  const stats = diffNumstat(cwd, base, head);
  const substance = stats ? diffSubstance(cwd, base, head) : null;
  if (!stats || substance === null) return null;
  const substantive = substantiveFiles(substance);
  const files: ChangedFile[] = [
    ...stats.map((entry) => ({
      ...entry,
      cosmetic: !entry.binary && !substantive.has(entry.path),
    })),
    ...(head === null ? untrackedFiles(cwd).map((file) => untrackedStat(cwd, file)) : []),
  ];
  const generated = generatedPaths(
    cwd,
    files.map((entry) => entry.path),
  );
  return files.map((entry) => ({ ...entry, generated: generated.has(entry.path) }));
}

export type BranchLane = LaneAssessment & { base: string | null; head: string | null };

/**
 * The lane of `head` against `base` (a branch name; `origin/<base>` is
 * preferred, then the local branch, then the repository default). When the
 * diff cannot be read the lane is focused (an independent verdict, as
 * before lanes), or full under a high-risk judgment.
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
  const files =
    base && options.workingTree
      ? changedFiles(cwd, base, null)
      : base && options.head
        ? changedFiles(cwd, base, options.head)
        : null;
  const judged = {
    riskTier: options.judgment?.riskTier ?? null,
    riskPaths: options.riskPaths ?? [],
  };
  if (!files) {
    const high = judged.riskTier === "high";
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
  return { ...computeLane({ files, ...judged }), base, head: options.head };
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
