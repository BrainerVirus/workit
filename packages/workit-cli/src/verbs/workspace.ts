// `workit workspace` (#444): add or adjust workspaces.json entries without the
// wizard, keeping every hand-set field of the entries it does not touch.
//
//   workit workspace list
//   workit workspace add <name> --glob <g> [--from <parent>]
//   workit workspace set <name> <key>=<value>…
//   workit workspace rm <name>
//
// These verbs never raise authority, so an agent shell may run them. Grants,
// defaultEndpoint and verification stay with `workit grant set` at the user's
// own terminal (verbs/grant.ts):
// - `add` never copies them; `--from` copies vcs, issues, branchPolicy,
//   commitPolicy, trailers, youtrack and models only. A new entry nested in
//   another starts at the defaults clamped to the entry it shadows, so the
//   directories it takes over never get more than they had.
// - `set` refuses the grant keys and the keys that decide where grants apply
//   (name, glob).
// - `rm` refuses when the entry that would take over its directories grants
//   more than the removed one did.
// Every write keeps the previous file as workspaces.json.bak, like grant set.
import { copyFileSync, existsSync } from "node:fs";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_GRANTS,
  DEFAULT_VERIFICATION,
  GRANT_KINDS,
  configuredGrants,
  isDefaultEndpoint,
  raises,
  raisesEndpoint,
  verificationOf,
  type DefaultEndpoint,
  type Grants,
  type VerificationMode,
} from "@brainervirus/workit-core/src/autonomy";
import { writeFileAtomic } from "@brainervirus/workit-core/src/core/safe-write";
import {
  WorkspaceConfigError,
  enclosingEntries,
  globSpecificity,
  readWorkspacesResult,
  resolveWorkspaceFromEntries,
  validateWorkspaceGlob,
  validateWorkspacesDocument,
  workspaceMatches,
  type WorkspacesResult,
} from "@brainervirus/workit-core/src/core/workspaces";
import { emit, fail, ok, type Io } from "../output";

const USAGE =
  "workit workspace list | workspace add <name> --glob <g> [--from <parent>] | workspace set <name> <key>=<value>… | workspace rm <name>";

/** What `--from` copies: never a grant, the endpoint or verification. */
export const INHERITED_KEYS = [
  "vcs",
  "issues",
  "branchPolicy",
  "commitPolicy",
  "trailers",
  "youtrack",
  "models",
] as const;

/** Keys only `workit grant set` changes, at the user's own terminal. */
const GRANT_KEYS = new Set(["autonomy", "autoApprove", "defaultEndpoint", "verification"]);
/** Keys that decide where an entry's grants apply. */
const SCOPE_KEYS = new Set(["name", "glob"]);

type Entry = Record<string, unknown> & { name: string; glob: string };

/** What an entry lets an agent deliver: grants, the default endpoint, verification. */
type Ceiling = {
  grants: Grants;
  endpoint: DefaultEndpoint;
  verification: VerificationMode;
};

const DEFAULT_CEILING: Ceiling = {
  grants: { ...DEFAULT_GRANTS },
  endpoint: DEFAULT_ENDPOINT,
  verification: DEFAULT_VERIFICATION,
};

const ceilingOf = (entry: unknown): Ceiling => ({
  grants: { ...DEFAULT_GRANTS, ...configuredGrants(entry).grants },
  endpoint: isDefaultEndpoint((entry as { defaultEndpoint?: unknown } | null)?.defaultEndpoint)
    ? (entry as { defaultEndpoint: DefaultEndpoint }).defaultEndpoint
    : DEFAULT_ENDPOINT,
  verification: verificationOf(entry),
});

const STRICTNESS: readonly VerificationMode[] = ["independent", "self", "proportional"];
const looser = (current: VerificationMode, next: VerificationMode): boolean =>
  STRICTNESS.indexOf(next) > STRICTNESS.indexOf(current);

/** What `next` grants beyond `current`, by name; empty when it never raises. */
export const ceilingRaises = (current: Ceiling, next: Ceiling): string[] => [
  ...GRANT_KINDS.filter((kind) => raises(kind, current.grants[kind], next.grants[kind])),
  ...(raisesEndpoint(current.endpoint, next.endpoint) ? ["defaultEndpoint"] : []),
  ...(looser(current.verification, next.verification) ? ["verification"] : []),
];

