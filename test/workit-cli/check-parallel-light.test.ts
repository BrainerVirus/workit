import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "@/packages/workit-core/src/core";
import { readLedger } from "@/packages/workit-core/src/ledger";

// #645: `workit check lint` and `workit check typecheck` launched together
// hung silently past 300 s while either alone took about a second. Light
// checks never take the heavy-check lease, so the two must run side by side:
// each command below waits at a barrier for the other to start, and fails
// if it never does, so a run that serializes them fails here instead of hanging.

setDefaultTimeout(90_000);

const BUN = process.execPath;
const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
/** How long one check waits at the barrier for the other before it fails. */
const BARRIER_MS = 20_000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const BARRIER = `
const fs = require("node:fs");
const path = require("node:path");
const [dir, me, other] = process.argv.slice(2);
fs.writeFileSync(path.join(dir, me), String(Date.now()));
const deadline = Date.now() + ${BARRIER_MS};
const poll = () => {
  if (fs.existsSync(path.join(dir, other))) process.exit(0);
  if (Date.now() > deadline) {
    console.error(me + ": " + other + " never started while " + me + " ran");
    process.exit(1);
  }
  setTimeout(poll, 25);
};
poll();
`;

const setup = () => {
  const root = temp("wk-check-light-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  // The barrier lives outside the repo: a check that writes the worktree leaves stale evidence.
  const barrier = temp("wk-check-light-barrier-");
  const script = path.join(barrier, "barrier.cjs");
  writeFileSync(script, BARRIER);
  const markers = path.join(barrier, "started");
  mkdirSync(markers);
  mkdirSync(path.join(root, ".workit"));
  writeFileSync(
    path.join(root, ".workit", "checks.json"),
    JSON.stringify({
      checks: {
        lint: [BUN, script, markers, "lint", "typecheck"],
        typecheck: [BUN, script, markers, "typecheck", "lint"],
      },
    }),
  );
  writeFileSync(path.join(root, "a.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature/parallel-light");
  const state = temp("wk-check-light-state-");
  const config = temp("wk-check-light-config-");
  // One heavy slot, held by nobody: lint and typecheck stay light by default.
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "here", glob: "**", resources: { scope: false, slots: 1 } }],
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-parallel-light",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  return { root, env };
};

type Run = { code: number | null; stdout: string; stderr: string; ms: number };
const check = (name: string, root: string, env: NodeJS.ProcessEnv) =>
  new Promise<Run>((resolve) => {
    const began = Date.now();
    const child = spawn(BUN, [MAIN, "check", name, "--json", "--cwd", root], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => void (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => void (stderr += String(chunk)));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, ms: Date.now() - began });
    });
  });

test("Given two light checks launched in parallel on one head, When both run, Then they run side by side, both exit 0 within the bound, and each records its evidence once", async () => {
  const { root, env } = setup();
  const [lint, typecheck] = await Promise.all([
    check("lint", root, env),
    check("typecheck", root, env),
  ]);
  const runs = { lint, typecheck };
  const evidence: Record<string, string> = {};
  for (const [name, run] of Object.entries(runs)) {
    expect(run.code, `${name}: ${run.stderr}`).toBe(0);
    // Each finished well inside the barrier: neither waited for the other to end.
    expect(run.ms, `${name}: ${run.stderr}`).toBeLessThan(BARRIER_MS);
    expect(run.stderr).not.toContain("heavy-check lease");
    const out = JSON.parse(run.stdout) as {
      ok: boolean;
      data: {
        name: string;
        evidenceId: string | null;
        ledgerRowId: string | null;
        lease: unknown;
      };
    };
    expect(out).toMatchObject({ ok: true, data: { name, lease: null } });
    expect(out.data.evidenceId).toBeString();
    expect(out.data.ledgerRowId).toBeString();
    evidence[name] = out.data.evidenceId!;
  }

  const ledger = readLedger(root);
  if (!ledger.ok) throw new Error(ledger.error);
  const rows = ledger.value.rows.filter((row) => row.type === "check");
  expect(rows.map((row) => String(row.name)).toSorted()).toEqual(["lint", "typecheck"]);

  // Both recorded on the branch's one implicit task, once each.
  const tasks = new TaskStore(root).listTasks();
  if (!tasks.ok) throw new Error(tasks.error);
  const recorded = tasks.data.flatMap((task) =>
    task.evidence.map((item) => ({ task: task.id, id: item.id })),
  );
  expect(recorded.map((item) => item.id).toSorted()).toEqual(Object.values(evidence).toSorted());
  expect(new Set(recorded.map((item) => item.task)).size).toBe(1);
});
