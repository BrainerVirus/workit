// `workit workspace` (#444): add or adjust workspaces.json entries without the
// wizard, keeping every hand-set field of the entries it does not touch.
//
//   workit workspace list
//   workit workspace add <name> --glob <g> [--from <parent>]
//   workit workspace set <name> <key>=<value>…
//   workit workspace rm <name>
//
// list, add and set never raise authority, so an agent shell may run them. Grants,
// defaultEndpoint and verification stay with `workit grant set` at the user's
// own terminal (verbs/grant.ts):
// - `add` never copies them; `--from` copies vcs, issues, branchPolicy,
//   commitPolicy, trailers, youtrack and models only. A new entry starts at
//   the strictest level of every entry and the defaults: textual glob overlap
//   is not a safe bound (a linked worktree outside every glob resolves through
//   its main checkout's entry, and symlinks after a wildcard are not
//   resolved), so no directory it takes over can ever get more than it had.
// - `set` refuses the grant keys and the keys that decide where grants apply
//   (name, glob). `remotes` (#549) caps every checkout of a claimed remote at
//   the entry's grants, so adding or removing one is the user's, like a
//   grant: `set` changes it only at an interactive terminal outside an agent,
//   with the workspace name typed to confirm. `add` offers the folder's origin
//   as the new entry's `remotes` there, and sets none headless.
// - `rm` (#453) hands the entry's directories to whichever entry or default
//   resolves there next. Textual overlap is no bound on that (see above), so
//   every other entry and the defaults count as a possible taker, and an
//   entry of the same specificity may have made a directory ambiguous (where
//   every command fails, so its baseline is nothing: no grant, no endpoint
//   beyond commit, the strictest verification). A removal
//   that might raise any grant, the endpoint or verification is refused in an
//   agent or headless shell, like `grant set`, and needs the workspace name
//   typed at the user's own terminal. It never removes the last entry.
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
  VERIFICATION_STRICTNESS,
  type VerificationMode,
} from "@brainervirus/workit-core/src/autonomy";
import { checkoutRemotes, remotePattern } from "@brainervirus/workit-core/src/core/remotes";
import { writeFileAtomic } from "@brainervirus/workit-core/src/core/safe-write";
import {
  WorkspaceConfigError,
  globRoot,
  globSpecificity,
  overlappingEntries,
  readWorkspacesResult,
  resolveWorkspaceFromEntries,
  validateWorkspaceGlob,
  validateWorkspacesDocument,
  workspaceMatches,
  type WorkspacesResult,
} from "@brainervirus/workit-core/src/core/workspaces";
import { emit, fail, ok, type Io } from "../output";
import { askLine, askOrCancel, cancelled } from "../prompt";
import { agentMarker, type GrantDeps } from "./grant";

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
/** Remote URLs whose checkouts an entry caps (#549): the user's, like a grant. */
const REMOTES_KEY = "remotes";
const remotesOf = (entry: Entry): string[] =>
  Array.isArray(entry.remotes) ? (entry.remotes as string[]) : [];
/** Keys that decide where an entry's grants apply. */
const SCOPE_KEYS = new Set(["name", "glob"]);
/** The top-level keys `set` changes: the schema's non-grant, non-scope keys. */
const SETTABLE_KEYS = new Set([
  "vcs",
  "issues",
  "branchPolicy",
  "commitPolicy",
  "trailers",
  "deleteBranch",
  "liveSessionGuard",
  "youtrack",
  "models",
  "fanout",
  "delegation",
  "defaultProfile",
  "profiles",
  "releaseTracks",
  "resources",
]);
const SEGMENT = /^[A-Za-z0-9_-]+$/u;
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

type Entry = Record<string, unknown> & { name: string; glob: string };

/** What an entry lets an agent deliver: grants, the default endpoint, verification. */
type Ceiling = {
  grants: Grants;
  endpoint: DefaultEndpoint;
  verification: VerificationMode;
};

const ceilingOf = (entry: unknown): Ceiling => ({
  grants: { ...DEFAULT_GRANTS, ...configuredGrants(entry).grants },
  endpoint: isDefaultEndpoint((entry as { defaultEndpoint?: unknown } | null)?.defaultEndpoint)
    ? (entry as { defaultEndpoint: DefaultEndpoint }).defaultEndpoint
    : DEFAULT_ENDPOINT,
  verification: verificationOf(entry),
});

/**
 * What an entry really delivers, for the side of a comparison that must not be
 * overstated: explicit grants without vcs.account reach no forge (autonomy.ts),
 * so such an entry delivers nothing beyond a local commit.
 */
