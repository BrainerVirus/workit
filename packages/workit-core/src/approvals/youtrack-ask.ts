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
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "../core/task-contract";
import { shownText } from "./store";

/** Each write verb's value flags; `attach` may repeat. */
const TIME = "markdown file minutes text date";
const FLAGS: Record<string, string> = {
  note: TIME,
  time: TIME,
  meeting: TIME,
  update: `${TIME} attach state command`,
  create: "project summary description file attach command",
};

export const isYouTrackWriteVerb = (word: string | undefined): boolean =>
  Object.hasOwn(FLAGS, word ?? "");

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** What the host shows and binds for one `workit youtrack <verb> …` call. */
export type YouTrackAsk = {
  kind: "youtrack-write";
  /** The call as the person reads it: `workit youtrack note ABC-1`. */
  action: string;
  /** The prompt: what posts, in full (long texts end with "N more lines"). */
  text: string;
  argvHash: string;
  contentHash: string;
};

/**
 * The ask for `args` (the words past `youtrack`: the verb, then its
 * arguments), run in `cwd`; null when it is no write or the verb would refuse
 * it before writing (an unknown flag, a missing issue, an unreadable file).
 */
export const youTrackAsk = (args: readonly string[], cwd: string): YouTrackAsk | null => {
  const [verb = "", ...rest] = args;
  if (!isYouTrackWriteVerb(verb)) return null;
  const known = FLAGS[verb]?.split(" ") ?? [];
  const values: Record<string, string> = {};
  const attach: string[] = [];
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (arg === "--") {
      positionals.push(...rest.slice(index + 1));
      break;
    }
    if (arg === "--json") continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const value = eq >= 0 ? arg.slice(eq + 1) : rest[++index];
    if (!known.includes(name) || !value || (eq < 0 && value.startsWith("--"))) return null;
    if (name === "attach") attach.push(value);
    else values[name] = value;
  }
  const files: [string, string][] = [];
  const read = (file: string): Buffer | null => {
    try {
      const full = realpathSync(path.resolve(cwd, file));
      const content = readFileSync(full);
      files.push([full, sha256(content)]);
      return content;
    } catch {
      return null;
    }
  };
  const fromFile = values.file === undefined ? undefined : read(values.file);
  if (fromFile === null) return null;
  const lines: string[] = [];
  const text = fromFile?.toString("utf8") ?? values.markdown ?? values.description;
  const [target, extra] = positionals;
  let action = `workit youtrack ${verb} ${target}`;
  if (verb === "create") {
    if (!values.project || !values.summary?.trim() || target !== undefined) return null;
    action = `workit youtrack create --project ${values.project}`;
    lines.push(`new issue in ${values.project}: ${values.summary.trim()}`);
    if (text !== undefined) lines.push("description:", ...shownText(text));
  } else {
    if (!target || !/^[A-Z][A-Z0-9_]*-\d+$/u.test(target) || extra !== undefined) return null;
    if (text !== undefined) lines.push(`comment on ${target}:`, ...shownText(text));
    if (values.minutes)
      lines.push(
        `time on ${target}: ${values.minutes} minutes on ${values.date && values.date !== "auto" ? values.date : "today"}${values.text === undefined ? "" : ` ("${values.text}")`}`,
      );
    if (values.state) lines.push(`state: ${values.state}`);
  }
  if (values.command) lines.push(`command: ${values.command}`);
  for (const file of attach) {
    const content = read(file);
    if (!content) return null;
    lines.push(
      `attach: ${path.basename(file)} (${content.length} bytes, sha256 ${files.at(-1)?.[1].slice(0, 12)})`,
    );
  }
  if (!lines.length) return null;
  return {
    kind: "youtrack-write",
    action,
    text: [`Workit: ${action} posts this to YouTrack once if you say yes:`, ...lines].join("\n"),
    argvHash: sha256(canonicalJson(args)),
    contentHash: sha256(canonicalJson({ args, files })),
  };
};
