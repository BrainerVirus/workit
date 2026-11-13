// Raw `ytrack` writes (#780): a comment, work item, issue change or API write
// an agent runs itself would post without the user's yes. The shell hook finds
// each one through raw-git.ts commandLines (chains, pipes, `cd`, env prefixes,
// wrappers, `bash -c`, eval, heredoc-fed shells, substitutions, variables),
// plus `workit check -- …` and package runners (`npx ytrack`), and routes it to
// the `workit youtrack …` call that asks first; one with no such verb needs
// the user's own yes. `youtrack.writes: auto` turns the guard off, unless the
// grant seal is broken (#819, autonomy.ts youTrackWritesMode).
import { youTrackWritesMode } from "../autonomy";
import type { HookDecision } from "./protocol";
import { commandLines, workitCheckTail } from "./raw-git";
import { segmentsOf, type ShellDialect } from "./shell-words";
import { namesYtrack } from "./ytrack-word";

const name = (word = "") =>
  (word.split(/[\\/]/).at(-1) ?? "").toLowerCase().replace(/\.(?:exe|cmd)$|@.*$/g, "");

const quote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** ytrack's `--duration` in whole minutes (`90`, `1h30m`, `1.5h`, `2 hours 15 minutes`), or null. */
const minutesOf = (text = ""): number | null => {
  if (/^\d+$/.test(text.trim())) return Number(text) > 0 ? Number(text) : null;
  let total = 0;
  const rest = text.replace(
    /(\d+(?:\.\d+)?)\s*(h|hours?|m|mins?|minutes?)(?![a-z])/gi,
    (_, n, unit) => {
      total += Number(n) * (/^h/i.test(unit) ? 60 : 1);
      return "";
    },
  );
  return rest.trim() || !Number.isInteger(total) || total <= 0 ? null : total;
};

/**
 * Options that take the next word as their value, across the ytrack commands
 * the ytrack skill documents (`issue`, `work-item`, `api`, the global `--host`),
 * so a `--help` that is a value (`--body --help`) is not read as the help flag.
 */
const VALUE = new Set(
  (
    "--host --body -b --body-file --text --date --duration --type --project -p --summary -s " +
    "--description --description-file --field --tag --add-tag --remove-tag --assignee --comment " +
    "--json --jq -X --method -f -F --raw-field --input --fields -q --query --author --since --limit " +
    "--attach -H --header"
  ).split(" "),
);

/** Flags known to take no value (ytrack skill and ytrack's own `--help`). */
const BARE = new Set(
  "--debug --no-color --paginate --include --dry-run --silent --yes --meeting --help -h".split(" "),
);
/**
 * Whether the word at `at` stands alone, so it is no option's value: no `--`
 * before it, and the word before it is no option, a `--flag=value`, or a flag
 * known to take no value. After any other option it may be that option's value.
 */
const standsAlone = (args: readonly string[], at: number): boolean => {
  const before = args[at - 1] ?? "";
  const end = args.indexOf("--");
  return (
    (end < 0 || at < end) && (!before.startsWith("-") || before.includes("=") || BARE.has(before))
  );
};
/** A clearing word (`--help`, `--dry-run`) present and standing alone. */
const flagged = (args: readonly string[], flag: RegExp): boolean =>
  args.some((arg, at) => flag.test(arg) && standsAlone(args, at));
/** `ytrack … --help` (or `-h`) standing alone: it only prints help. */
const asksHelp = (args: readonly string[]): boolean => flagged(args, /^(?:--help|-h)$/);

/**
 * ytrack's command groups Workit judges, with their aliases. The repo's own
 * ytrack surface (core/youtrack-backend.ts, the bench's fake ytrack in
 * scripts/eval/scaffold.ts, docs/guides/youtrack.md) names `issue`, `work-item`
 * and `api`; `workitem` is the alias ytrack's `work-item --help` lists.
 */
const GROUPS: Record<string, string> = {
  issue: "issue",
  "work-item": "work-item",
  workitem: "work-item",
  api: "api",
};

const ASKS = /^(?:post|put|patch|delete)$/i;
const BODY = /^(?:-[fF]|--(?:field|raw-field|input))(?:=|$)|^-[fF]./;

/** Options that change only what ytrack prints: a mapped write may carry them. */
const QUIET = /^--(?:debug|no-color|json|jq)$/;

