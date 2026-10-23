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
import { readFileSync } from "node:fs";
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
  type MergeOutcome,
} from "@brainervirus/workit-core/src/forge/pr-ops";
import { prStatusReport } from "@brainervirus/workit-core/src/forge/report";
import type { MergeMethod } from "@brainervirus/workit-core/src/forge/types";
import { currentBranch } from "@brainervirus/workit-core/src/git/rev";
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
import { emit, fail, ok, type Io } from "../output";
import {
  connect,
  forgeDeps,
  forgeFail,
  parseFlags,
  positiveInt,
  renderStatus,
  unverifiedFlag,
  usage,
} from "./forge-common";

const STATUS_USAGE = "workit pr status [--pr <n> | --branch <b>] [--log-lines 60] [--json]";
const CREATE_USAGE =
  "workit pr create [--base <b> | --track <t>] (--title <t> [--body <text> | --body-file <f|->] | --fill) [--issue <#n|ID|url>]… [--refs] [--label <l>]… [--reviewer <login>]… [--draft] [--json]";
const MERGE_USAGE =
  "workit pr merge [--pr <n>] [--method squash|merge|rebase] [--subject <s>] [--body <b> | --body-file <f|->] [--delete-branch] [--unverified --reason <why>] [--json]";
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
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, STATUS_USAGE);
  if (pr && flags.values.branch) return usage(io, "pass --pr or --branch, not both", STATUS_USAGE);
  const logLines =
    flags.values["log-lines"] === "0" ? 0 : positiveInt(flags.values["log-lines"], "--log-lines");
  if (typeof logLines === "string") return usage(io, logLines, STATUS_USAGE);
  if (logLines !== null && logLines > 500)
    return usage(io, "--log-lines is capped at 500", STATUS_USAGE);

  const connected = connect(io, flags.values.branch);
  if (!connected.ok) return forgeFail(io, connected);
  const report = prStatusReport(io.cwd, connected.data, {
    pr,
    branch: flags.values.branch ?? null,
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

  const connected = connect(io, branch);
  if (!connected.ok) return forgeFail(io, connected);
  let title = flags.values.title ?? "";
  if (fill) {
    const filled = fillFromCommits(io.cwd, connected.data, base);
    if (!filled.ok) return forgeFail(io, filled);
    title ||= filled.data.title;
    body ??= filled.data.body;
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
    `next: ${data.next}`,
  ]);
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

async function merge(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    pr: "value",
    method: "value",
    "delete-branch": "boolean",
    unverified: "boolean",
    reason: "value",
    subject: "value",
    body: "value",
    "body-file": "value",
  });
  if (typeof flags === "string") return usage(io, flags, MERGE_USAGE);
  const unverified = unverifiedFlag(flags);
  if (typeof unverified === "string") return usage(io, unverified, MERGE_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, MERGE_USAGE);
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, MERGE_USAGE);
  const method = (flags.values.method ?? "squash") as MergeMethod;
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
      actor: actorFromEnv(io.env),
      ...(unverified ? { unverified } : {}),
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
  return emit(io, ok(result.data), (data: MergeOutcome) => [
    `merged ${connected.data.forge.kind === "github" ? "PR #" : "MR !"}${data.number} (${data.method}) at head ${data.head.slice(0, 12)}${data.mergeSha ? ` -> ${data.mergeSha.slice(0, 12)}` : ""}`,
    data.unverified
      ? `UNVERIFIED: merged without a verdict (--unverified: ${data.unverified.reason}); ledger ${data.unverified.recorded}`
      : `verdict ${data.verdict.verdictId ?? "?"} accepted for that head${data.verdict.cover ? ` (stack verdict on ${data.verdict.cover.branch} @ ${data.verdict.cover.head.slice(0, 12)})` : data.verdict.carry ? ` (${carryLabel(data.verdict.carry)})` : ""}`,
    ...(data.mergeBack.length
      ? [
          `merge back: ${data.base} is the ${data.mergeBackTrack} production branch; bring it into ${data.mergeBack.join(", ")}`,
        ]
      : []),
    ...(data.deletedBranch === true
      ? [`deleted ${data.branch}`]
      : typeof data.deletedBranch === "object"
        ? [`branch not deleted: ${data.deletedBranch.error}`]
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
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, READY_USAGE);
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
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, EDIT_USAGE);
  let body: string | undefined;
  if (flags.values["body-file"] !== undefined) {
    const read = readBodyFile(io, flags.values["body-file"]);
    if (typeof read === "string") return usage(io, read, EDIT_USAGE);
    body = read.body;
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
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, THREADS_USAGE);
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
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, REPLY_USAGE);
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
