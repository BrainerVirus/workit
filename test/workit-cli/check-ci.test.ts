import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

const node = (code: string) => [BUN, "-e", code];

const setup = (config: unknown) => {
  const root = temp("wk-check-ci-");
  spawnSync("git", ["init", "-q", "-b", "feature/ci"], { cwd: root });
  mkdirSync(path.join(root, ".workit"));
  writeFileSync(path.join(root, ".workit", "checks.json"), JSON.stringify(config));
  const state = temp("wk-check-ci-state-");
  const cfg = temp("wk-check-ci-config-");
  writeFileSync(
    path.join(cfg, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "here", glob: "**", resources: { scope: false, slots: 1 } }],
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-ci",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: cfg,
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  return { root, env, state };
};

const check = (args: string[], root: string, env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
    const child = spawn(BUN, [MAIN, "check", ...args, "--cwd", root], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => void (stderr += String(chunk)));
    child.stdout.on("data", (chunk) => void (stdout += String(chunk)));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stderr, stdout });
    });
  });

test("Given a ci group with a failing member, When workit check ci runs, Then every member runs as its own check and the exit names the failed one", async () => {
  const { root, env } = setup({
    checks: { lint: node("0"), typecheck: node("process.exit(3)"), test: node("0") },
    groups: { ci: ["lint", "typecheck", "test"] },
  });
  const run = await check(["ci"], root, env);
  expect(run.code, run.stderr).toBe(1);
  for (const name of ["lint", "typecheck", "test"])
    expect(run.stderr).toContain(`workit check ${name}:`);
  expect(run.stderr).toContain("FAILED typecheck (2/3 passed)");
});

test("Given a ci group that all passes, When workit check ci runs, Then it exits 0", async () => {
  const { root, env } = setup({
    checks: { lint: node("0"), test: node("0") },
    groups: { ci: ["lint", "test"] },
  });
  const run = await check(["ci"], root, env);
  expect(run.code, run.stderr).toBe(0);
  expect(run.stderr).toContain("all 2 passed");
});

test("Given a repo without a ci group, When workit check ci runs, Then it exits 2 and lists the configured names", async () => {
  const { root, env } = setup({ checks: { lint: node("0"), test: node("0") } });
  const run = await check(["ci"], root, env);
  expect(run.code, run.stderr).toBe(2);
  const out = run.stdout + run.stderr;
  expect(out).toContain("no `ci` group");
  expect(out).toContain("lint, test");
  expect(out).toContain('"groups"');
});

test("Given light and heavy members while another session holds the lease, When the group runs, Then the light ones run at once and the heavy one queues", async () => {
  const { root, env } = setup({
    checks: { lint: node("0"), typecheck: node("0"), test: node("0") },
    groups: { ci: ["test", "lint", "typecheck"] },
  });
  // Another session holds the only slot for a while.
  const holder = spawn(
    BUN,
    [
      MAIN,
      "check",
      "--heavy",
      "--name",
      "other",
      "--cwd",
      root,
      "--",
      BUN,
      "-e",
      "setTimeout(()=>{},6000)",
    ],
    { env: { ...env, WORKIT_SESSION_ID: "s-other" }, stdio: "ignore" },
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const run = await check(["ci"], root, env);
  holder.kill("SIGKILL");
  const text = run.stderr;
  expect(run.code, text).toBe(0);
  expect(text.indexOf("running lint")).toBeLessThan(text.indexOf("running test"));
  expect(text.indexOf("workit check typecheck: passed")).toBeLessThan(
    text.indexOf("waiting for the heavy-check lease"),
  );
});
