// The `workit` entry point (design §2.0, S9a). A deterministic router: parse
// the global flags, look the verb up in verbs/registry.ts, lazily import its
// module and hand it argv + io. `--version` and `help` load nothing else, and
// only `init`/`uninstall` ever load ink/react (through index.tsx).
import path from "node:path";
import pkg from "../package.json" with { type: "json" };
import { emit, fail, ok, type Io } from "./output";
import {
  TASK_FAMILY_NAMES,
  VERBS,
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
  const sections = (Object.keys(GROUP_TITLES) as VerbGroup[]).map((group) => {
    const entries = VERBS.filter((entry) => entry.group === group);
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
  --json        Machine-readable output: {"ok","code","data","error"?,"unblock"?}
  --cwd <dir>   Run as if started in <dir>
  --version     Print the CLI version
  help <cmd>    Show usage for one command

Exit codes: 0 ok · 1 failed · 2 usage · 3 blocked · 4 busy/pending · 5 unavailable

Run \`npx @brainervirus/workit-cli init\` to configure platforms, YouTrack, VCS and project hygiene.
`;
}

const verbHelp = (entry: VerbEntry): string => `usage: ${entry.usage}\n\n${entry.summary}\n`;

type Parsed = { json: boolean; cwd: string | null; rest: string[]; error?: string };

/**
 * Pull the global flags out of argv. `--json` stays in the verb's argv as
 * well (existing verbs parse it themselves); `--cwd <dir>` is consumed.
 * Everything after a bare `--` belongs to the verb untouched.
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
    if (arg === "--json") json = true;
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
  const [command, ...args] = parsed.rest;

  if (command === "--version" || command === "-v" || command === "version") {
    return emit(io, ok({ version: pkg.version }), (data) => data.version);
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    const topic = command === "help" ? args.find((arg) => !arg.startsWith("-")) : undefined;
    if (topic) {
      const entry = findVerb(topic);
      if (!entry) return unknown(io, topic);
      return emit(io, ok(describe(entry)), () => verbHelp(entry));
    }
    return emit(io, ok({ version: pkg.version, verbs: VERBS.map(describe) }), () => helpText());
  }

  const entry = findVerb(command);
  if (!entry) return unknown(io, command);
  if (parsed.cwd !== null) {
    try {
      // Existing verbs resolve from process.cwd(); keep them in step with io.cwd.
      process.chdir(io.cwd);
    } catch {
      return emit(io, fail("invalid_input", `--cwd: cannot enter ${io.cwd}`));
    }
  }
  if (options.diagnostics) (await import("./diagnostics")).installDiagnostics(command);
  const verb = await entry.load();
  return verb.run(args, io);
}

const describe = (entry: VerbEntry) => ({
  name: entry.name,
  group: entry.group,
  usage: entry.usage,
  summary: entry.summary,
});

const unknown = (io: Io, command: string): number =>
  emit(io, fail("invalid_input", `unknown command "${command}"`, { unblock: "workit help" }));

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), {}, { diagnostics: true }));
}
