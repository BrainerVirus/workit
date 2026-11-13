// #859: the test run marker (WORKIT_TEST_RUN) changes nothing a process
// reads: grants and the seal come from the OS account record with or without
// it (D15). It only adds refusals: under it no process writes the account's
// seal, grants or host settings. Every write below targets a fake account
// home through the refusedHome seam, in the test's own process or the child's.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { grantsHome, resolveAutonomy } from "@/packages/workit-core/src/autonomy";
import { SEAL_FILE, writeSeal } from "@/packages/workit-core/src/core/grant-seal";
import {
  TEST_RUN_ENV,
  accountHome,
  accountHomeLookup,
  resetRefusalHome,
  testRunWriteRefusal,
} from "@/packages/workit-core/src/core/account-home";
import {
  dataDir,
  stateDir,
  configDir as workitConfigDir,
} from "@/packages/workit-core/src/core/workit-paths.mjs";

const CORE = path.resolve(import.meta.dir, "../../packages/workit-core/src");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** Run `body` in a child bun with `env`; it may use `autonomy`, `home` (account-home.ts) and `out(value)`. */
const child = (env: NodeJS.ProcessEnv, body: string): any => {
  const code = `const autonomy = await import(${JSON.stringify(path.join(CORE, "autonomy.ts"))});
const home = await import(${JSON.stringify(path.join(CORE, "core/account-home.ts"))});
const out = (value) => console.log(JSON.stringify(value));
${body}`;
  const run = spawnSync(process.execPath, ["-e", code], {
    cwd: os.tmpdir(),
    env,
    encoding: "utf8",
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!);
};

const withMarker = (marker: string | undefined): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  if (marker === undefined) delete env[TEST_RUN_ENV];
  else env[TEST_RUN_ENV] = marker;
  return env;
};

test("Given an agent-set marker, When grants resolve for an account that lowers them, Then they are identical to a run without the marker", () => {
  const home = temp("wk-marker-account-");
  const config = workitConfigDir({ HOME: home });
  mkdirSync(config, { recursive: true });
  const work = path.join(home, "work");
  const entries = [
    {
      name: "lowered",
      glob: `${work}/**`,
      autonomy: { push: false, pr: false, rerun: false },
      verification: "independent",
    },
  ];
  writeFileSync(path.join(config, "workspaces.json"), JSON.stringify({ workspaces: entries }));
  writeSeal(config, entries, new Date(), null);
  const saved = {
    resolve: grantsHome.resolve,
    config: process.env.WORKIT_CONFIG,
    marker: process.env[TEST_RUN_ENV],
  };
  grantsHome.resolve = () => home;
  process.env.WORKIT_CONFIG = config;
  try {
    delete process.env[TEST_RUN_ENV];
    const without = resolveAutonomy(path.join(work, "repo"));
    process.env[TEST_RUN_ENV] = temp("wk-agent-marker-");
    const marked = resolveAutonomy(path.join(work, "repo"));
    expect(marked).toEqual(without);
    expect(without.grants).toMatchObject({ push: false, pr: false, rerun: false });
  } finally {
    grantsHome.resolve = saved.resolve;
    if (saved.config === undefined) delete process.env.WORKIT_CONFIG;
    else process.env.WORKIT_CONFIG = saved.config;
    process.env[TEST_RUN_ENV] = saved.marker;
  }
});

test("Given a child process with or without the marker, When it resolves the grants home and dir, Then both read the OS account record (D15)", () => {
  // Read only: the children resolve paths and write nothing.
  const read = "out({ home: autonomy.grantsHome.resolve(), dir: autonomy.grantsDir() });";
  const marked = child(withMarker(temp("wk-agent-marker-")), read);
  const plain = child(withMarker(undefined), read);
  expect(marked).toEqual(plain);
  expect(marked.home).toBe(accountHome());
});