/**
 * The ytrack options each `workit youtrack` verb carries faithfully, by the
 * key it maps them to (ytrack skill: `--body`, `--body-file`, `--duration`,
 * `--text`, `--date`, `-p`/`--project`, `-s`/`--summary`, `--description`,
 * `--description-file`; `-b` is `--body` in ytrack's own `issue comment --help`).
 */
const CARRIES: Record<"note" | "time" | "create", Record<string, string>> = {
  note: { "--body": "body", "-b": "body", "--body-file": "file", "--attach": "attach" },
  time: { "--duration": "duration", "--text": "text", "--date": "date" },
  create: {
    "--project": "project",
    "-p": "project",
    "--summary": "summary",
    "-s": "summary",
    "--description": "description",
    "--description-file": "file",
  },
};

/**
 * What one write does on one issue, so writes on the same issue in one plain
 * chain combine into one `workit youtrack update` call.
 */
type Effect = {
  issue: string;
  markdown?: string;
  file?: string;
  attach?: string[];
  minutes?: number;
  text?: string;
  date?: string;
  command?: string;
};

type Mapped =
  | { workit: string; effect?: Effect; gap?: undefined }
  | { workit: null; effect?: undefined; gap: string };
const gap = (part: string): Mapped => ({ workit: null, gap: part });

