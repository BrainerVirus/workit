// S17 acceptance through the CLI: `workit policy assess --judge …`.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-judge-"));
  dirs.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "feature/x");
  git("commit", "-q", "--allow-empty", "-m", "base");
  return root;
};
const workit = (cwd: string, ...args: string[]) => {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "packages/workit-cli/src/main.ts"), ...args],
    { cwd, encoding: "utf8", env: { ...process.env, WORKFLOW_WORKSPACE_ROOT: "" } },
  );
  return { code: result.status, json: () => JSON.parse(result.stdout) };
};
const ruleIds = (output: { data: { requirements: { ruleId: string }[] } }) =>
  output.data.requirements.map((item) => item.ruleId);

test("G `--judge behavior=yes risk=normal`, T requirements = {check:test, verdict:non-author}", () => {
  const root = repo();
  const assessed = workit(
    root,
    "policy",
    "assess",
    "--judge",
    "behavior=yes",
    "risk=normal",
    "--json",
  );
  expect(assessed.code).toBe(0);
  expect(ruleIds(assessed.json())).toEqual(["check:test", "verdict:non-author"]);
});

test("G a 2-line mechanical fix judged trivial, T zero requirements and no spec proposed", () => {
  const root = repo();
  const assessed = workit(
    root,
    "policy",
    "assess",
    "--judge",
    "risk=trivial",
    "behavior=no",
    "--json",
  );
  expect(assessed.code).toBe(0);
  expect(ruleIds(assessed.json())).toEqual([]);
});

test("G a needed plan, W --ref cites it, T the judgment keeps its calls and records the ref", () => {
  const root = repo();
  expect(workit(root, "policy", "assess", "--judge", "plan=yes", "--json").code).toBe(0);
  const cited = workit(root, "policy", "assess", "--ref", "docs/plan.md", "--json");
  expect(ruleIds(cited.json())).toEqual(["plan"]);
  const bad = workit(root, "policy", "assess", "--judge", "risk=sky", "--json");
  expect(bad.code).not.toBe(0);
  expect(bad.json()).toMatchObject({ code: "invalid_input" });
});
