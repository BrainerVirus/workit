// Raw `ytrack` writes (#780): a comment, work item, issue change or API write
// an agent runs itself would post without the user's yes. The shell hook finds
// each one through raw-git.ts commandLines (chains, pipes, `cd`, env prefixes,
// wrappers, `bash -c`, eval, heredoc-fed shells, substitutions, variables),
// plus `workit check -- …` and package runners (`npx ytrack`), and routes it to
// the `workit youtrack …` call that asks first; one with no such verb needs
// the user's own yes. `youtrack.writes: auto` turns the guard off.
import { resolveRuntimeWorkspaceVcs } from "../core/workspaces";
import type { HookDecision } from "./protocol";
import { commandLines, workitCheckTail } from "./raw-git";
import type { ShellDialect } from "./shell-words";

const name = (word = "") =>
  (word.split(/[\\/]/).at(-1) ?? "").toLowerCase().replace(/\.(?:exe|cmd)$|@.*$/g, "");

const quote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** The value of the first of `flags` in `args` (`--f v`, `--f=v`), or undefined. */
const valueOf = (args: readonly string[], ...flags: string[]): string | undefined => {
  for (const [at, arg] of args.entries())
    for (const flag of flags) {
      if (arg === flag) return args[at + 1];
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
  return undefined;
};

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
    "--json --jq -X --method -f -F --raw-field --input --fields -q --query --author --since --limit"
  ).split(" "),
);

/** `ytrack … --help` (or `-h`) as an option, not a value: it only prints help. */
const asksHelp = (args: readonly string[]): boolean =>
  args.some((arg, at) => /^(?:--help|-h)$/.test(arg) && !VALUE.has(args[at - 1] ?? ""));

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
  note: { "--body": "body", "-b": "body", "--body-file": "file" },
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

type Mapped = { workit: string; gap?: undefined } | { workit: null; gap: string };
const gap = (part: string): Mapped => ({ workit: null, gap: part });

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
    if (/[$`]/.test(value))
      return gap(`the value of \`${flag}\`, which the shell expands when it runs`);
    values[key] = value;
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
  if (issue === undefined || more.length || !/^[A-Z]+-\d+$/.test(issue))
    return gap("the issue, which must be one id like ABC-123");
  if (verb === "note") {
    if ((v.body === undefined) === (v.file === undefined))
      return gap("a comment that needs exactly one of --body or --body-file");
    if (v.file === "-") return gap("text read from standard input");
    if (v.body !== undefined && !v.body.trim()) return gap("an empty --body");
    return {
      workit: `workit youtrack note ${issue} ${
        v.body === undefined ? pair("--file", v.file) : pair("--markdown", v.body)
      }`,
    };
  }
  const minutes = minutesOf(v.duration);
  if (minutes === null)
    return gap(`\`--duration ${v.duration ?? ""}\`, which is no whole number of minutes`);
  if (v.date !== undefined && !/^(?:auto|\d{4}-\d{2}-\d{2})$/.test(v.date))
    return gap(`\`--date ${v.date}\``);
  return {
    workit: [
      `workit youtrack time ${issue} --minutes ${minutes}`,
      v.text === undefined ? "" : pair("--text", v.text),
      v.date === undefined ? "" : pair("--date", v.date),
    ]
      .filter(Boolean)
      .join(" "),
  };
};

const UNCOVERED: Mapped = { workit: null, gap: "" };

/** For one `ytrack` argv (past the binary): null when it does not write, else the call that asks first or the gap. */
const classify = (args: readonly string[]): Mapped | null => {
  if (asksHelp(args)) return null;
  // The words that are no option or option value: the group, its verb, then
  // operands, past global flags such as `--host <h>`, `--debug`, `--no-color`.
  const words = args.filter((arg, at) => !arg.startsWith("-") && !VALUE.has(args[at - 1] ?? ""));
  const group = GROUPS[words[0] ?? ""];
  const verb = words[1] ?? "";
  if (group === "api") {
    const method =
      valueOf(args, "-X", "--method") ??
      args
        .find((a) => /^-X./.test(a))
        ?.slice(2)
        .replace(/^=/, "");
    return (method ? ASKS.test(method) : args.some((a) => BODY.test(a))) ? UNCOVERED : null;
  }
  if (group === "work-item" && /^(?:add|create)$/.test(verb)) return mapWrite("time", args);
  if (group === "work-item") return /^(?:edit|update|delete|rm)$/.test(verb) ? UNCOVERED : null;
  if (group !== "issue") return null;
  if (verb === "comment") return mapWrite("note", args);
  if (verb === "create") return mapWrite("create", args);
  if (verb === "command") return args.includes("--dry-run") ? null : UNCOVERED;
  return /^(?:edit|update|delete|rm)$/.test(verb) ? UNCOVERED : null;
};

