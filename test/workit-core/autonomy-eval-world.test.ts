import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  DEFAULT_GRANTS,
  EVAL_WORLD_ENV,
  EVAL_WORLD_MARKER,
  evalWorld,
  resolveAutonomy,
} from "@/packages/workit-core/src/autonomy";

// #792 item 27: the bench gives its throwaway world a workspace (endpoint,
// grants) through WORKIT_EVAL_WORLD. Any shell can set that variable, an
// agent's included, so it must never raise a grant: it applies only inside a
// marked world under the OS temp dir, and only up to the D4 defaults.

let configHome: ConfigHome;
let world = "";
let outside = "";
const SAVED = [EVAL_WORLD_ENV, "WORKIT_CONFIG", "TMPDIR"] as const;
const saved = Object.fromEntries(SAVED.map((key) => [key, process.env[key]]));

const gitInit = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir, timeout: 20_000 });
};

const writeWorkspaces = (dir: string, workspaces: Record<string, unknown>[]) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify({ workspaces }));
};

beforeAll(() => {
  configHome = useConfigHome("wk-eval-world-config-");
  world = realpathSync(mkdtempSync(path.join(os.tmpdir(), "workit-eval-unit-")));
  outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-eval-world-real-")));
  gitInit(path.join(world, "repo"));
  gitInit(path.join(outside, "repo"));
  writeFileSync(path.join(world, EVAL_WORLD_MARKER), "");
  // The account's real grants: the agent's own checkout stops at a commit, merge not granted.
  writeWorkspaces(configHome.configDir, [
    { name: "real", glob: `${outside}/**`, autonomy: { merge: false } },
  ]);
});
afterAll(() => {
  configHome.restore();
  rmSync(world, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
afterEach(() => {
  for (const key of SAVED)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});

const inWorld = (entry: Record<string, unknown>) => {
  writeWorkspaces(path.join(world, "config"), [{ name: "eval", glob: `${world}/**`, ...entry }]);
  process.env[EVAL_WORLD_ENV] = world;
  process.env.WORKIT_CONFIG = path.join(world, "config");
};

test("Given a bench world with defaultEndpoint pr, When its repo resolves grants, Then the world's workspace and endpoint apply", () => {
  inWorld({ defaultEndpoint: "pr" });
  const autonomy = resolveAutonomy(path.join(world, "repo"));
  expect(autonomy.workspace).toBe("eval");
  expect(autonomy.defaultEndpoint).toBe("pr");
  expect(autonomy.effectiveEndpoint).toBe("pr");
  expect(autonomy.grants).toEqual({ ...DEFAULT_GRANTS });
  expect(autonomy.note).toBeUndefined();
});

test("Given a bench world that grants merge, release and self verification, When resolved, Then nothing exceeds the D4 defaults", () => {
  inWorld({
    defaultEndpoint: "merged",
    autonomy: { merge: true, release: true },
    vcs: { provider: "github", account: "eval" },
    verification: "self",
  });
  const autonomy = resolveAutonomy(path.join(world, "repo"));
  expect(autonomy.grants).toEqual({ ...DEFAULT_GRANTS });
  expect(autonomy.verification).toBe("proportional");
  expect(autonomy.effectiveEndpoint).toBe("green");
  expect(autonomy.note).toContain("merge, release, verification capped at the D4 defaults");
});

test("Given a bench world may lower grants, When it denies push, Then push is denied and the endpoint stops at the commit", () => {
  inWorld({
    defaultEndpoint: "pr",
    autonomy: { push: false },
    vcs: { provider: "github", account: "eval" },
  });
  const autonomy = resolveAutonomy(path.join(world, "repo"));
  expect(autonomy.grants.push).toBe(false);
  expect(autonomy.effectiveEndpoint).toBe("commit");
});

test("Given an agent sets WORKIT_EVAL_WORLD to a world it wrote, When its own checkout outside the world resolves grants, Then the world is ignored", () => {
  inWorld({ defaultEndpoint: "merged", autonomy: { merge: true } });
  process.env.WORKIT_CONFIG = configHome.configDir;
  const own = resolveAutonomy(path.join(outside, "repo"));
  expect(evalWorld(path.join(outside, "repo"))).toBeNull();
  expect(own.workspace).toBe("real");
  expect(own.grants.merge).toBe(false);
  expect(own.defaultEndpoint).toBe("commit");
  // Pointing the config at the world too only drops to the D4 defaults.
  process.env.WORKIT_CONFIG = path.join(world, "config");
  const redirected = resolveAutonomy(path.join(outside, "repo"));
  expect(redirected.grants.merge).toBe(false);
  expect(redirected.defaultEndpoint).toBe("commit");
  expect(redirected.note).toContain("does not apply to grants");
});

test("Given a world without the marker or outside the temp dir, Then it is not a bench world", () => {
  inWorld({ defaultEndpoint: "pr" });
  const repo = path.join(world, "repo");
  expect(evalWorld(repo)).toBe(world);
  rmSync(path.join(world, EVAL_WORLD_MARKER));
  try {
    expect(evalWorld(repo)).toBeNull();
    expect(resolveAutonomy(repo).defaultEndpoint).toBe("commit");
  } finally {
    writeFileSync(path.join(world, EVAL_WORLD_MARKER), "");
  }
  process.env.TMPDIR = path.join(world, "repo");
  expect(evalWorld(repo)).toBeNull();
  delete process.env.TMPDIR;
  process.env[EVAL_WORLD_ENV] = "relative/world";
  expect(evalWorld(repo)).toBeNull();
});
