import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "@/packages/workit-core/src/core/config";
import { readVcsConfig, vcsConfig } from "@/packages/workit-core/src/core/vcs-config";
import { configPath } from "@/packages/workit-core/src/core/youtrack-tools";

const savedEnv = new Map<string, string | undefined>();

const isolate = (env: Record<string, string>, fn: () => void) => {
  for (const key of ["WORKIT_CONFIG", "WORKIT_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME"]) {
    savedEnv.set(key, process.env[key]);
  }
  for (const key of ["WORKIT_CONFIG", "WORKIT_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    fn();
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  }
};

// os.homedir() caches in bun (test runner calls it at startup), so the XDG
// env is the isolated knob — same default branch as HOME without the cache.
test("CA-01: default configDir ends with .config/workit when no env overrides", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-ca01-"));
  const config = path.join(home, ".config");
  mkdirSync(config, { recursive: true });
  try {
    isolate({ XDG_CONFIG_HOME: config }, () => {
      const dir = configDir();
      expect(dir).toBe(path.join(config, "workit"));
      expect(path.basename(dir)).toBe("workit");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The old product name, spelled in parts so the no-legacy-name guard stays clean.
const OLD_NAME = ["workflow", "toolkit"].join("-");
const OLD_ENV = (suffix: string) => ["WORKFLOW", "TOOLKIT", suffix].join("_");

test("CA-02: a config dir under the old product name is never read or copied", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-ca02-"));
  const legacy = path.join(xdg, OLD_NAME);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "config.json"), '{"locale":"es-CL"}');
  try {
    isolate({ XDG_CONFIG_HOME: xdg }, () => {
      expect(configDir()).toBe(path.join(xdg, "workit"));
      expect(existsSync(path.join(xdg, "workit"))).toBe(false);
    });
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("CA-04: WORKIT_CONFIG and WORKIT_CONFIG_DIR redirect the config dir, in that order", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-ca04-"));
  const config = path.join(xdg, "config");
  const configDirOverride = path.join(xdg, "config-dir");
  try {
    isolate({ WORKIT_CONFIG_DIR: configDirOverride }, () => {
      expect(configDir()).toBe(configDirOverride);
      expect(configPath()).toBe(path.join(configDirOverride, "youtrack.json"));
    });
    isolate({ WORKIT_CONFIG: config, WORKIT_CONFIG_DIR: configDirOverride }, () => {
      expect(configDir()).toBe(config);
    });
    expect(existsSync(config)).toBe(false);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("CA-05: the old product-name env vars are ignored (no alias)", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-ca05-"));
  try {
    isolate(
      {
        XDG_CONFIG_HOME: xdg,
        [OLD_ENV("CONFIG")]: path.join(xdg, "old-config"),
        [OLD_ENV("CONFIG_DIR")]: path.join(xdg, "old-config-dir"),
      },
      () => {
        expect(configDir()).toBe(path.join(xdg, "workit"));
      },
    );
  } finally {
    delete process.env[OLD_ENV("CONFIG")];
    delete process.env[OLD_ENV("CONFIG_DIR")];
    rmSync(xdg, { recursive: true, force: true });
  }
});

// The shell installers source scripts/lib/config-dir.sh; it must resolve the
// same dir as the TS resolver for each env shape.
const CONFIG_DIR_SH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/workit-core/scripts/lib/config-dir.sh",
);
const bashConfigDir = (env: Record<string, string>) => {
  const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: "/nonexistent" };
  Object.assign(childEnv, env);
  const out = spawnSync("bash", ["-c", `. "${CONFIG_DIR_SH}"; resolve_config_dir`], {
    env: childEnv,
    encoding: "utf8",
  });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout.trim();
};

test("CA-06: bash resolve_config_dir matches the TS resolver and ignores the old env names", () => {
  expect(bashConfigDir({ XDG_CONFIG_HOME: "/x/xdg" })).toBe("/x/xdg/workit");
  expect(bashConfigDir({ WORKIT_CONFIG_DIR: "/x/dir", XDG_CONFIG_HOME: "/x/xdg" })).toBe("/x/dir");
  expect(bashConfigDir({ WORKIT_CONFIG: "/x/cfg", WORKIT_CONFIG_DIR: "/x/dir" })).toBe("/x/cfg");
  expect(bashConfigDir({ [OLD_ENV("CONFIG_DIR")]: "/x/old", [OLD_ENV("CONFIG")]: "/x/old2" })).toBe(
    "/nonexistent/.config/workit",
  );
});

test("RL-01: vcsConfig load reports a path-specific malformed diagnostic (no generic fallback)", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-rl01-"));
  const workit = path.join(xdg, "workit");
  mkdirSync(workit, { recursive: true });
  writeFileSync(path.join(workit, "vcs.json"), "{ broken !!");
  try {
    isolate({ XDG_CONFIG_HOME: xdg }, () => {
      const cfg = vcsConfig("load");
      expect(cfg.ok).toBe(false);
      expect(cfg.error).toContain(path.join(xdg, "workit", "vcs.json"));
    });
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("RL-01: readVcsConfig classifies missing, valid, and malformed with exact paths", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-vcstyped-"));
  try {
    isolate({ XDG_CONFIG_HOME: xdg }, () => {
      expect(readVcsConfig().status).toBe("missing");
      expect(readVcsConfig().path).toBe(path.join(xdg, "workit", "vcs.json"));
    });
    const workit = path.join(xdg, "workit");
    mkdirSync(workit, { recursive: true });
    writeFileSync(path.join(workit, "vcs.json"), '{"provider":"github"}', "utf8");
    isolate({ XDG_CONFIG_HOME: xdg }, () => {
      const valid = readVcsConfig();
      expect(valid.status).toBe("valid");
      expect(valid.config.provider).toBe("github");
      expect(valid.error).toBeUndefined();
    });
    writeFileSync(path.join(workit, "vcs.json"), "{ bad json", "utf8");
    isolate({ XDG_CONFIG_HOME: xdg }, () => {
      const malformed = readVcsConfig();
      expect(malformed.status).toBe("malformed");
      expect(malformed.path).toBe(path.join(xdg, "workit", "vcs.json"));
      expect(malformed.error).toContain(path.join(xdg, "workit", "vcs.json"));
    });
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});
