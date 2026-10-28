// Layer 0 of the agent-behaviour eval (#425): real failures from agent
// sessions, replayed as deterministic cases. Each case in cases/*.json is a
// sanitised hook payload or CLI call plus what an agent must (and must not)
// see. A case marked `open` names the issue that fixes it and runs as an
// expected failure, so the fixing PR has to drop the mark: the case is the
// slice's red-then-green proof. A `tool` case calls the shared entry every
// host's flat tool uses (parseAdvertisedOperation) with a payload and checks
// the result's text: error, field reasons and guidance, or `ok` on success.
// See docs/agents/testing.md#agent-behaviour-eval.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  handleHook,
  type HookDecision,
} from "@/packages/workit-core/src/hooks/index";
import { parseAdvertisedOperation, type OperationFamily } from "@/packages/workit-core/src/core";
import { fixture, tempRoot } from "@/test/workit-core/hooks/hook-fixtures";

type Host = "claude-code" | "codex" | "cursor";
type Expect = { kind?: string[]; require?: string[]; forbid?: string[]; maxLines?: number };
type Case = {
  id: string;
  source: string;
  open?: string;
  repo?: {
    branch?: string;
    worktree?: "claude-agent";
    checks?: Record<string, string>;
    /** Workspace entries for workspaces.json; `__CWD__` in a glob is the repo path. */
    workspaces?: Record<string, unknown>[];
  };
  env?: Record<string, string>;
} & (
  | { hook: { host: Host; fixture: string; overrides?: Record<string, unknown> }; expect: Expect }
  | { cli: { argv: string[] }; expect: Expect & { exit?: number[] } }
  | { tool: { family: OperationFamily; input: unknown }; expect: Expect }
);

const ADAPTERS = { "claude-code": claudeCodeAdapter, codex: codexAdapter, cursor: cursorAdapter };
const AGENT_ID = "a0b1c2d3e4f5a6b7c";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

