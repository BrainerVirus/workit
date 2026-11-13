// `workit youtrack note|time|meeting|show|create` (design §4.2 S16, #263).
// Every call goes through one YouTrackBackend (core/youtrack-backend.ts):
// `ytrack … --json`, the only path to YouTrack (its token stays in the OS
// keyring); without ytrack every verb fails with the install unblock. Agents use
// these verbs, or the ytrack skill, instead of calling the API. Writes (note,
// time, meeting, update, create) ask the user first by default (#780, #864):
// on Claude Code and Pi the host asks on this very call, showing its full
// text (approvals/youtrack-ask.ts), and a yes posts in the same call; on the
// other hosts the verb records one request per text and refuses with the
// terminal step (`workit approve`), then the re-run consumes that yes once. A
// workspace with `youtrack: { writes: "auto" }` keeps the WORKIT_YT_WRITE=1 gate instead.
// Every comment or work item carries a deterministic marker and is read back
// first, so a retry after a lost response never posts twice; an identical
// entry by the same user is refused as `duplicate_entry`; a write an earlier
// call left unsettled is reported on the next call (core/youtrack-writes.ts).
//
//   workit youtrack note <ISSUE> (--markdown <text> | --file <path>) [--minutes <n>] [--date auto|YYYY-MM-DD]
//   workit youtrack time <ISSUE> --minutes <n> [--text <t>] [--date auto|YYYY-MM-DD]
//   workit youtrack meeting <ISSUE> --minutes <n> --text <t> [--date auto|YYYY-MM-DD]
//   workit youtrack update <ISSUE> [--markdown <t> | --file <p>] [--attach <file>]... [--minutes <n> [--text <t>] [--date …]] [--state <S>] [--command '<command>']
//   workit youtrack show <ISSUE>
//   workit youtrack create --project <P> --summary <s> [--description <t> | --file <p>] [--attach <file>]... [--command '<command>']
//
// `update` makes every write on one issue under one yes, in order: one comment
// carrying its attachments (`![](name)` in the text shows a file inline, the
// rest sit alongside), the time, then the commands (--state S is `State S`).
// It stops at the first failure and names what landed. Attachments are checked
// before asking: each file must exist and ytrack must have --attach.
import { progressFor } from "../progress";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { youTrackBaseUrl, youTrackWorkDateMs } from "@workit-dev/core/src/core/youtrack";
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
  consumeInlineAsk,
  createApprovalRequest,
  INLINE_TICKET_ENV,
  INLINE_UNASKED_ENV,
  type ApprovalFields,
} from "@workit-dev/core/src/approvals/store";
import { youTrackAsk } from "@workit-dev/core/src/approvals/youtrack-ask";
import { hostSessionFromEnv } from "@workit-dev/core/src/host-session";
import { actorFromEnv, appendObserved } from "@workit-dev/core/src/ledger";
import {
  youTrackBackend,
  youTrackWriteGate,
  type IssueView,
  type WriteResult,
  type YouTrackBackend,
} from "@workit-dev/core/src/core/youtrack-backend";
import {
  YTRACK_MISSING,
  ytrackHostName,
  ytrackMissingUnblock,
  ytrackUpgradeUnblock,
  type YtrackFeature,
} from "@workit-dev/core/src/core/youtrack-ytrack";
import { emit, fail, ok, type Io } from "../output";
import { parseFlags, positiveInt, usage } from "./forge-common";

const USAGE =
  "workit youtrack note <ISSUE> (--markdown <t> | --file <p>) [--minutes <n>] [--date auto|YYYY-MM-DD] | youtrack time <ISSUE> --minutes <n> [--text <t>] [--date …] | youtrack meeting <ISSUE> --minutes <n> --text <t> [--date …] | youtrack update <ISSUE> [--markdown <t> | --file <p>] [--attach <file>]... [--minutes <n> [--text <t>] [--date …]] [--state <S>] [--command '<command>'] | youtrack show <ISSUE> | youtrack create --project <P> --summary <s> [--description <t> | --file <p>] [--attach <file>]... [--command '<command>']";

