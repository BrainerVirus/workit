// `workit changelog roll` and `workit changelog release <version>`: move
// [Unreleased] entries into the release that shipped them, and cut a release
// from the rest, for a release pipeline (semantic-release, release-please,
// goreleaser). Local only: the file and the repo's tags, no forge, no grant.
//
//   workit changelog roll [--path <file>] [--tag-prefix <p>] [--preview]
//   workit changelog release <x.y.z> [--date <YYYY-MM-DD>] [--notes-out <file|->] [--notes-format markdown|github] [--no-write] [--path <file>] [--tag-prefix <p>]
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  RELEASE_VERSION,
  runChangelogRoll,
  type ChangelogRollRun,
} from "@workit-dev/core/src/core/changelog-roll";
import { emit, fail, ok, type Io } from "../output";
import { parseFlags, usage } from "./forge-common";

const ROLL_USAGE =
  "workit changelog roll [--path CHANGELOG.md] [--tag-prefix <prefix>] [--preview]";
const RELEASE_USAGE =
  "workit changelog release <x.y.z> [--date <YYYY-MM-DD>] [--notes-out <file|->] [--notes-format markdown|github] [--no-write] [--path CHANGELOG.md] [--tag-prefix <prefix>]";

type Done = Extract<ChangelogRollRun, { ok: true }>;

const entriesWord = (n: number): string => `${n} entr${n === 1 ? "y" : "ies"}`;

const movedLines = (run: Done, verb: string): string[] =>
  run.moved.map(
    ({ version, entries }) => `${run.path}: ${verb} ${entriesWord(entries)} -> [${version}]`,
  );

const isDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/** A refusal (exit 1, nothing written) or the missing file, with each named line on stderr. */
function refused(io: Io, run: Extract<ChangelogRollRun, { ok: false }>): number {
  const error = [run.error, ...run.lines].join("\n");
  return emit(
    io,
    fail(run.code === "not_found" ? "not_found" : "failed", error, {
      data: { path: run.path, lines: run.lines },
      ...(run.code === "refused"
        ? { unblock: `delete the named lines from [Unreleased] in ${run.path}, then rerun` }
        : {}),
    }),
  );
}

/** Why nothing moved: the section is missing, or it holds no entry for `verb`. */
const nothingMoved = (run: Done, verb: string): string =>
  run.unreleased
    ? `${run.path}: [Unreleased] is empty; nothing to ${verb}`
    : `${run.path}: no [Unreleased] section; nothing to ${verb}`;

const summary = (run: Done) => ({
  path: run.path,
  tagPrefix: run.tagPrefix,
  tags: run.tags,
  changed: run.changed,
  written: run.written,
  unreleased: run.unreleased,
  moved: run.moved,
  warnings: run.warnings,
});

export function runRoll(argv: string[], io: Io): number {
  const flags = parseFlags(argv, { path: "value", "tag-prefix": "value", preview: "boolean" });
  if (typeof flags === "string") return usage(io, flags, ROLL_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, ROLL_USAGE);
  const preview = flags.booleans.has("preview");
  const run = runChangelogRoll({
    cwd: io.cwd,
    write: !preview,
    ...(flags.values.path ? { path: flags.values.path } : {}),
    ...(flags.values["tag-prefix"] ? { tagPrefix: flags.values["tag-prefix"] } : {}),
  });
  if (!run.ok) return refused(io, run);
  if (!io.json) for (const warning of run.warnings) io.stderr(`workit: warning: ${warning}\n`);
  return emit(io, ok({ ...summary(run), ...(preview ? { after: run.text } : {}) }), () =>
    run.moved.length === 0
      ? [
          run.unreleased
            ? `${run.path}: no [Unreleased] entry has shipped; nothing to roll`
            : nothingMoved(run, "roll"),
        ]
      : [
          ...movedLines(run, preview ? "would move" : "moved"),
          ...(preview ? ["preview: nothing written"] : []),
        ],
  );
}

export function runRelease(argv: string[], io: Io): number {
  const flags = parseFlags(argv, {
    path: "value",
    "tag-prefix": "value",
    date: "value",
    "notes-out": "value",
    "notes-format": "value",
    "no-write": "boolean",
  });
  if (typeof flags === "string") return usage(io, flags, RELEASE_USAGE);
  const [version, ...extra] = flags.positionals;
  if (version === undefined) return usage(io, "release takes <x.y.z>", RELEASE_USAGE);
  if (extra.length) return usage(io, `unexpected argument ${extra[0]}`, RELEASE_USAGE);
  if (!RELEASE_VERSION.test(version))
    return usage(io, `not a release version: ${JSON.stringify(version)} (x.y.z)`, RELEASE_USAGE);
  const date = flags.values.date ?? new Date().toISOString().slice(0, 10);
  if (!isDate(date))
    return usage(io, `not a date: ${JSON.stringify(date)} (YYYY-MM-DD)`, RELEASE_USAGE);
  const notesOut = flags.values["notes-out"];
  if (notesOut === "-" && io.json)
    return usage(
      io,
      "--notes-out - and --json both write stdout; the notes are in data.notes",
      RELEASE_USAGE,
    );
  const format = flags.values["notes-format"] ?? "markdown";
  if (format !== "markdown" && format !== "github")
    return usage(
      io,
      `not a notes format: ${JSON.stringify(format)} (markdown or github)`,
      RELEASE_USAGE,
    );
  const write = !flags.booleans.has("no-write");
  const run = runChangelogRoll({
    cwd: io.cwd,
    write,
    release: { version, date },
    notesFormat: format,
    ...(flags.values.path ? { path: flags.values.path } : {}),
    ...(flags.values["tag-prefix"] ? { tagPrefix: flags.values["tag-prefix"] } : {}),
  });
  if (!run.ok) return refused(io, run);
  if (notesOut !== undefined && notesOut !== "-")
    try {
      writeFileSync(path.resolve(io.cwd, notesOut), run.notes, "utf8");
    } catch (error) {
      return emit(
        io,
        fail("failed", `could not write the notes to ${notesOut}: ${String(error)}`, {
          unblock: `fix --notes-out, then rerun the same command: a rerun writes the same notes and changes ${run.path} no further`,
        }),
      );
    }
  const lines = [
    ...(run.moved.length === 0
      ? [
          run.notes
            ? `${run.path}: [${version}] is already released; nothing to move`
            : nothingMoved(run, "release"),
        ]
      : movedLines(run, write ? "moved" : "would move")),
    ...(write || !run.changed ? [] : ["--no-write: nothing written"]),
    ...(notesOut && notesOut !== "-" ? [`notes: ${notesOut}`] : []),
  ];
  if (io.json) return emit(io, ok({ ...summary(run), version, date, notes: run.notes }));
  // With the notes on stdout, everything else goes to stderr.
  const human = notesOut === "-" ? io.stderr : io.stdout;
  for (const warning of run.warnings) io.stderr(`workit: warning: ${warning}\n`);
  for (const line of lines) human(`${line}\n`);
  if (notesOut === "-") io.stdout(run.notes);
  return 0;
}