/** The lowest of the shadowed entries' ceilings (a tie selects none: take the strictest). */
const shadowedCeiling = (shadowed: readonly Entry[]): Ceiling | null => {
  if (shadowed.length === 0) return null;
  const ceilings = shadowed.map(ceilingOf);
  const grants = { ...DEFAULT_GRANTS };
  for (const kind of GRANT_KINDS)
    grants[kind] = ceilings
      .map((ceiling) => ceiling.grants[kind])
      .reduce((low, value) => (raises(kind, value, low) ? value : low));
  return {
    grants,
    endpoint: ceilings
      .map((ceiling) => ceiling.endpoint)
      .reduce((low, value) => (raisesEndpoint(value, low) ? value : low)),
    verification: ceilings
      .map((ceiling) => ceiling.verification)
      .reduce((strict, value) => (looser(value, strict) ? value : strict)),
  };
};

/**
 * The grant fields a new entry needs so it never exceeds the entries it
 * shadows: the defaults, lowered where the shadowed ceiling is lower. Only
 * ever lowers (each value is at most the default), so it needs no terminal.
 */
const clampToShadowed = (shadowed: Ceiling | null): Record<string, unknown> => {
  if (!shadowed) return {};
  const autonomy = Object.fromEntries(
    GRANT_KINDS.filter((kind) => raises(kind, shadowed.grants[kind], DEFAULT_GRANTS[kind])).map(
      (kind) => [kind, shadowed.grants[kind]],
    ),
  );
  return {
    ...(Object.keys(autonomy).length ? { autonomy } : {}),
    ...(looser(shadowed.verification, DEFAULT_VERIFICATION)
      ? { verification: shadowed.verification }
      : {}),
  };
};

const usage = (io: Io, message: string): number =>
  emit(io, fail("invalid_input", `${message}\nusage: ${USAGE}`));

const load = (io: Io): WorkspacesResult | number => {
  const current = readWorkspacesResult();
  if (current.status === "malformed" || current.status === "invalid")
    return emit(io, fail("invalid_input", current.error ?? `${current.path} is invalid`));
  return current;
};

const entriesOf = (current: WorkspacesResult): Entry[] => current.entries;

