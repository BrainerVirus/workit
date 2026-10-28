// Issue #325: `workit lock` names the heavy-check lease, `--no-lease` needs a
// reason, and help explains the lease, waiting and --heavy.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";

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

const setup = () => {
  const root = temp("wk-lock-");
  spawnSync("git", ["init", "-q", "-b", "feature/lock"], { cwd: root });
  const state = temp("wk-lock-state-");
  const config = temp("wk-lock-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "here", glob: "**", resources: { scope: false } }] }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-lock",
    WORKFLOW_WORKSPACE_ROOT: "",
    WORKFLOW_TOOLKIT_STATE: state,
    WORKFLOW_TOOLKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  return { root, env, leases: path.join(state, "leases") };
};

const run = async (cwd: string, argv: string[], env: NodeJS.ProcessEnv) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const holdLease = (leases: string) => {
  mkdirSync(leases, { recursive: true });
  writeFileSync(
    path.join(leases, "slot-0.json"),
    JSON.stringify({
      id: "00000000-0000-4000-8000-0000000000c1",
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
};

test("Given `workit check --no-lease -- npm test` with no --reason, When it runs, Then it is refused and the command never starts", async () => {
  const { root, env } = setup();
  const marker = path.join(root, "ran");
  const refused = await run(
    root,
    [
      "check",
      "--no-lease",
      "--json",
      "--",
      BUN,
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
    ],
    env,
  );
  expect(refused.code).toBe(2);
  expect(refused.json()).toMatchObject({ ok: false, code: "invalid_input" });
  expect(refused.json().error).toContain("--no-lease needs --reason");
  expect(existsSync(marker)).toBe(false);
});

test("Given `workit help check` or `workit help lock`, When printed, Then it explains the lease, waiting and --heavy", async () => {
  const { root, env } = setup();
  for (const topic of [
    ["help", "check"],
    ["help", "lock"],
    ["lock", "run", "--help"],
  ]) {
    const help = await run(root, topic, env);
    expect(help.code, topic.join(" ")).toBe(0);
    expect(help.stdout).toContain("heavy-check lease");
    expect(help.stdout).toContain("waiting for the heavy-check lease");
    expect(help.stdout).toContain("--heavy");
    expect(help.stdout).toContain("--no-lease skips the lease and needs --reason");
  }
});

test("Given `workit lock heavy add`, When the command is tested next, Then it is gated, and remove takes it back out", async () => {
  const { root, env } = setup();
  const before = await run(
    root,
    ["lock", "heavy", "test", "--json", "--", "./ci/integration.sh", "--all"],
    env,
  );
  expect(before.json().data).toMatchObject({ heavy: false, rewrite: null });
  expect((await run(root, ["lock", "heavy", "add", "./ci/integration.sh"], env)).code).toBe(0);
  expect((await run(root, ["lock", "heavy", "add", "mvn verify"], env)).code).toBe(0);
  const after = await run(
    root,
    ["lock", "heavy", "test", "--json", "--", "./ci/integration.sh", "--all"],
    env,
  );
  expect(after.json().data).toMatchObject({
    heavy: true,
    source: { pattern: "./ci/integration.sh", from: "machine" },
    rewrite: "workit check --heavy -- ./ci/integration.sh --all",
  });
  const maven = await run(root, ["lock", "heavy", "test", "--json", "--", "mvn", "verify"], env);
  expect(maven.json().data).toMatchObject({
    heavy: true,
    rewrite: "workit check --heavy -- mvn verify",
  });
  const listed = await run(root, ["lock", "heavy", "list", "--json"], env);
  expect(listed.json().data.machine).toEqual(["./ci/integration.sh", "mvn verify"]);
  expect((await run(root, ["lock", "heavy", "remove", "./ci/integration.sh"], env)).code).toBe(0);
  const removed = await run(
    root,
    ["lock", "heavy", "test", "--json", "--", "./ci/integration.sh"],
    env,
  );
  expect(removed.json().data.heavy).toBe(false);
});

test("Given a lease held by another check, When `workit lock status` and `workit lock wait` run, Then status names the holder and wait gives up busy; once free, wait returns at once", async () => {
  const { root, env, leases } = setup();
  holdLease(leases);
  const status = await run(root, ["lock", "status"], env);
  expect(status.code).toBe(0);
  expect(status.stdout).toContain("1 of 1 slot held");
  expect(status.stdout).toContain("test, pid");
  expect(status.stdout).toContain("session s-other");
  expect(status.stdout).toContain("queue: empty");
  // A check queued behind it (#508) shows in arrival order.
  mkdirSync(path.join(leases, "queue"), { recursive: true });
  writeFileSync(
    path.join(leases, "queue", "000000000000001-0000000000000000-waiter.json"),
    JSON.stringify({
      id: "00000000-0000-4000-8000-0000000000c1",
      pid: process.pid,
      processStart: null,
      bootId: null,
      check: "build",
      cwd: "/repo/queued",
      session: "s-queued",
      startedAt: new Date().toISOString(),
      scope: null,
    }),
  );
  const queued = await run(root, ["lock", "status"], env);
  expect(queued.stdout).toContain("queue: 1 waiting, first come, first served");
  expect(queued.stdout).toContain("1. build, pid");
  const json = await run(root, ["lock", "status", "--json"], env);
  expect(json.json().data.queue).toEqual([expect.objectContaining({ cwd: "/repo/queued" })]);
  const noWait = await run(root, ["lock", "run", "--no-wait", "--json", "--", BUN, "-e", "0"], env);
  expect(noWait.code).toBe(4);
  rmSync(path.join(leases, "queue"), { recursive: true });
  const busy = await run(root, ["lock", "wait", "--timeout", "0", "--json"], env);
  expect(busy.code).toBe(4);
  expect(busy.json()).toMatchObject({ ok: false, code: "busy" });
  rmSync(path.join(leases, "slot-0.json"));
  const free = await run(root, ["lock", "wait", "--timeout", "5", "--json"], env);
  expect(free.code).toBe(0);
  expect(free.json().data.free).toBe(true);
});

test("Given `workit lock run -- <cmd>`, When it runs, Then the command takes the lease like workit check --heavy", async () => {
  const { root, env, leases } = setup();
  const result = await run(
    root,
    ["lock", "run", "--json", "--", BUN, "-e", "process.exit(0)"],
    env,
  );
  expect(result.code, result.stderr).toBe(0);
  expect(result.json().data.lease).toMatchObject({ slot: 0, inherited: false });
  expect(existsSync(path.join(leases, "slot-0.json"))).toBe(false);
});
