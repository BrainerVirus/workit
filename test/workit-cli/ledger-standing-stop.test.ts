// #320: `workit ledger standing add --stop` records the stop line running
// workers get on their next tool call; `add --clear` lifts it and keeps the
// other orders. Real git repositories, the real CLI entry.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { standingPending } from "@/packages/workit-core/src/hooks/standing-signal";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-standing-stop-config-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const run = async (cwd: string, argv: string[], session = "lead-1") => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: session },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const planned = async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-standing-stop-"));
  dirs.push(root);
  const cwd = path.join(root, "app");
  const hooks = path.join(root, "hooks");
  mkdirSync(cwd);
  mkdirSync(hooks);
  git(cwd, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", hooks],
  ])
    git(cwd, "config", key, value);
  writeFileSync(path.join(cwd, "README.md"), "# app\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  const file = path.join(root, "plan.json");
  writeFileSync(
    file,
    JSON.stringify({
      name: "wave",
      trunk: "main",
      slices: [
        {
          id: "a",
          branch: "feature/a",
          tier: "mundane",
          reason: "parallel",
          scope: ["a.ts"],
          goal: "GET /a answers 200",
          acceptance: ["Given the app, When GET /a, Then the status is 200"],
          verify: ["workit check test"],
          forbidden: ["no new packages"],
        },
      ],
    }),
  );
  const plan = await run(cwd, ["fanout", "plan", file, "--json"]);
  expect(plan.code, plan.stderr + plan.stdout).toBe(0);
  return cwd;
};

test("Given a running worker, When the lead runs standing add --stop, Then the stop line is in force and the worker's next hook has a revision to read", async () => {
  const cwd = await planned();
  await run(cwd, ["ledger", "standing", "add", "no new dependencies", "--json"]);
  const stop = await run(cwd, ["ledger", "standing", "add", "--stop", "memory is tight"]);
  expect(stop.code, stop.stderr + stop.stdout).toBe(0);
  expect(stop.stdout).toContain("running workers stop and report on their next tool call");
  expect(standingPending(cwd, "lead-1", "agent-1")).toBe(true);
  const listed = (await run(cwd, ["ledger", "standing", "list", "--json"])).json().data.orders;
  expect(listed.map((order: { what: string }) => order.what)).toEqual([
    "no new dependencies",
    expect.stringMatching(/^STOP: .*report to the lead now \(memory is tight\)$/u),
  ]);
});

test("Given a stop line, When the lead runs standing add --clear, Then only the stop line is cleared, and a second --clear finds none", async () => {
  const cwd = await planned();
  await run(cwd, ["ledger", "standing", "add", "no new dependencies"]);
  await run(cwd, ["ledger", "standing", "add", "--stop"]);
  const lifted = await run(cwd, ["ledger", "standing", "add", "--clear", "--json"]);
  expect(lifted.code, lifted.stderr + lifted.stdout).toBe(0);
  const orders = (await run(cwd, ["ledger", "standing", "list", "--json"])).json().data.orders;
  expect(orders.map((order: { what: string }) => order.what)).toEqual(["no new dependencies"]);
  const again = await run(cwd, ["ledger", "standing", "add", "--clear", "--json"]);
  expect(again.json()).toMatchObject({
    code: "not_found",
    error: "no stop line in force for fanout wave",
  });
});

test("Given a worker session, When it runs standing add --stop, Then it is refused: the stop line comes from the lead", async () => {
  const cwd = await planned();
  const refused = await run(
    cwd,
    ["ledger", "standing", "add", "--stop", "--json"],
    "lead-1:agent-1",
  );
  expect(refused.code).not.toBe(0);
  expect(refused.json().code).toBe("blocked");
});

test("Given --stop or --clear outside standing add, or both at once, Then the CLI refuses the grammar", async () => {
  const cwd = await planned();
  for (const argv of [
    ["ledger", "standing", "list", "--stop", "--json"],
    ["ledger", "standing", "clear", "--clear", "--json"],
    ["ledger", "standing", "add", "--stop", "--clear", "--json"],
  ]) {
    const result = await run(cwd, argv);
    expect(result.json().code, argv.join(" ")).toBe("invalid_input");
  }
});
