// Autonomy grants (D2, D4, D15; design §0 #12, §4.2): the per-workspace
// ceiling on what an agent may deliver without asking. Authority is the
// host's own permission prompt plus these grants; no approval ticket or
// checkout lease stands behind them.
//
// - Grants live only in the matched workspace entry of the user's
//   `~/.config/workit/workspaces.json`, where `~` is the OS account's home
//   (neither $HOME nor config-dir overrides redirect them; see grantsDir;
//   a bench world outside every workspace only lowers them, see benchWorld):
//     "autonomy": { "push": true, "pr": true, "merge": false | true | "verified",
//                   "release": false, "rerun": true }
//   never in a repo file. `workit grant set` raises only from an interactive
//   terminal (see verbs/grant.ts). Threat model (D18): this stops an honest
//   agent from raising its own ceiling by accident, not an adversarial one —
//   a process that drives a pseudo-terminal or edits the file directly can
//   still defeat it; the host's permission prompt is the hard boundary.
// - `release` gates `workit git push --release`: pushing the git-flow
//   production and develop branches (fast-forward only) and release tags (`v*` or git-flow's prefix) whose
//   commit already landed (a tag never moves). Outside git-flow it pushes
//   tags only. It needs `push` too.
// - Defaults (D4) when a kind is absent: push, pr and rerun are allowed;
//   merge and release need an explicit grant. The default ceiling is a stack
//   opened, CI green and independently verified: "verified, ready".
// - Every merge needs an accepted independent verdict (S13). `merge: true`
//   also allows an explicit, ledger-recorded `--unverified --reason` bypass;
//   `merge: "verified"` never does.
// - A legacy `autoApprove: true | [classes]` maps once to grants (its `merge`
//   class becomes `merge: "verified"`; `branch`/`commit` are local, dropped).
// - Explicitly configured grants require an account (design §2.0 Identity):
//   a workspace with grants but no `vcs.account` cannot push, open or merge
//   through a forge, so a personal grant never rides a work credential.
// - Protected-branch pushes stay denied by the git verbs (except the git-flow
//   release push above), and the host
//   permission prompt applies in addition: a host deny always wins.
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { grantsHome } from "./core/account-home";
import { configFilePath, resolveConfigDir } from "./core/config";
import { configDir as workitConfigDir } from "./core/workit-paths.mjs";
import { evalWorld, evalWorldEntry } from "./core/eval-world";
import {
  checkSeal,
  identityOf,
  sealDiffLines,
  sealedProjection,
  sealProjection,
  SEAL_COMMAND,
  writeSeal,
  type SealCheck,
} from "./core/grant-seal";
import { writeFileAtomic } from "./core/safe-write";
import {
  checkoutRemotes,
  remoteMatches,
  type CheckoutRemote,
  type GrantTarget,
  type LazyTarget,
} from "./core/remotes";
import {
  checkoutsAbove,
  loadWorkspacesFrom,
  readWorkspacesResult,
  resolveWorkspaceFrom,
  resolveWorkspaceFromEntries,
  validateWorkspacesDocument,
  type WorkspaceConfig,
} from "./core/workspaces";

/**
 * Grants are read only from the user's real config directory, the default
 * config dir under the account home (`~/.config/workit`, `%APPDATA%\\workit` on
 * Windows; D15, see grantsHome). The WORKIT_CONFIG(_DIR) and
 * XDG_CONFIG_HOME overrides that redirect the rest of the config never
 * redirect authority: an agent could point them at a file it wrote. While an
 * override points elsewhere, authority is the stricter of the D4 defaults and
 * the account's own (seal-aware) values: a redirect only ever lowers it.
 */
export { grantsHome };

/**
 * The default config dir (core/workit-paths.mjs) for the account home, with
 * no override: every grant is read from here. Null when no account record
 * answers (core/account-home.ts): then no grants are read at all.
 */
const accountDir = (): string | null => {
  const home = grantsHome.resolve();
  return home === null ? null : workitConfigDir({ HOME: home });
};

/**
 * The account's grants dir, which the write guard (hooks/write-gate.ts)
 * protects in every state, a bench world included. With no account record
 * it is the config dir, which the guard protects anyway; no grant is read
 * through this name.
 */
export const grantsDir = (): string => accountDir() ?? resolveConfigDir();

const NO_ACCOUNT =
  "no OS account record answered (core/account-home.ts), so no grants are read: the D4 defaults apply";

/** The workspace entries of a grants dir; none without one. */
const entriesIn = (dir: string | null): WorkspaceConfig[] =>
  dir === null ? [] : loadWorkspacesFrom(dir);

/**
 * Where authority entries come from: the account's workspaces.json, or the
 * last sealed entries of a broken seal (core/grant-seal.ts).
 */
type Source = {
  resolve: (cwd: string, name?: string) => WorkspaceConfig | null;
  entries: () => WorkspaceConfig[];
};

const fileSource = (dir: string | null = accountDir()): Source => ({
  resolve: (cwd, name) => (dir === null ? null : resolveWorkspaceFrom(cwd, dir, name)),
  entries: () => entriesIn(dir),
});

const sealedSource = (entries: WorkspaceConfig[]): Source => ({
  resolve: (cwd, name) => resolveWorkspaceFromEntries(cwd, entries, name),
  entries: () => entries,
});

/** The account's seal (#819); none without an account home. */
const sealOf = (): SealCheck => {
  const dir = accountDir();
  return dir === null ? { state: "none" } : checkSeal(dir);
};

/** The unblock of a value a broken seal, or an identity that differs from the sealed one, lowered. */
export const SEAL_UNBLOCK = `if the user made this change, ask them to run, in their own terminal: ${SEAL_COMMAND}`;
const NO_SEAL_UNBLOCK = `ask the user to review and seal the grants, in their own terminal: ${SEAL_COMMAND}`;
const NO_SEAL_NOTE = `workspaces.json has no seal yet (${SEAL_COMMAND} has never run), so grants, endpoint, verification and youtrack.writes stay at or below the D4 defaults; ${NO_SEAL_UNBLOCK}`;

/**
 * Why authority falls back (a seal that exists and does not match, see
 * core/grant-seal.ts), with the terminal command that accepts the change;
 * null when the seal matches or there is none.
 */
const sealNote = (seal: SealCheck = sealOf()): string | null =>
  seal.state === "broken"
    ? `workspaces.json does not match its seal (${seal.reason}), so grants, endpoint, verification and youtrack.writes are the stricter of their current and last sealed values; ${SEAL_UNBLOCK}`
    : null;

/**
 * How a YouTrack write is approved (#780). `ask` (the default, every
 * workspace): each write needs the user's yes through the approval channel.
 * `auto` is the opt-out a user sets in the workspace entry
 * (`youtrack: { writes: "auto" }`); it keeps the WORKIT_YT_WRITE gate alone.
 * Only the account's sealed file gives `auto` (see youTrackWritesMode). Here,
 * not in core/youtrack-writes.ts, so the shell hook's raw ytrack guard reads
 * it without the YouTrack client.
 */
export type YouTrackWritesMode = "ask" | "auto";