// Each case runs in its own world: nudges are once per session, verdict ids
// are issued per user, and host permission rules come from HOME. A stub
// `workit` on PATH lets the heavy gate's rewrite apply, as on a real machine.
const KEYS = [
  "PATH",
  "HOME",
  "WORKFLOW_TOOLKIT_STATE",
  "WORKFLOW_TOOLKIT_CONFIG_DIR",
  "WORKFLOW_TOOLKIT_CONFIG",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
beforeEach(() => {
  const world = tempRoot("workit-behavior-world-");
  roots.push(world);
  const [bin, home, state, config] = ["bin", "home", "state", "config"].map((name) => {
    const dir = path.join(world, name);
    mkdirSync(dir);
    return dir;
  }) as [string, string, string, string];
  writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "workit"), 0o755);
  writeFileSync(
    path.join(config, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
  for (const key of [
    "CLAUDE_PROJECT_DIR",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "WORKFLOW_TOOLKIT_CONFIG",
  ])
    delete process.env[key];
  Object.assign(process.env, {
    PATH: `${bin}${path.delimiter}${saved.PATH ?? ""}`,
    HOME: home,
    WORKFLOW_TOOLKIT_STATE: state,
    WORKFLOW_TOOLKIT_CONFIG_DIR: config,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
  });
});
afterEach(() => {
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
};

/** A Workit workspace on `branch`; `worktree` adds Claude Code's agent worktree. */
const workspace = (repo: Case["repo"] = {}): { cwd: string } => {
  const root = tempRoot("workit-behavior-repo-");
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  if (repo.branch) git(root, "checkout", "-q", "-b", repo.branch);
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  if (repo.checks) {
    mkdirSync(path.join(root, ".workit"), { recursive: true });
    writeFileSync(
      path.join(root, ".workit", "checks.json"),
      JSON.stringify({ checks: repo.checks }),
    );
  }
  if (repo.workspaces)
    writeFileSync(
      path.join(process.env.WORKFLOW_TOOLKIT_CONFIG_DIR ?? "", "workspaces.json"),
      JSON.stringify({ workspaces: bind(repo.workspaces, root) }),
    );
  if (repo.worktree !== "claude-agent") return { cwd: root };
  const cwd = path.join(root, ".claude", "worktrees", `agent-${AGENT_ID}`);
  git(root, "worktree", "add", "-q", "-b", `worktree-agent-${AGENT_ID}`, cwd);
  return { cwd };
};

const bind = (value: unknown, cwd: string): unknown =>
  JSON.parse(JSON.stringify(value ?? {}).replaceAll("__CWD__", JSON.stringify(cwd).slice(1, -1)));

/** Everything the model reads from a decision. */
const textOf = (decision: HookDecision): string =>
  [
    "reason" in decision ? decision.reason : null,
    "text" in decision ? decision.text : null,
    "command" in decision ? decision.command : null,
    "unblock" in decision ? decision.unblock : null,
    "userMessage" in decision ? decision.userMessage : null,
  ]
    .filter(Boolean)
    .join("\n");

/** The case itself is broken: an open case must not count it as its defect. */
class SetupError extends Error {}
const setup = <T>(step: () => T): T => {
  try {
    return step();
  } catch (error) {
    throw new SetupError(String(error));
  }
};

const run = async (spec: Case): Promise<void> => {
  if ("tool" in spec) {
    const result = parseAdvertisedOperation(spec.tool.family, spec.tool.input, "opencode");
    check(result.ok ? "ok" : `${result.error}\n${JSON.stringify(result.details)}`, spec.expect);
    return;
  }
  const { cwd } = setup(() => workspace(spec.repo));
  const env = { ...process.env, ...(bind(spec.env, cwd) as Record<string, string>) };
  const { expect: want } = spec;
  if ("hook" in spec) {
    const adapter = ADAPTERS[spec.hook.host];
    const payload = setup(() =>
      fixture(spec.hook.host, spec.hook.fixture, cwd, {
        ...(bind(spec.hook.overrides, cwd) as Record<string, unknown>),
      }),
    );
    const parsed = adapter.parse(payload, env);
    if (!parsed.ok) throw new SetupError(`payload does not parse: ${parsed.error}`);
    const decision = handleHook(parsed.input, {
      descriptor: { ...adapter.descriptor, host: parsed.input.host },
      addendum: adapter.addendum?.(parsed.input) ?? null,
    });
    const text = textOf(decision);
    if (want.kind && !want.kind.includes(decision.kind))
      throw new Error(`decision ${decision.kind}, want ${want.kind.join("|")}: ${text}`);
    check(text, want);
    return;
  }
  let out = "";
  const exit = await main(spec.cli.argv, {
    cwd,
    env,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      out += text;
    },
  });
  if (spec.expect.exit) expect(spec.expect.exit).toContain(exit);
  check(out, want);
};

const check = (text: string, want: Expect) => {
  for (const pattern of want.require ?? []) expect(text).toMatch(new RegExp(pattern, "u"));
  for (const pattern of want.forbid ?? []) expect(text).not.toMatch(new RegExp(pattern, "u"));
  if (want.maxLines !== undefined)
    expect(text.split("\n").length).toBeLessThanOrEqual(want.maxLines);
};

const CASES = path.join(import.meta.dir, "cases");
const cases: Case[] = readdirSync(CASES)
  .filter((name) => name.endsWith(".json"))
  .toSorted()
  .map((name) => JSON.parse(readFileSync(path.join(CASES, name), "utf8")) as Case);

test("every case names its source and a unique id", () => {
  const ids = cases.map((spec) => spec.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const spec of cases) {
    expect(spec.source.length).toBeGreaterThan(0);
    if (spec.open) expect(spec.open).toMatch(/^#\d+$/u);
  }
});

for (const spec of cases) {
  const name = `${spec.id} (${spec.source})`;
  if (!spec.open) test(name, () => run(spec), 30_000);
  // An open case must fail on its expectation, not on a broken setup, and
  // must be unmarked once its issue is fixed.
  else
    test(`${name} [open ${spec.open}]`, async () => {
      const failure: unknown = await run(spec).then(
        () => null,
        (error: unknown) => error,
      );
      if (failure === null) throw new Error(`${spec.id} passes now: drop "open": "${spec.open}"`);
      if (failure instanceof SetupError) throw failure;
    }, 30_000);
}
