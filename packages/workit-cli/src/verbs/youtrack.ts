// `workit youtrack note|time|meeting|show|create` (design §4.2 S16, #263).
// Every call goes through one YouTrackBackend (core/youtrack-backend.ts):
// `ytrack … --json`, the only path to YouTrack (its token stays in the OS
// keyring); without ytrack every verb fails with the install unblock. Agents use
// these verbs, or the ytrack skill, instead of calling the API. Writes (note,
// time, meeting, create) ask the user first by default (#780): the verb writes
// an approval request and refuses until the user approves it through
// `workit approve <id>`, then the re-run consumes that yes once. A workspace
// with `youtrack: { writes: "auto" }` keeps the WORKIT_YT_WRITE=1 gate instead.
// Every comment or work item carries a deterministic marker and is read back
// first, so a retry after a lost response never posts twice; an identical
// entry by the same user is refused as `duplicate_entry`; a write an earlier
// call left unsettled is reported on the next call (core/youtrack-writes.ts).
//
//   workit youtrack note <ISSUE> (--markdown <text> | --file <path>) [--minutes <n>] [--date auto|YYYY-MM-DD]
//   workit youtrack time <ISSUE> --minutes <n> [--text <t>] [--date auto|YYYY-MM-DD]
//   workit youtrack meeting <ISSUE> --minutes <n> --text <t> [--date auto|YYYY-MM-DD]
//   workit youtrack show <ISSUE>
//   workit youtrack create --project <P> --summary <s> [--description <t> | --file <p>]
import { progressFor } from "../progress";
import { readFileSync } from "node:fs";
import path from "node:path";
import { youTrackWorkDateMs } from "@workit-dev/core/src/core/youtrack";
import { ISSUE_RE } from "@workit-dev/core/src/core/youtrack-tools";
import {
  findDuplicate,
  forgetPending,
  markerPresent,
  rememberPending,
  settlePending,
  withMarker,
  writeOnce,
  youTrackApprovalFields,
  youTrackMarker,
  youTrackWritesMode,
  type EarlierWrite,
  type MarkerWhere,
  type OnceOutcome,
  type Wanted,
  type YouTrackWritesMode,
} from "@workit-dev/core/src/core/youtrack-writes";
import {
  approveLine,
  consumeApproval,
  createApprovalRequest,
  type ApprovalFields,
} from "@workit-dev/core/src/approvals/store";
import {
  youTrackBackend,
  youTrackWriteGate,
  type IssueView,
  type WriteResult,
  type YouTrackBackend,
} from "@workit-dev/core/src/core/youtrack-backend";
import { emit, fail, ok, type Io } from "../output";
import { parseFlags, positiveInt, usage } from "./forge-common";

const USAGE =
  "workit youtrack note <ISSUE> (--markdown <t> | --file <p>) [--minutes <n>] [--date auto|YYYY-MM-DD] | youtrack time <ISSUE> --minutes <n> [--text <t>] [--date …] | youtrack meeting <ISSUE> --minutes <n> --text <t> [--date …] | youtrack show <ISSUE> | youtrack create --project <P> --summary <s> [--description <t> | --file <p>]";

/** Test seams: the workspace's `youtrack.writes` mode for a cwd. */
export type YouTrackDeps = { writes?: (cwd: string) => YouTrackWritesMode };