/**
 * `auto` only from the account's own file with a valid seal, never under a
 * config redirect (WORKIT_CONFIG, WORKIT_CONFIG_DIR, XDG_CONFIG_HOME) or in a
 * bench world; with WORKIT_WORKSPACE_NAME, the named entry and the folder's
 * unnamed one must both say auto. Anything that throws reads as `ask`.
 */
export const youTrackWritesMode = (cwd: string): YouTrackWritesMode => {
  try {
    const dir = accountDir();
    if (dir === null || redirected(dir) || evalWorld(cwd)) return "ask";
    if (checkSeal(dir).state !== "valid") return "ask";
    const auto = (entry: WorkspaceConfig | null) =>
      (entry?.youtrack as { writes?: unknown } | undefined)?.writes === "auto";
    const name = process.env.WORKIT_WORKSPACE_NAME?.trim() || undefined;
    if (!auto(resolveWorkspaceFrom(cwd, dir, name))) return "ask";
    return !name || auto(resolveWorkspaceFrom(cwd, dir)) ? "auto" : "ask";
  } catch {
    return "ask";
  }
};

/** Whether the config dir the rest of the config reads is not the account's own. */
const redirected = (dir: string): boolean => path.resolve(resolveConfigDir()) !== path.resolve(dir);

/**
 * Where `grant show --all` lists grants and `grant set` writes them: the
 * account's dir, or the config dir of a bench world the cwd is in
 * (core/eval-world.ts), whose entry only ever lowers what the account's file
 * gives (benchWorld). Never read for authority.
 */
export const shownGrantsDir = (): string | null => {
  const world = evalWorld(process.cwd());
  return world ? path.join(world, "config") : accountDir();
};

/**
 * The bench world's entry for `cwd` (#792, core/eval-world.ts), cut down to
 * what may apply: its name, glob, endpoint and the grants it sets strictly
 * below the D4 defaults; never a raised grant, verification or vcs (a forge
 * account). resolveAutonomy uses it only where no real entry matches.
 */
const benchWorld = (cwd: string): WorkspaceConfig | null => {
  const entry = evalWorldEntry(cwd);
  if (!entry) return null;
  const { grants } = configuredGrants(entry);
  const lowered: Partial<Grants> = {};
  for (const kind of GRANT_KINDS) {
    const value = grants[kind];
    if (value !== undefined && raises(kind, value, DEFAULT_GRANTS[kind])) lowered[kind] = value;
  }
  return {
    name: entry.name,
    glob: entry.glob,
    ...(entry.defaultEndpoint ? { defaultEndpoint: entry.defaultEndpoint } : {}),
    autonomy: lowered,
  };
};

/** Why grants fell back to the defaults, or null when the real file is used. */
export const grantsOverride = (): string | null => {
  const shown = shownGrantsDir();
  if (shown === null) return NO_ACCOUNT;
  const configured = path.resolve(resolveConfigDir());
  return configured === path.resolve(shown)
    ? null
    : `the config directory is redirected to ${configured} (WORKIT_CONFIG, WORKIT_CONFIG_DIR or XDG_CONFIG_HOME), but that override does not apply to grants: grants are read only from ${path.join(grantsDir(), "workspaces.json")}, and under a redirect they never exceed the D4 defaults`;
};

/** The unblock of a grant a config redirect lowered to the D4 defaults. */
const redirectUnblock = (): string =>
  `ask the user: grants above the D4 defaults apply only without a config redirect (WORKIT_CONFIG, WORKIT_CONFIG_DIR or XDG_CONFIG_HOME), and are read from ${path.join(grantsDir(), "workspaces.json")}`;

export const GRANT_KINDS = ["push", "pr", "merge", "release", "rerun"] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

/** One grant: `"verified"` means allowed with an accepted independent verdict. */
export type GrantValue = boolean | "verified";
export type Grants = Record<GrantKind, GrantValue>;

/** The D4 ceiling: deliver up to "verified, ready"; merging and releasing are asked. */
export const DEFAULT_GRANTS: Readonly<Grants> = Object.freeze({
  push: true,
  pr: true,
  merge: false,
  release: false,
  rerun: true,
});

/**
 * Where an unnamed request stops (skills read it), lowest to highest:
 * `commit` (default) ends at a local commit; `pr` pushes and opens the PR;
 * `green` opens the PR, then babysits it (CI, threads, base) until it is
 * merge-ready, never merging; `merged` also lands it with `workit pr merge`,
 * and only takes effect with the merge grant (otherwise it acts as `green`).
 * User config only, same rules as grants: any step up needs the user at a
 * terminal; stepping down is free.
 */
export const DEFAULT_ENDPOINTS = ["commit", "pr", "green", "merged"] as const;
export type DefaultEndpoint = (typeof DEFAULT_ENDPOINTS)[number];
export const DEFAULT_ENDPOINT: DefaultEndpoint = "commit";
export const isDefaultEndpoint = (value: unknown): value is DefaultEndpoint =>
  typeof value === "string" && (DEFAULT_ENDPOINTS as readonly string[]).includes(value);
/** Whether `next` lets an unnamed request go further than `current`. */
export const raisesEndpoint = (current: DefaultEndpoint, next: DefaultEndpoint): boolean =>
  DEFAULT_ENDPOINTS.indexOf(next) > DEFAULT_ENDPOINTS.indexOf(current);

/**
 * The configured endpoint of one workspace entry. Lenient (D17): a value this
 * version does not know falls back to `commit` and is reported in `issue`, so
 * a newer Workit's endpoint never invalidates the file for an older one.
 */
function endpointOf(entry: unknown): {
  raw: unknown;
  endpoint: DefaultEndpoint;
  issue?: string;
} {
  const raw = (entry as { defaultEndpoint?: unknown } | null)?.defaultEndpoint;
  if (raw === undefined) return { raw, endpoint: DEFAULT_ENDPOINT };
  if (isDefaultEndpoint(raw)) return { raw, endpoint: raw };
  return {
    raw,
    endpoint: DEFAULT_ENDPOINT,
    issue: `defaultEndpoint ${JSON.stringify(raw)} is not one of ${DEFAULT_ENDPOINTS.join(", ")}; using ${DEFAULT_ENDPOINT}`,
  };
}

type EndpointContext = {
  workspace: string | null;
  grants: Grants;
  configured: readonly GrantKind[];
  accountConfigured: boolean;
};

/**
 * What the configured endpoint means today, mirroring the grant checks the
 * delivery verbs make (requireGrant): without `push` or `pr` (or without the
 * account explicit grants need) nothing reaches the forge, so anything above
 * `commit` acts as `commit`; without `merge`, `merged` acts as `green`. The
 * reason names the unblock. `merged` stays `merged` under either merge grant;
 * landing still needs an accepted verdict (forge/pr-ops.ts).
 */
