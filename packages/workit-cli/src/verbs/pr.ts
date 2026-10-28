// `workit pr status|create|merge|ready|edit|threads|reply` (design §2.1, S10/S11).
//
// status: PR/MR state, checks with failing job log tails, unresolved review
// threads, behind-base, and the next action.
// create: opens (or reuses) the PR for the pushed current branch, bound to and
// verified against the pushed SHA; records `pr.created`.
// merge: only when `pr status` reads READY, an accepted independent verdict
// covers the head (S13) and the merge grant allows it; head-SHA guarded.
// `--unverified --reason` (merge: true only) bypasses the verdict, recorded.
// `--subject`/`--body` (squash only) set the squash commit message.
// ready/edit/threads/reply: the lifecycle steps `next` names (audit M13).
import { endpointMismatch, resolveAutonomy } from "@brainervirus/workit-core/src/autonomy";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  label as issueLabel,
  linkedIssues,
  planIssueLinks,
  postBacklinks,
  recordIssueLinks,
  withIssueLines,
  type BacklinkOutcome,
  type IssueLink,
  type LinkedIssue,
} from "@brainervirus/workit-core/src/forge/issue-link";
import {
  editPullRequest,
  listThreads,
  readyPullRequest,
  replyToThread,
  type EditOutcome,
  type ReadyOutcome,
  type ReplyOutcome,
  type ThreadsOutcome,
} from "@brainervirus/workit-core/src/forge/pr-edit";
import {
  createPullRequest,
  fillFromCommits,
  mergePullRequest,
  nextHint,
  type CreateOutcome,
} from "@brainervirus/workit-core/src/forge/pr-ops";
import { prStatusReport } from "@brainervirus/workit-core/src/forge/report";
import type { MergeMethod } from "@brainervirus/workit-core/src/forge/types";
import { currentBranch } from "@brainervirus/workit-core/src/git/rev";
import { workspaceDeleteBranch } from "@brainervirus/workit-core/src/core/workspaces";
import {
  cleanupMergedBranch,
  type LocalCleanup,
} from "@brainervirus/workit-core/src/forge/merge-cleanup";
import {
  branchKindOf,
  flowMismatch,
  flowRoute,
  gitFlowOf,
  type FlowRoute,
} from "@brainervirus/workit-core/src/core/branch";
import {
  actorFromEnv,
  carryLabel,
  readLedger,
  type CarryNote,
} from "@brainervirus/workit-core/src/ledger";
import { checkVerdictsCovered, type StackCover } from "@brainervirus/workit-core/src/verdict-cover";
import { untrackedRiskPathsWarning } from "@brainervirus/workit-core/src/core/policy/lane";
import { prLaneGate } from "@brainervirus/workit-core/src/core/policy/pr-lane";
import {
  vcsConfig,
  type ResolvedReleaseTrack,
} from "@brainervirus/workit-core/src/core/vcs-config";
import { checkRoot } from "@brainervirus/workit-core/src/check-config";
import { emit, fail, ok, type Io } from "../output";
import {
  connect,
  forgeDeps,
  forgeFail,
  parseFlags,
  positiveInt,
  renderStatus,
  selector,
  unverifiedFlag,
  usage,
} from "./forge-common";

const CONVENTIONAL_TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
];
const COMMITLINT_FILES = [
  ".commitlintrc.json",
  ".commitlintrc",
  ".commitlintrc.yaml",
  ".commitlintrc.yml",
  ".commitlintrc.js",
  ".commitlintrc.cjs",
  ".commitlintrc.mjs",
  ".commitlintrc.ts",
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
];

type TitleRules = {
  types: { level: number; values: string[] } | null;
  maxHeader: { level: number; value: number } | null;
  format: number;
  defaultIgnores: boolean;
};

/** Mirror of @commitlint/is-ignored's default ignores, applied to the title. */
const DEFAULT_IGNORES: RegExp[] = [
  /^((Merge pull request)|(Merge (.*?) into (.*?)|(Merge branch (.*?)))(?:\r?\n)*$)/m,
  /^(Merge tag (.*?))(?:\r?\n)*$/m,
  /^(R|r)evert (.*)/,
  /^(R|r)eapply (.*)/,
  /^(amend|fixup|squash)!/,
  /^(Merged (.*?)(in|into) (.*)|Merged PR (.*): (.*))/,
  /^Merge remote-tracking branch(\s*)(.*)/,
  /^Automatic merge(.*)/,
  /^Auto-merged (.*?) into (.*)/,
  /^(chore(\([^)]+\))?:\s*)?v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?\s*$/,
];

type TitleRead = { rules: TitleRules | null; note: string | null };
const UNCHECKED = (what: string): TitleRead => ({
  rules: null,
  note: `commitlint config is ${what}; title not pre-checked, CI checks it`,
});

/** A JSON rule `[level, "always"|"never", value]`: its level and value, or null when unreadable or "never". */
const readRule = (
  rules: Record<string, unknown>,
  name: string,
): { level: number; value: unknown } | "off" | null => {
  const rule = rules[name];
  if (rule === undefined) return null;
  if (!Array.isArray(rule) || typeof rule[0] !== "number") return "off";
  if (rule[0] === 0 || rule[1] === "never") return "off";
  return { level: rule[0], value: rule[2] };
};

