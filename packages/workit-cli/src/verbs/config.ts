// `workit config show [--json]` (W2.8): the effective configuration for this
// checkout and where each value comes from, read-only. Agents asked "which
// forge, which models, which lease settings apply here?" by reading
// workspaces.json and vcs.json by hand; this answers from the same resolvers
// the verbs use (vcsConfig, resolveRoleModel, resolveResourceSettings).
import { CHECKS_FILE, loadCheckConfig } from "@workit-dev/core/src/check-config";
import { resolveRuntimeWorkspaceVcs, workspacesPath } from "@workit-dev/core/src/core/workspaces";
import { ROLE_SELECTORS, resolveRoleModel } from "@workit-dev/core/src/core/role-models";
import {
  resolveResourceSettings,
  type ResourceSettings,
} from "@workit-dev/core/src/core/resources";
import { actorFromEnv } from "@workit-dev/core/src/ledger";
import { emit, fail, ok, type Io } from "../output";
import { workspaceResources } from "./check";
import { vcsView, type Sourced } from "./config-vcs";

const USAGE = "workit config show [--json]";

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Each resolved resource setting with the layer that set it: the built-in
 * default, the workspace's `resources` in workspaces.json, or the repo's
 * checks.json (which can only tighten).
 */
async function resourcesView(
  io: Io,
): Promise<{ settings: Record<string, Sourced<unknown>>; warnings: string[] }> {
  const workspace = await workspaceResources(io);
  const repo = loadCheckConfig(io.cwd).resources;
  const machine = {
    label: "workspaces.json",
    trust: "machine" as const,
    value: workspace.value,
  };
  const defaults = resolveResourceSettings([]).settings;
  const fromMachine = resolveResourceSettings([machine]).settings;
  const full = resolveResourceSettings([
    machine,
    { label: CHECKS_FILE, trust: "repo", value: repo },
  ]);
  const settings: Record<string, Sourced<unknown>> = {};
  for (const key of Object.keys(full.settings) as (keyof ResourceSettings)[]) {
    const value = full.settings[key];
    settings[key] = {
      value,
      source: !same(value, fromMachine[key])
        ? `resources in ${CHECKS_FILE}`
        : !same(value, defaults[key])
          ? `resources in ${workspacesPath()}`
          : "default",
    };
  }
  return {
    settings,
    warnings: [...(workspace.warning ? [workspace.warning] : []), ...full.warnings],
  };
}

const show = (value: unknown): string =>
  value === null || value === undefined
    ? "(none)"
    : Array.isArray(value)
      ? value.join(", ") || "(none)"
      : String(value);

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv.filter((arg) => arg !== "--json");
  if (sub !== "show" || rest.length)
    return emit(
      io,
      fail("invalid_input", rest.length ? `unexpected argument ${rest[0]}` : `usage: ${USAGE}`, {
        unblock: "workit help config",
      }),
    );
  const workspace = resolveRuntimeWorkspaceVcs(io.cwd);
  const envHost = actorFromEnv(io.env).host;
  const host = envHost === "cli" ? "claude_code" : envHost;
  const models: Record<string, Sourced<string | null> & { effort: string | null }> = {};
  for (const selector of ROLE_SELECTORS) {
    const chosen = resolveRoleModel(io.cwd, selector, host);
    models[selector.tier ? `${selector.role} ${selector.tier}` : selector.role] = {
      value: chosen?.model ?? null,
      effort: chosen?.effort ?? null,
      source: chosen?.source ?? "none (the host's own default)",
    };
  }
  const resources = await resourcesView(io);
  const data = {
    workspace: {
      value: workspace?.name ?? null,
      source: workspace ? workspacesPath() : `no entry in ${workspacesPath()} matches ${io.cwd}`,
    },
    vcs: vcsView(io.cwd),
    models: { host, roles: models },
    resources: resources.settings,
    ...(resources.warnings.length ? { warnings: resources.warnings } : {}),
  };
  return emit(io, ok(data), (shown) => [
    `workspace: ${show(shown.workspace.value)}  [${shown.workspace.source}]`,
    "vcs:",
    `  provider: ${show(shown.vcs.provider.value)}  [${shown.vcs.provider.source}]`,
    `  default target branch: ${show(shown.vcs.defaultTargetBranch.value)}  [${shown.vcs.defaultTargetBranch.source}]`,
    `models (${shown.models.host}):`,
    ...Object.entries(shown.models.roles).map(
      ([role, entry]) =>
        `  ${role}: ${show(entry.value)}${entry.effort ? ` (effort ${entry.effort})` : ""}  [${entry.source}]`,
    ),
    "resources:",
    ...Object.entries(shown.resources).map(
      ([key, entry]) => `  ${key}: ${show(entry.value)}  [${entry.source}]`,
    ),
    ...(shown.warnings ?? []).map((warning) => `warning: ${warning}`),
  ]);
}
