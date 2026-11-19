import "@/test/shared/state-isolation";
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { repoDir } from "@/packages/workit-core/src/core/repo-paths";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { FANOUT_TOKEN_FILE } from "@/packages/workit-core/src/hooks/worktree-confine";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { fixture, withProtectedMain } from "../workit-core/hooks/hook-fixtures";

// Decision D2/D4 (ft-spawn-gate): the slice name is enough to spawn an
// implementer on the first try. `fanout worktree create` takes several
// slices, registers a plan passed by path, makes one unplanned slice with
// --branch, and prints per slice the WORKTREE line and the spawn whose
// prompt the spawn gate passes unchanged. Every repository is a real one.

setDefaultTimeout(30_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-fanout-spawn-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const makeRepo = (): { root: string; cwd: string } => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-fanout-spawn-")));
  dirs.push(root);
  const cwd = path.join(root, "app");
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  git(cwd, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", path.join(root, "no-hooks")],
  ])
    git(cwd, "config", key, value);
  writeFileSync(path.join(cwd, "src", "core.ts"), "export const core = 1;\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  return { root, cwd };
};

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "lead-1", WORKIT_HOST: "claude_code" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
};

const slice = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  branch: `feature/${id}`,
  tier: "standard",
  reason: "parallel",
  scope: [`src/${id}/**`],
  goal: `ship ${id}`,
  acceptance: [`Given the app, When ${id} runs, Then it works`],
  verify: ["workit check test"],
  forbidden: ["no edits outside SCOPE"],
  ...extra,
});

const writePlan = (file: string, name: string, ids: string[]): string => {
  writeFileSync(file, JSON.stringify({ name, trunk: "main", slices: ids.map((id) => slice(id)) }));
  return file;
};

/** Is `dir` a worktree `fanout worktree create` made (its admin dir holds the token)? */
const tokened = (dir: string): boolean =>
  existsSync(path.resolve(dir, git(dir, "rev-parse", "--git-dir"), FANOUT_TOKEN_FILE));

/** The spawn gate on a workit:implementer spawn with `prompt`: its deny reason, or null when it runs. */
const gate = (cwd: string, prompt: string): string | null => {
  const out = dispatchHook(claudeCodeAdapter, {
    ...fixture("claude-code", "pre-tool-use-bash", cwd),
    permission_mode: "auto",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "workit:implementer",
      run_in_background: true,
      description: "d",
      prompt,
    },
  }).json as { hookSpecificOutput?: { permissionDecisionReason?: string } } | undefined;
  return out?.hookSpecificOutput?.permissionDecisionReason ?? null;
};

/** The prompt a printed SPAWN line carries (a JSON string at its end). */
const spawnPrompt = (line: string): string => JSON.parse(line.slice(line.indexOf("prompt: ") + 8));

test("Given a registered plan, When `fanout worktree create a b c` runs, Then three worktrees exist and each slice prints a WORKTREE line and a spawn whose prompt passes the gate unchanged", async () => {
  const { root, cwd } = makeRepo();
  const plan = writePlan(path.join(root, "plan.json"), "wave", ["a", "b", "c"]);
  expect((await run(cwd, ["fanout", "plan", plan])).code).toBe(0);
  const out = await run(cwd, ["fanout", "worktree", "create", "a", "b", "c"]);
  expect(out.code, out.stderr).toBe(0);
  const lines = out.stdout.split("\n");
  const worktrees = lines.filter((line) => line.startsWith("WORKTREE: ")).map((l) => l.slice(10));
  const spawns = lines.filter((line) => line.startsWith("SPAWN: "));
  expect(worktrees).toHaveLength(3);
  expect(spawns).toHaveLength(3);
  for (const [index, id] of ["a", "b", "c"].entries()) {
    expect(path.basename(worktrees[index])).toBe(id);
    expect(tokened(worktrees[index])).toBe(true);
    expect(spawns[index]).toStartWith(
      `SPAWN: Agent subagent_type: "workit:implementer", run_in_background: true, description: "${id}", prompt: `,
    );
    // The standard tier is the agent file's model: the spawn names none.
    expect(spawns[index]).not.toContain("model:");
    const prompt = spawnPrompt(spawns[index]);
    expect(prompt.split("\n")[0]).toBe(`WORKTREE: ${worktrees[index]}`);
    expect(prompt).toContain(`Run \`workit fanout brief ${id} --name wave\``);
    expect(gate(cwd, prompt)).toBeNull();
  }
});

test("Given a hard slice whose tier model differs from the agent file, When its worktree is made, Then its spawn names the model", async () => {
  const { root, cwd } = makeRepo();
  const plan = path.join(root, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({ name: "wave", trunk: "main", slices: [slice("h", { tier: "hard" })] }),
  );
  expect((await run(cwd, ["fanout", "plan", plan])).code).toBe(0);
  const out = await run(cwd, ["fanout", "worktree", "create", "h", "--json"]);
  expect(out.code, out.stdout).toBe(0);
  const data = JSON.parse(out.stdout).data;
  expect(data.spawn).toContain('model: "opus"');
  expect(data.prompt).toStartWith(`WORKTREE: ${data.path}\n`);
});