function effectiveEndpoint(
  endpoint: DefaultEndpoint,
  context: EndpointContext,
): { endpoint: DefaultEndpoint; reason?: string } {
  if (endpoint === "commit") return { endpoint };
  const missing = (kind: GrantKind) =>
    `${kind} grant missing; ${grantHint(context.workspace, kind)}`;
  if (context.grants.push === false) return { endpoint: "commit", reason: missing("push") };
  if (context.grants.pr === false) return { endpoint: "commit", reason: missing("pr") };
  if (context.configured.length > 0 && !context.accountConfigured)
    return {
      endpoint: "commit",
      reason: `vcs.account missing; ${accountHint(context.workspace)}`,
    };
  if (endpoint === "merged" && context.grants.merge === false)
    return { endpoint: "green", reason: missing("merge") };
  return { endpoint };
}

const STOPS: Record<DefaultEndpoint, string> = {
  commit: "the local commit",
  pr: "the PR",
  green: "a green PR",
  merged: "the merge",
};

/**
 * One line when an explicit grant reaches further than the endpoint: `merge`
 * granted but the endpoint stops at the PR, or `pr` granted with endpoint
 * `commit`. Defaults never trigger it (pr is on by default), so only a grant
 * the user wrote counts. Null when grant and endpoint agree.
 */
export function endpointMismatch(view: {
  workspace: string | null;
  grants: Grants;
  configured: readonly GrantKind[];
  defaultEndpoint: DefaultEndpoint;
}): string | null {
  const { defaultEndpoint: endpoint } = view;
  const ws = view.workspace ?? "<workspace>";
  const explicit = (kind: GrantKind) =>
    view.configured.includes(kind) && view.grants[kind] !== false;
  if (explicit("merge") && endpoint !== "merged")
    return `merge granted, but endpoint ${endpoint} stops at ${STOPS[endpoint]}; to land on green: workit grant set ${ws} defaultEndpoint=merged (your terminal)`;
  if (explicit("pr") && endpoint === "commit")
    return `pr granted, but endpoint commit stops at the local commit; to open PRs: workit grant set ${ws} defaultEndpoint=pr (your terminal)`;
  return null;
}

/** The mismatch line for one workspace entry as stored (null for no entry). */
export function entryMismatch(entry: unknown): string | null {
  if (!entry) return null;
  const { grants } = configuredGrants(entry);
  return endpointMismatch({
    workspace: (entry as { name?: string }).name ?? null,
    grants: { ...DEFAULT_GRANTS, ...grants },
    configured: GRANT_KINDS.filter((kind) => grants[kind] !== undefined),
    defaultEndpoint: endpointOf(entry).endpoint,
  });
}

/** The endpoint fields every grant view carries. */
export type EndpointView = {
  /** As configured (an unknown value reads as the default, see endpointIssue). */
  defaultEndpoint: DefaultEndpoint;
  /** The raw stored value (null when unset), including one this version does not know. */
  configuredEndpoint: unknown;
  /** What an agent acts on, e.g. `merged` without the merge grant is `green`. */
  effectiveEndpoint: DefaultEndpoint;
  /** Why the effective endpoint is lower than the configured one, with its unblock. */
  endpointReason?: string;
  /** A configured value this version does not know (reported, then ignored). */
  endpointIssue?: string;
};

function endpointView(entry: unknown, context: EndpointContext): EndpointView {
  const { raw, endpoint, issue } = endpointOf(entry);
  const effective = effectiveEndpoint(endpoint, context);
  return {
    defaultEndpoint: endpoint,
    configuredEndpoint: raw ?? null,
    effectiveEndpoint: effective.endpoint,
    ...(effective.reason ? { endpointReason: effective.reason } : {}),
    ...(issue ? { endpointIssue: issue } : {}),
  };
}

/**
 * How a behavior change is verified (S17, #333). `proportional` (default):
 * the review lane computed from the diff decides (core/policy/lane.ts): none
 * needs no verdict, self the author's own `--self` verdict, focused and full
 * a non-author verdict, at every gate including merge. `self`: an observed
 * passing `workit check test` plus the author's own `--self` verdict at
 * normal risk, labelled self-reviewed; merge still needs a non-author
 * verdict. `independent`: a verdict from a session that did not author the
 * branch. User config only, like grants.
 */
export type VerificationMode = "self" | "independent" | "proportional";
export const VERIFICATION_MODES: readonly VerificationMode[] = [
  "proportional",
  "self",
  "independent",
];
/**
 * Strictest first. `self` is the loosest: the author's own `--self` verdict
 * satisfies even lanes that `proportional` sends to an independent verifier.
 */
export const VERIFICATION_STRICTNESS: readonly VerificationMode[] = [
  "independent",
  "proportional",
  "self",
];
export const DEFAULT_VERIFICATION: VerificationMode = "proportional";
export const verificationOf = (entry: unknown): VerificationMode => {
  const value = (entry as { verification?: unknown } | null)?.verification;
  return VERIFICATION_MODES.includes(value as VerificationMode)
    ? (value as VerificationMode)
    : DEFAULT_VERIFICATION;
};

export type AutonomySource = "autonomy" | "autoApprove" | "default";

export type Autonomy = EndpointView & {
  workspace: string | null;
  /** Every kind, with absent ones filled from DEFAULT_GRANTS. */
  grants: Grants;
  /** The kinds the user configured explicitly (the rest are defaults). */
  configured: GrantKind[];
  source: AutonomySource;
  accountConfigured: boolean;
  verification: VerificationMode;
  /**
   * Set when the grants file was not read (see grantsOverride), or when
   * WORKIT_WORKSPACE_NAME (#536) or a linked worktree's main checkout (#540)
   * capped the grants.
   */
  note?: string;
  /** The bench world whose entry applied, lowered (benchWorld): no real entry matched. */
  world?: string;
  /** The unblock of each grant a cap lowered: it names the capping entry. */
  unblocks?: Partial<Record<GrantKind, string>>;
};

export type GrantDecision =
  | {
      allowed: true;
      kind: GrantKind;
      /** Where the permission came from. */
      source: AutonomySource;
      /** `merge: true` only: `--unverified --reason` may bypass the verdict (S13). */
      allowUnverified: boolean;
      workspace: string | null;
    }
  | {
      allowed: false;
      kind: GrantKind;
      reason: "grant_required" | "account_required" | "config_invalid";
      error: string;
      unblock: string;
      workspace: string | null;
    };

export const isGrantKind = (value: unknown): value is GrantKind =>
  typeof value === "string" && (GRANT_KINDS as readonly string[]).includes(value);

const isGrantValue = (value: unknown): value is GrantValue =>
  value === true || value === false || value === "verified";

/** `verified` is meaningful only for merge; elsewhere it means allowed. */
const normalized = (kind: GrantKind, value: GrantValue): GrantValue =>
  value === "verified" && kind !== "merge" ? true : value;

/** Legacy `autoApprove` (≤4.x standing approvals) → grants, mapped once on read. */
const fromAutoApprove = (value: unknown): Partial<Grants> | null => {
  // A standing merge approval maps to merge "verified": an accepted
  // independent verdict is still required (S16 review L1).
  if (value === true) return { push: true, pr: true, merge: "verified" };
  if (!Array.isArray(value)) return null;
  const grants: Partial<Grants> = {};
  for (const item of value as unknown[])
    if (item === "push" || item === "pr") grants[item] = true;
    else if (item === "merge") grants.merge = "verified";
  return Object.keys(grants).length > 0 ? grants : null;
};