/**
 * The title rules of the repo's commitlint config. Only JSON configs are read
 * (extending nothing but config-conventional); any other form is left to CI
 * with a note, so the check never refuses a title commitlint accepts.
 */
function titleRules(cwd: string): TitleRead {
  let root: string;
  try {
    root = checkRoot(cwd);
  } catch {
    return { rules: null, note: null };
  }
  let text: string | null = null;
  let name = "";
  for (const candidate of COMMITLINT_FILES) {
    const full = path.join(root, candidate);
    if (!existsSync(full)) continue;
    text = readFileSync(full, "utf8");
    name = candidate;
    break;
  }
  if (text === null) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
        commitlint?: unknown;
      };
      if (pkg.commitlint === undefined) return { rules: null, note: null };
      text = JSON.stringify(pkg.commitlint);
    } catch {
      return { rules: null, note: null };
    }
  }
  if (/\.[cm]?[jt]s$/u.test(name)) return UNCHECKED("JS/TS");
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return UNCHECKED("not a plain JSON object");
    config = parsed as Record<string, unknown>;
  } catch {
    return UNCHECKED(/\.ya?ml$|^\.commitlintrc$/u.test(name) ? "YAML" : "unreadable");
  }
  if (config.ignores !== undefined) return UNCHECKED("using custom ignores");
  const extend = config.extends === undefined ? [] : [config.extends].flat();
  const known = (entry: unknown) =>
    typeof entry === "string" && /^(@commitlint\/)?config-conventional$/u.test(entry);
  if (!extend.every(known)) return UNCHECKED("extending a shareable config");
  const rules: TitleRules = {
    types: null,
    maxHeader: null,
    format: 0,
    defaultIgnores: config.defaultIgnores !== false,
  };
  if (extend.length) {
    rules.types = { level: 2, values: CONVENTIONAL_TYPES };
    rules.maxHeader = { level: 2, value: 100 };
    rules.format = 2;
  }
  const own = (config.rules ?? {}) as Record<string, unknown>;
  const types = readRule(own, "type-enum");
  if (types === "off") rules.types = null;
  else if (types && Array.isArray(types.value))
    rules.types = { level: types.level, values: types.value.map(String) };
  const max = readRule(own, "header-max-length");
  if (max === "off") rules.maxHeader = null;
  else if (max && typeof max.value === "number")
    rules.maxHeader = { level: max.level, value: max.value };
  for (const rule of ["type-empty", "subject-empty"]) {
    const read = readRule(own, rule);
    if (read === "off") rules.format = 0;
    else if (read) rules.format = Math.max(rules.format, read.level);
  }
  return { rules, note: null };
}

/**
 * Checks a PR title against the repo's commitlint rules. `error` names the
 * rule and length a level-2 rule refuses; `notes` carry level-1 warnings and
 * the "left to CI" note. Anything not readable exactly is not enforced.
 */
export function checkPrTitle(
  cwd: string,
  title: string,
): { error: string | null; notes: string[] } {
  const { rules, note } = titleRules(cwd);
  if (!rules) return { error: null, notes: note ? [note] : [] };
  const header = title.split("\n", 1)[0] ?? "";
  if (rules.defaultIgnores && DEFAULT_IGNORES.some((pattern) => pattern.test(title)))
    return { error: null, notes: [] };
  const problems: Array<{ level: number; message: string }> = [];
  const parsed = /^(\w*)(?:\((.*)\))?!?: (.*)$/u.exec(header);
  if (rules.format && (!parsed || !parsed[1] || !parsed[3]?.trim()))
    problems.push({
      level: rules.format,
      message: `PR title ${JSON.stringify(header)} is not a Conventional Commit "<type>(<scope>): <subject>" (commitlint type-empty/subject-empty); the squash-merge title is the commit and CI lints it`,
    });
  else if (parsed && rules.types && !rules.types.values.includes(parsed[1]))
    problems.push({
      level: rules.types.level,
      message: `PR title type "${parsed[1]}" is not allowed (commitlint type-enum: ${rules.types.values.join(", ")})`,
    });
  if (rules.maxHeader && header.length > rules.maxHeader.value)
    problems.push({
      level: rules.maxHeader.level,
      message: `PR title is ${header.length} characters, over the ${rules.maxHeader.value} allowed (commitlint header-max-length); shorten it by ${header.length - rules.maxHeader.value}`,
    });
  const refused = problems.filter((problem) => problem.level >= 2);
  return {
    error: refused.length ? refused.map((problem) => problem.message).join("; ") : null,
    notes: problems.filter((problem) => problem.level < 2).map((p) => `warning: ${p.message}`),
  };
}

/** A usage refusal (exit code) when the title breaks a commitlint rule; notes and warnings go to stderr. */
function refuseTitle(io: Io, title: string, line: string): number | null {
  const checked = checkPrTitle(io.cwd, title);
  for (const note of checked.notes) io.stderr(`${note}\n`);
  return checked.error ? usage(io, checked.error, line) : null;
}

const STATUS_USAGE = "workit pr status [--pr <n> | --branch <b>] [--log-lines 60] [--json]";
const CREATE_USAGE =
  "workit pr create [--base <b> | --track <t>] (--title <t> [--body <text> | --body-file <f|->] | --fill) [--issue <#n|ID|url>]… [--refs] [--label <l>]… [--reviewer <login>]… [--draft] [--json]";
