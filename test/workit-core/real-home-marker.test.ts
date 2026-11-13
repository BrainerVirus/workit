// #859: the test run marker (WORKIT_TEST_RUN) sends a child process's grants
// home to the run's temp account home, so a child never reads or writes the
// OS account's grants or seal; without it D15 holds (the account record).
// Every child here gets its own temp marker; none writes outside it.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grantsHome, resolveAutonomy } from "@/packages/workit-core/src/autonomy";
import { SEAL_FILE, writeSeal } from "@/packages/workit-core/src/core/grant-seal";
import {
  TEST_RUN_ENV,
  accountHome,
  testRunHome,
  testRunWriteRefusal,
} from "@/packages/workit-core/src/core/account-home";
import { configDir as workitConfigDir } from "@/packages/workit-core/src/core/workit-paths.mjs";

const AUTONOMY = path.resolve(import.meta.dir, "../../packages/workit-core/src/autonomy.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** Run `body` in a child bun with `env`; it may use `autonomy`, `cwd` and `out(value)`. */
const child = (env: NodeJS.ProcessEnv, body: string, cwd = os.tmpdir()): any => {
  const code = `const autonomy = await import(${JSON.stringify(AUTONOMY)});
const cwd = ${JSON.stringify(cwd)};
const out = (value) => console.log(JSON.stringify(value));
${body}`;
  const run = spawnSync(process.execPath, ["-e", code], { cwd, env, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!);
};

/** A workspace that grants everything, for a file an agent could write into a marker home. */
const greedy = (work: string) => ({
  name: "greedy",
  glob: `${work}/**`,
  vcs: { provider: "github", account: "me" },
  autonomy: { push: true, pr: true, merge: true, release: true, rerun: true },
});

test("Given no marker, a marker in the temp dir, and markers that are not, Then testRunHome is undefined, <marker>/account-home, and refused (null)", () => {
  const marker = temp("wk-marker-");
  expect(testRunHome({})).toBeUndefined();
  expect(testRunHome({ [TEST_RUN_ENV]: marker })).toBe(path.join(marker, "account-home"));
  // Outside the temp dir (this checkout), relative, missing, or the temp dir itself.
  expect(testRunHome({ [TEST_RUN_ENV]: import.meta.dir })).toBeNull();
  expect(testRunHome({ [TEST_RUN_ENV]: "relative/dir" })).toBeNull();
  expect(testRunHome({ [TEST_RUN_ENV]: path.join(marker, "missing") })).toBeNull();
  expect(testRunHome({ [TEST_RUN_ENV]: os.tmpdir() })).toBeNull();
  expect(testRunHome({ [TEST_RUN_ENV]: "/" })).toBeNull();
});

test("Given a child process with the run marker, When it resolves the grants home and seals, Then both are the marker's temp account home, and the grants there stay at the D4 defaults", () => {
  const marker = temp("wk-marker-");
  const work = path.join(marker, "work");
  mkdirSync(path.join(work, "repo"), { recursive: true });
  const config = workitConfigDir({ HOME: path.join(marker, "account-home") });
  mkdirSync(config, { recursive: true });
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({ workspaces: [greedy(work)] }),
  );
  // The escalation case: the config dir the child reads is the marker home's own.
  const env = { ...process.env, [TEST_RUN_ENV]: marker, WORKIT_CONFIG: config };
  const seen = child(
    env,
    `const dir = autonomy.grantsDir();
if (!dir.startsWith(${JSON.stringify(`${marker}/`)})) { out({ dir }); process.exit(0); }
const sealed = autonomy.sealAccount();
out({ dir, sealed, release: autonomy.resolveAutonomy(cwd + "/repo").grants.release, note: autonomy.resolveAutonomy(cwd + "/repo").note });`,
    work,
  );
  expect(seen.dir).toBe(config);
  expect(seen.sealed).toEqual({ ok: true, path: path.join(config, SEAL_FILE) });
  expect(seen.release).toBe(false);
  expect(seen.note).toContain(TEST_RUN_ENV);

  // Control: the same sealed file read in-process as the account's own grants it.
  const saved = { resolve: grantsHome.resolve, config: process.env.WORKIT_CONFIG };
  grantsHome.resolve = () => path.join(marker, "account-home");
  process.env.WORKIT_CONFIG = config;
  try {
    expect(resolveAutonomy(path.join(work, "repo")).grants.release).toBe(true);
  } finally {
    grantsHome.resolve = saved.resolve;
    if (saved.config === undefined) delete process.env.WORKIT_CONFIG;
    else process.env.WORKIT_CONFIG = saved.config;
  }
});

test("Given a child process without the marker (a user's shell), When it resolves the grants home, Then it is the OS account record's home (D15)", () => {
  const env = { ...process.env };
  delete env[TEST_RUN_ENV];
  // Read only: the child resolves the path and writes nothing.
  const seen = child(env, `out({ home: autonomy.grantsHome.resolve() });`);
  expect(seen.home).toBe(accountHome());
});

test("Given a child process whose marker is outside the temp dir, When it resolves the grants home, Then it is refused: no account, never the account record's", () => {
  const seen = child(
    { ...process.env, [TEST_RUN_ENV]: import.meta.dir },
    `out({ home: autonomy.grantsHome.resolve(), override: autonomy.grantsOverride() });`,
  );
  expect(seen.home).toBeNull();
  expect(seen.override).toContain("no OS account record");
});

test("Given a test run, When writeSeal targets the account's own config dir, Then it refuses and writes nothing; another dir is sealed", () => {
  const home = temp("wk-fake-account-");
  const config = workitConfigDir({ HOME: home });
  mkdirSync(config, { recursive: true });
  expect(process.env[TEST_RUN_ENV]).toBeDefined();
  expect(() => writeSeal(config, [], new Date(), home)).toThrow(
    `refusing to write ${path.join(config, SEAL_FILE)}`,
  );
  expect(existsSync(path.join(config, SEAL_FILE))).toBe(false);
  const other = temp("wk-other-config-");
  expect(writeSeal(other, [], new Date(), home)).toBe(path.join(other, SEAL_FILE));
});

test("Given a fake account home, When testRunWriteRefusal judges a path, Then only its host settings and Workit dirs are refused, its worktrees and other dirs are not, and nothing is refused without the marker", () => {
  const home = temp("wk-fake-account-");
  const marked = { [TEST_RUN_ENV]: home };
  const refused = (file: string, env: NodeJS.ProcessEnv = marked) =>
    testRunWriteRefusal(path.join(home, file), home, env);
  for (const file of [
    ".claude/settings.json",
    ".cursor/cli-config.json",
    ".codex/rules/workit.rules",
    ".pi/agent/settings.json",
    ".config/opencode/opencode.json",
    ".local/state/workit/host-permissions.json",
  ])
    expect(refused(file)).toContain(`refusing to write ${path.join(home, file)}`);
  expect(refused(".local/state/workit/worktrees/workit/slice/file.ts")).toBeNull();
  expect(refused("projects/repo/.claude/settings.json")).toBeNull();
  expect(refused(".claude/settings.json", {})).toBeNull();
});