/** Test seams: the workspace's `youtrack.writes` mode for a cwd, and how a named file is read. */
export type YouTrackDeps = {
  writes?: (cwd: string) => YouTrackWritesMode;
  read?: (file: string) => Buffer;
};

/**
 * Each file a call names is read once per run (#864): the bytes the yes is
 * checked against (youTrackAsk's content hash) are the bytes that post. An
 * attachment posts from a private copy of those bytes, never from its path.
 */
const loaders = new WeakMap<Io, (file: string) => Buffer>();
const load = (io: Io, file: string): Buffer =>
  (loaders.get(io) ?? ((full: string) => readFileSync(full)))(path.resolve(io.cwd, file));
const copies = new WeakMap<Io, string>();
const copyOf = (io: Io, name: string, content: Buffer): string => {
  let dir = copies.get(io);
  if (!dir) {
    dir = mkdtempSync(path.join(tmpdir(), "workit-attach-"));
    copies.set(io, dir);
  }
  const file = path.join(dir, name);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
};

type Write = (yt: YouTrackBackend, marked: (text: string) => string) => Promise<WriteResult>;

/** One write of a call, in the order the call makes them. */
type Step = {
  label: string;
  /** Where its marker is read back; null for a write with no text of its own (attachments, a command). */
  where: MarkerWhere | null;
  request: Record<string, unknown>;
  /** What the duplicate check compares; null when the step has no identity of its own. */
  wanted: Wanted | null;
  write: Write;
};

/** Everything one call writes, and what the user approves for it. */
type Plan = {
  issueId: string;
  verb: string;
  localDate: string;
  steps: Step[];
  action: string;
  effect: string;
  subject: Record<string, unknown>;
  /** A ytrack feature the writes need, checked before asking. */
  needs?: { feature: YtrackFeature; what: string };
};

type StepResult = {
  step: string;
  status: OnceOutcome["status"] | "not_applied";
  note?: string;
};

export async function run(
  argv: string[],
  io: Io,
  backend: () => YouTrackBackend = () => youTrackBackend(io.env),
  deps: YouTrackDeps = {},
): Promise<number> {
  const read = deps.read ?? ((full: string) => readFileSync(full));
  const seen = new Map<string, Buffer>();
  loaders.set(io, (full) => {
    const known = seen.get(full) ?? read(full);
    seen.set(full, known);
    return known;
  });
  try {
    return await runVerb(argv, io, backend, deps);
  } finally {
    const dir = copies.get(io);
    if (dir) rmSync(dir, { recursive: true, force: true });
    loaders.delete(io);
    copies.delete(io);
  }
}

async function runVerb(
  argv: string[],
  io: Io,
  backend: () => YouTrackBackend,
  deps: YouTrackDeps,
): Promise<number> {
  const [sub, ...rest] = argv;
  const writesMode = () => (deps.writes ?? youTrackWritesMode)(io.cwd);
  if (sub === "show") return show(rest, io, backend);
  if (sub === "create") return create(rest, io, backend, writesMode(), argv);
  if (sub !== "note" && sub !== "time" && sub !== "meeting" && sub !== "update")
    return usage(io, `unknown subcommand "${sub ?? ""}"`, USAGE);
  const flags = parseFlags(rest, {
    markdown: "value",
    file: "value",
    minutes: "value",
    text: "value",
    date: "value",
    ...(sub === "update" ? { attach: "list", state: "value", command: "value" } : {}),
  } as const);
  if (typeof flags === "string") return usage(io, flags, USAGE);
  const [issueId, extra] = flags.positionals;
  if (!issueId || !ISSUE_RE.test(issueId))
    return usage(io, "an issue id like ABC-123 is required", USAGE);
  if (extra !== undefined) return usage(io, `unexpected argument ${extra}`, USAGE);
  const minutes = positiveInt(flags.values.minutes, "--minutes");
  if (typeof minutes === "string") return usage(io, minutes, USAGE);
  const date = youTrackWorkDateMs(flags.values.date ?? "auto");
  if ("error" in date) return usage(io, date.error, USAGE);
  const when: When = {
    dateMs: date.data.dateMs,
    localDate: date.data.localDate,
    // The marker names the day only when the user named it: with `--date auto`
    // a retry on a later day is the same request and must not post again.
    markedDay:
      flags.values.date !== undefined && flags.values.date !== "auto"
        ? { dateMs: date.data.dateMs }
        : {},
  };
  const plan =
    sub === "update"
      ? updatePlan(io, issueId, flags, minutes, when)
      : legacyPlan(io, sub, issueId, flags, minutes, when);
  if (typeof plan === "string") return usage(io, plan, USAGE);
  return runPlan(io, plan, backend, writesMode(), argv);
}