test("Given an unregistered plan file, When `worktree create a --name <path>/plan.json` (or --plan <path>) runs, Then the plan is registered and the worktree made in that call", async () => {
  const { root, cwd } = makeRepo();
  const plan = writePlan(path.join(root, "plan.json"), "wave", ["a", "b"]);
  const byName = await run(cwd, ["fanout", "worktree", "create", "a", "--name", plan]);
  expect(byName.code, byName.stdout + byName.stderr).toBe(0);
  expect(byName.stderr).toContain(`registered fanout wave from ${plan}`);
  expect(byName.stdout).toContain(`WORKTREE: `);
  const byPlan = await run(cwd, ["fanout", "worktree", "create", "b", "--plan", plan]);
  expect(byPlan.code, byPlan.stdout + byPlan.stderr).toBe(0);
  const status = await run(cwd, ["fanout", "status", "--name", "wave", "--offline", "--json"]);
  expect(status.code, status.stdout).toBe(0);
  expect(JSON.parse(status.stdout).data.slices.map((one: { id: string }) => one.id)).toEqual([
    "a",
    "b",
  ]);
});

test("Given a plan file in `workit dir plans` that is not registered, When `worktree create a --name <its name>` runs, Then that single file is registered; an unknown name lists the registered plans", async () => {
  const { cwd } = makeRepo();
  const plans = repoDir("plans", cwd);
  if (plans instanceof Error) throw plans;
  writePlan(path.join(plans, "wave12c-plan.json"), "wave12c", ["a"]);
  const out = await run(cwd, ["fanout", "worktree", "create", "a", "--name", "wave12c"]);
  expect(out.code, out.stdout + out.stderr).toBe(0);
  expect(out.stdout).toContain("WORKTREE: ");
  const unknown = await run(cwd, ["fanout", "worktree", "create", "a", "--name", "nope", "--json"]);
  expect(unknown.code).not.toBe(0);
  expect(JSON.parse(unknown.stdout).error).toContain(
    "no fanout plan named nope (registered: wave12c)",
  );
});

test("Given no plan, When `worktree create fix-x --branch fix/fix-x` runs, Then a worktree with the fanout token exists, its spawn passes the gate, and `fanout status` lists the slice", async () => {
  const { cwd } = makeRepo();
  const out = await run(cwd, [
    "fanout",
    "worktree",
    "create",
    "fix-x",
    "--branch",
    "fix/fix-x",
    "--json",
  ]);
  expect(out.code, out.stdout).toBe(0);
  const data = JSON.parse(out.stdout).data;
  expect(data.branch).toBe("fix/fix-x");
  expect(tokened(data.path)).toBe(true);
  expect(git(data.path, "branch", "--show-current")).toBe("fix/fix-x");
  expect(gate(cwd, data.prompt)).toBeNull();
  const status = await run(cwd, ["fanout", "status", "--offline"]);
  expect(status.code, status.stdout + status.stderr).toBe(0);
  expect(status.stdout).toContain("fix-x (fix/fix-x)");
  // The same call again keeps the worktree (idempotent).
  const again = await run(cwd, ["fanout", "worktree", "create", "fix-x", "--branch", "fix/fix-x"]);
  expect(again.code, again.stdout + again.stderr).toBe(0);
  expect(again.stdout).toContain("kept worktree for slice fix-x");
});

test("Given no plan and no --branch, When `worktree create hello --base main` runs (the call agents make first), Then the unplanned slice gets the first branch policy allows and its spawn passes the gate", async () => {
  const { cwd } = makeRepo();
  await withProtectedMain(async () => {
    const out = await run(cwd, [
      "fanout",
      "worktree",
      "create",
      "hello",
      "--base",
      "main",
      "--json",
    ]);
    expect(out.code, out.stdout).toBe(0);
    const data = JSON.parse(out.stdout).data;
    // The policy allows only feature/*.
    expect(data.branch).toBe("feature/hello");
    // A branch that exists already (the lead's own) is never reused.
    git(cwd, "branch", "feature/again");
    const again = await run(cwd, ["fanout", "worktree", "create", "again", "--json"]);
    expect(again.code, again.stdout).toBe(0);
    expect(JSON.parse(again.stdout).data.branch).toBe("feature/again-2");
    expect(tokened(data.path)).toBe(true);
    expect(gate(cwd, data.prompt)).toBeNull();
  });
  // Two slices with no plan still need one.
  const two = await run(cwd, ["fanout", "worktree", "create", "x", "y", "--json"]);
  expect(two.code).not.toBe(0);
});

test("Given a slice a registered plan holds on another branch, When `--branch` names a different one, Then it is refused naming the plan's call", async () => {
  const { root, cwd } = makeRepo();
  const plan = writePlan(path.join(root, "plan.json"), "wave", ["a"]);
  expect((await run(cwd, ["fanout", "plan", plan])).code).toBe(0);
  const out = await run(cwd, [
    "fanout",
    "worktree",
    "create",
    "a",
    "--branch",
    "fix/other",
    "--json",
  ]);
  expect(out.code).not.toBe(0);
  expect(JSON.parse(out.stdout).unblock).toBe("workit fanout worktree create a --name wave");
});

test("Given a plan whose slice branch breaks branch policy, When `fanout plan` runs, Then it is refused with the allowed name and nothing is stored", async () => {
  const { root, cwd } = makeRepo();
  const plan = path.join(root, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      name: "wave",
      trunk: "main",
      slices: [slice("a", { branch: "feat/a" })],
    }),
  );
  await withProtectedMain(async () => {
    const out = await run(cwd, ["fanout", "plan", plan, "--json"]);
    expect(out.code).not.toBe(0);
    const body = JSON.parse(out.stdout);
    expect(body.error).toContain('slice a: allowed_pattern: branch "feat/a"');
    expect(body.unblock).toContain('use "feature/a"');
    const status = await run(cwd, ["fanout", "status", "--offline", "--json"]);
    expect(JSON.parse(status.stdout).error).toContain("no fanout plan is recorded here");
  });
});
