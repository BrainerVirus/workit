// #328 with decider ruling 6: a background server is charged against the heavy
// budget of its own checkout; a start that does not fit is refused at once
// naming the holders, and `--no-lease --reason` starts it with a ledger row.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { runDeps } from "@/packages/workit-cli/src/verbs/run";
import { checkoutBudget } from "@/packages/workit-cli/src/procs/supervisor";
import { admit, leaseDir, type ResourceSource } from "@/packages/workit-core/src/core/resources";
import { openThreadsStore } from "@/packages/workit-core/src/store/threads/store";
import { readLedger } from "@/packages/workit-core/src/ledger";

const BUN = process.execPath;
const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const GiB = 1024 ** 3;
const dirs: string[] = [];
const groups: number[] = [];
const releases: Array<() => void> = [];
const saved = { ...runDeps };

beforeAll(() => {
  runDeps.supervisor = () => [BUN, MAIN, "run"];
  runDeps.startBoundMs = 8_000;
  runDeps.hostPid = () => null;
});
afterAll(() => Object.assign(runDeps, saved));
afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const pid of groups.splice(0))
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const setup = (resources: Record<string, unknown>) => {
  const root = temp("wk-runb-");
  spawnSync("git", ["init", "-q", "-b", "feature/budget"], { cwd: root });
  const config = temp("wk-runb-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "here", glob: "**", resources }] }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-budget",
    WORKIT_HOST: "claude-code",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: temp("wk-runb-state-"),
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  const server = path.join(root, "serve.sh");
  writeFileSync(server, "#!/bin/sh\necho 'on http://localhost:4555'\nwhile :; do sleep 1; done\n");
  chmodSync(server, 0o755);
  return { root, env, server };
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
  return { code, stdout, stderr };
};

const machine = (value: Record<string, unknown>): ResourceSource[] => [
  { label: "workspaces.json", trust: "machine", value },
];

const liveRows = (env: NodeJS.ProcessEnv) => {
  const store = openThreadsStore({ env });
  try {
    return store.db.all("SELECT * FROM procs WHERE ended_at IS NULL");
  } finally {
    store.close();
  }
};

/** Another server holding 900 MiB of a 1 GiB budget. */
const holdBudget = (env: NodeJS.ProcessEnv, root: string) => {
  const held = admit({
    dir: leaseDir(env),
    kind: "server",
    label: "dev: ng serve",
    rssBytes: 900 * 1024 ** 2,
    cwd: root,
    session: "s-holder",
    ref: "pholder0001",
    budget: checkoutBudget(machine({ budget: "1G" })),
  });
  if (!held.ok) throw new Error(held.line);
  releases.push(held.admission.release);
};

test("Given a full heavy budget, When a server starts, Then it is refused at once naming the holders and the unblock, and nothing runs", async () => {
  const { root, env, server } = setup({ scope: false, budget: "1G" });
  holdBudget(env, root);
  const refused = await run(root, ["run", "--bg", "--", server], env);
  expect(refused.code).toBe(3);
  expect(refused.stderr).toContain("not started: it needs 512 MiB");
  expect(refused.stderr).toContain("dev: ng serve");
  expect(refused.stderr).toContain("workit stop pholder0001");
  expect(refused.stderr).toContain("--no-lease --reason");
  expect(liveRows(env)).toHaveLength(0);
}, 20_000);

test("Given a full heavy budget, When the start passes --no-lease --reason, Then it starts and the reason is in the ledger", async () => {
  const { root, env, server } = setup({ scope: false, budget: "1G" });
  holdBudget(env, root);
  const started = await run(
    root,
    ["run", "--bg", "--no-lease", "--reason", "demo for the user", "--json", "--", server],
    env,
  );
  expect(started.code, started.stderr).toBe(0);
  const data = JSON.parse(started.stdout).data;
  groups.push(data.pid);
  expect(data.port).toBe(4555);
  const ledger = readLedger(root);
  if (!ledger.ok) throw new Error(ledger.error);
  expect(ledger.value.rows.find((row) => row.type === "proc.no_lease")).toMatchObject({
    proc: data.id,
    reason: "demo for the user",
  });
}, 20_000);

test("Given two checkouts resolved in one process, When each admits a server, Then each uses its own budget", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKIT_STATE_DIR: temp("wk-runb-two-") };
  const small = checkoutBudget(machine({ budget: "1G" }));
  const large = checkoutBudget(machine({ budget: "3G" }));
  expect(small.memoryBytes).toBe(GiB);
  expect(large.memoryBytes).toBe(3 * GiB);
  const ask = (budget: typeof small) =>
    admit({
      dir: leaseDir(env),
      kind: "server",
      label: "probe",
      rssBytes: 2 * GiB,
      cwd: "/a",
      session: null,
      budget,
    });
  // Resolved last, the large budget must not leak into the small one's admission.
  const refused = ask(small);
  expect(refused.ok).toBe(false);
  const admitted = ask(large);
  expect(admitted.ok).toBe(true);
  if (admitted.ok) admitted.admission.release();
});