const deliveredCeilingOf = (entry: Entry): Ceiling => {
  const ceiling = ceilingOf(entry);
  const account = (entry.vcs as { account?: unknown } | undefined)?.account;
  if (Object.keys(configuredGrants(entry).grants).length === 0 || account) return ceiling;
  return {
    grants: Object.fromEntries(GRANT_KINDS.map((kind) => [kind, false])) as Grants,
    endpoint: DEFAULT_ENDPOINT,
    verification: ceiling.verification,
  };
};

const STRICTNESS = VERIFICATION_STRICTNESS;
const looser = (current: VerificationMode, next: VerificationMode): boolean =>
  STRICTNESS.indexOf(next) > STRICTNESS.indexOf(current);

/** The strictest of these entries' ceilings, kind by kind; null for none. */
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
 * The grant fields a new entry needs so it never exceeds `floor`: the
 * defaults, lowered where `floor` is lower. Only ever lowers (each value is
 * at most the default), so it needs no terminal.
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

const defaultDeps: GrantDeps = {
  interactive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  ask: (question) => askLine(question),
};

/** What `after` grants beyond `before`: grant kinds, defaultEndpoint, verification. */
const raisedKinds = (before: Ceiling, after: Ceiling): string[] => [
  ...GRANT_KINDS.filter((kind) => raises(kind, before.grants[kind], after.grants[kind])),
  ...(raisesEndpoint(before.endpoint, after.endpoint) ? ["defaultEndpoint"] : []),
  ...(looser(before.verification, after.verification) ? ["verification"] : []),
];

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

