// #648: the Codex hook entry and MCP server put the Workit-owned `workit`
// (core/cli-locate) first on their own PATH, so what they run or probe is the
// owned CLI, never a stale global copy earlier on PATH. Codex has no way to
// change the agent's shell env (docs/agents/hosts.md host parity).
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { envProbe, ownedCliHome } from "@/test/shared/helpers/owned-cli";

const PKG = path.resolve(import.meta.dir, "../../packages/workit-codex");
const HOOK = path.join(PKG, "hooks", "launcher.ts");
const MCP = path.join(PKG, "scripts", "launch-mcp.ts");

const run = (entry: string, owned: boolean, input: string) => {
  const fixture = ownedCliHome(owned);
  const probe = envProbe(fixture.home);
  const child = spawnSync(process.execPath, ["--preload", probe.preload, entry], {
    input,
    encoding: "utf8",
    cwd: fixture.home,
    env: {
      ...fixture.env,
      CODEX_HOME: path.join(fixture.home, ".codex"),
      WORKFLOW_WORKSPACE_ROOT: fixture.home,
    },
    timeout: 30_000,
  });
  return { ...fixture, child, seen: probe.read() };
};

const preToolUse = (cwd: string) =>
  JSON.stringify({
    session_id: "s1",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "bash",
    tool_input: { command: "ls" },
  });

test("Given an owned install and a stale workit earlier on PATH, When the Codex hook runs, Then its PATH starts with the owned launcher", () => {
  const { ownedBin, child, seen } = run(HOOK, true, preToolUse(process.cwd()));
  expect(child.status, child.stderr).toBe(0);
  expect(seen?.PATH.split(path.delimiter)[0]).toBe(ownedBin);
  expect(seen?.WORKIT_CLI).toBe(path.join(ownedBin, "workit"));
});

test("Given no owned install, When the Codex hook runs, Then its PATH is unchanged", () => {
  const { env, child, seen } = run(HOOK, false, preToolUse(process.cwd()));
  expect(child.status, child.stderr).toBe(0);
  expect(seen?.PATH).toBe(env.PATH);
  expect(seen?.WORKIT_CLI).toBeNull();
});

test("Given an owned install, When the Codex MCP server starts, Then its PATH starts with the owned launcher", () => {
  const { ownedBin, seen } = run(MCP, true, "");
  expect(seen?.PATH.split(path.delimiter)[0]).toBe(ownedBin);
  expect(seen?.WORKIT_CLI).toBe(path.join(ownedBin, "workit"));
});