test("Given a child process with the marker and a fake account home, When it seals or writes grants there, Then both are refused naming the file and nothing is written; without the marker they are written", () => {
  const run = (marker: string | undefined) => {
    const fake = temp("wk-child-account-");
    const config = workitConfigDir({ HOME: fake });
    mkdirSync(config, { recursive: true });
    const entries = [{ name: "w", glob: `${fake}/w/**`, autonomy: { push: false } }];
    writeFileSync(path.join(config, "workspaces.json"), JSON.stringify({ workspaces: entries }));
    // The child's own seams: the fake home is both what it reads and what it must not write.
    const seen = child(
      withMarker(marker),
      `home.refusedHome.value = ${JSON.stringify(fake)};
autonomy.grantsHome.resolve = () => ${JSON.stringify(fake)};
const sealed = autonomy.sealAccount();
const granted = autonomy.writeGrants("w", [{ kind: "rerun", value: false }]);
out({ sealed, granted: granted.ok ? "ok" : granted.error });`,
    );
    return { ...seen, config };
  };
  const refused = run(temp("wk-agent-marker-"));
  expect(refused.sealed.ok).toBe(false);
  expect(refused.sealed.error).toContain(
    `refusing to write ${path.join(refused.config, SEAL_FILE)}`,
  );
  expect(refused.granted).toContain(
    `refusing to write ${path.join(refused.config, "workspaces.json")}`,
  );
  expect(existsSync(path.join(refused.config, SEAL_FILE))).toBe(false);
  const written = run(undefined);
  expect(written.sealed).toEqual({ ok: true, path: path.join(written.config, SEAL_FILE) });
  expect(written.granted).toBe("ok");
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

test("Given a fake account home, When testRunWriteRefusal judges a path, Then only its host settings and Workit dirs (this platform's) are refused, its worktrees, the temp dir and other dirs are not, and nothing is refused without the marker", () => {
  const home = temp("wk-fake-account-");
  const marked = { [TEST_RUN_ENV]: home };
  const refused = (file: string, env: NodeJS.ProcessEnv = marked) =>
    testRunWriteRefusal(file, home, env);
  // Workit's own dirs as this platform puts them (~/.local/state on Linux,
  // %LOCALAPPDATA% under the home on Windows).
  const homeEnv = { HOME: home, USERPROFILE: home };
  for (const file of [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".cursor", "cli-config.json"),
    path.join(home, ".codex", "rules", "workit.rules"),
    path.join(home, ".pi", "agent", "settings.json"),
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".local", "share", "bash-completion", "completions", "workit"),
    path.join(home, ".local", "bin", "workit"),
    path.join(workitConfigDir(homeEnv), "workspaces.json"),
    path.join(stateDir(homeEnv), "host-permissions.json"),
    path.join(dataDir(homeEnv), "versions", "1.0.0", "package.json"),
  ])
    expect(refused(file), file).toContain(`refusing to write ${file}`);
  expect(refused(path.join(stateDir(homeEnv), "worktrees", "workit", "slice", "f.ts"))).toBeNull();
  expect(refused(path.join(home, "projects", "repo", ".claude", "settings.json"))).toBeNull();
  expect(refused(path.join(home, ".claude", "settings.json"), {})).toBeNull();
});

test("Given a temp dir inside the account's protected dirs (as %LOCALAPPDATA%\\Temp is on Windows, not a protected root), When a fixture home there is written, Then it is not refused; the account's own files still are", () => {
  const account = temp("wk-fake-account-");
  // Under a protected root of this account, the way Windows nests its temp dir.
  const tmp = path.join(account, "AppData", "Local", "Temp");
  mkdirSync(tmp, { recursive: true });
  const marked = { [TEST_RUN_ENV]: tmp };
  const fixture = path.join(tmp, "wk-fixture-home", ".claude", "settings.json");
  expect(testRunWriteRefusal(fixture, account, marked, tmp)).toBeNull();
  const own = path.join(account, ".config", "opencode", "opencode.json");
  expect(testRunWriteRefusal(own, account, marked, tmp)).toContain(`refusing to write ${own}`);
});

test("Given many refusal checks in one process, When they run without a home argument, Then the account home is resolved once", () => {
  const home = temp("wk-fake-account-");
  const real = accountHomeLookup.resolve;
  let calls = 0;
  accountHomeLookup.resolve = () => {
    calls += 1;
    return home;
  };
  resetRefusalHome();
  try {
    const marked = { [TEST_RUN_ENV]: home };
    const own = path.join(home, ".claude", "settings.json");
    for (let i = 0; i < 5; i += 1)
      expect(testRunWriteRefusal(own, undefined, marked)).toContain("refusing to write");
    expect(calls).toBe(1);
  } finally {
    accountHomeLookup.resolve = real;
    resetRefusalHome();
  }
});

