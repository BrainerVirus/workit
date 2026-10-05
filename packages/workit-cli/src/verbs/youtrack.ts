// `workit youtrack note|time|meeting` (design §4.2 S16): the YouTrack writes
// that ≤4.x ran as approved external actions, now plain verbs. The host's own
// permission prompt authorizes them like any other shell command; no grant is
// involved (they write to the tracker, not to the repository).
//
//   workit youtrack note <ISSUE> (--markdown <text> | --file <path>) [--minutes <n>] [--date auto|YYYY-MM-DD]
//   workit youtrack time <ISSUE> --minutes <n> [--text <t>] [--date auto|YYYY-MM-DD]
//   workit youtrack meeting <ISSUE> --minutes <n> --text <t> [--date auto|YYYY-MM-DD]
import { readFileSync } from "node:fs";
import path from "node:path";
import { youTrackWorkDateMs } from "@brainervirus/workit-core/src/core/youtrack";
import {
  ISSUE_RE,
  logTimeUpdate,
  postUpdate,
} from "@brainervirus/workit-core/src/core/youtrack-tools";
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
  const root = io.cwd;

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
    const posted = await postUpdate({
      confirmed: true,
      issueId,
      markdown,
      ...(minutes ? { minutes } : {}),
      dateMs,
      workspace_root: root,
    });
    return posted.ok
      ? emit(io, ok(posted.data), (data) => [
          `${data.issueId}: comment posted${data.loggedMinutes ? `, ${data.loggedMinutes} min logged on ${date.data.localDate}` : ""}`,
        ])
      : emit(io, fail("failed", posted.error, { data: posted.data ?? {} }));
  }
  if (!minutes) return usage(io, `${sub} needs --minutes <n>`, USAGE);
  if (sub === "meeting" && !flags.values.text)
    return usage(io, "meeting needs --text <what the meeting was>", USAGE);
  const logged = await logTimeUpdate({
    issueId,
    minutes,
    ...(flags.values.text ? { text: flags.values.text } : {}),
    dateMs,
    workspace_root: root,
  });
  return logged.ok
    ? emit(io, ok(logged.data), () => [
        `${issueId}: ${minutes} min logged on ${date.data.localDate}`,
      ])
    : emit(io, fail("failed", logged.error, { data: logged.data ?? {} }));
}
