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
  if (/^\d+$/.test(text.trim())) return Number(text);
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

/** For one `ytrack` argv (past the binary): whether it writes, and the `workit youtrack` call that asks first. */
const classify = (args: readonly string[]): { workit: string | null } | null => {
  // Past the global `--host <h>`.
  if (asksHelp(args)) return null;
  const rest = args;
  // The words that are no option or option value: the group, its verb, then
  // operands, past global flags such as `--host <h>`, `--debug`, `--no-color`.
  const words = args.filter((arg, at) => !arg.startsWith("-") && !VALUE.has(args[at - 1] ?? ""));
  const group = GROUPS[words[0] ?? ""];
  const verb = words[1];
  const issue = words[2] ?? "<ISSUE>";
  if (group === "api") {
    const method = valueOf(rest, "-X", "--method") ?? rest.find((a) => /^-X./.test(a))?.slice(2);
    return (method ? ASKS.test(method) : rest.some((a) => BODY.test(a))) ? { workit: null } : null;
  }
  if (group === "work-item" && /^(?:add|create)$/.test(verb ?? "")) {
    const minutes = minutesOf(valueOf(rest, "--duration")) ?? "<minutes>";
    const text = valueOf(rest, "--text");
    const date = valueOf(rest, "--date");
    const meeting = rest.includes("--meeting");
    return {
      workit: [
        `workit youtrack ${meeting ? "meeting" : "time"} ${issue} --minutes ${minutes}`,
        text !== undefined || meeting ? `--text ${quote(text ?? "<what the meeting was>")}` : "",
        date === undefined ? "" : `--date ${quote(date)}`,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  if (group === "work-item" && /^(?:edit|update|delete|rm)$/.test(verb ?? ""))
    return { workit: null };
  if (group !== "issue") return null;
  if (verb === "comment") {
    const body = valueOf(rest, "--body");
    const file = valueOf(rest, "--body-file");
    return {
      workit: `workit youtrack note ${issue} ${
        body !== undefined
          ? `--markdown ${quote(body)}`
          : `--file ${file && file !== "-" ? quote(file) : "<file with the comment>"}`
      }`,
    };
  }
  if (verb === "create") {
    const description = valueOf(rest, "--description", "-d");
    const file = valueOf(rest, "--description-file");
    return {
      workit: [
        `workit youtrack create --project ${quote(valueOf(rest, "--project", "-p") ?? "<P>")}`,
        `--summary ${quote(valueOf(rest, "--summary", "-s") ?? "<summary>")}`,
        description !== undefined ? `--description ${quote(description)}` : "",
        file && file !== "-" ? `--file ${quote(file)}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  if (verb === "command") return rest.includes("--dry-run") ? null : { workit: null };
  return /^(?:edit|update|delete|rm)$/.test(verb ?? "") ? { workit: null } : null;
};

type YtrackWrite = { command: string; workit: string | null };

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
  if (depth > 4 || !/ytrack/i.test(command.replace(/['"\\`]/g, ""))) return found;
  for (const line of commandLines(command, dialect)) ytrackArgs(line, found, depth);
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
    writes = ytrackWrites(command, dialect);
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
  const bare = writes.filter((write) => !write.workit).map((write) => `\`${write.command}\``);
  if (!calls.length && ask)
    return {
      kind: "ask",
      reason: `${bare.join(", ")} writes to YouTrack and no workit youtrack verb covers it: the user decides this call (#780).`,
    };
  const why = `A raw ytrack write posts to YouTrack without the user's yes (#780).`;
  const run = calls.length
    ? ` Run ${calls.join(", then ")} instead: it asks the user first. When it answers approval_needed, run exactly the \`workit approve <id>\` it names, now, with nothing around it (no 2>&1, pipe or echo), so the host asks the user; then rerun the workit call once.`
    : "";
  const user = bare.length
    ? ` No workit youtrack verb covers ${bare.join(", ")}: ask the user, and if they agree they run it in their own terminal.`
    : "";
  return {
    kind: "deny",
    reason: `${why}${run}${user}`,
    unblock: writes[0]?.workit ?? null,
  };
};
