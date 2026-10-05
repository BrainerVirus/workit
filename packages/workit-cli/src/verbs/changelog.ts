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
import { emit, fail, ok, type Io } from "../output";
import { parseFlags, usage } from "./forge-common";

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