/** `remotes=` as a JSON array, or comma-separated patterns; `null` removes. */
const parseRemotes = (raw: string): string[] | null | Error => {
  const value = parseSetValue(raw);
  if (value === null) return null;
  const patterns = Array.isArray(value)
    ? value
    : String(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const bad = patterns.find((item) => typeof item !== "string" || remotePattern(item) === null);
  if (bad !== undefined || patterns.length === 0)
    return Error(
      `remotes: ${bad === undefined ? "no pattern given" : `${JSON.stringify(bad)} is not a remote URL`} (https://host/owner/repo, git@host:owner/repo, a path, or owner/*)`,
    );
  return patterns as string[];
};

/** The origin URL of the folder `add` runs for: the glob's root, else cwd. */
const originOf = (glob: string, cwd: string): string | null => {
  for (const where of [globRoot(glob), cwd]) {
    const remotes = existsSync(where) ? checkoutRemotes(where) : [];
    if (remotes instanceof Error) continue;
    const origin = remotes.find((remote) => remote.name === "origin");
    if (origin) return origin.url;
  }
  return null;
};

/** Ask the user whether the new entry claims its folder's origin (#549). */
const askRemotes = async (
  glob: string,
  io: Io,
  deps: GrantDeps,
): Promise<string[] | undefined | null> => {
  if (!deps.interactive() || agentMarker(io.env)) return undefined;
  const origin = originOf(glob, io.cwd);
  const answer = await askOrCancel(io, () =>
    deps.ask(
      `Remote URLs this workspace owns (a checkout pushing to one never exceeds its grants), comma-separated${origin ? ` [${origin}]` : ""}; - for none: `,
    ),
  );
  if (answer === null) return null;
  const typed = answer.trim() || origin || "-";
  if (typed === "-") return undefined;
  const parsed = parseRemotes(typed);
  return parsed instanceof Error || parsed === null ? undefined : parsed;
};

async function add(argv: string[], io: Io, deps: GrantDeps): Promise<number> {
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
  // Capped at every entry, not only the overlapping ones (see the header).
  const shadowed = overlappingEntries(glob, entries);
  const remotes = await askRemotes(glob, io, deps);
  if (remotes === null) return cancelled(io);
  const entry: Entry = {
    name,
    glob,
    ...inherited,
    ...clampToShadowed(shadowedCeiling(entries)),
    ...(remotes ? { remotes } : {}),
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
      ...(data.shadows.length ? [`  overlaps: ${data.shadows.join(", ")}`] : []),
      remotesOf(data.workspace).length
        ? `  remotes: ${remotesOf(data.workspace).join(", ")}`
        : `  no remotes: a checkout elsewhere whose origin is this workspace's remote keeps its own folder's grants; the user can set them: workit workspace set ${name} remotes=<url>`,
      `  grants start at the strictest level of every workspace and the defaults:`,
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

async function set(argv: string[], io: Io, deps: GrantDeps): Promise<number> {
  const [name, ...specs] = argv;
  if (!name || specs.length === 0) return usage(io, "set needs <name> and <key>=<value>");
  const grantSpecs: string[] = [];
  const remoteSpecs: string[] = [];
  const changes: { path: string[]; value: unknown }[] = [];
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq <= 0) return usage(io, `${spec}: expected <key>=<value>`);
    const key = spec.slice(0, eq);
    const keyPath = key.split(".");
    if (keyPath.some((part) => !SEGMENT.test(part) || UNSAFE_SEGMENTS.has(part)))
      return usage(io, `${spec}: each key segment is letters, digits, _ or -`);
    if (GRANT_KEYS.has(keyPath[0])) {
      grantSpecs.push(spec);
      continue;
    }
    if (keyPath[0] === REMOTES_KEY) {
      if (keyPath.length > 1) return usage(io, `${spec}: remotes takes the whole list`);
      const remotes = parseRemotes(spec.slice(eq + 1));
      if (remotes instanceof Error) return usage(io, remotes.message);
      remoteSpecs.push(spec);
      changes.push({ path: keyPath, value: remotes });
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
    // Anything else (a case variant such as Autonomy or GLOB included) would
    // be an inert key: refused, never written.
    if (!SETTABLE_KEYS.has(keyPath[0]))
      return usage(
        io,
        `${spec}: unknown key ${keyPath[0]} (settable: ${[...SETTABLE_KEYS].join(", ")})`,
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
  if (remoteSpecs.length) {
    // Removing a claim raises the checkouts it capped; adding one moves where
    // this entry's grants reach. Either is the user's, at their own terminal.
    const command = `workit workspace set ${name} ${remoteSpecs.map((spec) => `'${spec}'`).join(" ")}`;
    const agent = agentMarker(io.env);
    if (!deps.interactive() || agent)
      return emit(
        io,
        fail(
          "blocked",
          `grant_raise_refused: remotes decides which checkouts "${name}"'s grants cap; changing it needs the user at an interactive terminal${agent ? ` (this shell belongs to an agent: ${agent} is set)` : ""}`,
          {
            unblock: `ask the user to run, in a terminal outside the agent host (not Claude Code's \`!\` prefix or an agent shell): ${command}`,
          },
        ),
      );
    const answer = await askOrCancel(io, () =>
      deps.ask(
        `Change the remotes of workspace "${name}" to ${remoteSpecs.join(" ")}? Checkouts of a remote no longer listed keep their own folder's grants. Type the workspace name to confirm: `,
      ),
    );
    if (answer === null) return cancelled(io);
    if (answer.trim() !== name)
      return emit(io, fail("blocked", "remotes change not confirmed; nothing was written"));
  }
  // Configured grants need vcs.account (autonomy.ts): changing the entry's vcs
  // could switch them on or move them to another credential.
  const credential = changes.find((change) => change.path[0] === "vcs");
  if (
    credential &&
    (configuredGrants(entry).source !== "default" || entry.defaultEndpoint !== undefined)
  )
    return emit(
      io,
      fail(
        "blocked",
        `${name} has grants of its own; its vcs decides the account they act through, so workspace set does not change it`,
        {
          unblock: `ask the user to change ${credential.path.join(".")} of "${name}" in their own editor, or to unset the grants first (workit grant unset ${name} …)`,
        },
      ),
    );
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

/** One possible taker of the removed entry's directories and what it would raise. */
type Raise = { taker: string; kinds: string[]; reason: string };

async function rm(argv: string[], io: Io, deps: GrantDeps): Promise<number> {
  const [name, extra] = argv;
  if (!name) return usage(io, "rm needs <name>");
  if (extra) return usage(io, `unexpected argument ${extra}`);
  const current = load(io);
  if (typeof current === "number") return current;
  const entries = entriesOf(current);
  const removed = entries.find((entry) => entry.name === name);
  if (!removed)
    return emit(io, fail("not_found", `no workspace named "${name}" in ${current.path}`));
  const remaining = entries.filter((entry) => entry !== removed);
  if (remaining.length === 0)
    return emit(
      io,
      fail(
        "blocked",
        `"${name}" is the last workspace in ${current.path}: it holds your vcs, policies and grants, and without it every folder falls back to the defaults; workspace rm does not remove it`,
        {
          unblock: `add the workspace that should replace it first (workit workspace add <name> --glob <g> --from ${name}), or edit ${current.path} in your own editor`,
        },
      ),
    );
  // Every directory the entry decided now resolves to some other entry or the
  // defaults; which one is not decidable from the text (see the header).
  const before = deliveredCeilingOf(removed);
  const defaults = ceilingOf({});
  // An ambiguous folder: every command there fails, so nothing is granted.
  const nothing: Ceiling = {
    grants: Object.fromEntries(GRANT_KINDS.map((kind) => [kind, false])) as Grants,
    endpoint: DEFAULT_ENDPOINT,
    verification: STRICTNESS[0],
  };
  const specificity = globSpecificity(removed.glob);
  const raised: Raise[] = [
    { taker: "defaults", kinds: raisedKinds(before, defaults), reason: "no entry matches" },
    ...remaining.map((entry) => ({
      taker: entry.name,
      kinds: raisedKinds(before, ceilingOf(entry)),
      reason: "may match a folder it covered",
    })),
    ...remaining
      .filter((entry) => globSpecificity(entry.glob) === specificity)
      .map((entry) => ({
        taker: entry.name,
        kinds: raisedKinds(nothing, ceilingOf(entry)),
        reason: "equally specific: a folder both matched was ambiguous, with nothing granted",
      })),
    // Its remotes capped checkouts anywhere (#549); they stop being capped.
    ...(remotesOf(removed).length
      ? [
          {
            taker: "checkouts of its remotes",
            kinds: ["remotes"],
            reason: `no longer capped at ${name}: ${remotesOf(removed).join(", ")}`,
          },
        ]
      : []),
  ].filter((raise) => raise.kinds.length > 0);
  if (raised.length > 0) {
    const kinds = [...new Set(raised.flatMap((raise) => raise.kinds))];
    const detail = raised
      .map((raise) => `${raise.taker} (${raise.reason}): ${raise.kinds.join(", ")}`)
      .join("; ");
    const agent = agentMarker(io.env);
    if (!deps.interactive() || agent)
      return emit(
        io,
        fail(
          "blocked",
          `grant_raise_refused: removing "${name}" may raise ${kinds.join(", ")} for the folders it covered (${detail}); that needs the user at an interactive terminal${agent ? ` (this shell belongs to an agent: ${agent} is set)` : ""}; grants are never raised headless`,
          {
            unblock: `ask the user to run, in a terminal outside the agent host (not Claude Code's \`!\` prefix or an agent shell): workit workspace rm ${name}`,
          },
        ),
      );
    const answer = await askOrCancel(io, () =>
      deps.ask(
        `Removing workspace "${name}" may raise ${kinds.join(", ")} for the folders it covered (${detail}). An agent there may then do more without asking. Type the workspace name to confirm: `,
      ),
    );
    if (answer === null) return cancelled(io);
    if (answer.trim() !== name)
      return emit(io, fail("blocked", "workspace removal not confirmed; nothing was written"));
  }
  const result = save(current, remaining);
  if (!result.ok) return emit(io, fail("invalid_input", result.error));
  const at = globRoot(removed.glob);
  let covers: { at: string; workspace: string | null; error?: string };
  try {
    covers = { at, workspace: resolveWorkspaceFromEntries(at, remaining)?.name ?? null };
  } catch (error) {
    covers = { at, workspace: null, error: error instanceof Error ? error.message : String(error) };
  }
  const coveringCeiling = ceilingOf(remaining.find((entry) => entry.name === covers.workspace));
  return emit(
    io,
    ok({
      path: result.path,
      backup: result.backup,
      removed,
      covers: {
        ...covers,
        grants: coveringCeiling.grants,
        defaultEndpoint: coveringCeiling.endpoint,
        verification: coveringCeiling.verification,
      },
      takers: overlappingEntries(removed.glob, remaining).map((entry) => entry.name),
      raises: raised,
    }),
    (data) => [
      `${name} (${removed.glob}) removed from ${written(data.path, data.backup)}`,
      data.covers.error
        ? `  ${data.covers.at}: ${data.covers.error}`
        : `  ${data.covers.at} is now ${data.covers.workspace ? `workspace ${data.covers.workspace}` : "under the defaults (no workspace)"}: ${GRANT_KINDS.map((kind) => `${kind}=${String(data.covers.grants[kind])}`).join(" ")}; default endpoint ${data.covers.defaultEndpoint}; verification ${data.covers.verification}`,
      ...(data.takers.length
        ? [`  entries whose globs may cover its other folders: ${data.takers.join(", ")}`]
        : []),
      "  workit workspace list --cwd <folder> shows which entry applies to a folder",
    ],
  );
}

export async function runWorkspace(
  argv: string[],
  io: Io,
  deps: GrantDeps = defaultDeps,
): Promise<number> {
  // Names and specs never start with --; a bare `--` before them is dropped.
  const [sub, ...rest] = argv.filter((arg) => arg !== "--json" && arg !== "--");
  if (sub === undefined || sub === "list") return list(rest, io);
  if (sub === "add") return add(rest, io, deps);
  if (sub === "set") return set(rest, io, deps);
  if (sub === "rm") return rm(rest, io, deps);
  return usage(io, `unknown subcommand "${sub}"`);
}

export const run = (argv: string[], io: Io): Promise<number> => runWorkspace(argv, io);
