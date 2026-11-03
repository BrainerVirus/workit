import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// #645: two `workit check` calls launched together sat silent past the host
// timeout. Each now says at once that it started, the second queues for the
// lease with a status line or runs, and both exit.

setDefaultTimeout(90_000);

const BUN = process.execPath;
const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
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
  const root = temp("wk-check-parallel-");
  spawnSync("git", ["init", "-q", "-b", "feature/parallel"], { cwd: root });
  mkdirSync(path.join(root, ".workit"));
  const slow = [BUN, "-e", "setTimeout(() => {}, 1500)"];
  writeFileSync(
    path.join(root, ".workit", "checks.json"),
    JSON.stringify({ checks: { lint: slow, typecheck: slow } }),
  );
  const state = temp("wk-check-parallel-state-");
  const config = temp("wk-check-parallel-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "here",
          glob: "**",
          resources: { scope: false, slots: 1, heavy: ["lint", "typecheck"] },
        },
      ],
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-parallel",
    WORKFLOW_WORKSPACE_ROOT: "",
    WORKFLOW_TOOLKIT_STATE: state,
    WORKFLOW_TOOLKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  return { root, env };
};

const check = (name: string, root: string, env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | null; stderr: string; ms: number }>((resolve) => {
    const began = Date.now();
    const child = spawn(BUN, [MAIN, "check", name, "--cwd", root], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => void (stderr += String(chunk)));
    child.stdout.resume();
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stderr, ms: Date.now() - began });
    });
  });

test("Given two workit check runs started in parallel, When both run, Then each says it started, the second queues with a status line or runs, and both exit", async () => {
  const { root, env } = setup();
  const [lint, typecheck] = await Promise.all([
    check("lint", root, env),
    check("typecheck", root, env),
  ]);
  for (const [name, run] of [
    ["lint", lint],
    ["typecheck", typecheck],
  ] as const) {
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr.split("\n")[0]).toStartWith(`workit: check ${name}: starting`);
    expect(run.ms).toBeLessThan(60_000);
  }
  const queued = [lint, typecheck].filter((run) =>
    run.stderr.includes("waiting for the heavy-check lease"),
  );
  // One slot: unless the first ended before the second asked, the second queued and said so.
  expect(queued.length).toBeLessThanOrEqual(1);
});
