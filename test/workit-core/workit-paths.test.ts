// The one Workit location resolver (core/workit-paths.mjs): XDG on Linux and
// macOS, APPDATA/LOCALAPPDATA on Windows, the WORKIT_* overrides, the hook
// copies (byte-equal .mjs, verbatim shell functions that answer the same), the
// one-time macOS legacy state move and the doctor row that reports it.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  CONFIG_DIR_SH,
  DATA_DIR_SH,
  STATE_DIR_SH,
  WORKIT_DIR_KINDS,
  WORKIT_DIR_OVERRIDES,
  WORKIT_DIR_XDG,
  cacheDir,
  configDir,
  dataDir,
  migrateLegacyDirs,
  runtimeDir,
  stateDir,
  workitDir,
} from "@/packages/workit-core/src/core/workit-paths.mjs";
import { launcherScript } from "@/packages/workit-cli/src/install/launcher";
import { main } from "@/packages/workit-cli/src/main";
import { runDoctor, type DoctorCheck } from "@/packages/workit-cli/src/admin/doctor";
import { scratchDir } from "../shared/helpers/hook-node";

const REPO = path.resolve(import.meta.dir, "../..");
const CANONICAL = "packages/workit-core/src/core/workit-paths.mjs";
const read = (file: string) => readFileSync(path.join(REPO, file), "utf8");
type Kind = "config" | "state" | "data" | "cache" | "runtime";
const H = "/home/u";

test("Given Linux or macOS with no XDG vars, When each resolver runs, Then every kind sits under the XDG defaults", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const env = { HOME: H };
    expect(configDir(env, platform)).toBe(`${H}/.config/workit`);
    expect(stateDir(env, platform)).toBe(`${H}/.local/state/workit`);
    expect(dataDir(env, platform)).toBe(`${H}/.local/share/workit`);
    expect(cacheDir(env, platform)).toBe(`${H}/.cache/workit`);
    expect(runtimeDir({ ...env, TMPDIR: "/t" }, platform)).toMatch(/^\/t\/workit-\S+$/);
  }
});

test("Given XDG_*_HOME set, Then each kind follows its variable; a relative one is ignored", () => {
  const env = {
    HOME: H,
    XDG_CONFIG_HOME: "/x/c",
    XDG_STATE_HOME: "/x/s",
    XDG_DATA_HOME: "/x/d",
    XDG_CACHE_HOME: "/x/k",
    XDG_RUNTIME_DIR: "/run/user/1",
  };
  for (const platform of ["linux", "darwin"] as const) {
    expect(configDir(env, platform)).toBe("/x/c/workit");
    expect(stateDir(env, platform)).toBe("/x/s/workit");
    expect(dataDir(env, platform)).toBe("/x/d/workit");
    expect(cacheDir(env, platform)).toBe("/x/k/workit");
    expect(runtimeDir(env, platform)).toBe("/run/user/1/workit");
  }
  expect(stateDir({ HOME: H, XDG_STATE_HOME: "rel/state" }, "linux")).toBe(
    `${H}/.local/state/workit`,
  );
});

test("Given WORKIT_STATE_DIR, WORKIT_CONFIG_DIR or WORKIT_CONFIG, Then those win over XDG, WORKIT_CONFIG first", () => {
  const env = { HOME: H, XDG_CONFIG_HOME: "/x/c", XDG_STATE_HOME: "/x/s" };
  expect(stateDir({ ...env, WORKIT_STATE_DIR: "/o/state" }, "linux")).toBe("/o/state");
  expect(configDir({ ...env, WORKIT_CONFIG_DIR: "/o/dir" }, "linux")).toBe("/o/dir");
  expect(configDir({ ...env, WORKIT_CONFIG_DIR: "/o/dir", WORKIT_CONFIG: "/o/cfg" }, "win32")).toBe(
    "/o/cfg",
  );
  // An empty override is unset.
  expect(stateDir({ ...env, WORKIT_STATE_DIR: "" }, "linux")).toBe("/x/s/workit");
});

test("Given Windows (simulated), Then config is under APPDATA and state, data and cache under LOCALAPPDATA", () => {
  const env = { HOME: H, APPDATA: "/w/Roaming", LOCALAPPDATA: "/w/Local", TEMP: "/w/Temp" };
  expect(configDir(env, "win32")).toBe(path.join("/w/Roaming", "workit"));
  expect(stateDir(env, "win32")).toBe(path.join("/w/Local", "workit"));
  expect(dataDir(env, "win32")).toBe(path.join("/w/Local", "workit"));
  expect(cacheDir(env, "win32")).toBe(path.join("/w/Local", "workit", "cache"));
  expect(runtimeDir(env, "win32")).toBe(path.join("/w/Temp", "workit"));
  // Without the variables, the profile's AppData folders.
  expect(configDir({ HOME: H }, "win32")).toBe(path.join(H, "AppData", "Roaming", "workit"));
  expect(stateDir({ HOME: H }, "win32")).toBe(path.join(H, "AppData", "Local", "workit"));
});