type YtrackWrite = Mapped & { command: string };

const SHELLS = /^(?:sh|bash|zsh|dash|ksh|ash|mksh|yash|fish)$/;
/** Nested scripts read this deep; deeper ones that name ytrack are refused. */
const MAX_DEPTH = 4;
/** Scripts already read (the same text, the same writes), so nesting costs one read per level. */
const READ = new Map<string, YtrackWrite[]>();

/** The ytrack writes one command line runs: past a package runner (`npx -y ytrack`, `pnpm dlx ytrack`) or `workit check --`. */
const ytrackArgs = (line: readonly string[], found: YtrackWrite[], depth: number): void => {
  const tail = workitCheckTail(line);
  if (tail)
    return void found.push(
      ...ytrackWrites(
        "script" in tail ? tail.script : tail.argv.map(quote).join(" "),
        "posix",
        depth + 1,
      ),
    );
  // A shell's `-c` script or eval's text is read here too, one level per call,
  // so nesting past commandLines' own depth is judged or refused, never passed.
  const flag = SHELLS.test(name(line[0]))
    ? line.findIndex((word, index) => index > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word))
    : -1;
  const script =
    flag > 0 ? line[flag + 1] : name(line[0]) === "eval" ? line.slice(1).join(" ") : undefined;
  if (script !== undefined) return void found.push(...ytrackWrites(script, "posix", depth + 1));
  let at = 0;
  const runner = name(line[0]);
  if (
    /^(?:npx|bunx|pnpx)$/.test(runner) ||
    (/^(?:p?npm|yarn)$/.test(runner) && /^(?:dlx|exec|x)$/.test(line[1] ?? ""))
  ) {
    at = runner.endsWith("x") ? 1 : 2;
    for (; line[at]?.startsWith("-"); at++) {
      // `npx -c '<script>'` runs a shell string.
      if (/^(?:-c|--call)$/.test(line[at]))
        found.push(...ytrackWrites(line[at + 1] ?? "", "posix", depth + 1));
      if (/^(?:-[pc]|--package|--call)$/.test(line[at])) at++;
    }
  }
  if (name(line[at]) !== "ytrack") return;
  const write = classify(line.slice(at + 1));
  if (write) found.push({ command: line.slice(at).map(quote).join(" "), ...write });
};

/** Every raw ytrack write `command` runs, wrapped or not. Throws when the command cannot be analysed. */
const ytrackWrites = (
  command: string,
  dialect: ShellDialect = "posix",
  depth = 0,
): YtrackWrite[] => {
  const found: YtrackWrite[] = [];
  if (!/ytrack/i.test(command.replace(/['"\\`]/g, ""))) return found;
  if (depth > MAX_DEPTH) throw new Error("ytrack nested too deep");
  const known = READ.get(command);
  if (known) return known;
  for (const line of commandLines(command, dialect)) ytrackArgs(line, found, depth);
  READ.set(command, found);
  if (READ.size > 64) READ.delete(READ.keys().next().value as string);
  return found;
};

const writesMode = (cwd: string): unknown =>
  (resolveRuntimeWorkspaceVcs(cwd)?.youtrack as { writes?: unknown } | undefined)?.writes;

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
    writes = [
      ...new Map(ytrackWrites(command, dialect).map((write) => [write.command, write])).values(),
    ];
  } catch {
    // Unanalysable and naming ytrack: denied unless the user opted out.
    if (writesMode(cwd) === "auto") return null;
    return {
      kind: "deny",
      reason: `Workit could not analyse this command, which names ytrack: run each ytrack call as its own plain command so a YouTrack write can ask the user first (#780).`,
      unblock: null,
    };
  }
  if (!writes.length || writesMode(cwd) === "auto") return null;
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
  return {
    kind: "deny",
    reason: `${why}${run}${user}`,
    unblock: writes[0]?.workit ?? null,
  };
};
