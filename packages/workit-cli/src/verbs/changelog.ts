// `workit changelog apply` (design §4.2 S16): the changelog write that used to
// be an approved external action, now a plain local verb. `--preview` shows
// the result without writing.
//
//   workit changelog apply (--entries <JSON> | --normalize-only) [--path CHANGELOG.md] [--preview]
//
// --entries takes `{"Added": ["…"], "Fixed": ["…"]}` or `[{"category", "text"}]`
// (`@file` reads it from a file, `-` from stdin).
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  changelogApply,
  changelogApplyPreview,
} from "@brainervirus/workit-core/src/core/changelog";
import {
  installChangelogDriver,
  mergeChangelogFiles,
} from "@brainervirus/workit-core/src/core/changelog-merge";
import { emit, fail, ok, type Io } from "../output";
import { parseFlags, usage } from "./forge-common";

const MERGE_USAGE = "workit changelog merge <base> <ours> <theirs>";
const DRIVER_USAGE = "workit changelog driver install";
const USAGE =
  "workit changelog apply (--entries <JSON|@file|-> | --normalize-only) [--path CHANGELOG.md] [--preview]";

const readEntries = (raw: string, cwd: string): unknown => {
  const text =
    raw === "-"
      ? readFileSync(0, "utf8")
      : raw.startsWith("@")
        ? readFileSync(path.resolve(cwd, raw.slice(1)), "utf8")
        : raw;
  return JSON.parse(text);
};

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "merge") {
    const [base, ours, theirs, ...extra] = rest;
    if (!base || !ours || !theirs || extra.length > 1)
      return usage(io, "merge takes <base> <ours> <theirs>", MERGE_USAGE);
    try {
      const merged = mergeChangelogFiles({
        base: path.resolve(io.cwd, base),
        ours: path.resolve(io.cwd, ours),
        theirs: path.resolve(io.cwd, theirs),
      });
      if (merged.error) return emit(io, fail("failed", merged.error));
      // Exit 1 is git's "conflict": the markers are already in <ours>.
      if (merged.code !== 0) io.stderr("workit: changelog conflict outside [Unreleased]\n");
      return merged.code;
    } catch (error) {
      return emit(io, fail("failed", error instanceof Error ? error.message : String(error)));
    }
  }
  if (sub === "driver") {
    if (rest[0] !== "install" || rest.length > 1)
      return usage(io, "driver takes install", DRIVER_USAGE);
    const installed = installChangelogDriver(io.cwd);
    if ("error" in installed) return emit(io, fail("failed", installed.error));
    return emit(io, ok(installed), (data) => [
      data.changed.length
        ? `changelog merge driver installed (${data.changed.join(", ")})`
        : "changelog merge driver already installed",
    ]);
  }
  if (sub !== "apply") return usage(io, `unknown subcommand "${sub ?? ""}"`, USAGE);
  const flags = parseFlags(rest, {
    entries: "value",
    path: "value",
    "normalize-only": "boolean",
    preview: "boolean",
  });
  if (typeof flags === "string") return usage(io, flags, USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, USAGE);
  const normalizeOnly = flags.booleans.has("normalize-only");
  if (!normalizeOnly && !flags.values.entries)
    return usage(io, "pass --entries <JSON> or --normalize-only", USAGE);
  let entries: unknown;
  if (flags.values.entries)
    try {
      entries = readEntries(flags.values.entries, io.cwd);
    } catch (error) {
      return usage(io, `--entries is not valid JSON: ${String(error)}`, USAGE);
    }
  const input = {
    entries,
    ...(flags.values.path ? { path: flags.values.path } : {}),
    normalize_only: normalizeOnly,
    workspace_root: io.cwd,
  };
  if (flags.booleans.has("preview")) {
    const preview = changelogApplyPreview(input);
    if (preview.error) return emit(io, fail("invalid_input", String(preview.error)));
    const { after, ...summary } = preview;
    return emit(io, ok({ ...summary, after }), () => [String(after)]);
  }
  const applied = changelogApply(input);
  if (applied.error) return emit(io, fail("failed", String(applied.error)));
  return emit(io, ok(applied), () => [
    `changelog updated: ${String(applied.path ?? "CHANGELOG.md")}`,
  ]);
}