test("the hook launcher copies of workit-paths.mjs equal the core file", () => {
  const core = read(CANONICAL);
  for (const copy of [
    "packages/workit-claude-code/bin/workit-paths.mjs",
    "packages/workit-codex/bin/workit-paths.mjs",
    "packages/workit-cursor/hooks/workit-paths.mjs",
  ])
    expect(read(copy), copy).toBe(core);
});

test("the shell launchers embed the resolver's shell functions verbatim", () => {
  expect(read("packages/workit-claude-code/bin/workit")).toContain(STATE_DIR_SH);
  expect(launcherScript({ root: "/r", installNode: "/n" })).toContain(STATE_DIR_SH);
  const lib = read("packages/workit-core/scripts/lib/config-dir.sh");
  expect(lib).toContain(CONFIG_DIR_SH);
  expect(lib).toContain(DATA_DIR_SH);
});

// A fake `uname` stands in for Git Bash on Windows (MINGW64_NT-…).
const unameBin = (system: string) => {
  const dir = scratchDir("wk-uname-");
  writeFileSync(path.join(dir, "uname"), `#!/bin/sh\necho ${system}\n`);
  chmodSync(path.join(dir, "uname"), 0o755);
  return dir;
};

const runSh = (fn: string, name: string, env: Record<string, string>, bin: string) => {
  const out = spawnSync("sh", ["-c", `${fn}\n${name}`], {
    env: { ...env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout.trim();
};

test("Given the same env, When the shell functions and the resolver run, Then they name the same dirs", () => {
  const envs: Array<Record<string, string>> = [
    { HOME: H },
    { HOME: H, XDG_STATE_HOME: "/x/s", XDG_CONFIG_HOME: "/x/c", XDG_DATA_HOME: "/x/d" },
    { HOME: H, XDG_STATE_HOME: "rel", XDG_CONFIG_HOME: "rel", XDG_DATA_HOME: "rel" },
    { HOME: H, WORKIT_STATE_DIR: "/o/s", WORKIT_CONFIG_DIR: "/o/c" },
    { HOME: H, WORKIT_CONFIG: "/o/cfg", WORKIT_CONFIG_DIR: "/o/c" },
    { HOME: H, APPDATA: "/w/Roaming", LOCALAPPDATA: "/w/Local" },
  ];
  const cases: Array<[string, string, Kind]> = [
    [STATE_DIR_SH, "workit_state_dir", "state"],
    [CONFIG_DIR_SH, "workit_config_dir", "config"],
    [DATA_DIR_SH, "workit_data_dir", "data"],
  ];
  const systems: Array<[string, NodeJS.Platform]> = [
    ["Linux", "linux"],
    ["Darwin", "darwin"],
    ["MINGW64_NT-10.0", "win32"],
  ];
  const slash = (value: string) => value.replaceAll("\\", "/");
  for (const [system, platform] of systems) {
    const bin = unameBin(system);
    for (const env of envs)
      for (const [fn, name, kind] of cases)
        expect(slash(runSh(fn, name, env, bin)), `${system} ${name} ${JSON.stringify(env)}`).toBe(
          slash(workitDir(kind, env, platform)),
        );
  }
});

test("bin/workit and the owned launcher read node.json from the resolver's state dir", () => {
  // Each launcher calls the embedded function; none keeps its own state path.
  for (const text of [
    read("packages/workit-claude-code/bin/workit"),
    launcherScript({ root: "/r", installNode: "/n" }),
  ]) {
    expect(text).toContain("state=$(workit_state_dir)");
    expect(text).not.toContain("Library/Application Support/workit");
  }
});

/** A temp macOS-style home whose pre-XDG state dir holds ledger state. */
const legacyHome = () => {
  const home = scratchDir("wk-legacy-");
  const legacy = path.join(home, "Library", "Application Support", "workit");
  mkdirSync(path.join(legacy, "ledger"), { recursive: true });
  writeFileSync(path.join(legacy, "ledger", "events.jsonl"), '{"kind":"ruling"}\n');
  writeFileSync(path.join(legacy, "node.json"), '{"path":"/n","version":"24.1.0"}\n');
  return { home, legacy, support: path.dirname(legacy) };
};

const quiet = () => undefined;

const cliEnv = (home: string) => ({ HOME: home, PATH: process.env.PATH ?? "" });

const markers = (support: string) =>
  readdirSync(support).filter((name) => name.startsWith("workit.moved-"));

test("Given a macOS home with only the legacy state dir, When the CLI runs twice, Then the first run moves it and leaves a marker, the second does nothing", async () => {
  const { home, legacy, support } = legacyHome();
  const target = path.join(home, ".local", "state", "workit");
  const run = () =>
    main(
      ["--version"],
      { env: cliEnv(home), stdout: quiet, stderr: quiet },
      {
        platform: "darwin",
      },
    );

  expect(await run()).toBe(0);
  expect(existsSync(legacy)).toBe(false);
  expect(readFileSync(path.join(target, "ledger", "events.jsonl"), "utf8")).toContain("ruling");
  expect(readFileSync(path.join(target, "node.json"), "utf8")).toContain("24.1.0");
  const [marker] = markers(support);
  expect(marker).toMatch(/^workit\.moved-\d{8}T\d{6}Z$/);
  expect(readFileSync(path.join(support, String(marker)), "utf8")).toContain(target);
  const logs = readdirSync(path.join(target, "logs"));
  expect(readFileSync(path.join(target, "logs", String(logs[0])), "utf8")).toContain(
    "moved a legacy Workit directory",
  );

  const before = readdirSync(target).toSorted();
  expect(await run()).toBe(0);
  expect(markers(support)).toEqual([String(marker)]);
  expect(readdirSync(target).toSorted()).toEqual(before);
});

const rmTarget = (home: string) =>
  spawnSync("rm", ["-rf", path.join(home, ".local", "state", "workit")]);

test("Given the XDG state dir already exists, When the move runs, Then it leaves both in place", () => {
  const { home, legacy, support } = legacyHome();
  mkdirSync(path.join(home, ".local", "state", "workit"), { recursive: true });
  expect(migrateLegacyDirs({ env: { HOME: home }, platform: "darwin" })).toEqual([]);
  expect(existsSync(legacy)).toBe(true);
  expect(markers(support)).toEqual([]);
  // An override or XDG_STATE_HOME means the default is not in use: nothing moves.
  rmTarget(home);
  expect(
    migrateLegacyDirs({ env: { HOME: home, XDG_STATE_HOME: "/x/s" }, platform: "darwin" }),
  ).toEqual([]);
  expect(migrateLegacyDirs({ env: { HOME: home }, platform: "linux" })).toEqual([]);
  expect(existsSync(legacy)).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "Given the legacy state dir is a symlink the user made, When the move runs, Then the link is left alone",
  () => {
    const { home, legacy, support } = legacyHome();
    const real = path.join(home, "real-state");
    renameSync(legacy, real);
    symlinkSync(real, legacy);
    expect(migrateLegacyDirs({ env: { HOME: home }, platform: "darwin" })).toEqual([]);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(home, ".local", "state", "workit"))).toBe(false);
    expect(markers(support)).toEqual([]);
  },
);

const legacyRow = (home: string): DoctorCheck =>
  runDoctor({
    host: "cli",
    home,
    cwd: home,
    configDir: path.join(home, "config"),
    stateDir: path.join(home, "state"),
    dev: path.join(home, "no-dev"),
    env: cliEnv(home),
    platform: "darwin",
    scopeProbe: () => ({ effective: false, supported: false, reason: "test", delegate: null }),
  }).checks.find((check) => check.id === "legacy_dirs")!;

test("Given a leftover legacy dir beside the XDG one, When doctor runs, Then legacy_dirs warns with the command that finishes the move", () => {
  const { home, legacy } = legacyHome();
  mkdirSync(path.join(home, ".local", "state", "workit"), { recursive: true });
  const row = legacyRow(home);
  expect(row.status).toBe("warn");
  expect(row.detail).toContain(legacy);
  expect(row.fix).toStartWith(
    `cp -Rn '${legacy}/.' ${path.join(home, ".local/state/workit")}/ && mv `,
  );
  expect(row.fix).toMatch(/ '.+workit\.moved-\d{8}T\d{6}Z'$/);

  // Running the printed command finishes it: doctor then reports the finished move.
  expect(spawnSync("sh", ["-c", row.fix!]).status).toBe(0);
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(path.join(home, ".local/state/workit/ledger/events.jsonl"))).toBe(true);
  const after = legacyRow(home);
  expect(after.status).toBe("info");
  expect(after.detail).toContain("moved to");
});

test("docs/agents/file-locations.md names every kind and every env override the resolver reads", () => {
  const doc = read("docs/agents/file-locations.md");
  const table = doc.split("\n").filter((line) => line.startsWith("|"));
  for (const kind of WORKIT_DIR_KINDS)
    expect(
      table.some((line) => line.split("|")[1]?.trim().toLowerCase().startsWith(kind)),
      kind,
    ).toBe(true);
  const names = [
    ...Object.values(WORKIT_DIR_OVERRIDES as Record<string, string[]>).flat(),
    ...Object.values(WORKIT_DIR_XDG as Record<string, string>),
    "APPDATA",
    "LOCALAPPDATA",
  ];
  for (const name of names)
    expect(
      table.some((line) => line.includes(name)),
      name,
    ).toBe(true);
});