/** The explicit grants of one workspace entry, before defaults. */
export function configuredGrants(entry: unknown): {
  grants: Partial<Grants>;
  source: AutonomySource;
} {
  const record = (entry ?? {}) as { autonomy?: unknown; autoApprove?: unknown };
  const raw = record.autonomy;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const grants: Partial<Grants> = {};
    for (const kind of GRANT_KINDS) {
      const value = (raw as Record<string, unknown>)[kind];
      if (isGrantValue(value)) grants[kind] = normalized(kind, value);
    }
    return { grants, source: "autonomy" };
  }
  const legacy = fromAutoApprove(record.autoApprove);
  return legacy ? { grants: legacy, source: "autoApprove" } : { grants: {}, source: "default" };
}

/** The grants one resolved workspace entry (or none) gives. */
function autonomyOf(workspace: WorkspaceConfig | null): Autonomy {
  const { grants, source } = configuredGrants(workspace);
  const full = { ...DEFAULT_GRANTS, ...grants };
  const configured = GRANT_KINDS.filter((kind) => grants[kind] !== undefined);
  const accountConfigured = Boolean(workspace?.vcs?.account);
  const name = workspace?.name ?? null;
  return {
    workspace: name,
    grants: full,
    configured,
    source,
    accountConfigured,
    ...endpointView(workspace, {
      workspace: name,
      grants: full,
      configured,
      accountConfigured,
    }),
    verification: verificationOf(workspace),
  };
}

/**
 * The grants, endpoint and verification of `named` never exceed what `where`
 * resolves to without a name, or nothing granted when its entries tie (#536:
 * WORKIT_WORKSPACE_NAME, which any shell can set; #540: a linked worktree's
 * main checkout). Explicit grants without vcs.account reach no forge, so such
 * an entry caps at nothing granted too. A lowered grant's unblock names the
 * capping entry, never the named one. Settings that are not authority stay.
 */
function capAt(
  source: Source,
  named: Autonomy,
  where: string | Error | { entry: WorkspaceConfig },
  by: string,
  why: string,
  main = false,
): Autonomy {
  let folder: Autonomy | null = null;
  let none = "";
  try {
    if (where instanceof Error) throw where;
    folder = autonomyOf(typeof where === "string" ? source.resolve(where) : where.entry);
  } catch (error) {
    // Its entries tie (the only resolver error once `named` resolved), or git
    // did not answer (`where`): nothing granted.
    none = (error as Error).message;
  }
  // A name equal to the folder's entry is the folder's resolution; a main
  // checkout caps even its own entry, so naming it never beats the unnamed.
  if (!main && folder?.workspace === named.workspace) return named;
  const nothing = !folder || (folder.configured.length > 0 && !folder.accountConfigured);
  const grants = { ...named.grants };
  const unblocks = { ...named.unblocks };
  const lowered: string[] = [];
  for (const kind of GRANT_KINDS) {
    const floor = !nothing && folder!.grants[kind];
    if (!raises(kind, floor, grants[kind])) continue;
    grants[kind] = floor;
    unblocks[kind] = folder
      ? nothing
        ? accountHint(folder.workspace)
        : grantHint(folder.workspace, kind)
      : `ask the user to fix: ${none}`;
    lowered.push(kind);
  }
  // The folder's effective endpoint already reflects its own grants.
  const ceiling = (!nothing && folder!.effectiveEndpoint) || DEFAULT_ENDPOINT;
  const endpoint = raisesEndpoint(ceiling, named.effectiveEndpoint);
  if (endpoint) lowered.push("defaultEndpoint");
  const strict = folder?.verification ?? "independent";
  const looser =
    VERIFICATION_STRICTNESS.indexOf(named.verification) > VERIFICATION_STRICTNESS.indexOf(strict);
  if (looser) lowered.push("verification");
  if (lowered.length === 0) return named;
  const note = `${by}: ${lowered.join(", ")} capped at ${folder ? `workspace ${folder.workspace}` : `nothing (${none})`}; ${why}`;
  return {
    ...named,
    grants,
    unblocks,
    ...(endpoint ? { effectiveEndpoint: ceiling, endpointReason: undefined } : {}),
    verification: looser ? strict : named.verification,
    note: named.note ? `${named.note}; ${note}` : note,
  };
}

/** The grants for the workspace `cwd` belongs to (read-only). */
export function resolveAutonomy(cwd: string, target?: LazyTarget): Autonomy {
  const world = benchWorld(cwd);
  const override = world ? null : grantsOverride();
  // No account record: no grants are read, the D4 defaults.
  if (override === NO_ACCOUNT) return { ...autonomyOf(null), note: override };
  // Resolved once even when a broken seal resolves twice.
  let resolved: GrantTarget | undefined;
  const once: LazyTarget | undefined =
    typeof target === "function" ? () => (resolved ??= target()) : target;
  const account = accountAuthority(cwd, world, once);
  // A redirect only ever adds a cap at the defaults: never above the account.
  return override ? stricter(account, autonomyOf(null), override, redirectUnblock()) : account;
}

/** The account file's authority for `cwd`, seal-aware (#819). */
function accountAuthority(
  cwd: string,
  world: WorkspaceConfig | null,
  target: LazyTarget | undefined,
): Autonomy {
  const current = resolveWith(fileSource(), cwd, world, target);
  const seal = sealOf();
  if (seal.state !== "broken") {
    // A bench world's entry (no real entry matched) is not the account's file:
    // it only ever lowers (benchWorld), so a missing seal leaves it as it is.
    if (seal.state === "valid" || current.world) return current;
    // Never sealed: the D4 defaults are the sealed value; a note only when it lowers.
    const capped = stricter(current, autonomyOf(null), NO_SEAL_NOTE, NO_SEAL_UNBLOCK);
    return authorityKey(capped) === authorityKey(current) ? current : capped;
  }
  // No sealed value: the D4 defaults. Sealed entries that no longer resolve
  // (a tie, a name they do not have): nothing granted.
  let sealed: Autonomy | null = autonomyOf(null);
  try {
    if (seal.sealed) sealed = resolveWith(sealedSource(seal.sealed), cwd, world, target);
  } catch {
    sealed = null;
  }
  return stricter(current, sealed, sealNote(seal)!, SEAL_UNBLOCK);
}

/** What an agent may do with an autonomy (not its notes or unblocks). */
const authorityKey = (autonomy: Autonomy): string =>
  JSON.stringify([
    autonomy.grants,
    autonomy.configured,
    autonomy.accountConfigured,
    autonomy.defaultEndpoint,
    autonomy.effectiveEndpoint,
    autonomy.verification,
  ]);

