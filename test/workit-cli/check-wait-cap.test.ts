// The lease wait inside a host shell tool (#325): Claude Code and OpenCode
// kill a shell call at 120 s, so `workit check` caps its lease wait there
// (100 s; WORKIT_HOST_WAIT_CAP_MS replaces it in tests). An explicit
// --wait wins; outside those hosts the configured wait applies.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { hostToolWaitCapMs } from "@/packages/workit-cli/src/verbs/check";

const BUN = process.execPath;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A repo whose lease is held by this process, with a configured wait of `waitS`. */
const setup = (waitS: number) => {
  const root = temp("wk-wait-cap-");
  spawnSync("git", ["init", "-q", "-b", "feature/wait"], { cwd: root });
  const state = temp("wk-wait-cap-state-");
  const config = temp("wk-wait-cap-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "here", glob: "**", resources: { scope: false, wait: waitS } }],
    }),
  );
  const leases = path.join(state, "leases");
  mkdirSync(leases, { recursive: true });
  writeFileSync(
    path.join(leases, "slot-0.json"),
    JSON.stringify({
      id: "00000000-0000-4000-8000-0000000000d1",
      pid: process.pid,
      processStart: null,
      bootId: null,
      check: "test",
      cwd: "/elsewhere",
      session: "s-other",
      startedAt: new Date().toISOString(),
      scope: null,
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-wait",
    WORKFLOW_WORKSPACE_ROOT: "",
    WORKFLOW_TOOLKIT_STATE: state,
    WORKFLOW_TOOLKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
    WORKIT_HOST_WAIT_CAP_MS: "200",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  return { root, env };
};

const heavy = async (root: string, env: NodeJS.ProcessEnv, flags: string[] = []) => {
  let stdout = "";
  const code = await main(["check", "--heavy", ...flags, "--json", "--", BUN, "-e", "0"], {
    cwd: root,
    env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  return { code, waitedMs: JSON.parse(stdout).data?.lease?.waitedMs as number };
};

test("Given the host markers, Then the cap is 100 s inside Claude Code and OpenCode and none elsewhere", () => {
  expect(hostToolWaitCapMs({ CLAUDECODE: "1" })).toBe(100_000);
  expect(hostToolWaitCapMs({ OPENCODE: "1" })).toBe(100_000);
  expect(hostToolWaitCapMs({ OPENCODE_SESSION_ID: "ses_1" })).toBe(100_000);
  expect(hostToolWaitCapMs({})).toBeNull();
  expect(hostToolWaitCapMs({ CLAUDECODE: "1", WORKIT_HOST_WAIT_CAP_MS: "200" })).toBe(200);
});

test("Given a held lease in a Claude Code or OpenCode shell, When a heavy check waits, Then it gives up busy at the host cap, not the configured wait", async () => {
  for (const marker of ["CLAUDECODE", "OPENCODE"]) {
    const { root, env } = setup(30);
    const started = Date.now();
    const result = await heavy(root, { ...env, [marker]: "1" });
    expect(result.code, marker).toBe(4);
    expect(Date.now() - started, marker).toBeLessThan(5_000);
  }
});

test("Given an explicit --wait, When a heavy check waits in a Claude Code shell, Then --wait wins over the cap", async () => {
  const { root, env } = setup(30);
  const started = Date.now();
  const result = await heavy(root, { ...env, CLAUDECODE: "1" }, ["--wait", "5"]);
  expect(result.code).toBe(4);
  expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
}, 20_000);

test("Given no host marker, When a heavy check waits, Then the configured wait applies", async () => {
  const { root, env } = setup(2);
  const started = Date.now();
  const result = await heavy(root, env);
  expect(result.code).toBe(4);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_800);
}, 20_000);
