// Layer 1 of the agent-behaviour eval (#425): the size of everything Workit
// puts in an agent's context, in characters. docs/qualification/context-budget.json
// holds the committed values; context-budget.test.ts fails when they drift,
// `bun run write:budget` rewrites them, and CI asks for the
// `context-increase` label when a value grows (scripts/check-budget-growth.ts).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { invariantBootstrap } from "@/packages/workit-core/src/core/methods";
import { flatOperationJsonSchema } from "@/packages/workit-core/src/core/operation-input";
import { OPERATION_FAMILIES } from "@/packages/workit-core/src/core/task-contract";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  handleHook,
  type HookDecision,
} from "@/packages/workit-core/src/hooks/index";
import { fixture } from "@/test/workit-core/hooks/hook-fixtures";

const ROOT = path.resolve(import.meta.dir, "../..");
export const BUDGET_FILE = path.join(ROOT, "docs/qualification/context-budget.json");
const AGENT_ID = "a0b1c2d3e4f5a6b7c";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

const bytesUnder = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .reduce((sum, entry) => sum + readFileSync(path.join(entry.parentPath, entry.name)).length, 0);

/** Hook text with the machine-specific checkout path replaced, so sizes are stable. */
const hookText = (
  adapter: typeof claudeCodeAdapter,
  host: "claude-code" | "codex" | "cursor",
  name: string,
  cwd: string,
  overrides: Record<string, unknown> = {},
): number => {
  const parsed = adapter.parse(fixture(host, name, cwd, overrides), process.env);
  if (!parsed.ok) throw new Error(`${host}/${name}: ${parsed.error}`);
  const decision: HookDecision = handleHook(parsed.input, {
    descriptor: { ...adapter.descriptor, host: parsed.input.host },
    addendum: adapter.addendum?.(parsed.input) ?? null,
  });
  const text = "text" in decision ? (decision.text ?? "") : "";
  return text.replaceAll(cwd, "<cwd>").length;
};

/** The same isolated world the replay cases run in, for the hook measurements. */
const withWorld = async <T>(
  run: (repo: string, agentWorktree: string) => Promise<T>,
): Promise<T> => {
  const world = mkdtempSync(path.join(tmpdir(), "workit-budget-"));
  const keys = [
    "PATH",
    "HOME",
    "WORKFLOW_TOOLKIT_STATE",
    "WORKFLOW_TOOLKIT_CONFIG_DIR",
    "WORKFLOW_TOOLKIT_CONFIG",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_PROJECT_DIR",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const [bin, home, state, config, repo] = ["bin", "home", "state", "config", "repo"].map(
      (name) => {
        const dir = path.join(world, name);
        mkdirSync(dir);
        return dir;
      },
    ) as [string, string, string, string, string];
    writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "workit"), 0o755);
    writeFileSync(
      path.join(config, "config.json"),
      JSON.stringify({
        branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
      }),
    );
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    Object.assign(process.env, {
      PATH: `${bin}${path.delimiter}${saved.PATH ?? ""}`,
      HOME: home,
      WORKFLOW_TOOLKIT_STATE: state,
      WORKFLOW_TOOLKIT_CONFIG_DIR: config,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CODEX_HOME: path.join(home, ".codex"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
    });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "checkout", "-q", "-b", "feature/x");
    mkdirSync(path.join(repo, ".git", "workit"), { recursive: true });
    const agent = path.join(repo, ".claude", "worktrees", `agent-${AGENT_ID}`);
    git(repo, "worktree", "add", "-q", "-b", `worktree-agent-${AGENT_ID}`, agent);
    return await run(repo, agent);
  } finally {
    for (const key of keys)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    rmSync(world, { recursive: true, force: true });
  }
};

/** Every measured item, name → characters (bytes for files). */
export const measureBudget = async (): Promise<Record<string, number>> => {
  const sizes: Record<string, number> = {};
  sizes["bootstrap.invariant"] = invariantBootstrap().length;

  await withWorld(async (repo, agent) => {
    sizes["hook.session-start.claude-code"] = hookText(
      claudeCodeAdapter,
      "claude-code",
      "session-start-compact",
      repo,
    );
    sizes["hook.session-start.codex"] = hookText(codexAdapter, "codex", "session-start", repo);
    sizes["hook.session-start.cursor"] = hookText(cursorAdapter, "cursor", "session-start", repo);
    const start = (agentType: string, cwd: string, agentId: string) =>
      hookText(claudeCodeAdapter, "claude-code", "subagent-start", cwd, {
        agent_type: agentType,
        agent_id: agentId,
      });
    sizes["hook.subagent-start.implementer"] = start("workit:implementer", repo, "b1");
    sizes["hook.subagent-start.implementer-isolated"] = start(
      "workit:implementer",
      agent,
      AGENT_ID,
    );
    sizes["hook.subagent-start.verifier"] = start("workit:verifier", repo, "b2");
    sizes["hook.subagent-start.reviewer"] = start("workit:reviewer", repo, "b3");
    let help = "";
    await main(["help"], {
      cwd: repo,
      stdout: (text) => {
        help += text;
      },
      stderr: () => {},
    });
    sizes["cli.help"] = help.length;
  });

  let schemas = 0;
  for (const family of OPERATION_FAMILIES) {
    const size = JSON.stringify(flatOperationJsonSchema(family)).length;
    sizes[`schema.${family}`] = size;
    schemas += size;
  }
  sizes["schema.total"] = schemas;

  const skills = path.join(ROOT, "packages/workit-core/skills");
  for (const name of readdirSync(skills).toSorted())
    sizes[`skill.${name}`] = bytesUnder(path.join(skills, name));
  const agents = path.join(ROOT, "packages/workit-claude-code/agents");
  for (const name of readdirSync(agents).toSorted())
    sizes[`agent.${name.replace(/\.md$/u, "")}`] = readFileSync(path.join(agents, name)).length;
  return sizes;
};

export const readBudget = (): Record<string, number> =>
  JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as Record<string, number>;

export const writeBudget = (sizes: Record<string, number>): void =>
  writeFileSync(BUDGET_FILE, `${JSON.stringify(sizes, null, 2)}\n`);