function resolveWith(
  source: Source,
  cwd: string,
  world: WorkspaceConfig | null,
  target?: LazyTarget,
): Autonomy {
  const name = process.env.WORKIT_WORKSPACE_NAME?.trim() || undefined;
  // A real entry always wins over a bench world.
  const real = source.resolve(cwd, name);
  let autonomy = autonomyOf(real ?? world);
  if (!real && world) autonomy.world = evalWorld(cwd) ?? undefined;
  if (name)
    autonomy = capAt(
      source,
      autonomy,
      cwd,
      `WORKIT_WORKSPACE_NAME=${name}`,
      "a name never raises grants",
    );
  const above = checkoutsAbove(cwd);
  for (const where of above instanceof Error ? [above] : above)
    autonomy = capAt(
      source,
      autonomy,
      where,
      where instanceof Error ? "git" : `checkout ${where}`,
      "a worktree or submodule never exceeds it",
      true,
    );
  return capAtRemotes(source, autonomy, cwd, target);
}

const needsAccount = (autonomy: Autonomy): boolean =>
  autonomy.configured.length > 0 && !autonomy.accountConfigured;

/**
 * A broken or missing seal (#819), or a config redirect: every authority value
 * is the stricter of the current one and `sealed` (the last sealed one, or the
 * D4 defaults; null means nothing granted), and each lowered value carries
 * `unblock`. It never raises anything; settings that are not authority stay.
 */
function stricter(
  current: Autonomy,
  sealed: Autonomy | null,
  note: string,
  unblock: string,
): Autonomy {
  const grants = { ...current.grants };
  const unblocks = { ...current.unblocks };
  for (const kind of GRANT_KINDS) {
    const floor = sealed ? sealed.grants[kind] : false;
    if (!raises(kind, floor, grants[kind])) continue;
    grants[kind] = floor;
    unblocks[kind] = unblock;
  }
  const configured = GRANT_KINDS.filter(
    (kind) => current.configured.includes(kind) || sealed?.configured.includes(kind),
  );
  const accountConfigured =
    !needsAccount(current) &&
    !(sealed && needsAccount(sealed)) &&
    (current.accountConfigured || Boolean(sealed?.accountConfigured));
  const lower = (a: DefaultEndpoint, b: DefaultEndpoint) => (raisesEndpoint(a, b) ? a : b);
  const defaultEndpoint = lower(
    current.defaultEndpoint,
    sealed?.defaultEndpoint ?? DEFAULT_ENDPOINT,
  );
  const effective = effectiveEndpoint(defaultEndpoint, {
    workspace: current.workspace,
    grants,
    configured,
    accountConfigured,
  });
  const endpoint = lower(
    lower(effective.endpoint, current.effectiveEndpoint),
    sealed?.effectiveEndpoint ?? DEFAULT_ENDPOINT,
  );
  const strict = sealed?.verification ?? "independent";
  const looser =
    VERIFICATION_STRICTNESS.indexOf(current.verification) > VERIFICATION_STRICTNESS.indexOf(strict);
  return {
    ...current,
    grants,
    configured,
    accountConfigured,
    defaultEndpoint,
    effectiveEndpoint: endpoint,
    endpointReason: endpoint === current.effectiveEndpoint ? current.endpointReason : unblock,
    verification: looser ? strict : current.verification,
    unblocks: Object.keys(unblocks).length > 0 ? unblocks : current.unblocks,
    note: current.note ? `${current.note}; ${note}` : note,
  };
}

/**
 * Every entry whose `remotes` claims one of the checkout's remote URLs caps
 * its grants (#549): grants follow the folder, so a fresh repository whose
 * origin is a stricter workspace's remote would otherwise push there with the
 * folder's grants. Git is asked only when some entry claims remotes; a git
 * error or an unreadable URL caps at nothing.
 */
function capAtRemotes(
  source: Source,
  autonomy: Autonomy,
  cwd: string,
  target?: LazyTarget,
): Autonomy {
  const claiming = source.entries().filter((entry) => entry.remotes?.length);
  if (claiming.length === 0) return autonomy;
  // The action's own target when the verb names it (a fork pushes to its own
  // origin with the folder's grants); every remote otherwise.
  // Git is asked only now, when some entry claims remotes (no extra call otherwise).
  const remotes =
    target === undefined ? checkoutRemotes(cwd) : typeof target === "function" ? target() : target;
  if (remotes instanceof Error)
    return capAt(
      source,
      autonomy,
      remotes,
      target === undefined ? "git" : "target",
      "a target that cannot be resolved never raises grants",
    );
  let capped = autonomy;
  for (const remote of Array.isArray(remotes) ? remotes : remotes.remotes)
    for (const entry of claiming) {
      const pattern = entry.remotes!.find((item) => remoteMatches(item, remote.key));
      if (pattern)
        capped = capAt(
          source,
          capped,
          { entry },
          `remote ${remote.name} ${remote.url} (workspace ${entry.name} claims ${pattern})`,
          "a checkout never exceeds the workspace that owns its remote",
        );
    }
  return capped;
}

/**
 * Whether grants could stop a raw `kind` command: a workspace claims remotes,
 * or an entry leaves `kind` ungranted (or has grants but no account). False
 * costs no git call (the shell hook asks first).
 */
export const grantsMatter = (kind: GrantKind): boolean => {
  const override = grantsOverride();
  if (override === NO_ACCOUNT) return false;
  const entries = entriesIn(accountDir());
  const matters = entries.some((entry) => {
    const autonomy = autonomyOf(entry);
    return entry.remotes?.length || autonomy.grants[kind] === false || needsAccount(autonomy);
  });
  // A broken seal falls back to sealed entries or, with none, the D4 defaults;
  // a missing seal and a config redirect fall back to the D4 defaults.
  const seal = sealOf();
  const defaults = entries.length > 0 && DEFAULT_GRANTS[kind] === false;
  return (
    matters ||
    ((seal.state === "none" || override !== null) && defaults) ||
    (seal.state === "broken" &&
      (seal.sealed ? seal.sealed.length > 0 : DEFAULT_GRANTS[kind] === false))
  );
};

/** The entries authority reads: the account's, plus a broken seal's last sealed ones. */
const authorityEntries = (): WorkspaceConfig[] => {
  const seal = sealOf();
  return [...entriesIn(accountDir()), ...(seal.state === "broken" ? (seal.sealed ?? []) : [])];
};

/** Whether any workspace claims remotes (then targets are worth resolving). */
export const remotesClaimed = (dir: string | null = accountDir()): boolean =>
  entriesIn(dir).some((entry) => entry.remotes?.length);

/** The entries whose `remotes` claim one of a target's URLs (grant show). */
export const targetClaims = (target: GrantTarget, dir: string | null = accountDir()) =>
  claimsIn(target, entriesIn(dir));

function claimsIn(
  target: GrantTarget,
  entries: WorkspaceConfig[],
): { url: string; workspace: string; pattern: string }[] | Error {
  if (target instanceof Error) return target;
  const claiming = entries.filter((entry) => entry.remotes?.length);
  return target.remotes.flatMap((remote) =>
    claiming.flatMap((entry) => {
      const pattern = entry.remotes!.find((item) => remoteMatches(item, remote.key));
      return pattern ? [{ url: remote.url, workspace: entry.name, pattern }] : [];
    }),
  );
}