const ISSUE = /^[A-Z][A-Z0-9_]*-\d+$/;
/** A word the shell or the reader would change: a variable, a substitution, a glob, a leading `~`. */
const EXPANDS = /[$`*?[\]]|^~/;

/** `State <S>` as --state, any other command as --command. */
const commandFlag = (command: string): string => {
  const state = /^State\s+(\S.*)$/u.exec(command)?.[1];
  return state ? pair("--state", state) : pair("--command", command);
};

/**
 * The call that makes `effect`: `note` or `time` when that is all it is (the
 * verbs agents already know), else one `workit youtrack update`.
 */
const callFor = (effect: Effect): string => {
  const comment = effect.markdown !== undefined || effect.file !== undefined;
  const time = effect.minutes !== undefined;
  const timeFlags = [
    effect.text === undefined ? "" : pair("--text", effect.text),
    effect.date === undefined ? "" : pair("--date", effect.date),
  ];
  const commentFlag =
    effect.markdown !== undefined
      ? pair("--markdown", effect.markdown)
      : effect.file !== undefined
        ? pair("--file", effect.file)
        : "";
  const only = !effect.attach?.length && effect.command === undefined;
  if (only && comment && !time) return `workit youtrack note ${effect.issue} ${commentFlag}`;
  if (only && time && !comment)
    return [`workit youtrack time ${effect.issue} --minutes ${effect.minutes}`, ...timeFlags]
      .filter(Boolean)
      .join(" ");
  return [
    `workit youtrack update ${effect.issue}`,
    commentFlag,
    ...(effect.attach ?? []).map((file) => pair("--attach", file)),
    time ? `--minutes ${effect.minutes}` : "",
    ...(time ? timeFlags : []),
    effect.command === undefined ? "" : commandFlag(effect.command),
  ]
    .filter(Boolean)
    .join(" ");
};

const mapped = (effect: Effect): Mapped => ({ workit: callFor(effect), effect });

/**
 * One effect for several writes on one issue, or null when they cannot be one
 * update: another issue, or a part twice (two comments, two times, two commands).
 */
const combine = (effects: readonly Effect[]): Effect | null => {
  const out: Effect = { issue: effects[0].issue };
  for (const effect of effects) {
    if (effect.issue !== out.issue) return null;
    const comment = effect.markdown !== undefined || effect.file !== undefined;
    if (comment && (out.markdown !== undefined || out.file !== undefined)) return null;
    if (effect.minutes !== undefined && out.minutes !== undefined) return null;
    if (effect.command !== undefined && out.command !== undefined) return null;
    Object.assign(out, {
      ...effect,
      attach: [...(out.attach ?? []), ...(effect.attach ?? [])],
    });
  }
  if (!out.attach?.length) delete out.attach;
  return out;
};

/** `--flag value`, or `--flag=value` for a value starting with `-` (the workit CLI reads that as a flag). */
const pair = (flag: string, value: string) =>
  value.startsWith("-") ? `${flag}=${quote(value)}` : `${flag} ${quote(value)}`;

/**
 * The `workit youtrack note|time|create` call that makes exactly the write
 * `args` (past the binary) makes, or the first part it cannot carry: an option
 * it has no flag for, a value the shell expands at run time, a missing or
 * non-id issue, text read from standard input, a duration in days.
 */
const mapWrite = (verb: keyof typeof CARRIES, args: readonly string[]): Mapped => {
  const values: Record<string, string> = {};
  const attach: string[] = [];
  const operands: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (!arg.startsWith("-") || arg === "-") {
      operands.push(arg);
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const value = eq > 0 ? arg.slice(eq + 1) : VALUE.has(flag) ? args[++at] : undefined;
    if (QUIET.test(flag)) continue;
    const key = CARRIES[verb][flag];
    if (!key || value === undefined || key in values) return gap(`\`${flag}\``);
    if (/[$`]|^~/.test(value) || (key === "attach" && EXPANDS.test(value)))
      return gap(`the value of \`${flag}\`, which the shell expands when it runs`);
    if (key === "attach") attach.push(value);
    else values[key] = value;
  }
  // The group and verb words come first.
  const [issue, ...more] = operands.slice(2);
  const v = values;
  if (verb === "create") {
    if (issue !== undefined) return gap(`the operand \`${issue}\``);
    if (v.project === undefined || v.summary === undefined)
      return gap("a missing --project or --summary");
    if (v.description !== undefined && v.file !== undefined)
      return gap("both --description and --description-file");
    if (v.file === "-") return gap("text read from standard input");
    return {
      workit: [
        "workit youtrack create",
        pair("--project", v.project),
        pair("--summary", v.summary),
        v.description === undefined ? "" : pair("--description", v.description),
        v.file === undefined ? "" : pair("--file", v.file),
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  if (issue === undefined || more.length || !ISSUE.test(issue))
    return gap("the issue, which must be one id like ABC-123");
  if (verb === "note") {
    if ((v.body === undefined) === (v.file === undefined))
      return gap("a comment that needs exactly one of --body or --body-file");
    if (v.file === "-") return gap("text read from standard input");
    if (v.body !== undefined && !v.body.trim()) return gap("an empty --body");
    return mapped({
      issue,
      ...(v.body === undefined ? { file: v.file } : { markdown: v.body }),
      ...(attach.length ? { attach } : {}),
    });
  }
  const minutes = minutesOf(v.duration);
  if (minutes === null)
    return gap(`\`--duration ${v.duration ?? ""}\`, which is no whole number of minutes`);
  if (v.date !== undefined && !/^(?:auto|\d{4}-\d{2}-\d{2})$/.test(v.date))
    return gap(`\`--date ${v.date}\``);
  return mapped({
    issue,
    minutes,
    ...(v.text === undefined ? {} : { text: v.text }),
    ...(v.date === undefined ? {} : { date: v.date }),
  });
};

/**
 * `issue attach <ISSUE> <file>…` and `issue command <ISSUE> '<command>'` as
 * an update, or the part it cannot carry. Only output options may ride along.
 */
const mapIssueWrite = (verb: "attach" | "command", args: readonly string[]): Mapped => {
  const operands: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (!arg.startsWith("-") || arg === "-") {
      operands.push(arg);
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (!QUIET.test(flag)) return gap(`\`${flag}\``);
    if (eq < 0 && VALUE.has(flag)) at++;
  }
  const [issue, ...rest] = operands.slice(2);
  if (issue === undefined || !ISSUE.test(issue))
    return gap("the issue, which must be one id like ABC-123");
  if (verb === "attach") {
    if (!rest.length) return gap("an attach with no file");
    const odd = rest.find((file) => file === "-" || EXPANDS.test(file));
    if (odd !== undefined)
      return gap(`the file \`${odd}\`, which the shell expands or reads from standard input`);
    return mapped({ issue, attach: rest });
  }
  if (rest.length !== 1 || !rest[0].trim())
    return gap("a command that is not one quoted word (`ytrack issue command X-1 'State Done'`)");
  if (/[$`]/.test(rest[0])) return gap("a command the shell expands when it runs");
  return mapped({ issue, command: rest[0].trim() });
};

/**
 * `ytrack api` POST to `/issues/<ISSUE>/comments` (one `text` field) or
 * `/issues/<ISSUE>/attachments` (`-F <name>=@<file>` fields), the hand-built
 * forms of a comment and an upload, as the call that makes them; any other
 * API write is no verb's.
 */
const mapApi = (args: readonly string[], target: string): Mapped | null => {
  const where =
    /^\/?(?:api\/)?issues\/([A-Z][A-Z0-9_]*-\d+)\/(comments|attachments)\/?(?:\?.*)?$/u.exec(
      target,
    );
  if (!where) return null;
  const [, issue, kind] = where;
  const fields: Array<{ typed: boolean; key: string; value: string }> = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (!arg.startsWith("-")) continue;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const glued = /^-[fFX]./.test(arg) && !arg.startsWith("--");
    const flag = glued ? arg.slice(0, 2) : eq > 0 ? arg.slice(0, eq) : arg;
    const value = glued
      ? arg.slice(2)
      : eq > 0
        ? arg.slice(eq + 1)
        : VALUE.has(flag)
          ? args[++at]
          : undefined;
    if (QUIET.test(flag)) continue;
    if (/^(?:-X|--method)$/.test(flag)) {
      if (!/^=?post$/i.test(value ?? "")) return gap(`\`${flag} ${value ?? ""}\``);
      continue;
    }
    if (/^(?:-H|--header)$/.test(flag) && /^(?:content-type|accept)\s*:/i.test(value ?? ""))
      continue;
    if (!/^(?:-f|-F|--field|--raw-field)$/.test(flag) || value === undefined)
      return gap(`\`${flag}\``);
    const split = value.indexOf("=");
    if (split <= 0) return gap(`the field \`${value}\``);
    fields.push({
      typed: flag === "-F" || flag === "--field",
      key: value.slice(0, split),
      value: value.slice(split + 1),
    });
  }
  if (fields.some((field) => /[$`]/.test(field.value)))
    return gap("a field value the shell expands when it runs");
  if (kind === "comments") {
    const [field, ...more] = fields;
    if (!field || more.length || field.key !== "text")
      return gap("a comment body other than one `text` field");
    if (field.typed && field.value.startsWith("@")) {
      const file = field.value.slice(1);
      if (!file || file === "-" || EXPANDS.test(file)) return gap(`the file \`${file}\``);
      return mapped({ issue, file });
    }
    return field.value.trim() ? mapped({ issue, markdown: field.value }) : gap("an empty `text`");
  }
  const files = fields.map((field) =>
    field.typed && field.value.startsWith("@") ? field.value.slice(1) : null,
  );
  if (!files.length || files.some((file) => !file || file === "-" || EXPANDS.test(file)))
    return gap("an upload other than `-F <name>=@<file>` fields");
  return mapped({ issue, attach: files as string[] });
};

const UNCOVERED: Mapped = { workit: null, gap: "" };

/** For one `ytrack` argv (past the binary): null when it does not write, else the call that asks first or the gap. */
const classify = (args: readonly string[]): Mapped | null => {
  if (asksHelp(args)) return null;
  // The words that are no option or option value: the group, its verb, then
  // operands, past global flags such as `--host <h>`, `--debug`, `--no-color`.
  // An option Workit does not know may take the next word or not: read both
  // ways, and the stricter reading (the one that finds a write) wins.
  const lenient = args.filter((arg, at) => !arg.startsWith("-") && !VALUE.has(args[at - 1] ?? ""));
  const strict = args.filter((arg, at) => !arg.startsWith("-") && standsAlone(args, at));
  return judge(args, lenient) ?? judge(args, strict);
};

/** The write `args` makes, read with `words` as its group, verb and operands. */
const judge = (args: readonly string[], words: readonly string[]): Mapped | null => {
  const group = GROUPS[words[0] ?? ""];
  const verb = words[1] ?? "";
  if (group === "api") {
    // A write method anywhere makes it a write; only a read method standing alone clears a body.
    const methods = args.flatMap((arg, at) =>
      /^(?:-X|--method)$/.test(arg)
        ? [{ value: args[at + 1] ?? "", alone: standsAlone(args, at) }]
        : /^(?:-X.|--method=)/.test(arg)
          ? [{ value: arg.replace(/^(?:-X=?|--method=)/, ""), alone: standsAlone(args, at) }]
          : [],
    );
    const posts = methods.length > 0 && methods.every((method) => /^post$/i.test(method.value));
    if (methods.some((method) => ASKS.test(method.value)))
      return (posts ? mapApi(args, words[1] ?? "") : null) ?? UNCOVERED;
    if (methods.some((method) => method.alone)) return null;
    return args.some((a) => BODY.test(a)) ? (mapApi(args, words[1] ?? "") ?? UNCOVERED) : null;
  }
  if (group === "work-item" && /^(?:add|create)$/.test(verb)) return mapWrite("time", args);
  if (group === "work-item") return /^(?:edit|update|delete|rm)$/.test(verb) ? UNCOVERED : null;
  if (group !== "issue") return null;
  if (verb === "comment") return mapWrite("note", args);
  if (verb === "create") return mapWrite("create", args);
  if (verb === "command")
    return flagged(args, /^--dry-run$/) ? null : mapIssueWrite("command", args);
  if (verb === "attach") return mapIssueWrite("attach", args);
  return /^(?:edit|update|delete|rm)$/.test(verb) ? UNCOVERED : null;
};

type YtrackWrite = Mapped & { command: string };

const SHELLS = /^(?:sh|bash|zsh|dash|ksh|ash|mksh|yash|fish)$/;
/** Nested scripts read this deep; deeper ones that name ytrack are refused. */
const MAX_DEPTH = 4;
/** Scripts already read (the same text, the same writes), so nesting costs one read per level. */
const READ = new Map<string, YtrackWrite[]>();

const NOT_PLAIN: Mapped = gap(
  "a ytrack call that is not a plain command of its own (a wrapper, loop, substitution or script around it can change or repeat it)",
);
/** The same write, unmapped: a named call is only for a plain command. */
const ungrant = (write: YtrackWrite): YtrackWrite =>
  write.workit ? { command: write.command, ...NOT_PLAIN } : write;

/**
 * The ytrack writes one command line runs: past a package runner (`npx -y
 * ytrack`, `pnpm dlx ytrack`) or `workit check --`, and in a shell's `-c`
 * script or eval's text. Returns whether the line is a ytrack call or a script
 * the gate reads; a write found while not `plain` is never mapped.
 */
const ytrackArgs = (
  line: readonly string[],
  found: YtrackWrite[],
  depth: number,
  names: ReadonlyMap<string, string[]>,
  plain: boolean,
): boolean => {
  const inner = (script: string) =>
    void found.push(...ytrackWrites(script, "posix", depth + 1, plain));
  const tail = workitCheckTail(line);
  if (tail) {
    inner("script" in tail ? tail.script : tail.argv.map(quote).join(" "));
    return true;
  }
  // Read one level per call, so nesting past commandLines' own depth is judged or refused.
  const flag = SHELLS.test(name(line[0]))
    ? line.findIndex((word, index) => index > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word))
    : -1;
  const script =
    flag > 0 ? line[flag + 1] : name(line[0]) === "eval" ? line.slice(1).join(" ") : undefined;
  if (script !== undefined) {
    inner(script);
    return true;
  }
  let at = 0;
  let called = false;
  const runner = name(line[0]);
  if (
    /^(?:npx|bunx|pnpx)$/.test(runner) ||
    (/^(?:p?npm|yarn)$/.test(runner) && /^(?:dlx|exec|x)$/.test(line[1] ?? ""))
  ) {
    at = runner.endsWith("x") ? 1 : 2;
    for (; line[at]?.startsWith("-"); at++) {
      // `npx -c '<script>'` runs a shell string.
      if (/^(?:-c|--call)$/.test(line[at])) {
        inner(line[at + 1] ?? "");
        called = true;
      }
      if (/^(?:-[pc]|--package|--call)$/.test(line[at])) at++;
    }
  }
  // `$(which ytrack)`, `$(command -v ytrack)`, backticks: the path the shell resolves.
  const resolved = /^(?:\$\(|`)\s*(?:which|command\s+-v|type\s+-[pP])\s+ytrack\s*[)`]$/.test(
    line[at] ?? "",
  );
  const alias = names.get(line[at] ?? "");
  if (name(line[at]) !== "ytrack" && !resolved && !alias) return called;
  const argv = [...(alias ?? []), ...line.slice(at + 1)];
  const write = classify(argv);
  if (write) {
    const one = { command: ["ytrack", ...argv].map(quote).join(" "), ...write };
    found.push(plain ? one : ungrant(one));
  }
  return true;
};

/**
 * Names this command defines to run ytrack, with the words they put before
 * the caller's: `alias yt=ytrack`, `alias yt='ytrack issue'`, and a function
 * whose body runs ytrack (`yt() { ytrack "$@"; }`, `function yt { … }`).
 */
const aliases = (command: string): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  for (const [, alias, a, b, c] of command.matchAll(
    /\balias\s+([\w.-]+)=(?:'([^']*)'|"([^"]*)"|([^\s;&|)]+))/g,
  )) {
    const value = a ?? b ?? c ?? "";
    if (/^(?:\S*\/)?ytrack(?:\s|$)/.test(value)) found.set(alias, value.split(/\s+/).slice(1));
  }
  for (const [, a, b, body] of command.matchAll(
    /(?:\bfunction\s+([\w.-]+)(?:\s*\(\s*\))?|\b([\w.-]+)\s*\(\s*\))\s*\{([^}]*)\}/g,
  ))
    if (/(?:^|[\s;&|])(?:\S*\/)?ytrack\s/.test(body ?? "")) found.set(a ?? b ?? "", []);
  return found;
};

