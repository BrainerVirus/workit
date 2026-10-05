// Autonomy grants (D2, D4, D15; design §0 #12, §4.2): the per-workspace
// ceiling on what an agent may deliver without asking. Authority is the
// host's own permission prompt plus these grants; no approval ticket or
// checkout lease stands behind them.
//
// - Grants live only in the matched workspace entry of the user's
//   `$HOME/.config/workit/workspaces.json` (config-dir overrides never
//   redirect them; see grantsDir):
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
 * `$HOME/.config/workit` (D15). The WORKFLOW_TOOLKIT_CONFIG(_DIR) and
 * XDG_CONFIG_HOME overrides that redirect the rest of the config never
 * redirect grants: an agent could point them at a file it wrote. While an
 * override points elsewhere, grants resolve to the D4 defaults.
 */
export const grantsDir = (): string =>
  path.join(process.env.HOME || os.homedir(), ".config", "workit");

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
 * Where an unnamed request stops (skills read it): `commit` (default) ends at
 * a local commit; `pr` goes on to push and open the PR. User config only,
 * same rules as grants: raising commit → pr needs the user at a terminal.
 */
export type DefaultEndpoint = "commit" | "pr";
export const DEFAULT_ENDPOINT: DefaultEndpoint = "commit";
const endpointOf = (entry: unknown): DefaultEndpoint =>
  (entry as { defaultEndpoint?: unknown } | null)?.defaultEndpoint === "pr" ? "pr" : "commit";

export type AutonomySource = "autonomy" | "autoApprove" | "default";

export type Autonomy = {
  workspace: string | null;
  /** Every kind, with absent ones filled from DEFAULT_GRANTS. */
  grants: Grants;
  /** The kinds the user configured explicitly (the rest are defaults). */
  configured: GrantKind[];
  source: AutonomySource;
  accountConfigured: boolean;
  defaultEndpoint: DefaultEndpoint;
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
      note: override,
    };
  const workspace = resolveWorkspaceFrom(
    cwd,
    grantsDir(),
    process.env.WORKFLOW_WORKSPACE_NAME?.trim() || undefined,
  );
  const { grants, source } = configuredGrants(workspace);
  return {
    workspace: workspace?.name ?? null,
    grants: { ...DEFAULT_GRANTS, ...grants },
    configured: GRANT_KINDS.filter((kind) => grants[kind] !== undefined),
    source,
    accountConfigured: Boolean(workspace?.vcs?.account),
    defaultEndpoint: endpointOf(workspace),
  };
}

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
  | {
      ok: true;
      path: string;
      backup: string | null;
      workspace: string;
      grants: Grants;
      configured: GrantKind[];
      defaultEndpoint: DefaultEndpoint;
    }
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
  return {
    ok: true,
    path: current.path,
    backup,
    workspace: workspaceName,
    grants: { ...DEFAULT_GRANTS, ...grants },
    configured: GRANT_KINDS.filter((kind) => grants[kind] !== undefined),
    defaultEndpoint: endpointOf(entry),
  };
}

/** Every workspace's grants, for `workit grant show --all`. */
export function listGrants(dir: string = grantsDir()): {
  path: string;
  workspaces: {
    name: string;
    glob: string;
    grants: Grants;
    configured: GrantKind[];
    defaultEndpoint: DefaultEndpoint;
  }[];
  error?: string;
} {
  const current = readWorkspacesResult(dir);
  if (current.status === "malformed" || current.status === "invalid")
    return { path: current.path, workspaces: [], error: current.error };
  return {
    path: current.path,
    workspaces: current.entries.map((entry) => {
      const { grants } = configuredGrants(entry);
      return {
        name: entry.name,
        glob: entry.glob,
        grants: { ...DEFAULT_GRANTS, ...grants },
        configured: GRANT_KINDS.filter((kind) => grants[kind] !== undefined),
        defaultEndpoint: endpointOf(entry),
      };
    }),
  };
}