const MERGE_USAGE =
  "workit pr merge [--pr <n>] [--squash|--merge|--rebase | --method squash|merge|rebase] [--subject <s>] [--body <b> | --body-file <f|->] [--delete-branch | --keep-branch] [--unverified --reason <why>] [--base-red-ok --reason <why>] [--json]";
const READY_USAGE = "workit pr ready [--pr <n>] [--undo] [--json]";
const EDIT_USAGE =
  "workit pr edit [--pr <n>] [--title <t>] [--body-file <f|->] [--add-label <l>]… [--remove-label <l>]… [--add-reviewer <login>]… [--base <b>] [--json]";
const THREADS_USAGE = "workit pr threads [--pr <n>] [--json]";
const REPLY_USAGE =
  "workit pr reply [--pr <n>] --thread <id> [--body-file <f|->] [--resolve] [--json]";
const USAGE = "workit pr status|create|merge|ready|edit|threads|reply ... (workit help pr)";

/** `--body-file <path>`, or `-` for stdin. A string is the usage error. */
function readBodyFile(io: Io, file: string): { body: string } | string {
  try {
    return {
      body: file === "-" ? forgeDeps.readStdin() : readFileSync(path.resolve(io.cwd, file), "utf8"),
    };
  } catch {
    return `cannot read --body-file ${file}`;
  }
}

const prLabel = (kind: string, number: number): string =>
  `${kind === "github" ? "PR #" : "MR !"}${number}`;

async function status(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { pr: "value", branch: "value", "log-lines": "value" });
  if (typeof flags === "string") return usage(io, flags, STATUS_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, STATUS_USAGE);
  const picked = selector(flags);
  if (typeof picked === "string") return usage(io, picked, STATUS_USAGE);
  const { pr, branch: pickedBranch } = picked;
  const logLines =
    flags.values["log-lines"] === "0" ? 0 : positiveInt(flags.values["log-lines"], "--log-lines");
  if (typeof logLines === "string") return usage(io, logLines, STATUS_USAGE);
  if (logLines !== null && logLines > 500)
    return usage(io, "--log-lines is capped at 500", STATUS_USAGE);

  const connected = connect(io, pickedBranch);
  if (!connected.ok) return forgeFail(io, connected);
  const report = prStatusReport(io.cwd, connected.data, {
    pr,
    branch: pickedBranch,
    logLines: logLines ?? 60,
    identity: connected.data.identity,
    actor: actorFromEnv(io.env),
  });
  if (!report.ok) return forgeFail(io, report);
  const doc = report.data.doc;
  const hint = nextHint(doc.next, doc.number);
  const issues = issuesBlock(io.cwd, doc);
  return emit(
    io,
    ok({ ...doc, nextHint: hint, verdict: verdictBlock(io.cwd, doc.head.branch, doc), issues }),
    (data) => {
      const lines = renderStatus(data);
      if (data.issues?.length)
        lines.splice(
          1,
          0,
          `issues: ${data.issues.map((entry) => `${entry.tracker === "youtrack" ? entry.issue : (entry.url ?? `${entry.repo ?? ""}#${entry.issue}`)} (${entry.relation})`).join(", ")}`,
        );
      // `next:` stays the last line.
      lines.splice(
        lines.length - 1,
        0,
        data.verdict?.merge
          ? `verdict: ${mergedVerdictLine(data.verdict.merge)}`
          : data.verdict
            ? `verdict: ${data.verdict.accepted ? `accepted (${acceptedHow(data.verdict)})` : data.verdict.review === "self-reviewed" ? "self-reviewed (author's own verdict; not independent)" : `not accepted (${data.verdict.reasons.join(", ") || data.verdict.basis})`}`
            : "verdict: unknown (ledger unreadable)",
      );
      if (data.verdict?.reverify && !data.verdict.merge)
        lines.splice(
          lines.length - 1,
          0,
          `reverify: focused (${data.verdict.reverify.files.join(", ")}): re-check only the change since ${data.verdict.reverify.since.slice(0, 12)} and reuse green CI`,
        );
      if (data.verdict?.lane)
        lines.splice(
          lines.length - 1,
          0,
          `lane: ${data.verdict.lane.lane} (${data.verdict.lane.reasons.join("; ")}); merge needs ${NEED_TEXT[data.verdict.lane.need]}${data.verdict.lane.verification === "proportional" ? "" : ` (verification: ${data.verdict.lane.verification})`}`,
        );
      for (const warning of data.verdict?.lane?.warnings ?? [])
        lines.splice(lines.length - 1, 0, `warning: ${warning}`);
      // The step that clears `next`, right above it.
      if (data.nextHint) lines.splice(lines.length - 1, 0, `do: ${data.nextHint}`);
      return lines;
    },
  );
}

/** The issues `pr.linked` rows record for this PR; null when the ledger is unreadable. */
function issuesBlock(cwd: string, doc: { number: number; repo: string }): LinkedIssue[] | null {
  const ledger = readLedger(cwd);
  if (!ledger.ok) return null;
  return linkedIssues(ledger.value.rows, { pr: doc.number, repo: doc.repo });
}

