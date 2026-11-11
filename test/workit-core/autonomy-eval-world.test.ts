import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { DEFAULT_GRANTS, resolveAutonomy } from "@/packages/workit-core/src/autonomy";
import { EVAL_WORLD_ENV, EVAL_WORLD_MARKER } from "@/packages/workit-core/src/core/eval-world";

// #792 item 27: the bench gives its throwaway world a workspace (endpoint,
// grants) through WORKIT_EVAL_WORLD. Any shell can set that variable, and
// TMPDIR, an agent's included, so a world counts only where no real workspace
// matches, and only for its endpoint and the grants it lowers.

let configHome: ConfigHome;
let world = "";
let real = "";
// os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
const TMP_VARS = ["TMPDIR", "TEMP", "TMP"] as const;
const SAVED = [EVAL_WORLD_ENV, "WORKIT_CONFIG", ...TMP_VARS] as const;
const saved = Object.fromEntries(SAVED.map((key) => [key, process.env[key]]));

const gitInit = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir, timeout: 20_000 });
};

const writeWorkspaces = (dir: string, workspaces: Record<string, unknown>[]) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify({ workspaces }));
};

/** A marked world at `dir` with one entry, the variable and the config pointing at it. */
const makeWorld = (dir: string, entry: Record<string, unknown>) => {
  gitInit(path.join(dir, "repo"));
  writeFileSync(path.join(dir, EVAL_WORLD_MARKER), "");
  writeWorkspaces(path.join(dir, "config"), [{ name: "eval", glob: `${dir}/**`, ...entry }]);
  process.env[EVAL_WORLD_ENV] = dir;
  process.env.WORKIT_CONFIG = path.join(dir, "config");
};

beforeAll(() => {
  configHome = useConfigHome("wk-eval-world-config-");
  world = realpathSync(mkdtempSync(path.join(os.tmpdir(), "workit-eval-unit-")));
  real = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-eval-world-real-")));
  gitInit(path.join(real, "repo"));
  // The account's real grants: this checkout may not push.
  writeWorkspaces(configHome.configDir, [
    { name: "real", glob: `${real}/**`, autonomy: { push: false } },
  ]);
});
afterAll(() => {
  configHome.restore();
  rmSync(world, { recursive: true, force: true });
  rmSync(real, { recursive: true, force: true });
});
afterEach(() => {
  for (const key of SAVED)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});

test("Given a bench world with defaultEndpoint pr, When its repo resolves grants, Then the world's workspace and endpoint apply", () => {
  makeWorld(world, { defaultEndpoint: "pr" });
  const autonomy = resolveAutonomy(path.join(world, "repo"));
  expect(autonomy.workspace).toBe("eval");
  expect(autonomy.defaultEndpoint).toBe("pr");
  expect(autonomy.effectiveEndpoint).toBe("pr");
  expect(autonomy.grants).toEqual({ ...DEFAULT_GRANTS });
  expect(autonomy.note).toBeUndefined();
});

test("Given a bench world that grants merge and release, loosens verification and names a forge account, Then none of it applies", () => {
  makeWorld(world, {
    defaultEndpoint: "merged",
    autonomy: { merge: true, release: true },
    vcs: { provider: "github", account: "eval" },
    verification: "self",
  });
  const autonomy = resolveAutonomy(path.join(world, "repo"));
  expect(autonomy.grants).toEqual({ ...DEFAULT_GRANTS });
  expect(autonomy.configured).toEqual([]);
  expect(autonomy.accountConfigured).toBe(false);
  expect(autonomy.verification).toBe("proportional");
  expect(autonomy.effectiveEndpoint).toBe("green");
});

test("Given a bench world that denies push, Then push is denied and the endpoint stops at the commit", () => {
  makeWorld(world, { defaultEndpoint: "pr", autonomy: { push: false } });
  const autonomy = resolveAutonomy(path.join(world, "repo"));
  expect(autonomy.grants.push).toBe(false);
  expect(autonomy.effectiveEndpoint).toBe("commit");
});

test("Given TMPDIR points at a checkout a real workspace covers and a marked world inside it, When that world resolves grants, Then the real grants win", () => {
  const inside = path.join(real, "repo", "w");
  mkdirSync(inside, { recursive: true });
  for (const name of TMP_VARS) process.env[name] = path.join(real, "repo");
  makeWorld(inside, { defaultEndpoint: "pr", autonomy: { push: true } });
  const autonomy = resolveAutonomy(path.join(inside, "repo"));
  expect(autonomy.workspace).toBe("real");
  expect(autonomy.grants.push).toBe(false);
  expect(autonomy.defaultEndpoint).toBe("commit");
});

test("Given an agent sets WORKIT_EVAL_WORLD to a world it wrote, When its own checkout outside the world resolves grants, Then the world is ignored", () => {
  makeWorld(world, { defaultEndpoint: "merged" });
  process.env.WORKIT_CONFIG = configHome.configDir;
  const own = resolveAutonomy(path.join(real, "repo"));
  expect(own.workspace).toBe("real");
  expect(own.grants.push).toBe(false);
  // Pointing the config at the world too only drops to the D4 defaults.
  process.env.WORKIT_CONFIG = path.join(world, "config");
  const redirected = resolveAutonomy(path.join(real, "repo"));
  expect(redirected.defaultEndpoint).toBe("commit");
  expect(redirected.note).toContain("does not apply to grants");
});

test("Given a world without the marker, outside the temp dir or named by a relative path, Then it is not a bench world", () => {
  makeWorld(world, { defaultEndpoint: "pr" });
  const repo = path.join(world, "repo");
  const endpoint = () => resolveAutonomy(repo).defaultEndpoint;
  expect(endpoint()).toBe("pr");
  rmSync(path.join(world, EVAL_WORLD_MARKER));
  try {
    expect(endpoint()).toBe("commit");
  } finally {
    writeFileSync(path.join(world, EVAL_WORLD_MARKER), "");
  }
  for (const name of TMP_VARS) process.env[name] = repo;
  expect(endpoint()).toBe("commit");
  for (const name of TMP_VARS) delete process.env[name];
  process.env[EVAL_WORLD_ENV] = path.relative(process.cwd(), world);
  expect(endpoint()).toBe("commit");
});