type Flags = Exclude<ReturnType<typeof parseFlags>, string>;
type When = {
  dateMs: number;
  localDate: string;
  markedDay: { dateMs?: number };
};

/** The note's text from --markdown or --file, or why there is none. */
function commentText(io: Io, flags: Flags, required: boolean): string | null | { error: string } {
  const { markdown, file } = flags.values;
  if (markdown !== undefined && file !== undefined)
    return { error: "pass at most one of --markdown or --file" };
  if (markdown === undefined && file === undefined)
    return required ? { error: "pass exactly one of --markdown or --file" } : null;
  let text = markdown ?? "";
  if (file !== undefined)
    try {
      text = load(io, file).toString("utf8");
    } catch (error) {
      return { error: `cannot read ${file}: ${String(error)}` };
    }
  return text.trim() ? text : { error: "the note is empty" };
}

/** `workit youtrack note|time|meeting`: the steps they always made. */
function legacyPlan(
  io: Io,
  sub: "note" | "time" | "meeting",
  issueId: string,
  flags: Flags,
  minutes: number | null,
  when: When,
): Plan | string {
  const { dateMs, localDate, markedDay } = when;
  const day = new Date(dateMs).toISOString().slice(0, 10);
  const action = `workit youtrack ${sub} ${issueId}${minutes ? ` --minutes ${minutes}` : ""}`;
  if (sub === "note") {
    const markdown = commentText(io, flags, true);
    if (markdown === null || typeof markdown === "object") return markdown?.error ?? "";
    const steps: Step[] = [
      {
        label: "comment",
        where: "comments",
        request: { operation: "note", issueId, markdown },
        wanted: { where: "comments", text: markdown },
        write: (yt, marked) => yt.addComment(issueId, marked(markdown)),
      },
    ];
    if (minutes)
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
        write: (yt, marked) =>
          yt.addWorkItem(issueId, {
            minutes,
            text: marked("workit update"),
            dateMs,
          }),
      });
    return {
      issueId,
      verb: sub,
      localDate,
      steps,
      action,
      effect: minutes
        ? `posts this comment on ${issueId} and logs ${minutes} minutes on ${localDate}`
        : `posts this comment on ${issueId}`,
      subject: {
        comment: markdown,
        ...(minutes ? { minutes, date: localDate } : {}),
      },
    };
  }
  if (!minutes) return `${sub} needs --minutes <n>`;
  if (sub === "meeting" && !flags.values.text) return "meeting needs --text <what the meeting was>";
  const text = flags.values.text ?? "";
  return {
    issueId,
    verb: sub,
    localDate,
    steps: [
      {
        label: sub,
        where: "workItems",
        request: { operation: sub, issueId, minutes, text, ...markedDay },
        wanted: { where: "workItems", text, minutes, date: day },
        write: (yt, marked) => yt.addWorkItem(issueId, { minutes, text: marked(text), dateMs }),
      },
    ],
    action,
    effect: `logs ${minutes} minutes on ${issueId} on ${localDate}`,
    subject: { minutes, text, date: localDate },
  };
}

