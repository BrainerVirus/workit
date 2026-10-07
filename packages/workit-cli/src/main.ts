// The `workit` entry point (design §2.0, S9a). A deterministic router: parse
// the global flags, look the verb up in verbs/registry.ts, lazily import its
// module and hand it argv + io. `--version` and `help` load nothing else, and
// only `init`/`uninstall` ever load ink/react (through index.tsx).
import path from "node:path";
import pkg from "../package.json" with { type: "json" };
import {
  firstWord,
  helpAsValue,
  takesPositionals,
  subcommandHelp,
  usageLines,
  verbHelp,
  wantsHelp,
  type HelpDoc,
} from "./help";
import { emit, fail, ok, type EnvelopeCode, type Io } from "./output";
import {
  TASK_FAMILY_NAMES,
  VERBS,
  findSubcommand,
  findVerb,
  type VerbEntry,
  type VerbGroup,
} from "./verbs/registry";

const GROUP_TITLES: Record<VerbGroup, string> = {
  setup: "Setup",
  task: "Task control",
  delivery: "Delivery",
};

const FAMILIES: readonly string[] = TASK_FAMILY_NAMES;

// One row per verb: its usage line, then its summary. The eight task families
// share one row (they share one grammar).
function helpText(): string {
  const row = (usage: string, summary: string) => `  ${usage}\n      ${summary}`;
  const sections = (Object.keys(GROUP_TITLES) as VerbGroup[]).flatMap((group) => {
    const entries = listed().filter((entry) => entry.group === group);
    if (entries.length === 0) return [];
    const rows = entries
      .filter((entry) => !FAMILIES.includes(entry.name))
      .map((entry) => row(entry.usage, entry.summary));
    if (entries.some((entry) => FAMILIES.includes(entry.name)))
      rows.unshift(
        row(
          "workit <family> <action> [options]",
          `Inspect and control a Workit task; <family>: ${FAMILIES.join(", ")}`,
        ),
      );
    return `${GROUP_TITLES[group]}:\n${rows.join("\n")}`;
  });
  return `workit ${pkg.version} — workflow rails for agentic coding

Usage: workit <command> [args] [--json] [--cwd <dir>]

${sections.join("\n\n")}

Global flags:
  --json             Machine-readable output: {"ok","code","data","error"?,"unblock"?}
  --cwd <dir>        Run as if started in <dir>
  --version          Print the CLI version
  -h, --help         Show usage for the command and subcommand before it (runs nothing)
  help <cmd> [<sub>] The same, as a command

Exit codes: 0 ok · 1 failed · 2 usage · 3 blocked · 4 busy/pending · 5 unavailable

Run \`npx @brainervirus/workit-cli init\` to configure platforms, YouTrack, VCS and project hygiene.
`;
}

type Parsed = { json: boolean; cwd: string | null; rest: string[]; error?: string };

/**
 * Pull the global flags out of argv, in any position before a bare `--`
 * (everything after it belongs to the verb untouched). `--cwd <dir>` is
 * consumed. `--json` before the command is consumed so the command is always
 * the first token; after the command it stays in the verb's argv too, because
 * existing verbs parse it themselves (main re-adds it for `--json <verb>`).
 */
export function parseGlobals(argv: readonly string[]): Parsed {
  const rest: string[] = [];
  let json = false;
  let cwd: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      rest.push(...argv.slice(index));
      break;
    }
    if (arg === "--json") {
      json = true;
      if (rest.length === 0) continue;
    }
    if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const value = arg === "--cwd" ? argv[++index] : arg.slice("--cwd=".length);
      if (!value || value.startsWith("--"))
        return { json, cwd, rest, error: "--cwd requires a directory" };
      cwd = value;
      continue;
    }
    rest.push(arg);
  }
  return { json, cwd, rest };
}

const defaultIo = (json: boolean): Io => ({
  json,
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});

