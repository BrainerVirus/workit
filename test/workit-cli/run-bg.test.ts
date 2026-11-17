// #328: `workit run --bg` starts a registered background process under a
// detached supervisor; `workit ps` lists it; `workit stop` ends its whole
// process group with a ledger row. Fake servers only, in temp dirs; every
// process the test starts is killed in afterEach.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { runDeps } from "@/packages/workit-cli/src/verbs/run";
import { procsDeps, readExtra } from "@/packages/workit-core/src/core/procs";
import { procTree } from "@/packages/workit-core/src/core/proc-tree";
import { openThreadsStore } from "@/packages/workit-core/src/store/threads/store";
import { readLedger } from "@/packages/workit-core/src/ledger";

const BUN = process.execPath;
const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const dirs: string[] = [];
const groups = new Set<number>();
const saved = { ...runDeps };
const savedGrace = procsDeps.graceMs;

beforeAll(() => {
  runDeps.supervisor = () => [BUN, MAIN, "run"];
  runDeps.startBoundMs = 8_000;
  runDeps.hostPid = () => null;
  procsDeps.graceMs = 1_000;
});
afterAll(() => {
  Object.assign(runDeps, saved);
  procsDeps.graceMs = savedGrace;
});

const killGroup = (pgid: number) => {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}
};