/**
 * Prefix words that run the command after them once, with the same arguments,
 * environment and binary: they change only signals, session, priority,
 * buffering, timing or what is printed (`env` is not one: it edits the environment).
 */
const PASS = /^(?:command|exec|nohup|setsid|time|nice|ionice|stdbuf|chronic|unbuffer|timeout)$/;
/** Words that repeat, define or group commands: a script holding one is not plain. */
const COMPOUND = /^(?:for|select|while|until|repeat|do|done|function|case|foreach|coproc)$/;
/**
 * `words` past pass-through prefixes with their options and numbers, or []
 * (not plain) when anything changes the call's environment or binary: an
 * assignment in front of it, `exec` with an option (`-c` clears the
 * environment, `-a` renames it), `command -p` (a default PATH).
 */
const passed = (words: readonly string[]): string[] => {
  let at = 0;
  for (; at < words.length; at++) {
    const word = words[at];
    if (/^[A-Za-z_]\w*=/.test(word)) return [];
    if (!PASS.test(word)) break;
    if (/^(?:exec|command)$/.test(word) && words[at + 1]?.startsWith("-")) return [];
    while (/^(?:-|\d)/.test(words[at + 1] ?? "")) at++;
  }
  return words.slice(at);
};

/**
 * The command lines of a plain script, or null. Plain: its first command is
 * the ytrack call (or a script the gate enters) behind pass-through prefixes
 * only, with no word the shell expands; nothing runs before it, since even a
 * `cd` or an assignment can change the directory, the environment or the
 * files the call reads. Later commands may only handle output or run
 * unrelated commands; they are read as not plain, so a second write is never
 * named. No group, substitution, loop, function or YTRACK_* assignment.
 */