const NEED_TEXT = {
  none: "no verdict",
  self: "the author's own --self verdict (or an independent one)",
  "non-author": "an accepted non-author verdict",
} as const;

/** How a merged PR landed, from its `pr.merged` row ("untracked": workit did not merge it). */
type MergeRecord = {
  head: string | null;
  verdictId: string | null;
  /** How the merge was reviewed (rows before review lanes carry none). */
  review?: string;
  lane?: string;
  unverified: boolean;
  /** Only the intent row: the merge call failed, yet the forge merged. */
  intentOnly?: boolean;
};

const mergedVerdictLine = (landed: MergeRecord | "untracked"): string =>
  landed === "untracked"
    ? "merged outside workit (no merge record)"
    : landed.unverified
      ? `merged unverified at ${(landed.head ?? "?").slice(0, 12)} (recorded bypass)`
      : landed.lane === "none" && !landed.verdictId
        ? `merged at ${(landed.head ?? "?").slice(0, 12)} with no verdict (lane none)`
        : landed.review === "self-reviewed"
          ? `merged self-reviewed (lane self) with the author's verdict ${landed.verdictId ?? "?"} at ${(landed.head ?? "?").slice(0, 12)}`
          : `merged with accepted verdict ${landed.verdictId ?? "?"} at ${(landed.head ?? "?").slice(0, 12)}${landed.intentOnly ? " (merge intent recorded; the merge call itself failed)" : ""}`;

/**
 * S12: the S13 verdict for the PR's head branch (fresh, carried through a
 * rebase or restack, or stale), read-only. Null when the ledger is unreadable.
 */
function verdictBlock(
  cwd: string,
  branch: string,
  doc: { state: string; number: number; base: string; head: { sha: string } },
) {
  const ledger = readLedger(cwd, { integrity: true });
  if (!ledger.ok) return null;
  const check = checkVerdictsCovered(cwd, branch, ledger.value.rows);
  // A merged PR's verdict is the one its merge was accepted on: the branch
  // has moved on or been deleted, so a fresh check would read as stale.
  let landed: MergeRecord | "untracked" | null = null;
  if (doc.state === "merged") {
    // Only the CLI's own chained merge record, for this PR on this base (one
    // clone can merge PR #N on two forge repos); else its merge intent, written
    // before a merge call that failed although the forge merged.
    const mine = (type: string) =>
      ledger.value.rows.findLast(
        (candidate) =>
          candidate.type === type &&
          candidate.observer === "workit_cli" &&
          candidate.integrity !== "unverified" &&
          candidate.pr === doc.number &&
          candidate.base === doc.base,
      );
    const merged = mine("pr.merged");
    const row = merged ?? mine("pr.merge.intent");
    landed = row
      ? {
          head: typeof row.head === "string" ? row.head : null,
          verdictId: typeof row.verdictId === "string" ? row.verdictId : null,
          ...(typeof row.review === "string" ? { review: row.review } : {}),
          ...(typeof row.lane === "string" ? { lane: row.lane } : {}),
          unverified: row.unverified !== undefined && row.unverified !== null,
          ...(merged ? {} : { intentOnly: true }),
        }
      : "untracked";
  }
  // The open PR's review lane and what the merge gate asks for it.
  const gate =
    doc.state === "merged" || !doc.head.sha
      ? null
      : prLaneGate(cwd, check, { branch, base: doc.base, head: doc.head.sha });
  return {
    merge: landed,
    lane: gate
      ? {
          lane: gate.lane.lane,
          reasons: gate.lane.reasons,
          lines: gate.lane.lines,
          files: gate.lane.files,
          riskFiles: gate.lane.riskFiles,
          base: gate.lane.base,
          verification: gate.verification,
          warnings: [untrackedRiskPathsWarning(cwd)].filter((line) => line !== null),
          need: gate.need,
          satisfied: gate.satisfied && (gate.need === "none" || check.head === doc.head.sha),
        }
      : null,
    accepted: check.accepted.accepted,
    review: check.review,
    basis: check.current.basis,
    reasons: check.accepted.reasons as string[],
    head: check.head,
    verdictId:
      check.accepted.accepted && typeof check.accepted.verdict?.id === "string"
        ? check.accepted.verdict.id
        : null,
    carry: check.cover ? null : check.carry,
    cover: check.cover,
    reverify: check.reverify,
  };
}

/**
 * The verdict a merge went through on, said the way the gate read it (#505):
 * "accepted" only for an accepted verdict, never for the author's own (lane
 * self) or for a lane that needs none.
 */
const mergedOnLine = (verdict: {
  accepted: boolean;
  verdictId: string | null;
  review: string;
  lane: string;
  cover?: StackCover | null;
  carry?: CarryNote | null;
}): string => {
  if (verdict.review === "self-reviewed")
    return `self-reviewed (lane ${verdict.lane}): the author's verdict ${verdict.verdictId ?? "?"}; no independent verdict accepted for that head`;
  if (!verdict.verdictId) return `no verdict required (lane ${verdict.lane})`;
  if (!verdict.accepted && !verdict.cover && !verdict.carry)
    return `verdict ${verdict.verdictId} satisfied lane ${verdict.lane}; not an accepted independent verdict for that head`;
  return `verdict ${verdict.verdictId} accepted for that head${verdict.cover ? ` (stack verdict on ${verdict.cover.branch} @ ${verdict.cover.head.slice(0, 12)})` : verdict.carry ? ` (${carryLabel(verdict.carry)})` : ""}`;
};

