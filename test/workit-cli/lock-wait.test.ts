// `workit lock wait` waits like a queued heavy check: woken when a slot
// frees, and at its `resources.wait` limit it waits once more before it gives
// up with the heavy check's two-limit wording; `--timeout` is one hard bound.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** Two slots, both held by this (live) test process; `wait` seconds is resources.wait. */
const setup = (wait: number) => {
  const root = temp("wk-lock-wait-");
  spawnSync("git", ["init", "-q", "-b", "feature/lock-wait"], { cwd: root });
  const state = temp("wk-lock-wait-state-");
  const config = temp("wk-lock-wait-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "here", glob: "**", resources: { scope: false, slots: 2, wait } }],
    }),
  );
  const leases = path.join(state, "leases");
  mkdirSync(leases, { recursive: true });
  for (const slot of [0, 1])
    writeFileSync(
      path.join(leases, `slot-${slot}.json`),
      JSON.stringify({
        id: `00000000-0000-4000-8000-00000000000${slot}`,
        pid: process.pid,
        processStart: null,
        bootId: null,
        check: "test",
        cwd: "/elsewhere",
        session: `s-holder-${slot}`,
        startedAt: new Date().toISOString(),
        scope: null,
      }),
    );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-lock-wait",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  return { root, env, leases };
};

const lockWait = async (root: string, env: NodeJS.ProcessEnv, extra: string[] = []) => {
  let stdout = "";
  let stderr = "";
  const code = await main(["lock", "wait", "--json", ...extra], {
    cwd: root,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stderr, envelope: JSON.parse(stdout) as Record<string, any> };
};

test("Given `workit lock wait` on two busy slots past its first limit, When a slot frees, Then it returns free at once, re-queued once, without the single-limit 'stayed busy' text", async () => {
  const { root, env, leases } = setup(0.5);
  let freedAt = 0;
  const freeing = new Promise<void>((resolve) =>
    setTimeout(() => {
      rmSync(path.join(leases, "slot-1.json"));
      freedAt = Date.now();
      resolve();
    }, 800),
  );
  const result = await lockWait(root, env);
  await freeing;
  expect(result.code, result.stderr).toBe(0);
  expect(result.envelope.data).toMatchObject({ free: true });
  expect(result.envelope.data.requeuedAfterMs).toBeGreaterThanOrEqual(500);
  expect(result.stderr).toContain("re-queued once for up to 1s more");
  expect(result.stderr).not.toContain("stayed busy");
  // Woken by the release, not by the next one-second poll.
  expect(Date.now() - freedAt).toBeLessThan(500);
});

test("Given two busy slots that never free, When `workit lock wait` reaches its second limit, Then it gives up busy with the two-limit wording and an estimate", async () => {
  const { root, env } = setup(0.5);
  const result = await lockWait(root, env);
  expect(result.code).toBe(4);
  expect(result.envelope.code).toBe("busy");
  expect(result.envelope.error).toMatch(
    /^the heavy-check lease stayed busy for \d+s \(re-queued once after \d+s\); no wait estimate yet \(no measured run of test\); held by test, pid/u,
  );
  expect(result.envelope.data.requeuedAfterMs).toBeGreaterThanOrEqual(500);
});

test("Given two busy slots, When `workit lock wait --timeout` reaches it, Then it gives up at that one bound", async () => {
  const { root, env } = setup(30);
  const result = await lockWait(root, env, ["--timeout", "0"]);
  expect(result.code).toBe(4);
  expect(result.envelope.error).toMatch(/stayed busy for 0s, the whole --timeout; /u);
  expect(result.envelope.data.requeuedAfterMs).toBeNull();
  expect(result.stderr).not.toContain("re-queued");
});