const plainLines = (
  command: string,
  dialect: ShellDialect,
): { first: string[]; chain: string[][]; later: string[][] } | null => {
  let first: string[] | null = null;
  const chain: string[][] = [];
  const later: string[][] = [];
  // `a || b` runs b only when a fails: such calls are never one update.
  let chaining = !command.includes("||");
  let piped = false;
  for (const segment of segmentsOf(command, dialect)) {
    if (segment.group || segment.unanalyzable || segment.subs?.length) return null;
    if (COMPOUND.test(segment.words[0] ?? "")) return null;
    if (segment.words.some((word) => /^YTRACK_\w*=/.test(word))) return null;
    const names = namesYtrack([...segment.words, ...(segment.stdin ?? [])].join(" "));
    if (first === null) {
      // The first command must be the call: anything before it is not plain.
      if (!names || segment.expands?.length) return null;
      first = passed(segment.words);
      chaining &&= name(first[0]) === "ytrack";
    } else {
      // Plain ytrack calls straight after the first may join it in one update.
      const words = passed(segment.words);
      chaining &&=
        !piped &&
        !segment.expands?.length &&
        !segment.stdin?.length &&
        !segment.inputs?.length &&
        name(words[0]) === "ytrack";
      if (chaining) chain.push(words);
      else if (names) later.push(segment.words);
    }
    piped = segment.pipe === true;
  }
  return first ? { first, chain, later } : null;
};