export async function run(
  argv: string[],
  io: Io,
  backend: () => YouTrackBackend = () => youTrackBackend(io.env),
  deps: YouTrackDeps = {},
): Promise<number> {
  const [sub, ...rest] = argv;
  const writesMode = () => (deps.writes ?? youTrackWritesMode)(io.cwd);
  if (sub === "show") return show(rest, io, backend);
  if (sub === "create") return create(rest, io, backend, writesMode());
  if (sub !== "note" && sub !== "time" && sub !== "meeting")
    return usage(io, `unknown subcommand "${sub ?? ""}"`, USAGE);
  const flags = parseFlags(rest, {
    markdown: "value",
    file: "value",
    minutes: "value",
    text: "value",
    date: "value",
  });
  if (typeof flags === "string") return usage(io, flags, USAGE);
  const [issueId, extra] = flags.positionals;
  if (!issueId || !ISSUE_RE.test(issueId))
    return usage(io, "an issue id like ABC-123 is required", USAGE);
  if (extra !== undefined) return usage(io, `unexpected argument ${extra}`, USAGE);
  const minutes = positiveInt(flags.values.minutes, "--minutes");
  if (typeof minutes === "string") return usage(io, minutes, USAGE);
  const date = youTrackWorkDateMs(flags.values.date ?? "auto");
  if ("error" in date) return usage(io, date.error, USAGE);
  const dateMs = date.data.dateMs;
  // The marker names the day only when the user named it: with `--date auto`
  // a retry on a later day is the same request and must not post again.
  const markedDay =
    flags.values.date !== undefined && flags.values.date !== "auto" ? { dateMs } : {};

  const day = new Date(dateMs).toISOString().slice(0, 10);
  const steps: {
    label: string;
    where: MarkerWhere;
    request: Record<string, unknown>;
    /** What the duplicate check compares; null when the step has no identity of its own. */
    wanted: Wanted | null;
  }[] = [];
  let effect = "";
  let subject: Record<string, unknown> = {};
  const writes: ((
    yt: YouTrackBackend,
    marked: (text: string) => string,
  ) => Promise<WriteResult>)[] = [];

  if (sub === "note") {
    if (Boolean(flags.values.markdown) === Boolean(flags.values.file))
      return usage(io, "pass exactly one of --markdown or --file", USAGE);
    let markdown = flags.values.markdown ?? "";
    if (flags.values.file)
      try {
        markdown = readFileSync(path.resolve(io.cwd, flags.values.file), "utf8");
      } catch (error) {
        return usage(io, `cannot read ${flags.values.file}: ${String(error)}`, USAGE);
      }
    if (!markdown.trim()) return usage(io, "the note is empty", USAGE);
    steps.push({
      label: "comment",
      where: "comments",
      request: { operation: "note", issueId, markdown },
      wanted: { where: "comments", text: markdown },
    });
    effect = minutes
      ? `posts this comment on ${issueId} and logs ${minutes} minutes on ${date.data.localDate}`
      : `posts this comment on ${issueId}`;
    subject = {
      comment: markdown,
      ...(minutes ? { minutes, date: date.data.localDate } : {}),
    };
    writes.push((yt, marked) => yt.addComment(issueId, marked(markdown)));
    if (minutes) {
      steps.push({
        label: "time",
        where: "workItems",
        request: {
          operation: "note.time",
          issueId,
          markdown,
          minutes,
          ...markedDay,
        },
        // The note's time is identified by its comment: "workit update" alone
        // would refuse a second legitimate note of the same length that day.
        wanted: null,
      });
      writes.push((yt, marked) =>
        yt.addWorkItem(issueId, {
          minutes,
          text: marked("workit update"),
          dateMs,
        }),
      );
    }
  } else {
    if (!minutes) return usage(io, `${sub} needs --minutes <n>`, USAGE);
    if (sub === "meeting" && !flags.values.text)
      return usage(io, "meeting needs --text <what the meeting was>", USAGE);
    const text = flags.values.text ?? "";
    steps.push({
      label: sub,
      where: "workItems",
      request: { operation: sub, issueId, minutes, text, ...markedDay },
      wanted: { where: "workItems", text, minutes, date: day },
    });
    effect = `logs ${minutes} minutes on ${issueId} on ${date.data.localDate}`;
    subject = { minutes, text, date: date.data.localDate };
    writes.push((yt, marked) => yt.addWorkItem(issueId, { minutes, text: marked(text), dateMs }));
  }

  const mode = writesMode();
  if (mode === "auto") {
    const gate = youTrackWriteGate(io.env, `workit youtrack ${sub}`);
    if (gate) return emit(io, fail(gate.code, gate.error, { unblock: gate.unblock }));
  }
  const yt = backend();
  const earlier = await settlePending(yt);
  const results: {
    step: string;
    status: OnceOutcome["status"];
    note?: string;
  }[] = [];
  const todo: number[] = [];
  for (const [index, entry] of steps.entries()) {
    if ((await markerPresent(issueId, youTrackMarker(entry.request), entry.where, yt)) === true) {
      results.push({ step: entry.label, status: "already_done" });
      continue;
    }
    const duplicate = entry.wanted ? await findDuplicate(issueId, entry.wanted, yt) : null;
    if (duplicate)
      return emit(
        io,
        fail(
          "blocked",
          `duplicate_entry: ${issueId} already has your ${entry.where === "comments" ? "comment" : "work item"} ${duplicate.id} with the same ${entry.where === "comments" ? "text" : "text, minutes and day"}; nothing was posted`,
          {
            data: {
              reason: "duplicate_entry",
              issueId,
              step: entry.label,
              entryId: duplicate.id,
              steps: results,
              earlier,
            },
            unblock: `tell the user ${issueId} already has entry ${duplicate.id}; do not post it again`,
          },
        ),
      );
    todo.push(index);
  }
  if (todo.length && mode === "ask") {
    const asked = askFirst(
      io,
      youTrackApprovalFields({
        action: `workit youtrack ${sub} ${issueId}${minutes ? ` --minutes ${minutes}` : ""}`,
        on: { issue: issueId },
        effect,
        subject,
      }),
      `youtrack ${sub}`,
      { issueId, steps: results, earlier },
    );
    if (asked !== null) return asked;
  }
  for (const index of todo) {
    const entry = steps[index];
    const marker = youTrackMarker(entry.request);
    const write = async () =>
      onceResult(await writes[index](yt, (text) => withMarker(text, marker)));
    rememberPending({
      issueId,
      step: entry.label,
      action: `workit youtrack ${sub} ${issueId}`,
      where: entry.where,
      marker,
    });
    // fetch and child-process work only, so Ctrl-C may clear the frame.
    const outcome = await progressFor(io).run(
      entry.label,
      () => writeOnce(issueId, marker, entry.where, write, yt),
      undefined,
      { signals: true },
    );
    if (outcome.status !== "unknown") forgetPending(marker);
    results.push({
      step: entry.label,
      status: outcome.status,
      ...("precheck" in outcome && outcome.precheck === "inconclusive"
        ? {
            note: "the issue has more items than one read-back page, so an earlier copy could not be ruled out before writing",
          }
        : {}),
    });
    if (outcome.status === "failed" || outcome.status === "unknown") {
      const unblock = (outcome.data as { unblock?: unknown } | undefined)?.unblock;
      return emit(
        io,
        fail(outcome.status === "unknown" ? "unavailable" : "failed", outcome.error, {
          data: {
            issueId,
            backend: yt.kind,
            steps: results,
            earlier,
            ...(outcome.data ? { detail: outcome.data } : {}),
          },
          ...(typeof unblock === "string"
            ? { unblock }
            : outcome.status === "unknown"
              ? {
                  unblock: `check ${issueId} in YouTrack; re-running is safe (the marker skips a write that already landed)`,
                }
              : {}),
        }),
      );
    }
  }
  return emit(
    io,
    ok({
      issueId,
      date: date.data.localDate,
      backend: yt.kind,
      steps: results,
      earlier,
    }),
    (data) => [
      ...earlierLines(data.earlier),
      `${issueId}: ${data.steps.map((entry) => `${entry.step} ${entry.status.replace("_", " ")}`).join(", ")} (${data.date})`,
      ...data.steps.flatMap((entry) =>
        entry.note ? [`  note (${entry.step}): ${entry.note}`] : [],
      ),
    ],
  );
}

