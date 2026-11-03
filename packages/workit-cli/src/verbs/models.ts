// `workit models show [--role <r>] [--tier <t>] [--host <h>]` (#395): the
// model and effort each role runs on for a host, from `models.roles` in
// workspaces.json (workspace, then global default), `fanout.tierModels` for
// the implementer tiers, then Claude Code's built-in defaults. Skills call it
// to know what to pass as `model` (and `effort`) when they spawn a role. A
// role's list falls back past a provider exhausted by a usage limit (#655);
// `exhausted` lists those providers and their resets.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ENFORCEMENT_HOSTS,
  MODEL_ROLES,
  MODEL_TIERS,
  ROLE_SELECTORS,
  fallbackText,
  leadSwitchNotice,
  resolveAvailableRoleModel,
  resolveLeadModel,
  resolveRoleModel,
  roleEnforcement,
  roleForAgentType,
  roleModelIssues,
  type Enforcement,
  type ModelRole,
  type ModelTier,
} from "@brainervirus/workit-core/src/core/role-models";
import { exhaustedProviders, shortTime } from "@brainervirus/workit-core/src/core/model-fallback";
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

type Row = {
  model: string | null;
  effort: string | null;
  source: string;
  fallback?: string;
};
type HostEnforcement = Record<string, Enforcement>;

const enforcementText = (hosts: HostEnforcement): string => {
  const of = (kind: Enforcement) => Object.keys(hosts).filter((host) => hosts[host] === kind);
  return (["enforced", "advisory"] as const)
    .filter((kind) => of(kind).length)
    .map((kind) => `${kind} on ${of(kind).join(", ")}`)
    .join("; ");
};

const line = (label: string, entry: Row, hosts?: HostEnforcement): string =>
  `  ${label}: ${
    entry.model
      ? `${entry.model}${entry.effort ? ` (effort ${entry.effort})` : ""}  [${entry.source}]`
      : "host default (nothing configured)"
  }${hosts ? `; ${enforcementText(hosts)}` : ""}${entry.fallback ? `\n    ${entry.fallback}` : ""}`;

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
            // First sight of this model for the entry: flag it once if no default matches.
            if (
              entry.models[model] === 1 &&
              entry.defaults.length &&
              !entry.defaults.some((d) => matches(model, d))
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
  const row = (selector: { role: ModelRole; tier?: ModelTier }): Row => {
    const chosen = resolveAvailableRoleModel(io.cwd, selector, host);
    if (!chosen) return { model: null, effort: null, source: "none" };
    const fallback = fallbackText(chosen);
    return {
      model: chosen.model,
      effort: chosen.effort,
      source: chosen.source,
      ...(fallback ? { fallback } : {}),
    };
  };
  const hostsFor = (selector: Parameters<typeof roleEnforcement>[1]): HostEnforcement =>
    Object.fromEntries(
      ENFORCEMENT_HOSTS.map((each) => [each, roleEnforcement(io.cwd, selector, each)]),
    );
  const roles: Record<string, Row | Record<string, Row>> = {};
  const enforcement: Record<string, HostEnforcement> = {};
  for (const selector of ROLE_SELECTORS) {
    if (role && selector.role !== role) continue;
    if (selector.tier) {
      if (tier && selector.tier !== tier) continue;
      const tiers = (roles[selector.role] ??= {}) as Record<string, Row>;
      tiers[selector.tier] = row(selector);
      enforcement[`${selector.role} ${selector.tier}`] = hostsFor(selector);
    } else {
      roles[selector.role] = row(selector);
      enforcement[selector.role] = hostsFor(selector);
    }
  }
  const lead: Row | null = role
    ? null
    : (resolveLeadModel(io.cwd, host) ?? { model: null, effort: null, source: "none" });
  if (lead) enforcement.lead = hostsFor("lead");
  const issues = roleModelIssues(io.cwd);
  const exhausted = exhaustedProviders();
  const leadSwitch = lead ? leadSwitchNotice(io.cwd, host, null) : null;
  const data = {
    host,
    ...(lead ? { lead } : {}),
    roles,
    enforcement,
    exhausted,
    ...(leadSwitch ? { leadSwitch } : {}),
    ...(issues.length ? { issues } : {}),
  };
  return emit(io, ok(data), (shown) => [
    `models for ${shown.host}`,
    ...(shown.lead ? [line("lead", shown.lead, shown.enforcement.lead)] : []),
    ...Object.entries(shown.roles).flatMap(([name, entry]) =>
      "source" in entry
        ? [line(name, entry as Row, shown.enforcement[name])]
        : Object.entries(entry).map(([t, tierRow]) =>
            line(`${name} ${t}`, tierRow, shown.enforcement[`${name} ${t}`]),
          ),
    ),
    ...(shown.exhausted.length
      ? [
          "exhausted providers (usage limit):",
          ...shown.exhausted.map(
            (one) => `  ${one.provider}: until ${shortTime(one.until)}  [${one.reason}]`,
          ),
        ]
      : ["exhausted providers: none"]),
    ...(shown.leadSwitch ? [`note: ${shown.leadSwitch}`] : []),
    ...(shown.issues ?? []).map((issue) => `note: ${issue}`),
  ]);
}
