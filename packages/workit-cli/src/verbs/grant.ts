// `workit grant` (design §4.2 S16; D4, D15): show and change the per-workspace
// autonomy grants in ~/.config/workit/workspaces.json.
//
//   workit grant show [<workspace>] [--all] [--json]
//   workit grant set <workspace> <kind>=<true|false|verified> [<kind>=<value>…]
//   workit grant unset <workspace> <kind> [<kind>…]
//
// `defaultEndpoint=commit|pr` sets where an unnamed request stops (skills read
// it); commit → pr is a raise, like any grant.
//
// Raising a grant (anything that lets an agent deliver more) needs the user at
// an interactive terminal who types the workspace name to confirm; a headless
// or agent-run call is refused with the command to hand to the user. Lowering
// is always allowed, so an agent can tighten its own ceiling. Grants are never
// read from a repository file, and no MCP or host tool can set them.
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_GRANTS,
  GRANT_KINDS,
  isGrantKind,
  listGrants,
  raises,
  resolveAutonomy,
  writeGrants,
  type DefaultEndpoint,
  type GrantKind,
  type GrantValue,
  type Grants,
} from "@brainervirus/workit-core/src/autonomy";
import { emit, fail, ok, type Io } from "../output";

const USAGE =
  "workit grant show [<workspace>] [--all] | grant set <workspace> <kind>=<true|false|verified>… [defaultEndpoint=commit|pr] | grant unset <workspace> <kind>…  (kinds: push, pr, merge, release, rerun, defaultEndpoint)";

/** Agent hosts that export a marker into the shells they run (best effort). */
const AGENT_ENV = ["CLAUDECODE", "OPENCODE", "CODEX_SANDBOX", "CURSOR_AGENT", "PI_CODING_AGENT"];

export type GrantDeps = {
  /** True only for a person at a terminal: stdin and stdout are TTYs. */
  interactive: () => boolean;
  /** Ask one question on the terminal and return the typed line. */
  ask: (question: string) => Promise<string>;
};

const defaultDeps: GrantDeps = {
  interactive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  ask: async (question) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await prompt.question(question);
    } finally {
      prompt.close();
    }
  },
};

const parseValue = (raw: string): GrantValue | null =>
  raw === "true" || raw === "yes" || raw === "on"
    ? true
    : raw === "false" || raw === "no" || raw === "off"
      ? false
      : raw === "verified"
        ? "verified"
        : null;

const describe = (
  grants: Grants,
  configured: readonly GrantKind[],
  endpoint: DefaultEndpoint,
): string[] => [
  ...GRANT_KINDS.map(
    (kind) =>
      `  ${kind.padEnd(8)}${String(grants[kind]).padEnd(10)}${configured.includes(kind) ? "configured" : "default"}`,
  ),
  `  default endpoint: ${endpoint} (an unnamed request stops at ${endpoint === "pr" ? "an opened PR" : "a local commit"})`,
];

function show(argv: string[], io: Io): number {
  const all = argv.includes("--all");
  const named = argv.filter((arg) => !arg.startsWith("--"));
  if (named.length > 1) return usage(io, `unexpected argument ${named[1]}`);
  if (all || named.length === 1) {
    const listed = listGrants();
    if (listed.error) return emit(io, fail("invalid_input", listed.error));
    const rows = named.length
      ? listed.workspaces.filter((entry) => entry.name === named[0])
      : listed.workspaces;
    if (named.length && rows.length === 0)
      return emit(io, fail("not_found", `no workspace named "${named[0]}" in ${listed.path}`));
    return emit(io, ok({ path: listed.path, defaults: DEFAULT_GRANTS, workspaces: rows }), () =>
      rows.flatMap((entry) => [
        `${entry.name} (${entry.glob})`,
        ...describe(entry.grants, entry.configured, entry.defaultEndpoint),
      ]),
    );
  }
  let autonomy;
  try {
    autonomy = resolveAutonomy(io.cwd);
  } catch (error) {
    return emit(io, fail("invalid_input", error instanceof Error ? error.message : String(error)));
  }
  return emit(io, ok(autonomy), (data) => [
    data.workspace
      ? `workspace ${data.workspace} (${data.source === "default" ? "D4 defaults" : `from ${data.source}`})`
      : "no workspace matches this checkout: D4 defaults apply",
    ...describe(data.grants, data.configured, data.defaultEndpoint),
    "merge/release beyond these needs the user: workit grant set <workspace> <kind>=<value>",
  ]);
}