/** Validate, re-read for a concurrent edit, back up and write atomically. */
const save = (
  current: WorkspacesResult,
  entries: Entry[],
): { ok: true; path: string; backup: string | null } | { ok: false; error: string } => {
  const document = { ...current.document, workspaces: entries };
  const validated = validateWorkspacesDocument(document, current.path);
  if (validated.status !== "valid")
    return { ok: false, error: validated.error ?? "invalid workspaces.json" };
  const latest = readWorkspacesResult();
  if (latest.revision !== current.revision)
    return { ok: false, error: `${current.path} changed; retry` };
  let backup: string | null = null;
  try {
    if (existsSync(current.path)) {
      backup = `${current.path}.bak`;
      copyFileSync(current.path, backup);
    }
    writeFileAtomic(current.path, `${JSON.stringify(document, null, 2)}\n`);
  } catch (error) {
    return {
      ok: false,
      error: `failed to write ${current.path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, path: current.path, backup };
};

const written = (path: string, backup: string | null) =>
  `${path}${backup ? ` (previous copy: ${backup})` : ""}`;

function list(argv: string[], io: Io): number {
  if (argv.length) return usage(io, `unexpected argument ${argv[0]}`);
  const current = load(io);
  if (typeof current === "number") return current;
  const entries = entriesOf(current);
  const matches = workspaceMatches(io.cwd, entries);
  let effective: string | null = null;
  let reason: string;
  try {
    effective = resolveWorkspaceFromEntries(io.cwd, entries)?.name ?? null;
    reason =
      matches.length === 0
        ? "no glob matches this directory: the defaults apply"
        : matches.length === 1
          ? "the only glob that matches"
          : `the most specific of ${matches.length} matching globs (${matches.map((entry) => `${entry.name}: ${globSpecificity(entry.glob)} literal segments`).join(", ")})`;
  } catch (error) {
    reason = error instanceof WorkspaceConfigError ? error.message : String(error);
  }
  const rows = entries.map((entry) => ({
    name: entry.name,
    glob: entry.glob,
    keys: Object.keys(entry).filter((key) => key !== "name" && key !== "glob"),
  }));
  return emit(
    io,
    ok({
      path: current.path,
      workspaces: rows,
      cwd: io.cwd,
      effective,
      matches: matches.map((entry) => entry.name),
      reason,
    }),
    (data) => [
      ...(data.workspaces.length ? [] : [`no workspaces in ${data.path}`]),
      ...data.workspaces.map(
        (row) =>
          `${row.name === data.effective ? "*" : " "} ${row.name} (${row.glob})${row.keys.length ? `: ${row.keys.join(", ")}` : ""}`,
      ),
      `${data.cwd}: ${data.effective ? `workspace ${data.effective}` : "no workspace"} (${data.reason})`,
    ],
  );
}

const flagValue = (argv: string[], flag: string): string | undefined | null => {
  const index = argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index < 0) return undefined;
  const arg = argv[index];
  if (arg.includes("=")) return arg.slice(flag.length + 1);
  return argv[index + 1] ?? null;
};

function add(argv: string[], io: Io): number {
  const positional = argv.filter(
    (arg, index) => !arg.startsWith("--") && !["--glob", "--from"].includes(argv[index - 1] ?? ""),
  );
  const [name, extra] = positional;
  if (!name) return usage(io, "add needs <name>");
  if (extra) return usage(io, `unexpected argument ${extra}`);
  const glob = flagValue(argv, "--glob");
  if (!glob) return usage(io, "add needs --glob <glob>");
  const checked = validateWorkspaceGlob(glob);
  if (!checked.ok) return emit(io, fail("invalid_input", checked.error));
  const from = flagValue(argv, "--from");
  if (from === null) return usage(io, "--from needs <parent>");
  const current = load(io);
  if (typeof current === "number") return current;
  const entries = entriesOf(current);
  if (entries.some((entry) => entry.name === name))
    return emit(
      io,
      fail("invalid_input", `a workspace named "${name}" already exists in ${current.path}`, {
        unblock: `workit workspace set ${name} <key>=<value>`,
      }),
    );
  const parent = from === undefined ? undefined : entries.find((entry) => entry.name === from);
  if (from !== undefined && !parent)
    return emit(io, fail("not_found", `no workspace named "${from}" in ${current.path}`));
  const inherited = parent
    ? Object.fromEntries(
        INHERITED_KEYS.filter((key) => parent[key] !== undefined).map((key) => [
          key,
          structuredClone(parent[key]),
        ]),
      )
    : {};
  const shadowed = enclosingEntries(glob, entries);
  const entry: Entry = {
    name,
    glob,
    ...inherited,
    ...clampToShadowed(shadowedCeiling(shadowed)),
  };
  const result = save(current, [...entries, entry]);
  if (!result.ok) return emit(io, fail("invalid_input", result.error));
  const ceiling = ceilingOf(entry);
  return emit(
    io,
    ok({
      path: result.path,
      backup: result.backup,
      workspace: entry,
      inherited: Object.keys(inherited),
      shadows: shadowed.map((item) => item.name),
      grants: ceiling.grants,
      defaultEndpoint: ceiling.endpoint,
      verification: ceiling.verification,
    }),
    (data) => [
      `${name} (${glob}) added to ${written(data.path, data.backup)}`,
      ...(data.inherited.length ? [`  from ${from}: ${data.inherited.join(", ")}`] : []),
      ...(data.shadows.length
        ? [`  nested in: ${data.shadows.join(", ")} (${name} wins there)`]
        : []),
      `  grants: ${GRANT_KINDS.map((kind) => `${kind}=${String(data.grants[kind])}`).join(" ")}; default endpoint ${data.defaultEndpoint}; verification ${data.verification}`,
      `  raising a grant needs the user, in their own terminal: workit grant set ${name} <kind>=<value>`,
    ],
  );
}

/** `true`, `3`, `["a"]` and `{"x":1}` parse as JSON; anything else is a string; `null` removes. */
const parseSetValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

function set(argv: string[], io: Io): number {
  const [name, ...specs] = argv;
  if (!name || specs.length === 0) return usage(io, "set needs <name> and <key>=<value>");
  const grantSpecs: string[] = [];
  const changes: { path: string[]; value: unknown }[] = [];
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq <= 0) return usage(io, `${spec}: expected <key>=<value>`);
    const key = spec.slice(0, eq);
    const keyPath = key.split(".");
    if (keyPath.some((part) => !part)) return usage(io, `${spec}: empty key segment`);
    if (GRANT_KEYS.has(keyPath[0])) {
      grantSpecs.push(spec);
      continue;
    }
    if (SCOPE_KEYS.has(keyPath[0]))
      return emit(
        io,
        fail(
          "blocked",
          `${keyPath[0]} decides where the entry's grants apply; workspace set does not change it`,
          {
            unblock: `ask the user to edit ${keyPath[0]} of "${name}" in their own editor, or add a new entry: workit workspace add <name> --glob <g> --from ${name}`,
          },
        ),
      );
    changes.push({ path: keyPath, value: parseSetValue(spec.slice(eq + 1)) });
  }
  if (grantSpecs.length)
    return emit(
      io,
      fail(
        "blocked",
        `workspace set does not change grants, defaultEndpoint or verification (${grantSpecs.join(", ")})`,
        {
          unblock: `ask the user to run, in their own terminal outside the agent host: workit grant set ${name} ${grantSpecs.join(" ")}`,
        },
      ),
    );
  const current = load(io);
  if (typeof current === "number") return current;
  const entries = structuredClone(entriesOf(current));
  const entry = entries.find((item) => item.name === name);
  if (!entry) return emit(io, fail("not_found", `no workspace named "${name}" in ${current.path}`));
  for (const change of changes) {
    let target: Record<string, unknown> = entry;
    for (const part of change.path.slice(0, -1)) {
      const next = target[part];
      if (next === undefined || next === null) target[part] = {};
      else if (typeof next !== "object" || Array.isArray(next))
        return usage(io, `${change.path.join(".")}: ${part} is not an object`);
      target = target[part] as Record<string, unknown>;
    }
    const last = change.path[change.path.length - 1];
    if (change.value === null) delete target[last];
    else target[last] = change.value;
  }
  const result = save(current, entries);
  if (!result.ok) return emit(io, fail("invalid_input", result.error));
  return emit(io, ok({ path: result.path, backup: result.backup, workspace: entry }), (data) => [
    `${name}: ${changes.map((change) => change.path.join(".")).join(", ")} updated in ${written(data.path, data.backup)}`,
  ]);
}