/** Route one command line. Returns the process exit code. */
export async function main(
  argv: readonly string[],
  overrides: Partial<Io> = {},
  options: { diagnostics?: boolean } = {},
): Promise<number> {
  const parsed = parseGlobals(argv);
  const cwd = path.resolve(overrides.cwd ?? process.cwd(), parsed.cwd ?? ".");
  const io: Io = { ...defaultIo(parsed.json), ...overrides, json: parsed.json, cwd };
  if (parsed.error) return emit(io, fail("invalid_input", parsed.error));
  const [command, ...verbArgs] = parsed.rest;
  // `workit --json doctor` reaches the verb as `doctor --json` (before any `--`).
  const args = parsed.json && !verbArgs.includes("--json") ? withJsonFlag(verbArgs) : verbArgs;

  if (command === "--version" || command === "-v" || command === "version") {
    return emit(io, ok({ version: pkg.version }), (data) => data.version);
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    const [topic, sub] = command === "help" ? words(args) : [];
    if (topic) {
      const entry = findVerb(topic);
      if (!entry) return unknown(io, topic);
      if (sub === undefined) return help(io, verbHelp(entry));
      const found = findSubcommand(entry, sub);
      if (!found)
        return emit(
          io,
          fail("invalid_input", `unknown ${topic} subcommand "${sub}"`, {
            unblock: `workit help ${topic}`,
          }),
        );
      return help(io, subcommandHelp(entry, found));
    }
    return emit(io, ok({ version: pkg.version, verbs: listed().map(describe) }), () => helpText());
  }

  const entry = findVerb(command);
  if (!entry) return unknown(io, command);
  // `-h`/`--help` anywhere before a bare `--` answers before the verb loads,
  // so no verb can act on it (or take it as a value).
  if (wantsHelp(verbArgs)) {
    const word = firstWord(verbArgs);
    const sub = word === undefined ? undefined : findSubcommand(entry, word);
    const asValue = helpAsValue(verbArgs, sub ? [sub.usage] : usageLines(entry));
    if (asValue)
      return emit(
        io,
        fail("invalid_input", asValue, {
          unblock: `workit help ${entry.name}${sub ? ` ${sub.name}` : ""}`,
        }),
      );
    return help(io, sub ? subcommandHelp(entry, sub) : verbHelp(entry));
  }
  const ended = endOfOptions(io, entry, args);
  if (typeof ended === "number") return ended;
  if (parsed.cwd !== null) {
    try {
      // Existing verbs resolve from process.cwd(); keep them in step with io.cwd.
      process.chdir(io.cwd);
    } catch {
      return emit(io, fail("invalid_input", `--cwd: cannot enter ${io.cwd}`));
    }
    // An explicit --cwd beats an inherited workspace root (task.ts and the
    // core read WORKFLOW_WORKSPACE_ROOT before process.cwd()).
    if (process.env.WORKFLOW_WORKSPACE_ROOT !== undefined) {
      process.env.WORKFLOW_WORKSPACE_ROOT = io.cwd;
      io.env = process.env;
    }
  }
  if (options.diagnostics) (await import("./diagnostics")).installDiagnostics(command);
  // A 2.x store migrates on first use; say so once, on stderr (see
  // workit-core store/notes.ts; a global slot keeps core off this path).
  (globalThis as Record<symbol, unknown>)[Symbol.for("workit.migrationReporter")] = (report: {
    from: string;
    to: string;
    backup: string;
    tasks: number;
  }) =>
    io.stderr(
      `workit: migrated ${report.tasks} task${report.tasks === 1 ? "" : "s"} from ${report.from} to ${report.to} (backup: ${report.backup})\n`,
    );
  const verb = await entry.load();
  if (!io.json) return verb.run(ended, io);
  return runJsonPure(io, command, (pure) => verb.run(ended, pure));
}

const CODE_FOR_EXIT: Record<number, Exclude<EnvelopeCode, "ok">> = {
  1: "failed",
  2: "invalid_input",
  3: "blocked",
  4: "busy",
  5: "unavailable",
};

const parsesAsJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Under --json, stdout carries exactly one JSON document. Verbs that predate
 * the envelope may still print plain text on some paths (usage lines,
 * confirmations). Their stdout is buffered: a JSON document passes through
 * unchanged, anything else moves to stderr and is replaced by an envelope
 * that keeps the verb's exit code.
 */
async function runJsonPure(
  io: Io,
  command: string,
  run: (io: Io) => Promise<number>,
): Promise<number> {
  let buffered = "";
  const capture = (chunk: string | Uint8Array): void => {
    buffered += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
  };
  // Shadow the stream's write with an own property, then restore exactly what
  // was there (usually nothing: write lives on the prototype).
  const stream = process.stdout;
  const own = Object.getOwnPropertyDescriptor(stream, "write");
  Object.defineProperty(stream, "write", {
    configurable: true,
    writable: true,
    value: (chunk: string | Uint8Array, ...rest: unknown[]) => {
      capture(chunk);
      const done = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
      done?.();
      return true;
    },
  });
  let code: number;
  try {
    code = await run({ ...io, stdout: capture });
  } finally {
    if (own) Object.defineProperty(stream, "write", own);
    else delete (stream as { write?: unknown }).write;
  }
  const text = buffered.trim();
  if (text && parsesAsJson(text)) {
    io.stdout(buffered);
    return code;
  }
  if (text) io.stderr(buffered.endsWith("\n") ? buffered : `${buffered}\n`);
  const envelope =
    code === 0
      ? ok(text ? { text } : {})
      : fail(
          CODE_FOR_EXIT[code] ?? "failed",
          text.split("\n")[0] || `${command} exited with ${code}`,
        );
  io.stdout(`${JSON.stringify(envelope)}\n`);
  return code;
}

const withJsonFlag = (args: string[]): string[] => {
  const end = args.indexOf("--");
  return end < 0 ? [...args, "--json"] : [...args.slice(0, end), "--json", ...args.slice(end)];
};

// Planned verbs answer `not_implemented`; help does not advertise them.
const listed = (): VerbEntry[] => VERBS.filter((entry) => !entry.planned);

/**
 * A bare `--` ends the options of every verb. A verb or subcommand whose usage
 * takes no positional arguments refuses anything after it (exit 2, before it
 * runs) and never sees a trailing `--`; the others parse it themselves. A
 * subcommand verb given only `--` is missing its subcommand.
 */
function endOfOptions(io: Io, entry: VerbEntry, args: string[]): string[] | number {
  const end = args.indexOf("--");
  if (end < 0) return args;
  const word = firstWord(args);
  const sub = word === undefined ? undefined : findSubcommand(entry, word);
  const unblock = `workit help ${entry.name}${sub ? ` ${sub.name}` : ""}`;
  if (entry.subcommands?.length && !sub) {
    if (entry.optionalSubcommand || word !== undefined) return args;
    return emit(io, fail("invalid_input", `missing ${entry.name} subcommand`, { unblock }));
  }
  if (takesPositionals(sub ? [sub.usage] : [entry.usage])) return args;
  const extra = args.slice(end + 1);
  if (extra.length)
    return emit(
      io,
      fail(
        "invalid_input",
        `${entry.name}${sub ? ` ${sub.name}` : ""} takes no positional arguments (got: ${extra.join(" ")})`,
        { unblock },
      ),
    );
  return args.slice(0, end);
}

/** The positional words of `help <verb> [<sub>]`. */
const words = (args: readonly string[]): string[] => args.filter((arg) => !arg.startsWith("-"));

const help = (io: Io, doc: HelpDoc): number => emit(io, ok(doc), (data) => data.text);

const describe = (entry: VerbEntry) => ({
  name: entry.name,
  group: entry.group,
  usage: entry.usage,
  usages: usageLines(entry),
  summary: entry.summary,
  ...(entry.planned ? { planned: entry.planned } : {}),
});

const unknown = (io: Io, command: string): number =>
  emit(io, fail("invalid_input", `unknown command "${command}"`, { unblock: "workit help" }));

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), {}, { diagnostics: true }));
}
