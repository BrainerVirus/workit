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

test("G `--judge behavior=yes risk=normal`, T requirements = {check:test, verdict:self} (default verification)", () => {
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
  expect(ruleIds(assessed.json())).toEqual(["check:test", "verdict:self"]);
  expect(assessed.json().data.requirements[0]).toMatchObject({ status: "unsatisfied" });
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

// M6 (audit 2026-10-07): judge calls are auditable and a session cannot
// silently lift the before-write blockers it judged.
const workitAs = (cwd: string, session: string | null, ...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKFLOW_WORKSPACE_ROOT: "" };
  if (session === null) delete env.WORKIT_SESSION_ID;
  else env.WORKIT_SESSION_ID = session;
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "packages/workit-cli/src/main.ts"), ...args],
    { cwd, encoding: "utf8", env },
  );
  return { code: result.status, stderr: result.stderr, json: () => JSON.parse(result.stdout) };
};
const judgedRows = (root: string) =>
  workitAs(root, null, "ledger", "list", "--type", "policy.judged", "--json").json().data.rows;

test("Given a judge call, When `policy assess --judge` runs, Then a ledger row records the session, the inputs and the resulting requirements", () => {
  const root = repo();
  const assessed = workitAs(root, "lead", "policy", "assess", "--judge", "plan=yes", "--json");
  expect(assessed.code).toBe(0);
  const rows = judgedRows(root);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    type: "policy.judged",
    observer: "workit_cli",
    actor: { session: "lead" },
    input: { plan: "yes" },
    judgment: { needsPlan: true },
    requirements: ["plan"],
  });
});

test("Given lead judged product-choice=yes, When lead judges product-choice=no without --why, Then it is refused; with --why it is recorded with the reason", () => {
  const root = repo();
  expect(
    workitAs(root, "lead", "policy", "assess", "--judge", "product-choice=yes", "--json").code,
  ).toBe(0);
  const silent = workitAs(
    root,
    "lead",
    "policy",
    "assess",
    "--judge",
    "product-choice=no",
    "--json",
  );
  expect(silent.code).not.toBe(0);
  expect(silent.json()).toMatchObject({ code: "invalid_input" });
  expect(silent.json().error).toContain("--why");
  const reasoned = workitAs(
    root,
    "lead",
    "policy",
    "assess",
    "--judge",
    "product-choice=no",
    "--why",
    "the user picked option B",
    "--json",
  );
  expect(reasoned.code).toBe(0);
  const rows = judgedRows(root);
  expect(rows.at(-1)).toMatchObject({
    actor: { session: "lead" },
    lifted: ["productChoiceOpen"],
    why: "the user picked option B",
  });
});

test("Given lead judged product-choice=yes, When lead lifts it with a 1900-char --why, Then the policy.judged row records the reason once; a reason too long to record is refused and lifts nothing", () => {
  const root = repo();
  expect(
    workitAs(root, "lead", "policy", "assess", "--judge", "product-choice=yes", "--json").code,
  ).toBe(0);
  const tooLong = workitAs(
    root,
    "lead",
    "policy",
    "assess",
    "--judge",
    "product-choice=no",
    "--why",
    "r".repeat(4200),
    "--json",
  );
  expect(tooLong.code).not.toBe(0);
  expect(tooLong.json()).toMatchObject({ code: "invalid_input" });
  expect(judgedRows(root)).toHaveLength(1);
  const why = "w".repeat(1900);
  const lifted = workitAs(
    root,
    "lead",
    "policy",
    "assess",
    "--judge",
    "product-choice=no",
    "--why",
    why,
    "--json",
  );
  expect(lifted.code).toBe(0);
  const rows = judgedRows(root);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ lifted: ["productChoiceOpen"], why });
  expect(JSON.stringify(rows[1]).split(why)).toHaveLength(2);
});
