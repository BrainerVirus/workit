// `workit models show [--role <r>] [--tier <t>] [--host <h>]` (#395): the
// model and effort each role runs on for a host, from `models.roles` in
// workspaces.json (workspace, then global default), `fanout.tierModels` for
// the implementer tiers, then Claude Code's built-in defaults. Skills call it
// to know what to pass as `model` (and `effort`) when they spawn a role.
import {
  MODEL_ROLES,
  MODEL_TIERS,
  ROLE_SELECTORS,
  resolveRoleModel,
  roleModelIssues,
  type ModelRole,
  type ModelTier,
} from "@brainervirus/workit-core/src/core/role-models";
import { actorFromEnv } from "@brainervirus/workit-core/src/ledger";
import { emit, fail, ok, type Io } from "../output";

const USAGE = "workit models show [--role <role>] [--tier <tier>] [--host <host>] [--json]";

const flag = (argv: string[], name: string): string | null | Error => {
  const at = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (at < 0) return null;
  const value = argv[at].includes("=") ? argv[at].slice(name.length + 1) : argv[at + 1];
  return value && !value.startsWith("--") ? value : new Error(`${name} needs a value`);
};

type Row = { model: string | null; effort: string | null; source: string };

const line = (label: string, entry: Row): string =>
  `  ${label}: ${
    entry.model
      ? `${entry.model}${entry.effort ? ` (effort ${entry.effort})` : ""}  [${entry.source}]`
      : "host default (nothing configured)"
  }`;

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...args] = argv.filter((arg) => arg !== "--json");
  if (sub !== "show")
    return emit(io, fail("invalid_input", `usage: ${USAGE}`, { unblock: "workit help models" }));
  const role = flag(args, "--role");
  const tier = flag(args, "--tier");
  const hostFlag = flag(args, "--host");
  for (const value of [role, tier, hostFlag])
    if (value instanceof Error) return emit(io, fail("invalid_input", value.message));
  if (role && !(MODEL_ROLES as readonly string[]).includes(role as string))
    return emit(io, fail("invalid_input", `unknown role ${role}: ${MODEL_ROLES.join(", ")}`));
  if (tier && !(MODEL_TIERS as readonly string[]).includes(tier as string))
    return emit(io, fail("invalid_input", `unknown tier ${tier}: ${MODEL_TIERS.join(", ")}`));
  const envHost = actorFromEnv(io.env).host;
  const host = (hostFlag as string | null) ?? (envHost === "cli" ? "claude_code" : envHost);
  const row = (selector: { role: ModelRole; tier?: ModelTier }): Row =>
    resolveRoleModel(io.cwd, selector, host) ?? { model: null, effort: null, source: "none" };
  const roles: Record<string, Row | Record<string, Row>> = {};
  for (const selector of ROLE_SELECTORS) {
    if (role && selector.role !== role) continue;
    if (selector.tier) {
      if (tier && selector.tier !== tier) continue;
      const tiers = (roles[selector.role] ??= {}) as Record<string, Row>;
      tiers[selector.tier] = row(selector);
    } else roles[selector.role] = row(selector);
  }
  const issues = roleModelIssues(io.cwd);
  return emit(io, ok({ host, roles, ...(issues.length ? { issues } : {}) }), (data) => [
    `models for ${data.host}`,
    ...Object.entries(data.roles).flatMap(([name, entry]) =>
      "source" in entry
        ? [line(name, entry as Row)]
        : Object.entries(entry).map(([t, tierRow]) => line(`${name} ${t}`, tierRow)),
    ),
    ...(data.issues ?? []).map((issue) => `note: ${issue}`),
  ]);
}