/** How the accepted verdict applies: fresh, carried (and why), or a stack verdict above it. */
const acceptedHow = (verdict: {
  basis: string;
  carry: CarryNote | null;
  cover: StackCover | null;
}): string =>
  verdict.cover
    ? `stack verdict ${verdict.cover.verdictId} on ${verdict.cover.branch} @ ${verdict.cover.head.slice(0, 12)}`
    : verdict.carry
      ? carryLabel(verdict.carry)
      : verdict.basis;

async function create(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    base: "value",
    track: "value",
    title: "value",
    body: "value",
    "body-file": "value",
    fill: "boolean",
    draft: "boolean",
    label: "list",
    reviewer: "list",
    issue: "list",
    refs: "boolean",
  });
  if (typeof flags === "string") return usage(io, flags, CREATE_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, CREATE_USAGE);
  const fill = flags.booleans.has("fill");
  if (!fill && !flags.values.title) return usage(io, "pass --title <t> or --fill", CREATE_USAGE);
  if (flags.values.body !== undefined && flags.values["body-file"] !== undefined)
    return usage(io, "pass --body or --body-file, not both", CREATE_USAGE);
  let body = flags.values.body ?? null;
  if (flags.values["body-file"] !== undefined) {
    const read = readBodyFile(io, flags.values["body-file"]);
    if (typeof read === "string") return usage(io, read, CREATE_USAGE);
    body = read.body;
  }
  if (flags.values.base !== undefined && flags.values.track !== undefined)
    return usage(
      io,
      "pass --base or --track, not both (--track picks the base for you)",
      CREATE_USAGE,
    );
  let base: string | null = flags.values.base ?? null;
  const branch = currentBranch(io.cwd);
  const kind = branchKindOf(branch);
  // Without --base the target is the release track's PR target, else the
  // git-flow route of the branch's kind (release/hotfix -> production,
  // feature/bugfix -> develop), else the workspace default.
  let releaseTrack: ResolvedReleaseTrack | null = null;
  let route: FlowRoute | null = null;
  if (base) {
    const flow = gitFlowOf(io.cwd);
    const mismatch = flowMismatch(flow, kind, base, "target");
    if (mismatch && flow && kind)
      return emit(
        io,
        fail("blocked", mismatch, {
          unblock: `workit pr create …  # without --base it targets ${flowRoute(flow, kind).target}`,
        }),
      );
  } else {
    const resolved = vcsConfig("resolve", io.cwd, { track: flags.values.track ?? null });
    if (resolved.ok === false)
      return emit(
        io,
        fail("blocked", String(resolved.error), {
          unblock: "fix ~/.config/workit/vcs.json or pass --base <b>",
        }),
      );
    releaseTrack = resolved.releaseTrack ?? null;
    // An undetermined release line never picks a target by guess.
    if (releaseTrack?.blocking)
      return emit(
        io,
        fail("blocked", releaseTrack.blocking, {
          unblock: "workit pr create --track <name> …  # or --base <branch>",
        }),
      );
    base = String(resolved.defaultTargetBranch ?? "") || null;
    const flow = releaseTrack?.track ? null : gitFlowOf(io.cwd, base);
    route = flow && kind ? flowRoute(flow, kind) : null;
    if (route) base = route.target;
  }
  if (!base)
    return usage(io, "no default target branch is configured; pass --base <b>", CREATE_USAGE);

  // A given title is checked before any forge call; a --fill title once it is derived.
  const given = flags.values.title ? refuseTitle(io, flags.values.title, CREATE_USAGE) : null;
  if (given !== null) return given;
  const connected = connect(io, branch);
  if (!connected.ok) return forgeFail(io, connected);
  let title = flags.values.title ?? "";
  if (fill) {
    const filled = fillFromCommits(io.cwd, connected.data, base);
    if (!filled.ok) return forgeFail(io, filled);
    title ||= filled.data.title;
    body ??= filled.data.body;
  }
  if (!flags.values.title) {
    const filled = refuseTitle(io, title, CREATE_USAGE);
    if (filled !== null) return filled;
  }
  const forge = connected.data.forge;
  const planned = planIssueLinks(io.cwd, {
    issues: flags.lists.issue ?? [],
    refs: flags.booleans.has("refs"),
    branch,
    forge: { kind: forge.kind, repo: forge.repo, host: forge.apiHost },
  });
  if (!planned.ok) return usage(io, planned.error, CREATE_USAGE);
  const links = planned.data.links;
  const actor = actorFromEnv(io.env);
  const result = await createPullRequest(
    io.cwd,
    connected.data,
    {
      base,
      title,
      body: withIssueLines(body ?? "", links),
      draft: flags.booleans.has("draft"),
      actor,
      labels: flags.lists.label ?? [],
      reviewers: flags.lists.reviewer ?? [],
    },
    forgeDeps.sleep,
  );
  if (!result.ok) return forgeFail(io, result);
  // Only a PR this call opened carries the lines; a reused one keeps its body.
  const opened = result.data.created;
  const linked = opened
    ? recordIssueLinks(io.cwd, result.data, links, { actor, forge: forge.kind, repo: forge.repo })
    : [];
  const backlinks: BacklinkOutcome[] =
    opened && planned.data.backlink && links.length
      ? await postBacklinks(io.cwd, connected.data, result.data, links, { env: io.env })
      : [];
  const created = {
    ...result.data,
    issues: links.map((link) => ({
      issue: issueLabel(link),
      tracker: link.tracker,
      relation: link.relation,
      source: link.source,
      line: link.line,
    })),
    linked,
    ...(planned.data.backlink && links.length ? { backlinks } : {}),
    ...(planned.data.warnings.length ? { warnings: planned.data.warnings } : {}),
    ...(releaseTrack ? { releaseTrack } : {}),
    ...(route ? { flow: route } : {}),
  };
  return emit(io, ok(created), (data: CreateOutcome & { releaseTrack?: ResolvedReleaseTrack }) => [
    `${data.created ? "opened" : "found open"} ${connected.data.forge.kind === "github" ? "PR #" : "MR !"}${data.number}${data.draft && data.created ? " (draft)" : ""}: ${data.branch} -> ${data.base}  ${data.url}`,
    ...(data.releaseTrack?.name
      ? [`release track: ${data.releaseTrack.name} (${data.releaseTrack.detail})`]
      : []),
    ...(data.releaseTrack?.warnings ?? []).map((warning) => `note: ${warning}`),
    ...(route?.mergeBack
      ? [
          `merge back: git-flow: once ${data.branch} lands on ${route.target}, bring ${route.target} into ${route.mergeBack} (workit pr create --base ${route.mergeBack} opens the back-merge PR from ${data.branch}, or merge locally and run workit git push --release ${route.mergeBack}); tag the release and push it with workit git push --release <tag>`,
        ]
      : []),
    `head ${data.head.slice(0, 12)} verified on the forge`,
    ...issueLines(links, opened, linked, backlinks, data.number),
    ...planned.data.warnings.map((warning) => `note: ${warning}`),
    ...("error" in data.recorded ? [`ledger: not recorded (${data.recorded.error})`] : []),
    `next: ${data.next}${endpointNote(io.cwd)}`,
  ]);
}