async function change(
  verb: "set" | "unset",
  argv: string[],
  io: Io,
  deps: GrantDeps,
): Promise<number> {
  const [workspace, ...specs] = argv.filter((arg) => arg !== "--json");
  if (!workspace || specs.length === 0) return usage(io, `${verb} needs <workspace> and a kind`);
  const listed = listGrants();
  if (listed.error) return emit(io, fail("invalid_input", listed.error));
  const entry = listed.workspaces.find((item) => item.name === workspace);
  if (!entry)
    return emit(io, fail("not_found", `no workspace named "${workspace}" in ${listed.path}`));
  const changes: { kind: GrantKind; value: GrantValue | undefined }[] = [];
  let endpoint: DefaultEndpoint | null | undefined;
  for (const spec of specs) {
    const [kind, raw] = verb === "set" ? spec.split("=", 2) : [spec, undefined];
    if (kind === "defaultEndpoint") {
      if (verb === "unset") endpoint = null;
      else if (raw === "commit" || raw === "pr") endpoint = raw;
      else return usage(io, `${spec}: defaultEndpoint must be commit or pr`);
      continue;
    }
    if (!isGrantKind(kind)) return usage(io, `unknown grant kind "${kind}"`);
    if (verb === "unset") {
      changes.push({ kind, value: undefined });
      continue;
    }
    const value = raw === undefined ? null : parseValue(raw);
    if (value === null) return usage(io, `${spec}: value must be true, false or verified`);
    changes.push({ kind, value });
  }
  const raised: { kind: string; value: string }[] = changes
    .filter(({ kind, value }) => raises(kind, entry.grants[kind], value ?? DEFAULT_GRANTS[kind]))
    .map(({ kind, value }) => ({ kind, value: String(value ?? DEFAULT_GRANTS[kind]) }));
  if (endpoint === "pr" && entry.defaultEndpoint !== "pr")
    raised.push({ kind: "defaultEndpoint", value: "pr" });
  if (raised.length > 0) {
    const command = `workit grant ${verb} ${workspace} ${specs.join(" ")}`;
    const agent = AGENT_ENV.find((name) => io.env[name]);
    if (!deps.interactive() || agent)
      return emit(
        io,
        fail(
          "blocked",
          `grant_raise_refused: raising ${raised.map(({ kind }) => kind).join(", ")} needs the user at an interactive terminal${agent ? ` (this shell belongs to an agent: ${agent} is set)` : ""}; grants are never raised headless`,
          { unblock: `ask the user to run, in their own terminal: ${command}` },
        ),
      );
    const answer = await deps.ask(
      `Raise ${raised.map(({ kind, value }) => `${kind}=${value}`).join(", ")} for workspace "${workspace}"? An agent there may then do this without asking. Type the workspace name to confirm: `,
    );
    if (answer.trim() !== workspace)
      return emit(io, fail("blocked", "grant change not confirmed; nothing was written"));
  }
  const written = writeGrants(workspace, changes, undefined, endpoint);
  if (!written.ok) return emit(io, fail(written.code, written.error));
  return emit(io, ok(written), (data) => [
    `${data.workspace}: grants updated in ${data.path}${data.backup ? ` (previous copy: ${data.backup})` : ""}`,
    ...describe(data.grants, data.configured, data.defaultEndpoint),
  ]);
}

const usage = (io: Io, message: string): number =>
  emit(io, fail("invalid_input", `${message}\nusage: ${USAGE}`));

export async function runGrant(argv: string[], io: Io, deps: GrantDeps = defaultDeps) {
  const [sub, ...rest] = argv;
  if (sub === "show") return show(rest, io);
  if (sub === undefined || (sub.startsWith("--") && sub !== "--help")) return show(argv, io);
  if (sub === "set" || sub === "unset") return change(sub, rest, io, deps);
  if (sub === "--help" || sub === "-h") {
    io.stdout(`usage: ${USAGE}\n`);
    return 0;
  }
  return usage(io, `unknown subcommand "${sub}"`);
}

export const run = (argv: string[], io: Io): Promise<number> => runGrant(argv, io);
