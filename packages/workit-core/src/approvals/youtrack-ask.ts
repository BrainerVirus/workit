// What a `workit youtrack` write asks on the action itself (#864): the host
// hook (Claude Code PreToolUse, Pi's tool_call) and the verb compute it from
// the same words and files, so the yes the hook records binds to exactly the
// text the person read. No network and no config read: the hook stays cheap.
//
// The words are read like the verb's parseFlags (workit-cli forge-common):
// `--json` is skipped, `--name=value` and `--name value` are one value, `--`
// ends the options. The hashes cover the words themselves and the bytes of
// every file they name, so a parse difference can only change what is shown,
// never what the yes covers.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "../core/task-contract";
import { shownText } from "./store";

export const YOUTRACK_WRITE_VERBS = ["note", "time", "meeting", "update", "create"] as const;
export type YouTrackWriteVerb = (typeof YOUTRACK_WRITE_VERBS)[number];
export const isYouTrackWriteVerb = (word: string | undefined): word is YouTrackWriteVerb =>
  (YOUTRACK_WRITE_VERBS as readonly string[]).includes(word ?? "");

type Spec = Record<string, "value" | "list">;
const TIME: Spec = {
  markdown: "value",
  file: "value",
  minutes: "value",
  text: "value",
  date: "value",
};
const SPECS: Record<YouTrackWriteVerb, Spec> = {
  note: TIME,
  time: TIME,
  meeting: TIME,
  update: { ...TIME, attach: "list", state: "value", command: "value" },
  create: {
    project: "value",
    summary: "value",
    description: "value",
    file: "value",
    attach: "list",
    command: "value",
  },
};

type Parsed = {
  values: Record<string, string>;
  lists: Record<string, string[]>;
  positionals: string[];
};

const parse = (args: readonly string[], spec: Spec): Parsed | null => {
  const parsed: Parsed = { values: {}, lists: {}, positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--json") continue;
    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const kind = spec[name];
    if (!kind) return null;
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++index];
    if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) return null;
    if (kind === "list") (parsed.lists[name] ??= []).push(value);
    else parsed.values[name] = value;
  }
  return parsed;
};

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

type ReadFile = { path: string; name: string; bytes: number; sha256: string; text: string };

const readNamed = (cwd: string, file: string): ReadFile | null => {
  try {
    const full = realpathSync(path.resolve(cwd, file));
    if (!statSync(full).isFile()) return null;
    const content = readFileSync(full);
    return {
      path: full,
      name: path.basename(full),
      bytes: content.length,
      sha256: sha256(content),
      text: content.toString("utf8"),
    };
  } catch {
    return null;
  }
};

const size = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

/** What the host shows and binds for one `workit youtrack <verb> …` call. */
export type YouTrackAsk = {
  kind: "youtrack-write";
  /** The call as the person reads it: `workit youtrack note ABC-1`. */
  action: string;
  /** The prompt body: what posts, in full (long texts end with "N more lines"). */
  lines: string[];
  argvHash: string;
  contentHash: string;
};

/**
 * The ask for `args` (the words past `youtrack`: the verb, then its
 * arguments), run in `cwd`; null when it is no write or the verb would refuse
 * it before writing (an unknown flag, a missing issue, an unreadable file).
 */
export const youTrackAsk = (args: readonly string[], cwd: string): YouTrackAsk | null => {
  const [verb, ...rest] = args;
  if (!isYouTrackWriteVerb(verb)) return null;
  const flags = parse(rest, SPECS[verb]);
  if (!flags) return null;
  const { values } = flags;
  const files: ReadFile[] = [];
  const named = (file: string | undefined): ReadFile | null | undefined => {
    if (file === undefined) return undefined;
    const read = readNamed(cwd, file);
    if (read) files.push(read);
    return read;
  };
  const textFile = named(values.file);
  if (textFile === null) return null;
  const attached = (flags.lists.attach ?? []).map((file) => named(file));
  if (attached.some((file) => file === null)) return null;
  const text = textFile ? textFile.text : (values.markdown ?? values.description);
  const lines: string[] = [];
  let action: string;
  if (verb === "create") {
    if (!values.project || !values.summary?.trim() || flags.positionals.length) return null;
    action = `workit youtrack create --project ${values.project}`;
    lines.push(`new issue in ${values.project}: ${values.summary.trim()}`);
    if (text !== undefined) lines.push("description:", ...shownText(text));
  } else {
    const [issue, extra] = flags.positionals;
    if (!issue || !/^[A-Z][A-Z0-9_]*-\d+$/u.test(issue) || extra !== undefined) return null;
    action = `workit youtrack ${verb} ${issue}`;
    if (text !== undefined) lines.push(`comment on ${issue}:`, ...shownText(text));
    if (values.minutes)
      lines.push(
        `time on ${issue}: ${values.minutes} minutes on ${values.date && values.date !== "auto" ? values.date : "today"}${values.text === undefined ? "" : ` ("${values.text}")`}`,
      );
    if (values.state) lines.push(`state: ${values.state}`);
  }
  if (values.command) lines.push(`command: ${values.command}`);
  for (const file of attached)
    if (file)
      lines.push(`attach: ${file.name} (${size(file.bytes)}, sha256 ${file.sha256.slice(0, 12)})`);
  if (!lines.length) return null;
  return {
    kind: "youtrack-write",
    action,
    lines,
    argvHash: sha256(canonicalJson(args)),
    contentHash: sha256(
      canonicalJson({ args, files: files.map((file) => [file.path, file.sha256]) }),
    ),
  };
};

/** The prompt a host shows for `ask`: no id, nothing to type. */
export const youTrackAskText = (ask: YouTrackAsk): string =>
  [
    `Workit: ${ask.action} writes this to YouTrack. Yes posts it in this call, once; No posts nothing.`,
    ...ask.lines,
  ].join("\n");
