// Autonomy grants (D2, D4, D15; design §0 #12, §4.2): the per-workspace
// ceiling on what an agent may deliver without asking. Authority is the
// host's own permission prompt plus these grants; no approval ticket or
// checkout lease stands behind them.
//
// - Grants live only in the matched workspace entry of the user's
//   `~/.config/workit/workspaces.json`, where `~` is the OS account's home
//   (neither $HOME nor config-dir overrides redirect them; see grantsDir):
//     "autonomy": { "push": true, "pr": true, "merge": false | true | "verified",
//                   "release": false, "rerun": true }
//   never in a repo file. `workit grant set` raises only from an interactive
//   terminal (see verbs/grant.ts). Threat model (D18): this stops an honest
//   agent from raising its own ceiling by accident, not an adversarial one —
//   a process that drives a pseudo-terminal or edits the file directly can
//   still defeat it; the host's permission prompt is the hard boundary.
// - `release` has no consuming verb yet; it is reserved, not enforced.
// - Defaults (D4) when a kind is absent: push, pr and rerun are allowed;
//   merge and release need an explicit grant. The default ceiling is a stack
//   opened, CI green and independently verified: "verified, ready".
// - `merge: "verified"` allows a merge only with an accepted independent
//   verdict (S13); `merge: true` is the only way to merge without one.
// - A legacy `autoApprove: true | [classes]` maps once to grants (its `merge`
//   class becomes `merge: "verified"`; `branch`/`commit` are local, dropped).
// - Explicitly configured grants require an account (design §2.0 Identity):
//   a workspace with grants but no `vcs.account` cannot push, open or merge
//   through a forge, so a personal grant never rides a work credential.
// - Protected-branch pushes stay denied by the git verbs, and the host
//   permission prompt applies in addition: a host deny always wins.
import { copyFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigDir } from "./core/config";
import { writeFileAtomic } from "./core/safe-write";
import {
  readWorkspacesResult,
  resolveWorkspaceFrom,
  validateWorkspacesDocument,
} from "./core/workspaces";

/**
 * Grants are read only from the user's real config directory,
 * `<account home>/.config/workit` (D15; see grantsHome). The WORKFLOW_TOOLKIT_CONFIG(_DIR) and
 * XDG_CONFIG_HOME overrides that redirect the rest of the config never
 * redirect grants: an agent could point them at a file it wrote. While an
 * override points elsewhere, grants resolve to the D4 defaults.
 */
const accountHome = (): string => {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
};

/**
 * Where grants are read from: the OS account record's home directory, never
 * `$HOME` (an agent can set that for one command). Tests swap `resolve`
 * in-process; nothing outside this process can change it.
 */
export const grantsHome = { resolve: accountHome };

export const grantsDir = (): string => path.join(grantsHome.resolve(), ".config", "workit");

/** Why grants fell back to the defaults, or null when the real file is used. */
export const grantsOverride = (): string | null => {
  const configured = path.resolve(resolveConfigDir());
  return configured === path.resolve(grantsDir())
    ? null
    : `the config directory is redirected to ${configured} (WORKFLOW_TOOLKIT_CONFIG, WORKFLOW_TOOLKIT_CONFIG_DIR or XDG_CONFIG_HOME); grants are read only from ${path.join(grantsDir(), "workspaces.json")}, so the D4 defaults apply`;
};

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
function endpointOf(entry: unknown): { raw: unknown; endpoint: DefaultEndpoint; issue?: string } {
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
 * reason names the unblock.
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
      reason: `vcs.account missing; set vcs.account for workspace "${context.workspace ?? "?"}" in ~/.config/workit/workspaces.json`,
    };
  if (endpoint === "merged" && context.grants.merge === false)
    return { endpoint: "green", reason: missing("merge") };
  return { endpoint };
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
 * How a normal-risk behavior change is verified (S17). `self` (default): an
 * observed passing `workit check test` plus the author's own `--self`
 * verdict, labelled self-reviewed. `independent`: a verdict from a session
 * that did not author the branch. User config only, like grants.
 */