/** `; <grant/endpoint mismatch>` when the workspace grants more than its endpoint does. */
function endpointNote(cwd: string): string {
  try {
    const line = endpointMismatch(resolveAutonomy(cwd));
    return line ? `; ${line}` : "";
  } catch {
    return "";
  }
}

function issueLines(
  links: readonly IssueLink[],
  opened: boolean,
  linked: ReturnType<typeof recordIssueLinks>,
  backlinks: readonly BacklinkOutcome[],
  number: number,
): string[] {
  if (links.length === 0) return [];
  const names = links.map(issueLabel).join(", ");
  if (!opened)
    return [
      `issues not linked: the PR was already open, so its body is unchanged (${names}); add the lines with workit pr edit --pr ${number} --body-file <f>`,
    ];
  return [
    `linked ${names}`,
    ...linked.flatMap((row) =>
      "error" in row ? [`ledger: link to ${row.issue} not recorded (${row.error})`] : [],
    ),
    ...backlinks.map(
      (entry) =>
        `backlink ${entry.issue}: ${entry.status.replace("_", " ")}${entry.note ? ` (${entry.note})` : ""}`,
    ),
  ];
}

const METHODS: ReadonlySet<string> = new Set<MergeMethod>(["squash", "merge", "rebase"]);

const EXIT_NAMES: Record<number, string> = {
  1: "failed",
  2: "invalid_input",
  3: "blocked",
  4: "busy",
  5: "unavailable",
};

/**
 * Every `pr merge` that does not merge ends in one stderr line with "error"
 * and "not merged" in it (#533): agents filter the output (`2>&1 | grep -E
 * '^merged|rror'`), and a refusal such as `workit: not_ready: …` slipped
 * through that filter and read as a silent no-op. A merge prints `merged …`
 * first on stdout; under --json the envelope says it.
 */
async function merge(argv: string[], io: Io): Promise<number> {
  if (io.json) return mergeOnce(argv, io);
  let reason: string | null = null;
  const code = await mergeOnce(argv, {
    ...io,
    stderr: (text) => {
      reason ??= /^workit: ([a-z][a-z_]*):/u.exec(text)?.[1] ?? null;
      io.stderr(text);
    },
  });
  if (code !== 0)
    io.stderr(
      `workit: error: PR not merged (${reason ?? EXIT_NAMES[code] ?? "failed"}, exit ${code})\n`,
    );
  return code;
}

