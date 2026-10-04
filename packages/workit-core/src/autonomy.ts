// Autonomy grants (D4, D15; design §0 #12, §4.2): the per-workspace ceiling on
// what an agent may deliver without asking. S11 introduces the reader and the
// one seam every delivery verb consults, `requireGrant(kind)`; S16 adds
// `workit grant`, the D4 defaults and the legacy `autoApprove` mapping.
//
// Today (S11):
// - Grants are read only from the matched workspace entry in the user's
//   `~/.config/workit/workspaces.json` (`"autonomy": {"push": true, "pr": true,
//   "merge": false | true | "verified", "release": false}`), never from a repo
//   file, and nothing here writes them (D15: never raised headless).
// - An explicit value is honored: `false` denies with `grant_required`, `true`
//   allows, and `merge: "verified"` allows only with an accepted independent
//   verdict (S13). `merge: true` is the only way to merge without one.
// - An absent grant is allowed on the host's own authority (`source:
//   "host_authority"`): the host permission prompt is the ceiling, and a merge
//   still needs an accepted verdict. S16 replaces that default with the D4
//   ceiling `{push: true, pr: true, merge: false, release: false}`.
// - Grants require an account (design §2.0 Identity): a workspace with any
//   grant but no `vcs.account` cannot push, open or merge through a forge,
//   so a personal grant never rides a work credential.
import { resolveRuntimeWorkspaceVcs } from "./core/workspaces";

export type GrantKind = "push" | "pr" | "merge" | "release";
const GRANT_KINDS: readonly GrantKind[] = ["push", "pr", "merge", "release"];

/** One grant as configured: `"verified"` means allowed with an accepted verdict. */
export type GrantValue = boolean | "verified";

export type Autonomy = {
  workspace: string | null;
  /** Explicitly configured grants; a kind that is absent falls back to host authority. */
  grants: Partial<Record<GrantKind, GrantValue>>;
  source: "autonomy" | "host_authority";
  accountConfigured: boolean;
};

export type GrantDecision =
  | {
      allowed: true;
      kind: GrantKind;
      /** Where the permission came from. */
      source: "autonomy" | "host_authority";
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

const isGrantValue = (value: unknown): value is GrantValue =>
  value === true || value === false || value === "verified";

/** The grants for the workspace `cwd` belongs to (read-only). */
export function resolveAutonomy(cwd: string): Autonomy {
  const workspace = resolveRuntimeWorkspaceVcs(cwd);
  const raw = (workspace as { autonomy?: unknown } | null)?.autonomy;
  const grants: Autonomy["grants"] = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    for (const kind of GRANT_KINDS) {
      const value = (raw as Record<string, unknown>)[kind];
      if (isGrantValue(value)) grants[kind] = value;
    }
  return {
    workspace: workspace?.name ?? null,
    grants,
    source: Object.keys(grants).length > 0 ? "autonomy" : "host_authority",
    accountConfigured: Boolean(workspace?.vcs?.account),
  };
}

const grantHint = (workspace: string | null, kind: GrantKind): string =>
  `ask the user to set "autonomy": {"${kind}": ${kind === "merge" ? '"verified"' : "true"}} for workspace "${workspace ?? "?"}" in ~/.config/workit/workspaces.json (S16: workit grant set ${workspace ?? "<workspace>"} ${kind}=${kind === "merge" ? "verified" : "true"})`;

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
  if (value === false)
    return {
      allowed: false,
      kind,
      reason: "grant_required",
      error: `grant_required: ${kind} is not granted for workspace "${workspace ?? "?"}"`,
      unblock: grantHint(workspace, kind),
      workspace,
    };
  if (
    autonomy.source === "autonomy" &&
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
    source: value === undefined ? "host_authority" : "autonomy",
    requireVerdict: kind === "merge" && value !== true,
    workspace,
  };
}