/**
 * Consume the user's yes for `fields` right before the write, or refuse with
 * the request to approve (`approval_needed`, `approval_stale`) or
 * `approval_consumed`. null when the write may go ahead.
 */
function askFirst(
  io: Io,
  fields: ApprovalFields,
  verb: string,
  data: Record<string, unknown>,
): number | null {
  const session = io.env.WORKIT_SESSION_ID || null;
  const used = consumeApproval(fields, { session, verb });
  if (used.ok) return null;
  // The yes went to a run that did not post (it failed before landing): this
  // run needs its own, so it gets a new request rather than a dead end.
  const request = used.request ?? createApprovalRequest(fields, { session });
  const message = used.request ? used.message : `${used.message}. ${approveLine([request.id])}`;
  return emit(
    io,
    fail("blocked", message, {
      data: { ...data, reason: used.code, posted: false, approval: request.id },
    }),
  );
}

const earlierLines = (earlier: EarlierWrite[]): string[] =>
  earlier.map(
    (write) =>
      `earlier ${write.action} (${write.step}, ${write.at}): ${write.landed === null ? "still unknown; check the issue in YouTrack" : write.landed ? "it landed" : "it did not land"}`,
  );

/** A backend write in writeOnce's shape: the outcome rides in data. */
const onceResult = (result: WriteResult): { ok: boolean; error?: string; data?: unknown } =>
  result.ok
    ? { ok: true, data: result.data }
    : {
        ok: false,
        error: result.error,
        data: {
          outcome: result.outcome,
          ...(result.unblock ? { unblock: result.unblock } : {}),
        },
      };