/** The entries whose `remotes` claim one of `remotes` (grant show, doctor). */
const claimsOf = (remotes: CheckoutRemote[], dir: string | null) => {
  const claiming = entriesIn(dir).filter((entry) => entry.remotes?.length);
  return remotes.flatMap((remote) =>
    claiming.flatMap((entry) => {
      const pattern = entry.remotes!.find((item) => remoteMatches(item, remote.key));
      return pattern
        ? [{ remote: remote.name, url: remote.url, workspace: entry.name, pattern }]
        : [];
    }),
  );
};

/** The entries whose `remotes` claim one of `cwd`'s remote URLs (grant show, doctor). */
export function remoteClaims(
  cwd: string,
  dir: string | null = accountDir(),
): { remote: string; url: string; workspace: string; pattern: string }[] | Error {
  if (!remotesClaimed(dir)) return [];
  const remotes = checkoutRemotes(cwd);
  return remotes instanceof Error ? remotes : claimsOf(remotes, dir);
}

/**
 * What `grant show` and doctor warn about remotes (#549): a remote of this
 * checkout another workspace claims (a warning: grants here are capped at
 * it), and a workspace that claims no remotes (a note, since every entry
 * starts without: a checkout elsewhere whose origin is its remote keeps that
 * folder's grants), with the command that claims a remote no other workspace
 * claims. Git is asked once, and only when one of them needs it.
 */
export function remoteFindings(
  cwd: string,
  dir: string | null = accountDir(),
): { warnings: string[]; notes: string[] } {
  let own: WorkspaceConfig | null = null;
  try {
    own = dir === null ? null : resolveWorkspaceFrom(cwd, dir);
  } catch {
    return { warnings: [], notes: [] };
  }
  const unclaimed = own !== null && !own.remotes?.length;
  if (!unclaimed && !remotesClaimed(dir)) return { warnings: [], notes: [] };
  const remotes = checkoutRemotes(cwd);
  if (remotes instanceof Error && remotesClaimed(dir))
    return { warnings: [`${remotes.message}: grants here are capped at nothing`], notes: [] };
  const listed = remotes instanceof Error ? [] : remotes;
  const others = claimsOf(listed, dir).filter((claim) => claim.workspace !== own?.name);
  const warnings = others.map(
    (claim) =>
      `remote ${claim.remote} ${claim.url} is claimed by workspace ${claim.workspace} (${claim.pattern}): an action that targets it never exceeds ${claim.workspace}'s grants`,
  );
  const notes: string[] = [];
  if (own && unclaimed) {
    // Never suggest a remote another workspace already claims.
    const free = listed.filter((remote) => !others.some((claim) => claim.url === remote.url));
    const suggest = free.find((remote) => remote.name === "origin") ?? free[0];
    notes.push(
      `workspace ${own.name} claims no remotes, so a folder outside it whose origin is ${suggest ? suggest.url : "one of its remotes"} keeps that folder's grants; to claim it, the user runs in their own terminal: workit workspace set ${own.name} remotes=${suggest ? suggest.url : "<url>"}`,
    );
  }
  return { warnings, notes };
}

const accountOf = (entry: unknown): unknown =>
  (entry as { vcs?: { account?: unknown } } | null)?.vcs?.account;

const suggested = (kind: GrantKind): string => (kind === "merge" ? "verified" : "true");

const accountHint = (workspace: string | null): string =>
  `set vcs.account for workspace "${workspace ?? "?"}" in ${configFilePath("workspaces.json")}`;

/** The one way to clear a missing grant: the user raises it from a terminal. */
export const grantHint = (workspace: string | null, kind: GrantKind): string =>
  `ask the user to run, in their own terminal: workit grant set ${workspace ?? "<workspace>"} ${kind}=${suggested(kind)}`;

/**
 * The seam every delivery verb consults before an external effect. `forge`
 * says the effect goes through a GitHub/GitLab account (a push to a local
 * path does not).
 */
export function requireGrant(
  cwd: string,
  kind: GrantKind,
  options: {
    forge?: boolean;
    /** What the action pushes to or acts on (core/remotes.ts pushTarget, forgeTarget). */
    target?: LazyTarget;
  } = {},
): GrantDecision {
  let autonomy: Autonomy;
  try {
    autonomy = resolveAutonomy(cwd, options.target);
  } catch (error) {
    return {
      allowed: false,
      kind,
      reason: "config_invalid",
      error: `grant_unreadable: ${error instanceof Error ? error.message : String(error)}`,
      unblock: `fix ${configFilePath("workspaces.json")} (workit init → Workspaces)`,
      workspace: null,
    };
  }
  const { workspace } = autonomy;
  const value = autonomy.grants[kind];
  const configured = autonomy.configured.includes(kind);
  if (value === false)
    return {
      allowed: false,
      kind,
      reason: "grant_required",
      error: `grant_required: ${kind} is not granted for ${workspace ? `workspace "${workspace}"` : "this checkout (no workspace matches it)"}${configured ? "" : " (the default ceiling stops at verified, ready)"}${autonomy.note ? `; ${autonomy.note}` : ""}`,
      unblock:
        autonomy.unblocks?.[kind] ??
        (workspace
          ? grantHint(workspace, kind)
          : "ask the user to add a workspace for this checkout (workit init → Workspaces), then: workit grant set <workspace> " +
            `${kind}=${suggested(kind)}`),
      workspace,
    };
  if (
    autonomy.configured.length > 0 &&
    !autonomy.accountConfigured &&
    options.forge !== false &&
    kind !== "release"
  )
    return {
      allowed: false,
      kind,
      reason: "account_required",
      error: `account_required: workspace "${workspace ?? "?"}" has autonomy grants but no vcs.account, so the credential cannot be checked`,
      unblock: accountHint(workspace),
      workspace,
    };
  return {
    allowed: true,
    kind,
    source: configured ? autonomy.source : "default",
    allowUnverified: kind === "merge" && value === true,
    workspace,
  };
}

/**
 * Why a raw shell command (the pre-tool hook: `git push`, `gh pr create`, a
 * release) may not run, or null. Only what a workspace governs is judged: a
 * workspace claims remotes, or some entry could leave `kind` ungranted
 * (otherwise no git runs). A folder outside every workspace, with nothing
 * claimed, keeps today's behaviour. A target that cannot be resolved denies.
 */
export function rawGrantDenial(
  cwd: string,
  kind: GrantKind,
  target?: LazyTarget,
): { error: string; unblock: string } | null {
  const entries = authorityEntries();
  const claimed = entries.some((entry) => entry.remotes?.length);
  if (!grantsMatter(kind)) return null;
  // Resolved once: the cap and the claim check below share it.
  let resolved: GrantTarget | undefined;
  const lazy = target && (() => (resolved ??= typeof target === "function" ? target() : target));
  let autonomy: Autonomy;
  try {
    autonomy = resolveAutonomy(cwd, lazy);
  } catch (error) {
    return claimed
      ? {
          error: String(error),
          unblock: `fix ${configFilePath("workspaces.json")}`,
        }
      : null;
  }
  const { workspace, note } = autonomy;
  const capped = autonomy.unblocks?.[kind];
  if (autonomy.grants[kind] !== false) return null;
  if (workspace !== null || capped)
    return {
      error: `${kind} is not granted for ${workspace ? `workspace ${workspace}` : "this checkout"}${note ? ` (${note})` : ""}`,
      unblock: capped ?? grantHint(workspace, kind),
    };
  // A folder outside every workspace: judged only by a workspace that claims
  // the target and does not grant `kind` (a default-false grant records no cap).
  if (!claimed || !lazy) return null;
  const claims = claimsIn(lazy(), entries);
  if (claims instanceof Error)
    return { error: `${kind}: ${claims.message}`, unblock: "name a target workit can resolve" };
  // Any entry of that name, current or last sealed, that does not grant `kind`.
  const strict = claims.find(({ workspace: name }) =>
    entries.some((item) => item.name === name && autonomyOf(item).grants[kind] === false),
  );
  return strict
    ? {
        error: `${kind} is not granted for workspace ${strict.workspace}, which claims ${strict.url} (${strict.pattern})`,
        unblock: grantHint(strict.workspace, kind),
      }
    : null;
}

