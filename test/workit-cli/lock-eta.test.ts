// `workit lock status` estimates (#326): each holder's time left and each
// waiter's wait, from the ledger's last measured run of their checks.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { actorFromEnv, appendObserved } from "@/packages/workit-core/src/ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const lease = (root: string, id: string, check: string, startedAt: number) => ({
  id,
  pid: process.pid,
  processStart: null,
  bootId: null,
  check,
  cwd: root,
  session: "s-other",
  startedAt: new Date(startedAt).toISOString(),
  scope: null,
});

const setup = () => {
  const root = temp("wk-lock-eta-");
  spawnSync("git", ["init", "-q", "-b", "feature/eta"], { cwd: root });
  const state = temp("wk-lock-eta-state-");
  const config = temp("wk-lock-eta-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "here", glob: "**", resources: { scope: false } }] }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-eta",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  const leases = path.join(state, "leases");
  mkdirSync(path.join(leases, "queue"), { recursive: true });
  return { root, env, leases };
};

const measured = (root: string, env: NodeJS.ProcessEnv, name: string, durationMs: number) =>
  expect(
    appendObserved(root, {
      type: "check",
      actor: actorFromEnv(env),
      name,
      result: "passed",
      timedOut: false,
      durationMs,
    }).ok,
  ).toBe(true);

const status = async (root: string, env: NodeJS.ProcessEnv, json = false) => {
  let stdout = "";
  const code = await main(["lock", "status", ...(json ? ["--json"] : [])], {
    cwd: root,
    env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  return { code, stdout };
};

test("Given a holder 1m into a 10m check and a queued 3m packaging run, When lock status runs, Then it shows ~9m left and the waiter's estimated wait", async () => {
  const { root, env, leases } = setup();
  measured(root, env, "test", 600_000);
  measured(root, env, "packaging", 180_000);
  const now = Date.now();
  writeFileSync(
    path.join(leases, "slot-0.json"),
    JSON.stringify(lease(root, "00000000-0000-4000-8000-0000000000e1", "test", now - 60_000)),
  );
  for (const [index, check] of ["packaging", "test"].entries())
    writeFileSync(
      path.join(
        leases,
        "queue",
        `${String(now + index).padStart(15, "0")}-${"1".padStart(16, "0")}-q${index}.json`,
      ),
      JSON.stringify({ ...lease(root, `q${index}`, check, now + index), session: `s-q${index}` }),
    );
  const text = await status(root, env);
  expect(text.code).toBe(0);
  expect(text.stdout).toMatch(
    /slot 0: test, pid \d+, session s-other, 1m( \ds)?, .*; ~(8|9)m( \d+s)? left/u,
  );
  expect(text.stdout).toMatch(/1\. packaging, .*; estimated wait ~(8|9)m/u);
  // The second waiter starts once packaging (3m) ran after the holder's ~9m.
  expect(text.stdout).toMatch(/2\. test, .*; estimated wait ~1[12]m/u);
  const json = await status(root, env, true);
  const data = JSON.parse(json.stdout).data;
  expect(data.estimates.slots).toEqual([
    expect.objectContaining({ slot: 0, remainingMs: expect.any(Number) }),
  ]);
  expect(data.estimates.queue.map((item: { position: number }) => item.position)).toEqual([1, 2]);
  expect(data.estimates.queue[1].waitMs).toBeGreaterThan(data.estimates.queue[0].waitMs);
});

test("Given a holder whose check was never measured, When lock status runs, Then the waiter has no estimate and says why", async () => {
  const { root, env, leases } = setup();
  const now = Date.now();
  writeFileSync(
    path.join(leases, "slot-0.json"),
    JSON.stringify(lease(root, "00000000-0000-4000-8000-0000000000e2", "build", now - 5_000)),
  );
  writeFileSync(
    path.join(leases, "queue", `${String(now).padStart(15, "0")}-${"1".padStart(16, "0")}-q.json`),
    JSON.stringify(lease(root, "q", "test", now)),
  );
  const text = await status(root, env);
  expect(text.stdout).toContain("1. test");
  expect(text.stdout).toContain("no wait estimate yet (no measured run of build)");
});