async function mergeOnce(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    pr: "value",
    method: "value",
    squash: "boolean",
    merge: "boolean",
    rebase: "boolean",
    "delete-branch": "boolean",
    "keep-branch": "boolean",
    unverified: "boolean",
    "base-red-ok": "boolean",
    reason: "value",
    subject: "value",
    body: "value",
    "body-file": "value",
  });
  if (typeof flags === "string") return usage(io, flags, MERGE_USAGE);
  const baseRedOk = flags.booleans.has("base-red-ok");
  const baseRedReason = flags.values.reason?.trim();
  if (baseRedOk && !baseRedReason)
    return usage(
      io,
      "--base-red-ok needs --reason <why merging onto a red base is fine>",
      MERGE_USAGE,
    );
  // One --reason serves --unverified and --base-red-ok, alone or together.
  const unverified = baseRedOk && !flags.booleans.has("unverified") ? null : unverifiedFlag(flags);
  if (typeof unverified === "string") return usage(io, unverified, MERGE_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, MERGE_USAGE);
  if (flags.booleans.has("delete-branch") && flags.booleans.has("keep-branch"))
    return usage(io, "pass --delete-branch or --keep-branch, not both", MERGE_USAGE);
  const picked = selector(flags);
  if (typeof picked === "string") return usage(io, picked, MERGE_USAGE);
  const { pr } = picked;
  const aliases = (["squash", "merge", "rebase"] as const).filter((name) =>
    flags.booleans.has(name),
  );
  if (aliases.length > 1 || (aliases.length === 1 && flags.values.method !== undefined))
    return usage(io, "pass one of --squash, --merge, --rebase or --method", MERGE_USAGE);
  const method = aliases[0] ?? flags.values.method ?? "squash";
  if (!METHODS.has(method))
    return usage(io, "--method must be squash, merge or rebase", MERGE_USAGE);
  const { subject } = flags.values;
  if (flags.values.body !== undefined && flags.values["body-file"] !== undefined)
    return usage(io, "pass --body or --body-file, not both", MERGE_USAGE);
  let body = flags.values.body;
  if (flags.values["body-file"] !== undefined) {
    const read = readBodyFile(io, flags.values["body-file"]);
    if (typeof read === "string") return usage(io, read, MERGE_USAGE);
    body = read.body;
  }
  if ((subject !== undefined || body !== undefined) && method !== "squash")
    return usage(io, "--subject and --body set a squash message; use --method squash", MERGE_USAGE);
  if (subject !== undefined && (!subject.trim() || subject.includes("\n")))
    return usage(io, "--subject must be one non-empty line", MERGE_USAGE);

  const connected = connect(io);
  if (!connected.ok) return forgeFail(io, connected);
  const result = await mergePullRequest(
    io.cwd,
    connected.data,
    {
      pr,
      method,
      deleteBranch: flags.booleans.has("delete-branch"),
      implicitDelete: !flags.booleans.has("keep-branch") && workspaceDeleteBranch(io.cwd),
      actor: actorFromEnv(io.env),
      ...(unverified ? { unverified } : {}),
      ...(baseRedOk && baseRedReason ? { baseRedOk: { reason: baseRedReason } } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(body !== undefined ? { body } : {}),
    },
    forgeDeps.sleep,
  );
  if (!result.ok)
    return emit(
      io,
      fail(result.code, result.error, {
        unblock: result.unblock,
        data:
          "refusal" in result && result.refusal
            ? result.refusal
            : "recorded" in result && result.recorded
              ? { recorded: result.recorded }
              : {},
      }),
    );
  const cleanup: LocalCleanup | null =
    result.data.deletedBranch === true
      ? cleanupMergedBranch(io.cwd, result.data.branch, result.data.head)
      : null;
  return emit(io, ok({ ...result.data, localCleanup: cleanup }), (data) => [
    `merged ${connected.data.forge.kind === "github" ? "PR #" : "MR !"}${data.number} (${data.method}) at head ${data.head.slice(0, 12)}${data.mergeSha ? ` -> ${data.mergeSha.slice(0, 12)}` : ""}`,
    data.unverified
      ? `UNVERIFIED: merged without a verdict (--unverified: ${data.unverified.reason}); ledger ${data.unverified.recorded}`
      : mergedOnLine(data.verdict),
    ...(data.baseCi.note ? [data.baseCi.note] : []),
    ...(data.mergeBack.length
      ? [
          `merge back: ${data.base} is the ${data.mergeBackTrack} production branch; bring it into ${data.mergeBack.join(", ")}`,
        ]
      : []),
    ...(data.deletedBranch === true
      ? [`deleted ${data.branch}`]
      : typeof data.deletedBranch === "object"
        ? [
            "skipped" in data.deletedBranch
              ? `kept ${data.branch}: ${data.deletedBranch.skipped}`
              : `branch not deleted: ${data.deletedBranch.error}`,
          ]
        : []),
    ...(data.localCleanup
      ? [
          ...(data.localCleanup.worktreeRemoved
            ? [`removed worktree ${data.localCleanup.worktreeRemoved}`]
            : []),
          ...(data.localCleanup.branchDeleted ? [`deleted local ${data.branch}`] : []),
          ...data.localCleanup.notes,
        ]
      : []),
    ...("error" in data.recorded ? [`ledger: not recorded (${data.recorded.error})`] : []),
    ...("error" in data.confirmed && !("error" in data.recorded)
      ? [`ledger: merge not confirmed in the ledger (${data.confirmed.error})`]
      : []),
  ]);
}

async function ready(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { pr: "value", undo: "boolean" });
  if (typeof flags === "string") return usage(io, flags, READY_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, READY_USAGE);
  const picked = selector(flags);
  if (typeof picked === "string") return usage(io, picked, READY_USAGE);
  const { pr } = picked;
  const connected = connect(io);
  if (!connected.ok) return forgeFail(io, connected);
  const result = readyPullRequest(io.cwd, connected.data, {
    pr,
    undo: flags.booleans.has("undo"),
  });
  if (!result.ok) return forgeFail(io, result);
  const kind = connected.data.forge.kind;
  return emit(io, ok(result.data), (data: ReadyOutcome) => [
    `${prLabel(kind, data.number)} ${data.changed ? "is now" : "was already"} ${data.draft ? "a draft" : "ready for review"}  ${data.url}`,
  ]);
}