/** Whether `next` grants more than `current` (false < "verified" < true). */
export const raises = (kind: GrantKind, current: GrantValue, next: GrantValue): boolean => {
  const rank = (value: GrantValue) => (value === true ? 2 : value === "verified" ? 1 : 0);
  return rank(normalized(kind, next)) > rank(normalized(kind, current));
};

export type GrantWrite =
  | (EndpointView & {
      ok: true;
      path: string;
      backup: string | null;
      workspace: string;
      grants: Grants;
      configured: GrantKind[];
      verification: VerificationMode;
      seal: SealAfter;
    })
  | {
      ok: false;
      code: "not_found" | "invalid_input" | "failed";
      error: string;
    };

/** What a write did to the seal (see sealAfterWrite). */
export type SealAfter = "unchanged" | "resealed" | "mismatch";

/**
 * Set (`value`) or unset (`undefined`) grants of a named workspace in the
 * user's workspaces.json. The caller decides whether raising is allowed (an
 * interactive terminal only); this only writes, atomically, after copying
 * the previous file to `workspaces.json.bak`. A legacy `autoApprove` is
 * folded into `autonomy` on the first write and removed.
 */
export function writeGrants(
  workspaceName: string,
  changes: readonly { kind: GrantKind; value: GrantValue | undefined }[],
  dir: string | null = shownGrantsDir(),
  /** A new default endpoint; `null` removes it (back to `commit`). */
  endpoint?: DefaultEndpoint | null,
  /** A new verification mode; `null` removes it (back to `proportional`). */
  verification?: VerificationMode | null,
  /** The user at an interactive terminal outside an agent (see sealAfterWrite). */
  terminal = false,
): GrantWrite {
  if (dir === null) return { ok: false, code: "failed", error: NO_ACCOUNT };
  const before = sealBefore(dir);
  const current = readWorkspacesResult(dir);
  if (current.status === "missing")
    return {
      ok: false,
      code: "not_found",
      error: `${current.path} does not exist`,
    };
  if (current.status !== "valid" || !current.document)
    return {
      ok: false,
      code: "invalid_input",
      error: current.error ?? "invalid workspaces.json",
    };
  const document = structuredClone(current.document) as {
    workspaces?: Record<string, unknown>[];
  };
  const entry = document.workspaces?.find((item) => item.name === workspaceName);
  if (!entry)
    return {
      ok: false,
      code: "not_found",
      error: `no workspace named "${workspaceName}" in ${current.path}`,
    };
  const { grants } = configuredGrants(entry);
  for (const { kind, value } of changes)
    if (value === undefined) delete grants[kind];
    else grants[kind] = normalized(kind, value);
  // Keys this version does not know stay as they are (S16 review L6).
  const unknown = Object.fromEntries(
    Object.entries(
      entry.autonomy && typeof entry.autonomy === "object" && !Array.isArray(entry.autonomy)
        ? (entry.autonomy as Record<string, unknown>)
        : {},
    ).filter(([key]) => !isGrantKind(key)),
  );
  delete entry.autoApprove;
  if (endpoint === null || endpoint === DEFAULT_ENDPOINT) delete entry.defaultEndpoint;
  else if (endpoint) entry.defaultEndpoint = endpoint;
  if (verification === null || verification === DEFAULT_VERIFICATION) delete entry.verification;
  else if (verification) entry.verification = verification;
  const autonomy = {
    ...unknown,
    ...Object.fromEntries(
      GRANT_KINDS.filter((item) => grants[item] !== undefined).map((item) => [item, grants[item]]),
    ),
  };
  if (Object.keys(autonomy).length === 0) delete entry.autonomy;
  else entry.autonomy = autonomy;
  const validated = validateWorkspacesDocument(document, current.path);
  if (validated.status !== "valid")
    return {
      ok: false,
      code: "invalid_input",
      error: validated.error ?? "invalid result",
    };
  // Re-read just before writing: a concurrent edit wins over this one.
  const latest = readWorkspacesResult(dir);
  if (latest.revision !== current.revision)
    return {
      ok: false,
      code: "failed",
      error: `${current.path} changed; retry`,
    };
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
      code: "failed",
      error: `failed to write ${current.path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const full = { ...DEFAULT_GRANTS, ...grants };
  const configured = GRANT_KINDS.filter((kind) => grants[kind] !== undefined);
  return {
    ok: true,
    path: current.path,
    backup,
    workspace: workspaceName,
    grants: full,
    configured,
    ...endpointView(entry, {
      workspace: workspaceName,
      grants: full,
      configured,
      accountConfigured: Boolean(accountOf(entry)),
    }),
    verification: verificationOf(entry),
    seal: sealAfterWrite(before, terminal, document.workspaces ?? []),
  };
}

/** The seal as a writer found it before writing (see sealAfterWrite). */
export type SealBefore = {
  dir: string;
  check: SealCheck;
  entries: WorkspaceConfig[];
} | null;

/**
 * Read before a write to `<dir>/workspaces.json`: null unless `dir` is the
 * account's own dir (a redirected file or a bench world's never touches the
 * seal), so "the seal matched before" is judged on the pre-write read.
 */
export function sealBefore(dir: string): SealBefore {
  const account = accountDir();
  if (account === null || path.resolve(dir) !== path.resolve(account)) return null;
  if (evalWorld(process.cwd())) return null;
  const read = readWorkspacesResult(dir);
  return { dir, check: checkSeal(dir), entries: read.entries };
}

/**
 * After a write to the account's workspaces.json. When the authority fields
 * did not move, the seal stays as it was. Otherwise a terminal write
 * (`terminal`: the user, outside an agent) reseals when the seal matched
 * before; any other write reseals only when its result only lowers the sealed
 * values (lowersOnly). Everything else leaves the seal mismatched: then the
 * stricter-of fallback applies until the user runs `workit workspace seal`.
 * Only `written`, the entries this writer wrote, are ever sealed: when the
 * file holds anything else by now (another write landed in between), the
 * seal is left mismatched.
 */
export function sealAfterWrite(
  before: SealBefore,
  terminal: boolean,
  written: readonly unknown[],
): SealAfter {
  if (before === null) return "unchanged";
  const projection = (entries: readonly unknown[]) => JSON.stringify(sealProjection(entries));
  const after = readWorkspacesResult(before.dir).entries;
  if (projection(after) === projection(before.entries)) return "unchanged";
  if (projection(after) !== projection(written)) return "mismatch";
  const sealed =
    before.check.state === "valid"
      ? before.entries
      : before.check.state === "broken"
        ? before.check.sealed
        : null;
  const reseal = terminal
    ? before.check.state === "valid"
    : sealed !== null && lowersOnly(sealed, written);
  if (!reseal) return "mismatch";
  writeSeal(before.dir, written);
  return "resealed";
}

const SCOPE_FIELDS = new Set([
  "autonomy",
  "autoApprove",
  "defaultEndpoint",
  "verification",
  "youtrack",
]);

/**
 * Whether `next` keeps every entry of `sealed` in place (name, glob, remotes,
 * forge identity) and only lowers grants, endpoint, verification and
 * youtrack.writes, or keeps them. Anything else (an entry added, removed or
 * moved, a glob, remote or identity change) is not a lowering.
 */
export function lowersOnly(sealed: readonly unknown[], next: readonly unknown[]): boolean {
  if (sealed.length !== next.length) return false;
  const scope = (entry: Record<string, unknown>) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(entry)
          .filter(([key]) => !SCOPE_FIELDS.has(key))
          .toSorted(([a], [b]) => (a < b ? -1 : 1)),
      ),
    );
  const [was, now] = [sealProjection(sealed), sealProjection(next)];
  return was.every((entry, at) => {
    if (scope(entry) !== scope(now[at])) return false;
    const before = autonomyOf(sealed[at] as WorkspaceConfig);
    const after = autonomyOf(next[at] as WorkspaceConfig);
    const writes = (item: unknown) =>
      (item as { youtrack?: { writes?: unknown } }).youtrack?.writes === "auto";
    return (
      !GRANT_KINDS.some((kind) => raises(kind, before.grants[kind], after.grants[kind])) &&
      !raisesEndpoint(before.defaultEndpoint, after.defaultEndpoint) &&
      VERIFICATION_STRICTNESS.indexOf(after.verification) <=
        VERIFICATION_STRICTNESS.indexOf(before.verification) &&
      !(needsAccount(before) && !needsAccount(after)) &&
      (writes(sealed[at]) || !writes(next[at]))
    );
  });
}

/** The account's seal for doctor, `workspace seal` and the setup/upgrade offer. */
export type SealStatus =
  | { state: "no_account"; note: string }
  | {
      state: "none" | "valid" | "broken";
      dir: string;
      reason?: string;
      /** What sealing now would accept (sealDiffLines). */
      diff: string[];
      /** The account file cannot be read: nothing can be sealed. */
      error?: string;
      entries: WorkspaceConfig[];
    };

/** The seal of the account's own workspaces.json (never a redirected one). */
export function sealStatus(): SealStatus {
  const dir = accountDir();
  if (dir === null) return { state: "no_account", note: NO_ACCOUNT };
  const check = checkSeal(dir);
  const read = readWorkspacesResult(dir);
  const error = read.status === "malformed" || read.status === "invalid" ? read.error : undefined;
  return {
    state: check.state,
    dir,
    ...(check.state === "broken" ? { reason: check.reason } : {}),
    diff: check.state === "valid" ? [] : sealDiffLines(sealedProjection(dir), read.entries),
    ...(error ? { error } : {}),
    entries: read.entries,
  };
}

/**
 * Seal the account's workspaces.json as it is now; the user's terminal only.
 * `shown`: the entries whose authority fields the user was shown; when the
 * file's differ by now, nothing is written (they did not see what would be sealed).
 */
export function sealAccount(
  shown?: readonly unknown[],
): { ok: true; path: string } | { ok: false; error: string } {
  const status = sealStatus();
  if (status.state === "no_account") return { ok: false, error: status.note };
  if (status.error) return { ok: false, error: status.error };
  if (
    shown &&
    JSON.stringify(sealProjection(shown)) !== JSON.stringify(sealProjection(status.entries))
  )
    return {
      ok: false,
      error: `workspaces.json changed while you were asked; nothing was sealed. Run ${SEAL_COMMAND} again`,
    };
  try {
    return { ok: true, path: writeSeal(status.dir, status.entries) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Why a forge verb may not use the runtime identity (`runtime`, the resolved
 * workspace's vcs): the seal is broken, a last sealed entry resolves for
 * `cwd`, and its provider, account, credential file or host differ. Null otherwise:
 * no seal, no sealed entry here, or a config redirect (grants are then at most
 * the D4 defaults). A sealed entry that cannot resolve is a denial.
 */
export function identityDenial(
  cwd: string,
  runtime: { name?: string; vcs?: unknown } | null,
): string | null {
  const dir = accountDir();
  if (dir === null || redirected(dir)) return null;
  const seal = checkSeal(dir);
  if (seal.state !== "broken" || !seal.sealed) return null;
  const name = process.env.WORKIT_WORKSPACE_NAME?.trim() || undefined;
  let sealed: WorkspaceConfig | null;
  try {
    sealed = resolveWorkspaceFromEntries(cwd, seal.sealed, name);
  } catch (error) {
    return `identity_unsealed: workspaces.json does not match its seal and the sealed entries do not resolve here (${error instanceof Error ? error.message : String(error)})`;
  }
  // The runtime entry is picked the same way (resolveRuntimeWorkspaceVcs reads
  // WORKIT_WORKSPACE_NAME too); should the two ever pick differently, the
  // sealed entry of the runtime's own name must match as well (fail safe).
  const named = runtime?.name
    ? seal.sealed.find((entry) => entry.name === runtime.name)
    : undefined;
  const differs = [sealed, named].find(
    (entry) => entry && identityOf(entry.vcs) !== identityOf(runtime?.vcs),
  );
  if (!differs) return null;
  return `identity_unsealed: workspace ${differs.name}'s forge identity (vcs.provider, account, credential file, host) differs from the sealed one, and workspaces.json does not match its seal (${seal.reason})`;
}

/** Every workspace's grants, for `workit grant show --all`. */
export function listGrants(dir: string | null = shownGrantsDir()): {
  path: string;
  workspaces: (EndpointView & {
    name: string;
    glob: string;
    grants: Grants;
    configured: GrantKind[];
    verification: VerificationMode;
  })[];
  error?: string;
} {
  if (dir === null) return { path: "", workspaces: [], error: NO_ACCOUNT };
  const current = readWorkspacesResult(dir);
  if (current.status === "malformed" || current.status === "invalid")
    return { path: current.path, workspaces: [], error: current.error };
  return {
    path: current.path,
    workspaces: current.entries.map((entry) => {
      const { grants } = configuredGrants(entry);
      const full = { ...DEFAULT_GRANTS, ...grants };
      const configured = GRANT_KINDS.filter((kind) => grants[kind] !== undefined);
      return {
        name: entry.name,
        glob: entry.glob,
        grants: full,
        configured,
        ...endpointView(entry, {
          workspace: entry.name,
          grants: full,
          configured,
          accountConfigured: Boolean(entry.vcs?.account),
        }),
        verification: verificationOf(entry),
      };
    }),
  };
}
