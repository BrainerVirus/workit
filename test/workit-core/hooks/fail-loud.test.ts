// Retro 2026-11-03 class 1: on a repo pinning Node 22 every Workit hook failed
// open silently (~4000 runs, `{}` and exit 0), verifiers got no session and
// doctor said healthy. A hook that cannot load or crashes now tells the user
// and the agent on the events the host shows (Claude Code and Codex:
// systemMessage + additionalContext; Cursor: sessionStart additional_context)
// and records a hook-runs failure row that `workit doctor` reads.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readHookRuns } from "@/packages/workit-core/src/hooks/hook-runs";
import { bareNodeEnv, scratchDir } from "../../shared/helpers/hook-node";

const REPO = path.resolve(import.meta.dir, "../../..");
const CLAUDE = path.join(REPO, "packages/workit-claude-code");
const CURSOR_HOOKS = path.join(REPO, "packages/workit-cursor/hooks");
const CODEX_LAUNCHER = path.join(REPO, "packages/workit-codex/hooks/launcher.ts");
const NODE = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();

const event = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: name, session_id: "s1", cwd: "/tmp", ...extra });

const failures = (env: Record<string, string>) =>
  readHookRuns(env.WORKIT_STATE_DIR).filter((row) => row.failure !== undefined);

const claude = (entry: string, input: string, env: Record<string, string>) =>
  spawnSync(NODE, [entry], { input, encoding: "utf8", env });

test("Given Node 22 and no Node 24, When Claude Code runs UserPromptSubmit, Then the user and the agent are told the cause and the fix, and a failure row is recorded", () => {
  const env = bareNodeEnv({ WORKIT_HOOK_NODE_VERSION: "22.1.0" });
  const child = claude(path.join(CLAUDE, "bin/workit-hook.mjs"), event("UserPromptSubmit"), env);
  expect(child.status).toBe(0);
  const out = JSON.parse(child.stdout);
  expect(out.systemMessage).toContain("Workit hooks are off");
  expect(out.systemMessage).toContain("22.1.0");
  expect(out.systemMessage).toContain("workit doctor");
  expect(out.hookSpecificOutput).toEqual({
    hookEventName: "UserPromptSubmit",
    additionalContext: out.systemMessage,
  });
  expect(failures(env)).toEqual([
    expect.objectContaining({
      host: "claude_code",
      event: "UserPromptSubmit",
      count: 1,
      failure: "needs Node >=24, found 22.1.0",
    }),
  ]);
});

test("Given Node 22, When a verifier's SubagentStart fires, Then it is told no session was issued and to run workit doctor", () => {
  const env = bareNodeEnv({ WORKIT_HOOK_NODE_VERSION: "22.1.0" });
  const child = claude(
    path.join(CLAUDE, "bin/workit-hook.mjs"),
    event("SubagentStart", { agent_id: "a1", agent_type: "workit:verifier" }),
    env,
  );
  const out = JSON.parse(child.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe("SubagentStart");
  expect(out.hookSpecificOutput.additionalContext).toContain("no_session");
  expect(out.hookSpecificOutput.additionalContext).toContain("`workit doctor`");
  expect(failures(env).map((row) => row.event)).toEqual(["SubagentStart"]);
});

test("Given Node 22, When PreToolUse fires twice, Then it answers {} (never blocks) and the failure row counts both", () => {
  const env = bareNodeEnv({ WORKIT_HOOK_NODE_VERSION: "22.1.0" });
  for (let i = 0; i < 2; i++) {
    const child = claude(
      path.join(CLAUDE, "bin/workit-hook.mjs"),
      event("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }),
      env,
    );
    expect(JSON.parse(child.stdout)).toEqual({});
  }
  expect(failures(env)).toEqual([expect.objectContaining({ event: "PreToolUse", count: 2 })]);
});

/** An installed Claude Code layout (bin/ and package.json) with `dist` as its bundle. */
const claudeInstall = (dist: string) => {
  const root = path.join(scratchDir("wk-claude-loud-"), "workit");
  cpSync(path.join(CLAUDE, "bin"), path.join(root, "bin"), { recursive: true });
  copyFileSync(path.join(CLAUDE, "package.json"), path.join(root, "package.json"));
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist", "workit-hook.js"), dist);
  return path.join(root, "bin", "workit-hook.mjs");
};

test("Given a Claude Code bundle that throws on import, When SessionStart fires, Then the systemMessage names the error and the fix, and a failure row is recorded", () => {
  const env = bareNodeEnv();
  const entry = claudeInstall('throw new Error("bundle exploded");\n');
  const child = claude(entry, event("SessionStart", { source: "startup" }), env);
  expect(child.status).toBe(0);
  const out = JSON.parse(child.stdout);
  expect(out.systemMessage).toContain("bundle exploded");
  expect(out.systemMessage).toContain("workit upgrade");
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(failures(env)).toEqual([
    expect.objectContaining({ host: "claude_code", event: "SessionStart" }),
  ]);
  expect(failures(env)[0].failure).toContain("bundle exploded");
});

test("Given a Claude Code runtime that crashes while answering, When UserPromptSubmit fires, Then it fails loud instead of a bare exit 1", () => {
  const env = bareNodeEnv();
  const entry = claudeInstall(
    'export const runClaudeHook = async () => { throw new Error("runtime fell over"); };\n',
  );
  const child = claude(entry, event("UserPromptSubmit"), env);
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout).systemMessage).toContain("runtime fell over");
  expect(failures(env)[0].failure).toContain("crashed (runtime fell over)");
});