async function edit(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    pr: "value",
    title: "value",
    "body-file": "value",
    base: "value",
    "add-label": "list",
    "remove-label": "list",
    "add-reviewer": "list",
  });
  if (typeof flags === "string") return usage(io, flags, EDIT_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, EDIT_USAGE);
  const picked = selector(flags);
  if (typeof picked === "string") return usage(io, picked, EDIT_USAGE);
  const { pr } = picked;
  let body: string | undefined;
  if (flags.values["body-file"] !== undefined) {
    const read = readBodyFile(io, flags.values["body-file"]);
    if (typeof read === "string") return usage(io, read, EDIT_USAGE);
    body = read.body;
  }
  if (flags.values.title !== undefined) {
    const edited = refuseTitle(io, flags.values.title, EDIT_USAGE);
    if (edited !== null) return edited;
  }
  const connected = connect(io);
  if (!connected.ok) return forgeFail(io, connected);
  const result = editPullRequest(io.cwd, connected.data, {
    pr,
    edit: {
      ...(flags.values.title !== undefined ? { title: flags.values.title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(flags.values.base !== undefined ? { base: flags.values.base } : {}),
      addLabels: flags.lists["add-label"] ?? [],
      removeLabels: flags.lists["remove-label"] ?? [],
      addReviewers: flags.lists["add-reviewer"] ?? [],
    },
  });
  if (!result.ok)
    return result.code === "invalid_input"
      ? usage(io, result.error, EDIT_USAGE)
      : forgeFail(io, result);
  const kind = connected.data.forge.kind;
  return emit(io, ok(result.data), (data: EditOutcome) => [
    `edited ${prLabel(kind, data.number)} (${data.changed.join(", ")}): ${data.title} -> ${data.base}  ${data.url}`,
  ]);
}

async function threads(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { pr: "value" });
  if (typeof flags === "string") return usage(io, flags, THREADS_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, THREADS_USAGE);
  const picked = selector(flags);
  if (typeof picked === "string") return usage(io, picked, THREADS_USAGE);
  const { pr } = picked;
  const connected = connect(io);
  if (!connected.ok) return forgeFail(io, connected);
  const result = listThreads(io.cwd, connected.data, { pr });
  if (!result.ok) return forgeFail(io, result);
  const kind = connected.data.forge.kind;
  return emit(io, ok(result.data), (data: ThreadsOutcome) => [
    `${prLabel(kind, data.number)}: ${data.threads.length} unresolved thread${data.threads.length === 1 ? "" : "s"}${data.truncated ? " (truncated at the page cap)" : ""}`,
    ...data.threads.map(
      (thread) =>
        `${thread.id}  ${thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""} ` : ""}@${thread.author ?? "?"}${thread.isBot ? " (bot)" : ""}${thread.outdated ? " (outdated)" : ""}: ${thread.body}`,
    ),
  ]);
}

async function reply(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    pr: "value",
    thread: "value",
    "body-file": "value",
    resolve: "boolean",
  });
  if (typeof flags === "string") return usage(io, flags, REPLY_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, REPLY_USAGE);
  const picked = selector(flags);
  if (typeof picked === "string") return usage(io, picked, REPLY_USAGE);
  const { pr } = picked;
  const thread = flags.values.thread;
  if (!thread) return usage(io, "--thread <id> is required (workit pr threads)", REPLY_USAGE);
  let body: string | null = null;
  if (flags.values["body-file"] !== undefined) {
    const read = readBodyFile(io, flags.values["body-file"]);
    if (typeof read === "string") return usage(io, read, REPLY_USAGE);
    body = read.body;
  }
  const connected = connect(io);
  if (!connected.ok) return forgeFail(io, connected);
  const result = replyToThread(io.cwd, connected.data, {
    pr,
    thread,
    body,
    resolve: flags.booleans.has("resolve"),
  });
  if (!result.ok)
    return result.code === "invalid_input"
      ? usage(io, result.error, REPLY_USAGE)
      : forgeFail(io, result);
  const kind = connected.data.forge.kind;
  return emit(io, ok(result.data), (data: ReplyOutcome) => [
    `${[data.replied ? "replied to" : null, data.resolved ? "resolved" : null].filter(Boolean).join(" and ")} thread ${data.thread} on ${prLabel(kind, data.number)}${data.replyUrl ? `  ${data.replyUrl}` : ""}`,
  ]);
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "status") return status(rest, io);
  if (sub === "create") return create(rest, io);
  if (sub === "merge") return merge(rest, io);
  if (sub === "ready") return ready(rest, io);
  if (sub === "edit") return edit(rest, io);
  if (sub === "threads") return threads(rest, io);
  if (sub === "reply") return reply(rest, io);
  return usage(
    io,
    sub && !sub.startsWith("-") ? `unknown pr subcommand "${sub}"` : "missing pr subcommand",
    USAGE,
  );
}
