// `workit youtrack note|time|meeting|show|create` (design §4.2 S16, #263).
// Every call goes through one YouTrackBackend (core/youtrack-backend.ts):
// `ytrack … --json`, the only path to YouTrack (its token stays in the OS
// keyring); without ytrack every verb fails with the install unblock. Agents use
// these verbs, or the ytrack skill, instead of calling the API. Writes (note, time, meeting, create) need WORKIT_YT_WRITE=1;
// the host's permission prompt authorizes them like any shell command. Every
// comment or work item carries a deterministic marker and is read back first,
// so a retry after a lost response never posts twice (core/youtrack-writes.ts).
//
//   workit youtrack note <ISSUE> (--markdown <text> | --file <path>) [--minutes <n>] [--date auto|YYYY-MM-DD]
//   workit youtrack time <ISSUE> --minutes <n> [--text <t>] [--date auto|YYYY-MM-DD]
//   workit youtrack meeting <ISSUE> --minutes <n> --text <t> [--date auto|YYYY-MM-DD]
//   workit youtrack show <ISSUE>
//   workit youtrack create --project <P> --summary <s> [--description <t> | --file <p>]
import { progressFor } from "../progress";
import { readFileSync } from "node:fs";
import path from "node:path";
import { youTrackWorkDateMs } from "@brainervirus/workit-core/src/core/youtrack";
import { ISSUE_RE } from "@brainervirus/workit-core/src/core/youtrack-tools";
import {
  withMarker,
  writeOnce,
  youTrackMarker,
  type MarkerWhere,
  type OnceOutcome,
} from "@brainervirus/workit-core/src/core/youtrack-writes";
import {
  youTrackBackend,
  youTrackWriteGate,
  type IssueView,
  type WriteResult,
  type YouTrackBackend,
} from "@brainervirus/workit-core/src/core/youtrack-backend";
import { emit, fail, ok, type Io } from "../output";
import { parseFlags, positiveInt, usage } from "./forge-common";

const USAGE =
  "workit youtrack note <ISSUE> (--markdown <t> | --file <p>) [--minutes <n>] [--date auto|YYYY-MM-DD] | youtrack time <ISSUE> --minutes <n> [--text <t>] [--date …] | youtrack meeting <ISSUE> --minutes <n> --text <t> [--date …] | youtrack show <ISSUE> | youtrack create --project <P> --summary <s> [--description <t> | --file <p>]";

export async function run(
  argv: string[],
  io: Io,
  backend: () => YouTrackBackend = () => youTrackBackend(io.env),
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "show") return show(rest, io, backend);
  if (sub === "create") return create(rest, io, backend);
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

  const steps: { label: string; where: MarkerWhere; request: Record<string, unknown> }[] = [];
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
    });
    writes.push((yt, marked) => yt.addComment(issueId, marked(markdown)));
    if (minutes) {
      steps.push({
        label: "time",
        where: "workItems",
        request: { operation: "note.time", issueId, markdown, minutes, ...markedDay },
      });
      writes.push((yt, marked) =>
        yt.addWorkItem(issueId, { minutes, text: marked("workit update"), dateMs }),
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
    });
    writes.push((yt, marked) => yt.addWorkItem(issueId, { minutes, text: marked(text), dateMs }));
  }

  const gate = youTrackWriteGate(io.env, `workit youtrack ${sub}`);
  if (gate) return emit(io, fail(gate.code, gate.error, { unblock: gate.unblock }));
  const yt = backend();
  const results: { step: string; status: OnceOutcome["status"]; note?: string }[] = [];
  for (const [index, entry] of steps.entries()) {
    const marker = youTrackMarker(entry.request);
    const write = async () =>
      onceResult(await writes[index](yt, (text) => withMarker(text, marker)));
    // fetch and child-process work only, so Ctrl-C may clear the frame.
    const outcome = await progressFor(io).run(
      entry.label,
      () => writeOnce(issueId, marker, entry.where, write, yt),
      undefined,
      { signals: true },
    );
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
    ok({ issueId, date: date.data.localDate, backend: yt.kind, steps: results }),
    (data) => [
      `${issueId}: ${data.steps.map((entry) => `${entry.step} ${entry.status.replace("_", " ")}`).join(", ")} (${data.date})`,
      ...data.steps.flatMap((entry) =>
        entry.note ? [`  note (${entry.step}): ${entry.note}`] : [],
      ),
    ],
  );
}

/** A backend write in writeOnce's shape: the outcome rides in data. */
const onceResult = (result: WriteResult): { ok: boolean; error?: string; data?: unknown } =>
  result.ok
    ? { ok: true, data: result.data }
    : {
        ok: false,
        error: result.error,
        data: { outcome: result.outcome, ...(result.unblock ? { unblock: result.unblock } : {}) },
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
      fail(result.code, result.error, { data: { issueId }, unblock: result.unblock }),
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

async function create(argv: string[], io: Io, backend: () => YouTrackBackend): Promise<number> {
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
  const gate = youTrackWriteGate(io.env, "creating a YouTrack issue");
  if (gate)
    return emit(io, fail(gate.code, gate.error, { data: { project }, unblock: gate.unblock }));
  const result = await backend().createIssue({
    project,
    summary: summary.trim(),
    ...(description === undefined ? {} : { description }),
  });
  if (!result.ok)
    return emit(
      io,
      fail(result.code, result.error, { data: { project }, unblock: result.unblock }),
    );
  return emit(io, ok(result.data), (data) => [
    `created ${data.issueId}${data.url ? ` ${data.url}` : ""}`,
  ]);
}
