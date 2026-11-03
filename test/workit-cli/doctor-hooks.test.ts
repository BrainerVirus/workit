// Retro 2026-11-03 class 1: doctor said healthy while every hook failed open on
// a repo pinning Node 22. hook_node now runs each installed hook launcher with
// the node this directory resolves and fails when one does not answer;
// hook_runs warns when a host's newest record is a failure row.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDoctor, type DoctorCheck } from "@/packages/workit-cli/src/admin/doctor";
import { recordHookFailure, recordHookRun } from "@/packages/workit-core/src/hooks/hook-runs";
import { bareNodeEnv } from "../shared/helpers/hook-node";

const PLUGIN = path.resolve(import.meta.dir, "../../packages/workit-claude-code");

/** A home whose Claude Code registry lists this checkout's Workit plugin. */
const claudeHome = (extra: Record<string, string> = {}) => {
  const env = bareNodeEnv(extra);
  delete env.CLAUDE_CONFIG_DIR;
  const plugins = path.join(env.HOME, ".claude", "plugins");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    path.join(plugins, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "workit@workit": [{ installPath: PLUGIN, version: "8.0.0", scope: "user" }] },
    }),
  );
  return env;
};

const row = (env: Record<string, string>, id: string): DoctorCheck =>
  runDoctor({
    host: "cli",
    home: env.HOME,
    cwd: env.HOME,
    configDir: path.join(env.HOME, "config"),
    stateDir: env.WORKFLOW_TOOLKIT_STATE,
    dev: path.join(env.HOME, "no-dev"),
    env,
    scopeProbe: () => ({ effective: false, supported: false, reason: "test", delegate: null }),
  }).checks.find((check) => check.id === id)!;

test("Given a healthy Claude Code install, When doctor runs, Then hook_node runs the hook and passes", () => {
  const check = row(claudeHome(), "hook_node");
  expect(check.status).toBe("pass");
  expect(check.detail).toContain("installed hooks ran: claude_code");
}, 60_000);

test("Given a directory whose node is 22 and no Node 24 to re-run on, When doctor runs, Then hook_node fails with the cause", () => {
  const check = row(claudeHome({ WORKIT_HOOK_NODE_VERSION: "22.1.0" }), "hook_node");
  expect(check.status).toBe("fail");
  expect(check.detail).toContain("did not run");
  expect(check.detail).toContain("needs Node >=24, found 22.1.0");
  expect(check.detail).toContain(path.join(PLUGIN, "bin", "workit-hook.mjs"));
  expect(check.fix).toContain("workit upgrade");
}, 60_000);

test("Given a host whose newest hook record is a failure, When doctor runs, Then hook_runs warns with the cause", () => {
  const env = bareNodeEnv();
  const minutes = (n: number) => () => Date.now() - n * 60_000;
  recordHookRun("claude_code", "SessionStart", env, minutes(60));
  recordHookFailure("claude_code", "PreToolUse", "needs Node >=24, found 22.1.0", env, minutes(2));
  recordHookFailure("claude_code", "PreToolUse", "needs Node >=24, found 22.1.0", env, minutes(1));
  recordHookRun("cursor", "sessionStart", env, minutes(1));
  recordHookFailure("cursor", "sessionStart", "no runtime", env, minutes(30));
  const check = row(env, "hook_runs");
  expect(check.status).toBe("warn");
  expect(check.detail).toBe(
    "claude_code: hook could not run 1 min ago on PreToolUse (2 failed runs): needs Node >=24, found 22.1.0",
  );
  expect(check.fix).toContain("workit doctor");
});
