// `workit youtrack note|time|meeting` (design §4.2 S16): the YouTrack writes
// that ≤4.x ran as approved external actions, now plain verbs. The host's own
// permission prompt authorizes them like any other shell command; no grant is
// involved (they write to the tracker, not to the repository). Every write
// carries a deterministic marker and is read back first, so a retry after a
// lost response never posts twice (core/youtrack-writes.ts).
//
//   workit youtrack note <ISSUE> (--markdown <text> | --file <path>) [--minutes <n>] [--date auto|YYYY-MM-DD]
//   workit youtrack time <ISSUE> --minutes <n> [--text <t>] [--date auto|YYYY-MM-DD]
//   workit youtrack meeting <ISSUE> --minutes <n> --text <t> [--date auto|YYYY-MM-DD]
import { readFileSync } from "node:fs";
import path from "node:path";
import { youTrackWorkDateMs } from "@brainervirus/workit-core/src/core/youtrack";
import {
  ISSUE_RE,
  defaultOperations,
  logTimeUpdate,
  unwrap,
} from "@brainervirus/workit-core/src/core/youtrack-tools";
import {
  withMarker,
  writeOnce,
  youTrackMarker,
  type MarkerWhere,
  type OnceOutcome,
} from "@brainervirus/workit-core/src/core/youtrack-writes";
import { emit, fail, ok, type Io } from "../output";
import { parseFlags, positiveInt, usage } from "./forge-common";

const USAGE =
  "workit youtrack note <ISSUE> (--markdown <t> | --file <p>) [--minutes <n>] [--date auto|YYYY-MM-DD] | youtrack time <ISSUE> --minutes <n> [--text <t>] [--date …] | youtrack meeting <ISSUE> --minutes <n> --text <t> [--date …]";

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
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
  const root = io.cwd;

  const steps: { label: string; where: MarkerWhere; run: () => Promise<OnceOutcome> }[] = [];
  const step = (
    label: string,
    where: MarkerWhere,
    request: Record<string, unknown>,
    text: string,
    write: (text: string) => Promise<{ ok: boolean; error?: string | null; data?: unknown }>,
  ): string | null => {
    const marker = youTrackMarker(request);
    if (!marker) return "YouTrack credentials are unavailable (youtrack.json / youtrack.token)";
    steps.push({
      label,
      where,
      run: () => writeOnce(issueId, marker, where, () => write(withMarker(text, marker))),
    });
    return null;
  };

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
    const missing =
      step(
        "comment",
        "comments",
        { operation: "note", issueId, markdown },
        markdown,
        async (text) => commentResult(await postComment(issueId, text, root)),
      ) ??
      (minutes
        ? step(
            "time",
            "workItems",
            { operation: "note.time", issueId, markdown, minutes, ...markedDay },
            "workit update",
            (text) => logTimeUpdate({ issueId, minutes, text, dateMs, workspace_root: root }),
          )
        : null);
    if (missing) return emit(io, fail("unavailable", missing));
  } else {
    if (!minutes) return usage(io, `${sub} needs --minutes <n>`, USAGE);
    if (sub === "meeting" && !flags.values.text)
      return usage(io, "meeting needs --text <what the meeting was>", USAGE);
    const text = flags.values.text ?? "";
    const missing = step(
      sub,
      "workItems",
      { operation: sub, issueId, minutes, text, ...markedDay },
      text,
      (marked) => logTimeUpdate({ issueId, minutes, text: marked, dateMs, workspace_root: root }),
    );
    if (missing) return emit(io, fail("unavailable", missing));
  }
  const results: { step: string; status: OnceOutcome["status"]; note?: string }[] = [];
  for (const entry of steps) {
    const outcome = await entry.run();
    results.push({
      step: entry.label,
      status: outcome.status,
      ...("precheck" in outcome && outcome.precheck === "inconclusive"
        ? {
            note: "the issue has more items than one read-back page, so an earlier copy could not be ruled out before writing",
          }
        : {}),
    });
    if (outcome.status === "failed" || outcome.status === "unknown")
      return emit(
        io,
        fail(outcome.status === "unknown" ? "unavailable" : "failed", outcome.error, {
          data: { issueId, steps: results, ...(outcome.data ? { detail: outcome.data } : {}) },
          ...(outcome.status === "unknown"
            ? {
                unblock: `check ${issueId} in YouTrack; re-running is safe (the marker skips a write that already landed)`,
              }
            : {}),
        }),
      );
  }
  return emit(io, ok({ issueId, date: date.data.localDate, steps: results }), (data) => [
    `${issueId}: ${data.steps.map((entry) => `${entry.step} ${entry.status.replace("_", " ")}`).join(", ")} (${data.date})`,
    ...data.steps.flatMap((entry) => (entry.note ? [`  note (${entry.step}): ${entry.note}`] : [])),
  ]);
}

const commentResult = (value: unknown): { ok: boolean; error?: string; data?: unknown } => {
  try {
    return { ok: true, data: unwrap(value as never) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const postComment = async (issueId: string, text: string, root: string): Promise<unknown> => {
  try {
    return await defaultOperations.postComment(issueId, text, root);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};