/** `2h45m`, `1h`, `30m`. */
const durationText = (minutes: number): string =>
  `${minutes >= 60 ? `${Math.floor(minutes / 60)}h` : ""}${minutes % 60 || minutes < 60 ? `${minutes % 60}m` : ""}`;

const sizeText = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** `post`: the private copy of the bytes read, which is what is attached. */
type Attachment = { path: string; name: string; bytes: number; sha256: string; post: string };

/** Each --attach file read once (name, size, content hash), or the first one that is not a readable file. */
function attachments(io: Io, files: readonly string[]): Attachment[] | string {
  const out: Attachment[] = [];
  for (const file of files) {
    const full = path.resolve(io.cwd, file);
    let content: Buffer;
    try {
      if (!statSync(full).isFile()) return `--attach ${file} is not a file`;
      content = load(io, full);
    } catch {
      return `--attach ${file}: no such file`;
    }
    const twin = out.find((earlier) => earlier.name === path.basename(full));
    if (twin)
      return `--attach ${file} has the same name as ${twin.path}: ytrack refuses two files with one name, so rename one`;
    out.push({
      path: full,
      name: path.basename(full),
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      post: copyOf(io, path.basename(full), content),
    });
  }
  return out;
}

/** The first three lines of a comment, with how many more there are. */
const firstLines = (text: string): string => {
  const lines = text.trim().split(/\r?\n/u);
  return lines.length > 3
    ? `${lines.slice(0, 3).join(" / ")} … (+${lines.length - 3} lines)`
    : lines.join(" / ");
};

/** What the user approves for each file: name, size and the start of its content hash. */
const attachmentLines = (files: readonly Attachment[]): string[] =>
  files.map((file) => `${file.name} (${sizeText(file.bytes)}, sha256 ${file.sha256.slice(0, 12)})`);

const fileList = (files: readonly Attachment[]): string =>
  files.map((file) => `${file.name} (${sizeText(file.bytes)})`).join(", ");

/** The commands --state and --command apply, in that order. */
const commandsOf = (flags: Flags): string[] | string => {
  const state = flags.values.state?.trim();
  const command = flags.values.command?.trim();
  if (flags.values.state !== undefined && !state) return "--state needs a state name";
  if (flags.values.command !== undefined && !command) return "--command needs a YouTrack command";
  return [...(state ? [`State ${state}`] : []), ...(command ? [command] : [])];
};

/**
 * `workit youtrack update`: one comment (carrying any attachments), time and
 * commands on one issue, in that order, under one yes.
 */
