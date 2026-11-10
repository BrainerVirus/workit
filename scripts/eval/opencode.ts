// The OpenCode leg of the local bench (docs/agents/eval.md): one
// `opencode run --format json` per case with the Workit OpenCode plugin pinned
// from this checkout, on the free provider first and the go provider once the
// free one reports its limit.
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { EvalCase } from "./cases";
import { runErrorOf } from "./grade";
import type { World } from "./scaffold";

export type Provider = { name: "free" | "go"; model: string };

/** `deepseek-v4.1-flash` runs as `opencode/deepseek-v4.1-flash-free`, then `opencode-go/deepseek-v4.1-flash`. */
export const providersFor = (model: string): Provider[] => [
  { name: "free", model: `opencode/${model}-free` },
  { name: "go", model: `opencode-go/${model}` },
];

const LIMIT =
  /provider\.(quota|free-limit)|\b429\b|FreeUsageLimit|rate.?limit|quota|usage limit|too many requests/i;

/** The rate or quota limit a run stopped on, or null when it was not limited. */
export const limitOf = (transcript: string, stderr: string): string | null => {
  const error = runErrorOf(transcript);
  if (error !== null) return LIMIT.test(error) ? error : null;
  const line = stderr.split("\n").find((each) => LIMIT.test(each));
  return line === undefined ? null : line.trim().slice(0, 300);
};

/** Claude Code tool names (the cases' `allowedTools`) as OpenCode permission actions. */
const ACTIONS: Record<string, string[]> = {
  Bash: ["shell"],
  Agent: ["subagent"],
  Read: ["read"],
  Edit: ["edit", "patch"],
  Write: ["write"],
  Glob: ["glob"],
  Grep: ["grep"],
  Skill: ["skill"],
};

type Rule = { action: string; resource: string; effect: "allow" | "deny" };

/** Deny everything, then allow the case's tools; the last matching rule wins. Workit's own tools stay allowed. */
const permissionsFor = (tools: string[]): Rule[] => [
  { action: "*", resource: "*", effect: "deny" },
  { action: "workit_*", resource: "*", effect: "allow" },
  ...tools.flatMap((tool): Rule[] => {
    const scoped = /^(\w+)\((.*)\)$/.exec(tool);
    const name = scoped?.[1] ?? tool;
    const resource = scoped?.[2] ?? "*";
    return (ACTIONS[name] ?? [name.toLowerCase()]).map((action) => ({
      action,
      resource,
      effect: "allow",
    }));
  }),
];

/** The world's OpenCode config dir (`XDG_CONFIG_HOME/opencode`): only the plugin, the case's tools and its step cap. */
export const writeOpencodeConfig = (
  world: World,
  spec: EvalCase,
  tools: string[],
  pluginDir: string,
): string => {
  const home = path.join(world.dir, "xdg");
  mkdirSync(path.join(home, "opencode"), { recursive: true });
  writeFileSync(
    path.join(home, "opencode", "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugins: [pathToFileURL(pluginDir).href],
        permissions: permissionsFor(tools),
        agents: { build: { steps: spec.maxTurns ?? 10 } },
      },
      null,
      2,
    )}\n`,
  );
  return home;
};

export const opencodeArgs = (provider: Provider): string[] => [
  "run",
  "--standalone",
  "--format",
  "json",
  "--auto",
  "--archived",
  "--model",
  provider.model,
];

/**
 * Your OpenCode login (its data dir) stays; your config, Claude Code skills
 * and parent session do not. OpenCode takes its project dir from PWD, and the
 * plugin would put an installed Workit CLI first on PATH: both point at the world.
 */
export const opencodeEnv = (
  base: Record<string, string>,
  configHome: string,
  world: World,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base))
    if (!key.startsWith("OPENCODE_")) env[key] = value;
  env.PWD = world.repo;
  env.WORKIT_INSTALL_ROOT = path.join(world.dir, "install");
  env.XDG_CONFIG_HOME = configHome;
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  return env;
};
