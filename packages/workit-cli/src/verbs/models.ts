// `workit models show [--role <r>] [--tier <t>] [--host <h>]` (#395): the
// model and effort each role runs on for a host, from `models.roles` in
// workspaces.json (workspace, then global default), `fanout.tierModels` for
// the implementer tiers, then Claude Code's built-in defaults. Skills call it
// to know what to pass as `model` (and `effort`) when they spawn a role.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MODEL_ROLES,
  MODEL_TIERS,
  ROLE_SELECTORS,
  resolveRoleModel,
  roleForAgentType,
  roleModelIssues,
  type ModelRole,
  type ModelTier,
} from "@brainervirus/workit-core/src/core/role-models";
import { actorFromEnv } from "@brainervirus/workit-core/src/ledger";
import { emit, fail, ok, type Io } from "../output";

const USAGE =
  "workit models show [--role <role>] [--tier <tier>] [--host <host>] [--report [--days <n>]] [--json]";

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

type AgentUse = {
  role: string | null;
  defaults: string[];
  models: Record<string, number>;
  flagged: string[];
};

/** Models the assistant messages of one subagent transcript ran on. */
const modelsOf = (file: string): Set<string> => {
  const found = new Set<string>();
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return found;
  }
  for (const row of text.split("\n"))
    if (row.includes('"type":"assistant"'))
      try {
        const model = (JSON.parse(row) as { message?: { model?: unknown } }).message?.model;
        if (typeof model === "string" && model && !model.startsWith("<")) found.add(model);
      } catch {
        // a torn line is not a model
      }
  return found;
};

/** Does the model a subagent ran on (`claude-sonnet-5-5`) match a configured one (`sonnet`)? */
const matches = (ran: string, configured: string): boolean =>
  ran.toLowerCase().includes(configured.toLowerCase());

/**
 * Claude Code's subagent transcripts (`<projects>/<project>/<session>/subagents/
 * agent-<id>.{meta.json,jsonl}`) from the last `days` days: the models each
 * agent type ran on, flagged when one is not the role's configured default.
 */
const usageReport = (cwd: string, env: NodeJS.ProcessEnv, days: number) => {
  const projects = path.join(
    env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude"),
    "projects",
  );
  const since = Date.now() - days * 86_400_000;
  const types: Record<string, AgentUse> = {};
  let agents = 0;
  const dirs = (dir: string): string[] => {
    try {
      return readdirSync(dir).map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  };
  for (const project of dirs(projects))
    for (const session of dirs(project))
      for (const meta of dirs(path.join(session, "subagents")).filter((f) =>
        f.endsWith(".meta.json"),
      )) {
        try {
          if (statSync(meta).mtimeMs < since) continue;
          const agentType = (JSON.parse(readFileSync(meta, "utf8")) as { agentType?: unknown })
            .agentType;
          const transcript = meta.replace(/\.meta\.json$/, ".jsonl");
          if (typeof agentType !== "string" || !existsSync(transcript)) continue;
          const ran = modelsOf(transcript);
          if (!ran.size) continue;
          agents += 1;
          const selector = roleForAgentType(agentType);
          const entry = (types[agentType] ??= {
            role: selector?.role ?? null,
            defaults: selector
              ? [
                  ...new Set(
                    (selector.role === "implementer"
                      ? MODEL_TIERS.map((tier) => ({ ...selector, tier }))
                      : [selector]
                    ).flatMap((one) => resolveRoleModel(cwd, one, "claude_code")?.model ?? []),
                  ),
                ]
              : [],
            models: {},
            flagged: [],
          });
          for (const model of ran) {
            entry.models[model] = (entry.models[model] ?? 0) + 1;
            if (
              entry.defaults.length &&
              !entry.defaults.some((d) => matches(model, d)) &&
              !entry.flagged.includes(model)
            )
              entry.flagged.push(model);
          }
        } catch {
          // an unreadable transcript is skipped
        }
      }
  return { days, agents, types };
};

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...args] = argv.filter((arg) => arg !== "--json");
  if (sub !== "show")
    return emit(io, fail("invalid_input", `usage: ${USAGE}`, { unblock: "workit help models" }));
  const role = flag(args, "--role");
  const tier = flag(args, "--tier");
  const hostFlag = flag(args, "--host");
  const daysFlag = flag(args, "--days");
  for (const value of [role, tier, hostFlag, daysFlag])
    if (value instanceof Error) return emit(io, fail("invalid_input", value.message));
  if (role && !(MODEL_ROLES as readonly string[]).includes(role as string))
    return emit(io, fail("invalid_input", `unknown role ${role}: ${MODEL_ROLES.join(", ")}`));
  if (tier && !(MODEL_TIERS as readonly string[]).includes(tier as string))
    return emit(io, fail("invalid_input", `unknown tier ${tier}: ${MODEL_TIERS.join(", ")}`));
  const days = daysFlag === null ? 7 : Number(daysFlag);
  if (!Number.isFinite(days) || days <= 0)
    return emit(io, fail("invalid_input", "--days needs a positive number"));
  if (args.includes("--report")) {
    const report = usageReport(io.cwd, io.env, days);
    return emit(io, ok(report), (data) => [
      `subagent models over the last ${data.days} days (${data.agents} agents)`,
      ...Object.entries(data.types).flatMap(([type, use]) => [
        `  ${type}${use.role ? ` (role ${use.role}, default ${use.defaults.join("/") || "host default"})` : ""}: ${Object.entries(
          use.models,
        )
          .map(([model, count]) => `${model} x${count}`)
          .join(", ")}`,
        ...use.flagged.map((model) => `    flag: ran on ${model}, not the role default`),
      ]),
    ]);
  }
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