function updatePlan(
  io: Io,
  issueId: string,
  flags: Flags,
  minutes: number | null,
  when: When,
): Plan | string {
  const { dateMs, localDate, markedDay } = when;
  const comment = commentText(io, flags, false);
  if (comment !== null && typeof comment === "object") return comment.error;
  const files = attachments(io, flags.lists.attach ?? []);
  if (typeof files === "string") return files;
  const commands = commandsOf(flags);
  if (typeof commands === "string") return commands;
  if (!minutes && (flags.values.text !== undefined || flags.values.date !== undefined))
    return "--text and --date describe time: pass --minutes <n> with them";
  if (comment === null && !files.length && !minutes && !commands.length)
    return "update needs at least one of --markdown/--file, --attach, --minutes, --state or --command";
  const steps: Step[] = [];
  const effects: string[] = [];
  const subject: Record<string, unknown> = {};
  const paths = files.map((file) => file.post);
  const hashes = files.map((file) => file.sha256);
  if (comment !== null) {
    steps.push({
      label: "comment",
      where: "comments",
      request: {
        operation: "update.comment",
        issueId,
        markdown: comment,
        attachments: hashes,
      },
      wanted: { where: "comments", text: comment },
      write: (yt, marked) => yt.addComment(issueId, marked(comment), paths),
    });
    effects.push(
      `comment "${firstLines(comment)}"${files.length ? ` with ${fileList(files)}` : ""}`,
    );
    // The whole text: the yes covers exactly what the user read (#864).
    subject.comment = comment;
  } else if (files.length) {
    steps.push({
      label: "attach",
      where: null,
      request: { operation: "update.attach", issueId, attachments: hashes },
      wanted: null,
      write: (yt) => yt.attachFiles(issueId, paths),
    });
    effects.push(`attach ${fileList(files)}`);
  }
  if (files.length) subject.attachments = attachmentLines(files);
  if (minutes) {
    const text = flags.values.text ?? (comment === null ? "" : "workit update");
    steps.push({
      label: "time",
      where: "workItems",
      request: {
        operation: "update.time",
        issueId,
        minutes,
        text,
        ...markedDay,
      },
      // Time that rides on a comment is identified by it, as with note.
      wanted:
        comment !== null && flags.values.text === undefined
          ? null
          : {
              where: "workItems",
              text,
              minutes,
              date: new Date(dateMs).toISOString().slice(0, 10),
            },
      write: (yt, marked) => yt.addWorkItem(issueId, { minutes, text: marked(text), dateMs }),
    });
    effects.push(
      `log ${durationText(minutes)} on ${localDate}${text && flags.values.text !== undefined ? ` ("${text}")` : ""}`,
    );
    subject.time = `${durationText(minutes)} on ${localDate}`;
    if (flags.values.text !== undefined) subject.text = text;
  }
  for (const [index, command] of commands.entries()) {
    steps.push({
      label: commands.length > 1 ? `command ${index + 1}` : "command",
      where: null,
      request: { operation: "update.command", issueId, command },
      wanted: null,
      write: (yt) => yt.applyCommand(issueId, command),
    });
    effects.push(`apply the command ${command}`);
  }
  if (commands.length) subject.commands = commands;
  return {
    issueId,
    verb: "update",
    localDate,
    steps,
    action: `workit youtrack update ${issueId}`,
    effect: `on ${issueId} at ${trackerName()}, in order: ${effects.map((effect, index) => `${index + 1}. ${effect}`).join("; ")}`,
    subject,
    ...(files.length
      ? {
          needs:
            comment !== null
              ? {
                  feature: "comment-attach" as const,
                  what: "`ytrack issue comment --attach`",
                }
              : {
                  feature: "issue-attach" as const,
                  what: "`ytrack issue attach`",
                },
        }
      : {}),
  };
}

/** The YouTrack the writes go to, as the user knows it. */
const trackerName = (): string => {
  const base = youTrackBaseUrl();
  return base ? ytrackHostName(base) : "ytrack's default host";
};

/** Refuse, before asking, a write this ytrack cannot make. null when it can. */
function unsupported(
  io: Io,
  yt: YouTrackBackend,
  plan: Pick<Plan, "needs">,
  data: Record<string, unknown>,
): number | null {
  if (!plan.needs) return null;
  const support = yt.supports(plan.needs.feature);
  if (support === "ok") return null;
  const host = youTrackBaseUrl();
  return emit(
    io,
    fail(
      "unavailable",
      support === "missing"
        ? `${YTRACK_MISSING}; nothing was posted`
        : `this ytrack has no ${plan.needs.what}, which attachments need; nothing was posted`,
      {
        data: {
          ...data,
          reason: support === "missing" ? "ytrack_missing" : "ytrack_too_old",
          posted: false,
        },
        unblock:
          support === "missing"
            ? ytrackMissingUnblock(host)
            : ytrackUpgradeUnblock(plan.needs.what),
      },
    ),
  );
}