/**
 * The writes of a plain first call and the plain ytrack calls chained right
 * after it, as one update when they all write the same issue and combine;
 * null when they do not.
 */
const chained = (
  first: readonly YtrackWrite[],
  chain: readonly string[][],
  depth: number,
): YtrackWrite[] | null => {
  if (first.length !== 1 || !first[0].effect || !chain.length) return null;
  const found: YtrackWrite[] = [...first];
  for (const line of chain) ytrackArgs(line, found, depth, new Map(), true);
  const effects = found.flatMap((write) => (write.effect ? [write.effect] : []));
  if (effects.length !== found.length) return null;
  const effect = combine(effects);
  if (!effect) return null;
  return [{ command: found.map((write) => write.command).join(" && "), ...mapped(effect) }];
};

/**
 * Every raw ytrack write `command` runs, wrapped or not. A plain script is
 * read line by line and may be mapped; anything else is read by commandLines
 * and never mapped. Throws when the command cannot be analysed.
 */
const ytrackWrites = (
  command: string,
  dialect: ShellDialect = "posix",
  depth = 0,
  plain = true,
): YtrackWrite[] => {
  if (!namesYtrack(command)) return [];
  if (depth > MAX_DEPTH) throw new Error("ytrack nested too deep");
  const key = `${plain}\0${dialect}\0${command}`;
  const known = READ.get(key);
  if (known) return known;
  let found: YtrackWrite[] = [];
  const lines = plain ? plainLines(command, dialect) : null;
  const none = new Map<string, string[]>();
  const plainFirst = lines ? ytrackArgs(lines.first, found, depth, none, true) : false;
  const joined = lines && plainFirst ? chained(found, lines.chain, depth) : null;
  if (joined) found = joined;
  if (
    !lines ||
    !plainFirst ||
    !(joined ? [] : lines.chain).every((line) => ytrackArgs(line, found, depth, none, false)) ||
    !lines.later.every((line) => ytrackArgs(line, found, depth, none, false))
  ) {
    found = [];
    for (const line of commandLines(command, dialect))
      ytrackArgs(line, found, depth, aliases(command), false);
  }
  READ.set(key, found);
  if (READ.size > 64) READ.delete(READ.keys().next().value as string);
  return found;
};