/** A Cursor plugin layout with the real launcher and no runtime to run. */
const cursorPlugin = (engines?: string) => {
  const root = scratchDir("wk-cursor-loud-");
  mkdirSync(path.join(root, "hooks"));
  for (const file of ["launch.mjs", "launch-runtime.mjs", "node-resolve.mjs"])
    copyFileSync(path.join(CURSOR_HOOKS, file), path.join(root, "hooks", file));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@brainervirus/workit-cursor",
      version: "1.2.3",
      ...(engines ? { engines: { node: engines } } : {}),
    }),
  );
  return path.join(root, "hooks", "launch.mjs");
};

test("Given Node 22, When Cursor's sessionStart fires, Then additional_context names the cause and a failure row is recorded", () => {
  const env = bareNodeEnv({ WORKIT_HOOK_NODE_VERSION: "22.1.0", PATH: "/usr/bin:/bin" });
  const child = spawnSync(NODE, [cursorPlugin(">=24"), "workit-cursor-session-start"], {
    input: JSON.stringify({ hook_event_name: "sessionStart" }),
    encoding: "utf8",
    env,
  });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout).additional_context).toContain("Workit hooks are off");
  expect(failures(env)).toEqual([
    expect.objectContaining({
      host: "cursor",
      event: "sessionStart",
      failure: "needs Node >=24, found 22.1.0",
    }),
  ]);
});

test("Given a Cursor plugin with nothing to run, When sessionStart fires, Then additional_context names the cause and the fix", () => {
  const env = bareNodeEnv({ PATH: "" });
  const child = spawnSync(NODE, [cursorPlugin(), "workit-cursor-session-start"], {
    input: JSON.stringify({ hook_event_name: "sessionStart" }),
    encoding: "utf8",
    env,
  });
  expect(child.status).toBe(0);
  const context = JSON.parse(child.stdout).additional_context;
  expect(context).toContain("no local workit-cursor runtime");
  expect(context).toContain("workit doctor");
  expect(failures(env)[0]).toEqual(expect.objectContaining({ host: "cursor" }));
});

test("Given Node 22, When Codex runs SessionStart, Then the systemMessage and additionalContext name the cause and a failure row is recorded", () => {
  const env = bareNodeEnv({ WORKIT_HOOK_NODE_VERSION: "22.1.0" });
  const child = spawnSync(process.execPath, [CODEX_LAUNCHER], {
    input: event("SessionStart", { source: "startup" }),
    encoding: "utf8",
    env,
  });
  expect(child.status, child.stderr).toBe(0);
  const out = JSON.parse(child.stdout);
  expect(out.systemMessage).toContain("Workit hooks are off");
  expect(out.hookSpecificOutput.additionalContext).toBe(out.systemMessage);
  expect(failures(env)).toEqual([
    expect.objectContaining({
      host: "codex_cli",
      event: "SessionStart",
      failure: "needs Node >=24, found 22.1.0",
    }),
  ]);
});