test("Given TMPDIR inside a fake account's .config, When a write under it is judged in a test run, Then it is refused", () => {
  const account = temp("wk-fake-account-");
  const tmp = path.join(account, ".config", "tmp");
  mkdirSync(tmp, { recursive: true });
  const marked = { [TEST_RUN_ENV]: tmp };
  const file = path.join(tmp, "f.json");
  expect(testRunWriteRefusal(file, account, marked, tmp)).toContain(`refusing to write ${file}`);
});

test("Given a dangling symlink in temp pointing into a fake account's .config, When a write through it is judged, Then it is refused; a normal temp file is not", () => {
  const account = temp("wk-fake-account-");
  const tmp = temp("wk-fake-tmp-");
  const target = path.join(account, ".config", "opencode", "opencode.json");
  mkdirSync(path.dirname(target), { recursive: true });
  const link = path.join(tmp, "link.json");
  symlinkSync(target, link);
  const dirLink = path.join(tmp, "dirlink");
  symlinkSync(path.join(account, ".config", "missing"), dirLink);
  const marked = { [TEST_RUN_ENV]: tmp };
  expect(testRunWriteRefusal(link, account, marked, tmp)).toContain("refusing to write");
  expect(testRunWriteRefusal(path.join(dirLink, "x.json"), account, marked, tmp)).toContain(
    "refusing to write",
  );
  expect(testRunWriteRefusal(path.join(tmp, "plain.json"), account, marked, tmp)).toBeNull();
});

test("Given TMPDIR that is a symlink into a protected root, When a write under it is judged, Then it is refused (no temp exemption)", () => {
  const account = temp("wk-fake-account-");
  const outside = temp("wk-fake-tmp-");
  const real = path.join(account, ".config", "tmp");
  mkdirSync(real, { recursive: true });
  const tmpLink = path.join(outside, "tmplink");
  symlinkSync(real, tmpLink);
  const marked = { [TEST_RUN_ENV]: tmpLink };
  const file = path.join(tmpLink, "f.json");
  expect(testRunWriteRefusal(file, account, marked, tmpLink)).toContain("refusing to write");
});

test("Given a symlink chain past the cap, When a write through it is judged, Then it is refused, not allowed", () => {
  const account = temp("wk-fake-account-");
  const tmp = temp("wk-fake-tmp-");
  for (let i = 0; i < 45; i += 1) symlinkSync(path.join(tmp, `l${i + 1}`), path.join(tmp, `l${i}`));
  symlinkSync(path.join(account, ".config"), path.join(tmp, "l45"));
  const marked = { [TEST_RUN_ENV]: tmp };
  expect(testRunWriteRefusal(path.join(tmp, "l0", "f.json"), account, marked, tmp)).toContain(
    "refusing to write",
  );
});

test("Given a link followed by .., When a write is judged, Then .. applies to the link's target, not lexically", () => {
  const account = temp("wk-fake-account-");
  const tmp = temp("wk-fake-tmp-");
  const deep = path.join(account, ".config", "a", "b");
  mkdirSync(deep, { recursive: true });
  symlinkSync(deep, path.join(tmp, "go"));
  const marked = { [TEST_RUN_ENV]: tmp };
  // tmp/go/../x is account/.config/a/x, not tmp/x.
  const file = `${tmp}${path.sep}go${path.sep}..${path.sep}x.json`;
  expect(testRunWriteRefusal(file, account, marked, tmp)).toContain("refusing to write");
});

test("Given the first account lookup answers null, When a later check runs, Then it asks again instead of caching no home", () => {
  const home = temp("wk-fake-account-");
  const real = accountHomeLookup.resolve;
  let asked = 0;
  accountHomeLookup.resolve = () => (asked++ === 0 ? null : home);
  resetRefusalHome();
  try {
    const marked = { [TEST_RUN_ENV]: home };
    const own = path.join(home, ".claude", "settings.json");
    expect(testRunWriteRefusal(own, undefined, marked)).toBeNull();
    expect(testRunWriteRefusal(own, undefined, marked)).toContain("refusing to write");
  } finally {
    accountHomeLookup.resolve = real;
    resetRefusalHome();
  }
});
