// `workit pr status|create|merge|ready|edit|threads|reply` (design §2.1, S10/S11).
//
// status: PR/MR state, checks with failing job log tails, unresolved review
// threads, behind-base, and the next action.
// create: opens (or reuses) the PR for the pushed current branch, bound to and
// verified against the pushed SHA; records `pr.created`.
// merge: only when `pr status` reads READY, an accepted independent verdict
// covers the head (S13) and the merge grant allows it; head-SHA guarded.
// `--unverified --reason` (merge: true only) bypasses the verdict, recorded.
// ready/edit/threads/reply: the lifecycle steps `next` names (audit M13).
import { readFileSync } from "node:fs";
import path from "node:path";
import { prBodyFor } from "@brainervirus/workit-core/src/forge/pr-body";
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
import { actorFromEnv, checkVerdicts, readLedger } from "@brainervirus/workit-core/src/ledger";
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
  "workit pr create [--base <b> | --track <t>] (--title <t> [--body <text> | --body-file <f|->] | --fill) [--label <l>]… [--reviewer <login>]… [--draft] [--json]";
const MERGE_USAGE =
  "workit pr merge [--pr <n>] [--method squash|merge|rebase] [--delete-branch] [--unverified --reason <why>] [--json]";
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
  return emit(
    io,
    ok({ ...doc, nextHint: hint, verdict: verdictBlock(io.cwd, doc.head.branch, doc) }),
    (data) => {
      const lines = renderStatus(data);
      // `next:` stays the last line.
      lines.splice(
        lines.length - 1,
        0,
        data.verdict?.merge
          ? `verdict: ${mergedVerdictLine(data.verdict.merge)}`
          : data.verdict
            ? `verdict: ${data.verdict.accepted ? `accepted (${data.verdict.basis})` : data.verdict.review === "self-reviewed" ? "self-reviewed (author's own verdict; not independent)" : `not accepted (${data.verdict.reasons.join(", ") || data.verdict.basis})`}`
            : "verdict: unknown (ledger unreadable)",
      );
      // The step that clears `next`, right above it.
      if (data.nextHint) lines.splice(lines.length - 1, 0, `do: ${data.nextHint}`);
      return lines;
    },
  );
}

/** How a merged PR landed, from its `pr.merged` row ("untracked": workit did not merge it). */
type MergeRecord = { head: string | null; verdictId: string | null; unverified: boolean };

const mergedVerdictLine = (landed: MergeRecord | "untracked"): string =>
  landed === "untracked"
    ? "merged outside workit (no merge record)"
    : landed.unverified
      ? `merged unverified at ${(landed.head ?? "?").slice(0, 12)} (recorded bypass)`
      : `merged with accepted verdict ${landed.verdictId ?? "?"} at ${(landed.head ?? "?").slice(0, 12)}`;

/**
 * S12: the S13 verdict for the PR's head branch (fresh, carried through a
 * rebase or restack, or stale), read-only. Null when the ledger is unreadable.
 */
function verdictBlock(
  cwd: string,
  branch: string,
  doc: { state: string; number: number; base: string },
) {
  const ledger = readLedger(cwd);
  if (!ledger.ok) return null;
  const check = checkVerdicts(cwd, branch, ledger.value.rows);
  // A merged PR's verdict is the one its merge was accepted on: the branch
  // has moved on or been deleted, so a fresh check would read as stale.
  let landed: MergeRecord | "untracked" | null = null;
  if (doc.state === "merged") {
    const row = ledger.value.rows.findLast(
      // Only the CLI's own merge record, for this PR on this base (one clone can
      // merge PR #N on two forge repos).
      (candidate) =>
        candidate.type === "pr.merged" &&
        candidate.observer === "workit_cli" &&
        candidate.pr === doc.number &&
        candidate.base === doc.base,
    );
    landed = row
      ? {
          head: typeof row.head === "string" ? row.head : null,
          verdictId: typeof row.verdictId === "string" ? row.verdictId : null,
          unverified: row.unverified !== undefined && row.unverified !== null,
        }
      : "untracked";
  }
  return {
    merge: landed,
    accepted: check.accepted.accepted,
    review: check.review,
    basis: check.current.basis,
    reasons: check.accepted.reasons as string[],
    head: check.head,
    verdictId:
      check.accepted.accepted && typeof check.accepted.verdict?.id === "string"
        ? check.accepted.verdict.id
        : null,
  };
}

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
  // Without --base the target is the release track's PR target (or the
  // workspace default when no tracks are configured).
  let releaseTrack: ResolvedReleaseTrack | null = null;
  if (!base) {
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
  }
  if (!base)
    return usage(io, "no default target branch is configured; pass --base <b>", CREATE_USAGE);

  const branch = currentBranch(io.cwd);
  const connected = connect(io, branch);
  if (!connected.ok) return forgeFail(io, connected);
  let title = flags.values.title ?? "";
  if (fill) {
    const filled = fillFromCommits(io.cwd, connected.data, base);
    if (!filled.ok) return forgeFail(io, filled);
    title ||= filled.data.title;
    body ??= filled.data.body;
  }
  const result = await createPullRequest(
    io.cwd,
    connected.data,
    {
      base,
      title,
      body: prBodyFor(io.cwd, {
        body: body ?? "",
        branch: branch ?? "",
        repo: connected.data.forge.kind === "github" ? connected.data.forge.repo : null,
      }),
      draft: flags.booleans.has("draft"),
      actor: actorFromEnv(io.env),
      labels: flags.lists.label ?? [],
      reviewers: flags.lists.reviewer ?? [],
    },
    forgeDeps.sleep,
  );
  if (!result.ok) return forgeFail(io, result);
  const created = releaseTrack ? { ...result.data, releaseTrack } : result.data;
  return emit(io, ok(created), (data: CreateOutcome & { releaseTrack?: ResolvedReleaseTrack }) => [
    `${data.created ? "opened" : "found open"} ${connected.data.forge.kind === "github" ? "PR #" : "MR !"}${data.number}${data.draft && data.created ? " (draft)" : ""}: ${data.branch} -> ${data.base}  ${data.url}`,
    ...(data.releaseTrack?.name
      ? [`release track: ${data.releaseTrack.name} (${data.releaseTrack.detail})`]
      : []),
    ...(data.releaseTrack?.warnings ?? []).map((warning) => `note: ${warning}`),
    `head ${data.head.slice(0, 12)} verified on the forge`,
    ...("error" in data.recorded ? [`ledger: not recorded (${data.recorded.error})`] : []),
    `next: ${data.next}`,
  ]);
}

const METHODS: ReadonlySet<string> = new Set<MergeMethod>(["squash", "merge", "rebase"]);

async function merge(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    pr: "value",
    method: "value",
    "delete-branch": "boolean",
    unverified: "boolean",
    reason: "value",
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
    },
    forgeDeps.sleep,
  );
  if (!result.ok)
    return emit(
      io,
      fail(result.code, result.error, {
        unblock: result.unblock,
        data: "refusal" in result && result.refusal ? result.refusal : {},
      }),
    );
  return emit(io, ok(result.data), (data: MergeOutcome) => [
    `merged ${connected.data.forge.kind === "github" ? "PR #" : "MR !"}${data.number} (${data.method}) at head ${data.head.slice(0, 12)}${data.mergeSha ? ` -> ${data.mergeSha.slice(0, 12)}` : ""}`,
    data.unverified
      ? `UNVERIFIED: merged without a verdict (--unverified: ${data.unverified.reason}); ledger ${data.unverified.recorded}`
      : `verdict ${data.verdict.verdictId ?? "?"} accepted for that head`,
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
