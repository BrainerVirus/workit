// #859: under the test run marker the host-permission writers refuse the OS
// account home's settings, naming the file, before writing anything. Proven
// on a fake account home through the `accountHome` seam.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyHostPermissions,
  planHostPermissions,
  removeCodexRules,
} from "@/packages/workit-cli/src/admin/host-permissions";
import { TEST_RUN_ENV } from "@/packages/workit-core/src/core/account-home";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** A home with Claude Code and Codex installed, its plan, and where its record goes. */
const fixture = () => {
  const home = temp("wk-perm-home-");
  for (const dir of [".claude", ".codex"]) mkdirSync(path.join(home, dir));
  const stateDir = path.join(temp("wk-perm-state-"), "workit");
  const paths = { home, env: { HOME: home }, stateDir };
  const plan = planHostPermissions({ hosts: ["claude-code", "codex"], shell: false, ...paths });
  return { home, paths, plan };
};

test("Given a test run and the fake account home as the target, When host permissions are applied, Then every entry fails naming its file and nothing is written", () => {
  expect(process.env[TEST_RUN_ENV]).toBeDefined();
  const { home, paths, plan } = fixture();
  expect(plan.changes.length).toBe(2);
  const entries = applyHostPermissions(plan, { ...paths, accountHome: home });
  const settings = path.join(home, ".claude", "settings.json");
  expect(entries.map((entry) => entry.status)).toEqual(["failed", "failed"]);
  for (const entry of entries)
    expect(entry.detail).toContain(`refusing to write ${settings}: a test run (${TEST_RUN_ENV})`);
  expect(existsSync(settings)).toBe(false);
  expect(existsSync(path.join(home, ".codex", "rules", "workit.rules"))).toBe(false);
  expect(existsSync(paths.stateDir)).toBe(false);
});

test("Given a test run and a home that is not the account's, When host permissions are applied, Then they are written and removable", () => {
  const { home, paths, plan } = fixture();
  const other = temp("wk-perm-account-");
  const entries = applyHostPermissions(plan, { ...paths, accountHome: other });
  expect(entries.map((entry) => entry.status)).toEqual(["written", "written"]);
  expect(readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).toContain("workit");
  const rules = path.join(home, ".codex", "rules", "workit.rules");
  expect(() => removeCodexRules(rules, { ...paths, accountHome: home })).toThrow(
    `refusing to write ${rules}`,
  );
  expect(removeCodexRules(rules, { ...paths, accountHome: other })).toBe(true);
});