export type VerificationMode = "self" | "independent";
export const DEFAULT_VERIFICATION: VerificationMode = "self";
export const verificationOf = (entry: unknown): VerificationMode =>
  (entry as { verification?: unknown } | null)?.verification === "independent"
    ? "independent"
    : "self";

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
  /** Set when the grants file was not read (see grantsOverride). */
  note?: string;
};

export type GrantDecision =
  | {
      allowed: true;
      kind: GrantKind;
      /** Where the permission came from. */
      source: AutonomySource;
      /** A merge must also have an accepted independent verdict (S13). */
      requireVerdict: boolean;
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

/** The grants for the workspace `cwd` belongs to (read-only). */
export function resolveAutonomy(cwd: string): Autonomy {
  const override = grantsOverride();
  if (override)
    return {
      workspace: null,
      grants: { ...DEFAULT_GRANTS },
      configured: [],
      source: "default",
      accountConfigured: false,
      defaultEndpoint: DEFAULT_ENDPOINT,
      configuredEndpoint: null,
      effectiveEndpoint: DEFAULT_ENDPOINT,
      verification: DEFAULT_VERIFICATION,
      note: override,
    };
  const workspace = resolveWorkspaceFrom(
    cwd,
    grantsDir(),
    process.env.WORKFLOW_WORKSPACE_NAME?.trim() || undefined,
  );
  const { grants, source } = configuredGrants(workspace);
  const full = { ...DEFAULT_GRANTS, ...grants };
  const configured = GRANT_KINDS.filter((kind) => grants[kind] !== undefined);
  const accountConfigured = Boolean(workspace?.vcs?.account);
  return {
    workspace: workspace?.name ?? null,
    grants: full,
    configured,
    source,
    accountConfigured,
    ...endpointView(workspace, {
      workspace: workspace?.name ?? null,
      grants: full,
      configured,
      accountConfigured,
    }),
    verification: verificationOf(workspace),
  };
}

const accountOf = (entry: unknown): unknown =>
  (entry as { vcs?: { account?: unknown } } | null)?.vcs?.account;

const suggested = (kind: GrantKind): string => (kind === "merge" ? "verified" : "true");

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
  options: { forge?: boolean } = {},
): GrantDecision {
  let autonomy: Autonomy;
  try {
    autonomy = resolveAutonomy(cwd);
  } catch (error) {
    return {
      allowed: false,
      kind,
      reason: "config_invalid",
      error: `grant_unreadable: ${error instanceof Error ? error.message : String(error)}`,
      unblock: "fix ~/.config/workit/workspaces.json (workit init → Workspaces)",
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
      unblock: workspace
        ? grantHint(workspace, kind)
        : "ask the user to add a workspace for this checkout (workit init → Workspaces), then: workit grant set <workspace> " +
          `${kind}=${suggested(kind)}`,
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
      unblock: `set vcs.account for workspace "${workspace ?? "?"}" in ~/.config/workit/workspaces.json`,
      workspace,
    };
  return {
    allowed: true,
    kind,
    source: configured ? autonomy.source : "default",
    requireVerdict: kind === "merge" && value !== true,
    workspace,
  };
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
    })
  | { ok: false; code: "not_found" | "invalid_input" | "failed"; error: string };

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
  dir: string = grantsDir(),
  /** A new default endpoint; `null` removes it (back to `commit`). */
  endpoint?: DefaultEndpoint | null,
  /** A new verification mode; `null` removes it (back to `self`). */
  verification?: VerificationMode | null,
): GrantWrite {
  const current = readWorkspacesResult(dir);
  if (current.status === "missing")
    return { ok: false, code: "not_found", error: `${current.path} does not exist` };
  if (current.status !== "valid" || !current.document)
    return { ok: false, code: "invalid_input", error: current.error ?? "invalid workspaces.json" };
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
    return { ok: false, code: "invalid_input", error: validated.error ?? "invalid result" };
  // Re-read just before writing: a concurrent edit wins over this one.
  const latest = readWorkspacesResult(dir);
  if (latest.revision !== current.revision)
    return { ok: false, code: "failed", error: `${current.path} changed; retry` };
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
  };
}

/** Every workspace's grants, for `workit grant show --all`. */
export function listGrants(dir: string = grantsDir()): {
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