async function show(argv: string[], io: Io, backend: () => YouTrackBackend): Promise<number> {
  const flags = parseFlags(argv, {});
  if (typeof flags === "string") return usage(io, flags, USAGE);
  const [issueId, extra] = flags.positionals;
  if (!issueId || !ISSUE_RE.test(issueId))
    return usage(io, "an issue id like ABC-123 is required", USAGE);
  if (extra !== undefined) return usage(io, `unexpected argument ${extra}`, USAGE);
  const result = await backend().showIssue(issueId);
  if (!result.ok)
    return emit(
      io,
      fail(result.code, result.error, {
        data: { issueId },
        unblock: result.unblock,
      }),
    );
  return emit(io, ok(result.data), showLines);
}

const showLines = (issue: IssueView): string[] => [
  `${issue.issueId}: ${issue.summary}${issue.state ? ` [${issue.state}]` : ""}`,
  ...(issue.url ? [issue.url] : []),
  ...issue.fields
    .filter((field) => field.value !== null && field.name !== "State")
    .map((field) => `  ${field.name}: ${JSON.stringify(field.value)}`),
  ...(issue.description ? ["", issue.description] : []),
  ...issue.comments.flatMap((comment) => [
    "",
    `-- ${comment.author ?? "unknown"} ${comment.created ?? ""}`.trimEnd(),
    comment.text,
  ]),
];

async function create(
  argv: string[],
  io: Io,
  backend: () => YouTrackBackend,
  mode: YouTrackWritesMode,
): Promise<number> {
  const flags = parseFlags(argv, {
    project: "value",
    summary: "value",
    description: "value",
    file: "value",
  });
  if (typeof flags === "string") return usage(io, flags, USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, USAGE);
  const { project, summary, file } = flags.values;
  if (!project || !summary?.trim())
    return usage(io, "create needs --project <P> and --summary <s>", USAGE);
  if (file && flags.values.description !== undefined)
    return usage(io, "pass at most one of --description or --file", USAGE);
  let description = flags.values.description;
  if (file)
    try {
      description = readFileSync(path.resolve(io.cwd, file), "utf8");
    } catch (error) {
      return usage(io, `cannot read ${file}: ${String(error)}`, USAGE);
    }
  if (mode === "auto") {
    const gate = youTrackWriteGate(io.env, "creating a YouTrack issue");
    if (gate)
      return emit(
        io,
        fail(gate.code, gate.error, {
          data: { project },
          unblock: gate.unblock,
        }),
      );
  } else {
    const asked = askFirst(
      io,
      youTrackApprovalFields({
        action: `workit youtrack create --project ${project}`,
        on: { project },
        effect: `creates a new issue in ${project}`,
        subject: {
          summary: summary.trim(),
          ...(description === undefined ? {} : { description }),
        },
      }),
      "youtrack create",
      { project },
    );
    if (asked !== null) return asked;
  }
  const result = await backend().createIssue({
    project,
    summary: summary.trim(),
    ...(description === undefined ? {} : { description }),
  });
  if (!result.ok)
    return emit(
      io,
      fail(result.code, result.error, {
        data: { project },
        unblock: result.unblock,
      }),
    );
  return emit(io, ok(result.data), (data) => [
    `created ${data.issueId}${data.url ? ` ${data.url}` : ""}`,
  ]);
}
