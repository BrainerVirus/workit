// #648: the Cursor hook process puts the Workit-owned `workit`
// (core/cli-locate) first on its own PATH, so what it runs or probes is the
// owned CLI, never a stale global copy earlier on PATH. Cursor has no way to
// change the agent's shell env (docs/agents/hosts.md host parity).
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { envProbe, ownedCliHome } from "@/test/shared/helpers/owned-cli";

const HOOK = path.resolve(import.meta.dir, "../../packages/workit-cursor/hooks/workit-hook.ts");

const run = (owned: boolean) => {
  const fixture = ownedCliHome(owned);
  const probe = envProbe(fixture.home);
  const child = spawnSync(process.execPath, ["--preload", probe.preload, HOOK], {
    input: JSON.stringify({ hook_event_name: "preCompact", workspace_roots: [] }),
    encoding: "utf8",
    cwd: fixture.home,
    env: fixture.env,
    timeout: 30_000,
  });
  return { ...fixture, child, seen: probe.read() };
};

test("Given an owned install and a stale workit earlier on PATH, When the Cursor hook runs, Then its PATH starts with the owned launcher", () => {
  const { ownedBin, child, seen } = run(true);
  expect(child.status, child.stderr).toBe(0);
  expect(seen?.PATH.split(path.delimiter)[0]).toBe(ownedBin);
  expect(seen?.WORKIT_CLI).toBe(path.join(ownedBin, "workit"));
});

test("Given no owned install, When the Cursor hook runs, Then its PATH is unchanged", () => {
  const { env, child, seen } = run(false);
  expect(child.status, child.stderr).toBe(0);
  expect(seen?.PATH).toBe(env.PATH);
  expect(seen?.WORKIT_CLI).toBeNull();
});