/**
 * The hook's answer to raw ytrack writes in a shell command, or null: a deny
 * naming each `workit youtrack …` call; for a write no verb covers, an ask on
 * Claude Code (`ask`), else a deny that hands the command to the user.
 */
export const ytrackGate = (
  cwd: string,
  command: string,
  dialect: ShellDialect,
  ask: boolean,
): HookDecision | null => {
  let writes: YtrackWrite[];
  try {
    // A write found twice, or once unmapped, is unmapped.
    const merged = new Map<string, YtrackWrite>();
    for (const write of ytrackWrites(command, dialect)) {
      const seen = merged.get(write.command);
      merged.set(
        write.command,
        !seen || !write.workit ? write : !seen.workit ? seen : ungrant(write),
      );
    }
    writes = [...merged.values()];
  } catch {
    // Unanalysable and naming ytrack: denied unless the user opted out.
    if (youTrackWritesMode(cwd) === "auto") return null;
    return {
      kind: "deny",
      reason: `Workit could not analyse this command, which names ytrack: run each ytrack call as its own plain command so a YouTrack write can ask the user first (#780).`,
      unblock: null,
    };
  }
  if (!writes.length || youTrackWritesMode(cwd) === "auto") return null;
  const calls = writes.flatMap((write) => (write.workit ? [`\`${write.workit}\``] : []));
  const bare = writes
    .filter((write) => !write.workit)
    .map(
      (write) =>
        `\`${write.command}\` (${write.gap ? `Workit cannot carry ${write.gap} into a workit youtrack call` : "no workit youtrack verb covers it"})`,
    );
  if (!calls.length && ask)
    return {
      kind: "ask",
      reason: `${bare.join(", ")} writes to YouTrack: the user decides this call (#780).`,
    };
  const why = `A raw ytrack write posts to YouTrack without the user's yes (#780).`;
  const run = calls.length
    ? ` Run ${calls.join(", then ")} instead: it asks the user first. When it answers approval_needed, run exactly the \`workit approve <id>\` it names, now, with nothing around it (no 2>&1, pipe or echo), so the host asks the user; then rerun the workit call once.`
    : "";
  const user = bare.length
    ? ` For ${bare.join(", ")}, the user decides: ask the user, and if they agree they run it in their own terminal.`
    : "";
  // Deny-only hosts: the named call comes back once the write is its own plain command.
  const rerun = writes.some((write) => write.gap === NOT_PLAIN.gap)
    ? " To get the named workit youtrack call instead, rerun the ytrack call as one plain command, with no wrapper, loop, substitution or script around it."
    : "";
  return {
    kind: "deny",
    reason: `${why}${run}${user}${rerun}`,
    unblock: writes[0]?.workit ?? null,
  };
};