/** Run a plan's writes once each, in order, under one yes; stop at the first failure. */
async function runPlan(
  io: Io,
  plan: Plan,
  backend: () => YouTrackBackend,
  mode: YouTrackWritesMode,
  argv: readonly string[],
): Promise<number> {
  const { issueId, steps } = plan;
  if (mode === "auto") {
    const gate = youTrackWriteGate(io.env, `workit youtrack ${plan.verb}`);
    if (gate) return emit(io, fail(gate.code, gate.error, { unblock: gate.unblock }));
  }
  const yt = backend();
  const refused = unsupported(io, yt, plan, { issueId });
  if (refused !== null) return refused;
  const earlier = await settlePending(yt);
  const results: StepResult[] = [];
  const todo: number[] = [];
  /** Steps whose duplicate check could not read the user's entries. */
  const unchecked = new Set<number>();
  for (const [index, entry] of steps.entries()) {
    if (
      entry.where &&
      (await markerPresent(issueId, youTrackMarker(entry.request), entry.where, yt)) === true
    ) {
      results.push({ step: entry.label, status: "already_done" });
      continue;
    }
    const duplicate = entry.wanted ? await findDuplicate(issueId, entry.wanted, yt) : null;
    if (duplicate === undefined) unchecked.add(index);
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
        action: plan.action,
        on: { issue: issueId },
        effect: plan.effect,
        subject: unchecked.size
          ? {
              ...plan.subject,
              duplicates: `not checked: your existing entries on ${issueId} could not be read`,
            }
          : plan.subject,
      }),
      `youtrack ${plan.verb}`,
      { issueId, steps: results, earlier },
      argv,
    );
    if (asked !== null) return asked;
  }
  for (const [position, index] of todo.entries()) {
    const entry = steps[index];
    const outcome = await runStep(io, plan, entry, yt);
    const notes = [
      ...("precheck" in outcome && outcome.precheck === "inconclusive"
        ? [
            "the issue has more items than one read-back page, so an earlier copy could not be ruled out before writing",
          ]
        : []),
      ...(unchecked.has(index)
        ? ["your existing entries could not be read, so duplicates were not checked"]
        : []),
    ];
    results.push({
      step: entry.label,
      status: outcome.status,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    });
    if (outcome.status === "failed" || outcome.status === "unknown") {
      const rest = todo.slice(position + 1).map((later) => steps[later].label);
      for (const label of rest) results.push({ step: label, status: "not_applied" });
      const landed = results
        .filter((result) => ["done", "already_done", "settled"].includes(result.status))
        .map((result) => result.step);
      const unblock = (outcome.data as { unblock?: unknown } | undefined)?.unblock;
      const summary = [
        landed.length ? `landed: ${landed.join(", ")}` : "",
        rest.length ? `not applied: ${rest.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      return emit(
        io,
        fail(
          outcome.status === "unknown" ? "unavailable" : "failed",
          `${entry.label} ${outcome.status === "unknown" ? "may not have landed" : "failed"}: ${outcome.error}${summary ? ` (${summary})` : ""}`,
          {
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
                    unblock: `check ${issueId} in YouTrack; re-running is safe for a comment or time (the marker skips a write that already landed), not for a command or attachment`,
                  }
                : {}),
          },
        ),
      );
    }
  }
  return emit(
    io,
    ok({
      issueId,
      date: plan.localDate,
      backend: yt.kind,
      steps: results,
      earlier,
    }),
    (data) => resultLines(issueId, data.date, data.steps, data.earlier),
  );
}

const resultLines = (
  issueId: string,
  date: string,
  steps: StepResult[],
  earlier: EarlierWrite[],
): string[] => [
  ...earlierLines(earlier),
  `${issueId}: ${steps.map((entry) => `${entry.step} ${entry.status.replace("_", " ")}`).join(", ")} (${date})`,
  ...steps.flatMap((entry) => (entry.note ? [`  note (${entry.step}): ${entry.note}`] : [])),
];

/** One step: a marked write at most once (read back first), else the write itself. */
async function runStep(io: Io, plan: Plan, entry: Step, yt: YouTrackBackend): Promise<OnceOutcome> {
  const { issueId } = plan;
  if (!entry.where) {
    const result = await progressFor(io).run(
      entry.label,
      () => entry.write(yt, (text) => text),
      undefined,
      {
        signals: true,
      },
    );
    if (result.ok) return { status: "done", data: result.data };
    return {
      status: result.outcome === "not_applied" ? "failed" : "unknown",
      error: result.error,
      data: onceResult(result).data,
    };
  }
  const where = entry.where;
  const marker = youTrackMarker(entry.request);
  const write = async () => onceResult(await entry.write(yt, (text) => withMarker(text, marker)));
  rememberPending({
    issueId,
    step: entry.label,
    action: `workit youtrack ${plan.verb} ${issueId}`,
    where,
    marker,
  });
  // fetch and child-process work only, so Ctrl-C may clear the frame.
  const outcome = await progressFor(io).run(
    entry.label,
    () => writeOnce(issueId, marker, where, write, yt),
    undefined,
    { signals: true },
  );
  if (outcome.status !== "unknown") forgetPending(marker);
  return outcome;
}

/** The `approval.consumed` ledger row; a checkout without a ledger records none. */
const recordConsumed = (io: Io, row: Record<string, unknown>): void => {
  try {
    appendObserved(io.cwd, { type: "approval.consumed", actor: actorFromEnv(io.env), ...row });
  } catch {
    // The yes is used either way; the store keeps the consumed record.
  }
};

/**
 * Consume the user's yes right before the write, or refuse. The yes comes
 * from the host's prompt on this very call (its ticket, Claude Code and Pi),
 * else from a terminal `workit approve` of the request for `fields`. Refuses
 * `approval_not_bound` when the ticket does not cover this call, else
 * `approval_needed`, `approval_stale` or `approval_consumed` with the one
 * request for this text. null when the write may go ahead.
 */
function askFirst(
  io: Io,
  fields: ApprovalFields,
  verb: string,
  data: Record<string, unknown>,
  argv: readonly string[],
): number | null {
  const session = io.env.WORKIT_SESSION_ID || null;
  const ticket = io.env[INLINE_TICKET_ENV];
  if (ticket) {
    const ask = youTrackAsk(argv, io.cwd, (full) => load(io, full));
    const used = ask
      ? consumeInlineAsk({
          ticket,
          kind: ask.kind,
          argvHash: ask.argvHash,
          contentHash: ask.contentHash,
          verb,
          // The host session this shell runs in, as its hooks see it.
          session: hostSessionFromEnv(io.env).session,
        })
      : { ok: false as const, reason: "Workit cannot read this call's text" };
    if (used.ok) {
      recordConsumed(io, {
        kind: used.asked.kind,
        verb,
        via: "inline",
        host: used.asked.host,
        contentHash: used.asked.contentHash,
        session,
        askSession: used.asked.session,
      });
      return null;
    }
    return emit(
      io,
      fail(
        "blocked",
        `approval_not_bound: nothing was posted; the yes from the host's prompt does not cover this call: ${used.reason}. Run the call again as its own plain command and the host asks the user again.`,
        { data: { ...data, reason: "approval_not_bound", posted: false } },
      ),
    );
  }
  const used = consumeApproval(fields, { session, verb });
  if (used.ok) {
    recordConsumed(io, {
      kind: fields.kind,
      verb,
      via: used.grant.via,
      host: used.grant.host,
      approval: used.consumed.id,
      hash: used.consumed.hash,
      session,
      grantSession: used.consumed.grantSession,
    });
    return null;
  }
  // approval_consumed: the yes went to a run that did not land, so this run
  // gets its own request rather than a dead end.
  const request = used.request ?? createApprovalRequest(fields, { session });
  const unasked = io.env[INLINE_UNASKED_ENV];
  const why = unasked
    ? ` The host ran this call in ${unasked.startsWith("sdk") ? `the ${unasked} entrypoint` : `${unasked} mode`}, where no person sees a prompt, so nothing was approved.`
    : io.env.CLAUDECODE
      ? " Claude Code asks the user only on a plain `workit youtrack …` call it sees: run it as its own call (no script, bash -c, pipe or redirect) and the host shows the user the text."
      : "";
  return emit(
    io,
    fail("blocked", `${used.code}: nothing was posted.${why} ${approveLine(request)}`, {
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
  words: readonly string[],
): Promise<number> {
  const flags = parseFlags(argv, {
    project: "value",
    summary: "value",
    description: "value",
    file: "value",
    attach: "list",
    command: "value",
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
      description = load(io, file).toString("utf8");
    } catch (error) {
      return usage(io, `cannot read ${file}: ${String(error)}`, USAGE);
    }
  const files = attachments(io, flags.lists.attach ?? []);
  if (typeof files === "string") return usage(io, files, USAGE);
  const commands = commandsOf(flags);
  if (typeof commands === "string") return usage(io, commands, USAGE);
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
  }
  const yt = backend();
  if (files.length) {
    const refused = unsupported(
      io,
      yt,
      { needs: { feature: "issue-attach", what: "`ytrack issue attach`" } },
      { project },
    );
    if (refused !== null) return refused;
  }
  if (mode === "ask") {
    const asked = askFirst(
      io,
      youTrackApprovalFields({
        action: `workit youtrack create --project ${project}`,
        on: { project },
        effect: [
          `creates a new issue in ${project}`,
          ...(files.length ? [`attaches ${fileList(files)}`] : []),
          ...commands.map((command) => `applies the command ${command}`),
        ].join(", then "),
        subject: {
          summary: summary.trim(),
          ...(description === undefined ? {} : { description }),
          ...(files.length ? { attachments: attachmentLines(files) } : {}),
          ...(commands.length ? { commands } : {}),
        },
      }),
      "youtrack create",
      { project },
      words,
    );
    if (asked !== null) return asked;
  }
  const result = await yt.createIssue({
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
  const issueId = result.data.issueId;
  const after: { label: string; write: () => Promise<WriteResult> }[] = [
    ...(files.length
      ? [
          {
            label: "attach",
            write: () =>
              yt.attachFiles(
                issueId,
                files.map((one) => one.post),
              ),
          },
        ]
      : []),
    ...commands.map((command, index) => ({
      label: commands.length > 1 ? `command ${index + 1}` : "command",
      write: () => yt.applyCommand(issueId, command),
    })),
  ];
  const steps: StepResult[] = [{ step: "create", status: "done" }];
  for (const [position, step] of after.entries()) {
    const written = await step.write();
    if (written.ok) {
      steps.push({ step: step.label, status: "done" });
      continue;
    }
    steps.push({
      step: step.label,
      status: written.outcome === "not_applied" ? "failed" : "unknown",
    });
    const rest = after.slice(position + 1).map((later) => later.label);
    for (const label of rest) steps.push({ step: label, status: "not_applied" });
    return emit(
      io,
      fail(
        written.outcome === "not_applied" ? "failed" : "unavailable",
        `${step.label} failed on the new issue ${issueId}: ${written.error} (landed: create${steps
          .filter((entry) => entry.status === "done" && entry.step !== "create")
          .map((entry) => `, ${entry.step}`)
          .join("")}${rest.length ? `; not applied: ${rest.join(", ")}` : ""})`,
        {
          data: { project, ...result.data, steps },
          unblock:
            written.unblock ??
            `the issue ${issueId} exists: finish it with workit youtrack update ${issueId}, never create it again`,
        },
      ),
    );
  }
  return emit(io, ok({ ...result.data, ...(after.length ? { steps } : {}) }), (data) => [
    `created ${data.issueId}${data.url ? ` ${data.url}` : ""}`,
    ...(after.length
      ? [
          `  ${steps
            .slice(1)
            .map((entry) => `${entry.step} ${entry.status}`)
            .join(", ")}`,
        ]
      : []),
  ]);
}