afterEach(() => {
  runDeps.startBoundMs = 8_000;
  for (const pgid of groups) killGroup(pgid);
  groups.clear();
  runDeps.hostPid = () => null;
  runDeps.ceilingBytes = null;
  runDeps.sampleMs = 30_000;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

const setup = (resources: Record<string, unknown> = { scope: false }) => {
  const root = temp("wk-run-");
  git(root, "init", "-q", "-b", "feature/run");
  writeFileSync(path.join(root, "README.md"), "x\n");
  git(root, "add", "README.md");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  const state = temp("wk-run-state-");
  const config = temp("wk-run-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "here", glob: "**", resources }] }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-run",
    WORKIT_HOST: "claude-code",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  delete env.OPENCODE_SESSION_ID;
  delete env.PI_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  return { root, env, state };
};

/** A fake dev server: prints its port, starts a child that ignores SIGTERM, and waits. */
const fakeServer = (dir: string, port: number, name = "serve.sh") => {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    `#!/bin/sh\nsh -c 'trap "" TERM; while :; do sleep 1; done' &\necho "ready on http://localhost:${port}/"\nwhile :; do sleep 1; done\n`,
  );
  chmodSync(file, 0o755);
  return file;
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

const rows = (env: NodeJS.ProcessEnv) => {
  const store = openThreadsStore({ env });
  try {
    return store.db.all("SELECT * FROM procs");
  } finally {
    store.close();
  }
};

const alive = (target: number) => {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

const start = async (root: string, env: NodeJS.ProcessEnv, extra: string[], command: string[]) => {
  const result = await run(root, ["run", "--bg", ...extra, "--json", "--", ...command], env);
  const data = result.stdout ? result.json().data : null;
  if (data?.pid) groups.add(data.pid);
  return { ...result, data };
};

test("Given `workit run --bg -- <fake server printing localhost:4321>`, Then it returns within 5 s with id, pid, port 4321 and the log, ps lists it with its owner and RSS, and the row is in threads.db", async () => {
  const { root, env } = setup();
  runDeps.sampleMs = 200;
  // The start returns once the log shows the port, long before its bound.
  runDeps.startBoundMs = 60_000;
  const started = await start(root, env, [], [fakeServer(root, 4321)]);
  expect(started.code, started.stderr).toBe(0);
  const { id, pid, port, log } = started.data;
  expect(id).toMatch(/^p[a-z0-9]+$/u);
  expect(alive(pid)).toBe(true);
  expect(port).toBe(4321);
  expect(readFileSync(log, "utf8")).toContain("localhost:4321");

  const human = await run(root, ["run", "--bg", "--", fakeServer(root, 4321)], env);
  expect(human.stdout).toContain(`already running ${id} (dev) pid ${pid} port 4321`);

  expect(await waitFor(() => rows(env)[0]?.rss !== null)).toBe(true);
  const listed = await run(root, ["ps", "--json"], env);
  const [row] = listed.json().data.processes;
  expect(row).toMatchObject({ id, pid, port: 4321, session: "s-run", kind: "server" });
  expect(row.rss).toBeGreaterThan(0);
  const text = await run(root, ["ps"], env);
  expect(text.stdout).toContain(`${id}  dev  server  pid ${pid}  port 4321`);
  expect(text.stdout).toContain("owner s-run");
  const [stored] = rows(env);
  expect(stored).toMatchObject({ id, pid, pgid: pid, host: "claude-code", ended_at: null });
}, 20_000);

test("Given that server alive, When the same checkout starts another server, Then it prints the existing id and port and starts nothing", async () => {
  const { root, env } = setup();
  const first = await start(root, env, [], [fakeServer(root, 4321)]);
  const marker = path.join(root, "second-ran");
  const second = await start(root, env, [], ["sh", "-c", `touch ${marker}; sleep 30`]);
  expect(second.code).toBe(0);
  expect(second.data).toMatchObject({ id: first.data.id, port: 4321, existing: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(existsSync(marker)).toBe(false);
  expect(rows(env)).toHaveLength(1);
}, 20_000);

test("Given a live server in one checkout, When another checkout of the repo starts one, Then it exits non-zero naming the live one's cwd, branch and owner", async () => {
  const { root, env } = setup();
  const other = path.join(temp("wk-run-wt-"), "wt");
  git(root, "worktree", "add", "-q", "-b", "feature/other", other);
  await start(root, env, [], [fakeServer(root, 4321)]);
  const refused = await run(other, ["run", "--bg", "--", fakeServer(other, 4322)], env);
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain(root);
  expect(refused.stderr).toContain("[feature/run]");
  expect(refused.stderr).toContain("owner s-run");
  expect(rows(env)).toHaveLength(1);
}, 20_000);

test("Given `workit stop <id>`, Then the whole group is gone (the child ignoring SIGTERM is killed after the grace), the row is ended with the reason, and a proc.stopped ledger row exists", async () => {
  const { root, env } = setup();
  const started = await start(root, env, [], [fakeServer(root, 4321)]);
  const { id, pid } = started.data;
  // The leader and the child that ignores SIGTERM are both in its group.
  const members = () =>
    (procTree.table() ?? "")
      .split("\n")
      .filter((line) => Number(line.trim().split(/\s+/u)[0]) === pid).length;
  expect(await waitFor(() => members() >= 2)).toBe(true);
  const stopped = await run(root, ["stop", id, "--reason", "work delivered"], env);
  expect(stopped.code, stopped.stderr).toBe(0);
  expect(stopped.stdout).toContain(`stopped (SIGKILL) ${id}`);
  expect(alive(-pid)).toBe(false);
  const [row] = rows(env);
  expect(row.ended_at).not.toBeNull();
  expect(row.end_reason).toBe("work delivered");
  const ledger = readLedger(root);
  if (!ledger.ok) throw new Error(ledger.error);
  const entry = ledger.value.rows.find((item) => item.type === "proc.stopped") as unknown as Record<
    string,
    unknown
  >;
  expect(entry).toMatchObject({
    proc: id,
    reason: "work delivered",
    signal: "SIGKILL",
    observer: "workit_cli",
  });
  const again = await run(root, ["stop", id], env);
  expect(again.stdout).toContain(`skipped ${id}: already ended`);
}, 20_000);

test("Given a command that exits within the start bound, Then run prints its output and exit code and leaves no live row", async () => {
  const { root, env } = setup();
  const result = await run(root, ["run", "--bg", "--", "sh", "-c", "echo built once; exit 3"], env);
  expect(result.code).toBe(3);
  expect(result.stdout).toContain("built once");
  expect(result.stderr).toContain("exited 3 within the start bound");
  expect(rows(env).filter((row) => row.ended_at === null)).toHaveLength(0);
}, 20_000);

test("Given a process past the RSS ceiling, Then exactly one notice file for its owner names it and the restart command", async () => {
  const { root, env, state } = setup();
  runDeps.ceilingBytes = 1;
  runDeps.sampleMs = 150;
  const started = await start(root, env, [], [fakeServer(root, 4321)]);
  const notices = path.join(state, "procs", "notices", "s-run.json");
  expect(await waitFor(() => existsSync(notices))).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const file = JSON.parse(readFileSync(notices, "utf8"));
  expect(file.notices).toHaveLength(1);
  expect(file.notices[0]).toMatchObject({
    id: started.data.id,
    ceilingBytes: 1,
    restart: `workit run --bg --restart ${started.data.id}`,
  });
  expect(readExtra(env, started.data.id)?.noticed).toBe(true);
}, 20_000);

test("Given `workit run --bg --restart <id>`, Then the old group is stopped and the same command runs again under a new id", async () => {
  const { root, env } = setup();
  const first = await start(root, env, [], [fakeServer(root, 4321)]);
  const restarted = await run(root, ["run", "--bg", "--restart", first.data.id, "--json"], env);
  expect(restarted.code, restarted.stderr).toBe(0);
  const data = restarted.json().data;
  groups.add(data.pid);
  expect(data.id).not.toBe(first.data.id);
  expect(data.port).toBe(4321);
  expect(alive(-first.data.pid)).toBe(false);
  const ended = rows(env).find((row) => row.id === first.data.id);
  expect(ended?.end_reason).toBe("restart");
}, 20_000);

test("Given an agent session, When it stops another session's process by id, Then it is skipped and keeps running", async () => {
  const { root, env } = setup();
  const started = await start(root, env, [], [fakeServer(root, 4321)]);
  const other = { ...env, WORKIT_SESSION_ID: "s-someone-else" };
  const refused = await run(root, ["stop", started.data.id], other);
  expect(refused.stdout).toContain(`skipped ${started.data.id}: owned by session s-run`);
  expect(alive(started.data.pid)).toBe(true);
  // A person at a terminal (no host session) may stop it.
  const person = { ...env, WORKIT_HOST: "", WORKIT_SESSION_ID: "" };
  const stopped = await run(root, ["stop", started.data.id], person);
  expect(stopped.code, stopped.stderr).toBe(0);
  expect(await waitFor(() => !alive(-started.data.pid))).toBe(true);
}, 20_000);

test("Given registered processes with a dead owner, a live owner, and an unregistered process, When gc --procs runs, Then only the orphan is listed, and --apply stops and records it", async () => {
  const { root, env } = setup();
  const deadHost = spawn("sleep", ["60"], { stdio: "ignore" });
  const liveHost = spawn("sleep", ["60"], { stdio: "ignore" });
  const stranger = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  try {
    runDeps.hostPid = () => deadHost.pid ?? null;
    const orphan = await start(root, env, ["--name", "web"], [fakeServer(root, 4401, "a.sh")]);
    runDeps.hostPid = () => liveHost.pid ?? null;
    const owned = await start(root, env, ["--name", "api"], [fakeServer(root, 4402, "b.sh")]);
    deadHost.kill("SIGKILL");
    await waitFor(() => !alive(deadHost.pid!));

    const dry = await run(root, ["gc", "--procs"], env);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(
      `would stop ${orphan.data.id}: its owner's host process ${deadHost.pid} is gone`,
    );
    expect(dry.stdout).not.toContain(owned.data.id);
    expect(alive(orphan.data.pid)).toBe(true);

    const applied = await run(root, ["gc", "--procs", "--apply"], env);
    expect(applied.stdout, applied.stderr).toContain(`stopped ${orphan.data.id}`);
    expect(await waitFor(() => !alive(-orphan.data.pid))).toBe(true);
    expect(alive(owned.data.pid)).toBe(true);
    expect(alive(stranger.pid!)).toBe(true);
    const ledger = readLedger(root);
    if (!ledger.ok) throw new Error(ledger.error);
    expect(
      ledger.value.rows.some(
        (item) =>
          item.type === "proc.stopped" &&
          (item as unknown as { proc: string }).proc === orphan.data.id,
      ),
    ).toBe(true);
  } finally {
    for (const child of [deadHost, liveHost, stranger]) child.kill("SIGKILL");
  }
}, 30_000);

test("Given `workit run` without --bg or without a command, Then it refuses with the usage", async () => {
  const { root, env } = setup();
  expect((await run(root, ["run", "--", "sleep", "1"], env)).stderr).toContain("pass --bg");
  expect((await run(root, ["run", "--bg"], env)).stderr).toContain("no command after --");
  expect((await run(root, ["run", "--bg", "--no-lease", "--", "x"], env)).stderr).toContain(
    "needs --reason",
  );
});

test("Given a running server, When `workit stop --within .` runs in its checkout, Then it stops, and ps then lists nothing running", async () => {
  const { root, env } = setup();
  const started = await start(root, env, [], [fakeServer(root, 4321)]);
  const elsewhere = temp("wk-run-else-");
  const none = await run(elsewhere, ["stop", "--within", "."], env);
  expect(none.stdout).toContain("nothing to stop");
  expect(alive(started.data.pid)).toBe(true);
  const stopped = await run(root, ["stop", "--within", ".", "--reason", "delivered"], env);
  expect(stopped.code, stopped.stderr).toBe(0);
  expect(stopped.stdout).toContain(`${started.data.id} -- `);
  expect(await waitFor(() => !alive(-started.data.pid))).toBe(true);
  expect((await run(root, ["ps"], env)).stdout).toContain(
    "no registered background processes running",
  );
}, 20_000);