function rm(argv: string[], io: Io): number {
  const [name, extra] = argv;
  if (!name) return usage(io, "rm needs <name>");
  if (extra) return usage(io, `unexpected argument ${extra}`);
  const current = load(io);
  if (typeof current === "number") return current;
  const entries = entriesOf(current);
  const entry = entries.find((item) => item.name === name);
  if (!entry) return emit(io, fail("not_found", `no workspace named "${name}" in ${current.path}`));
  const fallback = enclosingEntries(entry.glob, entries, name);
  const raised = ceilingRaises(ceilingOf(entry), shadowedCeiling(fallback) ?? DEFAULT_CEILING);
  if (raised.length)
    return emit(
      io,
      fail(
        "blocked",
        `removing ${name} raises ${raised.join(", ")} for ${entry.glob}: ${fallback.length ? fallback.map((item) => item.name).join(", ") : "the defaults"} would apply there`,
        {
          unblock: fallback.length
            ? `lower ${fallback[0].name} first (workit grant set ${fallback[0].name} …), or ask the user to remove ${name} in their own editor`
            : `ask the user to remove ${name} in their own editor`,
        },
      ),
    );
  const result = save(
    current,
    entries.filter((item) => item !== entry),
  );
  if (!result.ok) return emit(io, fail("invalid_input", result.error));
  return emit(
    io,
    ok({
      path: result.path,
      backup: result.backup,
      removed: name,
      fallback: fallback.map((item) => item.name),
    }),
    (data) => [`${name} removed from ${written(data.path, data.backup)}`],
  );
}

export async function runWorkspace(argv: string[], io: Io): Promise<number> {
  // Names and specs never start with --; a bare `--` before them is dropped.
  const [sub, ...rest] = argv.filter((arg) => arg !== "--json" && arg !== "--");
  if (sub === undefined || sub === "list") return list(rest, io);
  if (sub === "add") return add(rest, io);
  if (sub === "set") return set(rest, io);
  if (sub === "rm") return rm(rest, io);
  return usage(io, `unknown subcommand "${sub}"`);
}

export const run = (argv: string[], io: Io): Promise<number> => runWorkspace(argv, io);
