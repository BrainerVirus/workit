import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readConfig,
  readConfigFromDir,
  readConfigTyped,
  writeConfig,
  resolveBranchPolicy,
  mergeConfigValues,
  LOCALE_RE,
  PRESETS,
  type ToolkitConfig,
} from "../../packages/workit-core/src/core/config";

const savedEnv = new Map<string, string | undefined>();

const cfgDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-config-"));
  for (const key of ["WORKFLOW_TOOLKIT_CONFIG", "WORKFLOW_TOOLKIT_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
    savedEnv.set(key, process.env[key]);
  }
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  delete process.env.XDG_CONFIG_HOME;
  return dir;
};

const cleanupEnv = () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
};

test("readConfig returns defaults when config.json missing", () => {
  const dir = cfgDir();
  try {
    const cfg = readConfig();
    expect(cfg.locale).toBe("en");
    expect(cfg.branchPolicy.preset).toBe("gitflow");
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeConfig + readConfig round trip", () => {
  const dir = cfgDir();
  try {
    const cfg: ToolkitConfig = {
      locale: "es-CL",
      localeOptions: ["en", "es-CL"],
      timezone: "America/Santiago",
      branchPolicy: { preset: "custom", allowed: ["feature/*", "codex/*"], protected: ["main"] },
    };
    writeConfig(cfg);
    expect(readConfig()).toEqual(cfg);
    expect(existsSync(path.join(dir, "config.json"))).toBe(true);
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid locale falls back to en", () => {
  const dir = cfgDir();
  try {
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ locale: "not-valid!" }), "utf8");
    expect(readConfig().locale).toBe("en");
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LOCALE_RE accepts 3-digit UN M.49 region subtags and still rejects malformed tags", () => {
  expect(LOCALE_RE.test("es-419")).toBe(true);
  // pre-existing shapes keep working
  expect(LOCALE_RE.test("en")).toBe(true);
  expect(LOCALE_RE.test("es-CL")).toBe(true);
  expect(LOCALE_RE.test("zh-CN")).toBe(true);
  for (const bad of [
    "not-valid!",
    "es_419",
    "es-4190",
    "es-41",
    "es-cl",
    "ES",
    "e1",
    "es-",
    "-419",
    "es-4X9",
  ]) {
    expect(LOCALE_RE.test(bad), bad).toBe(false);
  }
});

test("presets define allowed/protected lists", () => {
  expect(PRESETS.gitflow.allowed).toContain("feature/*");
  expect(PRESETS.gitflow.allowed).toContain("bugfix/*");
  expect(PRESETS.gitflow.protected).toContain("develop");
  expect(PRESETS["github-flow"].allowed).toContain("*");
});

test("resolveBranchPolicy honors preset and custom overrides", () => {
  const dir = cfgDir();
  try {
    const gitflow = resolveBranchPolicy(readConfig());
    expect(gitflow.allowed.some((r) => r.test("feature/x"))).toBe(true);
    expect(gitflow.allowed.some((r) => r.test("codex/feature/x"))).toBe(false);
    expect(gitflow.protected.has("main")).toBe(true);

    writeConfig({
      locale: "en",
      localeOptions: ["en"],
      timezone: "UTC",
      branchPolicy: { preset: "custom", allowed: ["codex/*"], protected: ["main"] },
    });
    const custom = resolveBranchPolicy(readConfig());
    expect(custom.allowed.some((r) => r.test("codex/feature/x"))).toBe(true);
    expect(custom.allowed.some((r) => r.test("feature/x"))).toBe(false);
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RL-01: readConfigTyped distinguishes missing, valid, and malformed with exact paths", () => {
  const dir = cfgDir();
  try {
    expect(readConfigTyped().status).toBe("missing");
    expect(readConfigTyped().path).toBe(path.join(dir, "config.json"));

    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ locale: "es-CL" }), "utf8");
    const valid = readConfigTyped();
    expect(valid.status).toBe("valid");
    expect(valid.config?.locale).toBe("es-CL");
    expect(valid.error).toBeUndefined();

    writeFileSync(path.join(dir, "config.json"), "{ not json", "utf8");
    const malformed = readConfigTyped();
    expect(malformed.status).toBe("malformed");
    expect(malformed.path).toBe(path.join(dir, "config.json"));
    expect(malformed.error).toContain(path.join(dir, "config.json"));
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RL-01: readConfig throws an exact-path diagnostic on malformed config (no silent defaults)", () => {
  const dir = cfgDir();
  try {
    writeFileSync(path.join(dir, "config.json"), "{ broken", "utf8");
    expect(() => readConfig()).toThrow(path.join(dir, "config.json"));
    expect(() => readConfigFromDir(dir)).toThrow(path.join(dir, "config.json"));
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AR-07: non-object config.json shapes are malformed with exact paths, never defaults", () => {
  const dir = cfgDir();
  try {
    for (const content of ["null", '"just a string"', "42", "true", "[]", "[1, 2, 3]"]) {
      writeFileSync(path.join(dir, "config.json"), content, "utf8");
      const result = readConfigTyped();
      expect(result.status, content).toBe("malformed");
      expect(result.error).toContain(path.join(dir, "config.json"));
      expect(() => readConfig(), content).toThrow(path.join(dir, "config.json"));
    }
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RL-02: readConfig derives policy from the preset and resets divergent fields", () => {
  const dir = cfgDir();
  try {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        branchPolicy: {
          preset: "github-flow",
          allowed: ["feature/*", "stale/*"],
          protected: ["main", "develop"],
        },
      }),
      "utf8",
    );
    const cfg = readConfig();
    expect(cfg.branchPolicy.allowed).toEqual(["*"]);
    expect(cfg.branchPolicy.protected).toEqual(["main"]);
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RL-02/CA-23: custom preset without persisted allowed/protected inherits the current (default) policy", () => {
  const dir = cfgDir();
  try {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ branchPolicy: { preset: "custom" } }),
      "utf8",
    );
    const cfg = readConfig();
    expect(cfg.branchPolicy.preset).toBe("custom");
    expect(cfg.branchPolicy.allowed).toEqual([...PRESETS.gitflow.allowed]);
    expect(cfg.branchPolicy.protected).toEqual([...PRESETS.gitflow.protected]);
  } finally {
    cleanupEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RL-02/CA-23: mergeConfigValues routes every consumer through mergePreset", () => {
  const current: ToolkitConfig = {
    locale: "en",
    localeOptions: ["en"],
    timezone: "UTC",
    branchPolicy: { preset: "gitflow", allowed: ["feature/*"], protected: ["main"] },
  };
  const github = mergeConfigValues({ preset: "github-flow" }, current);
  expect(github.branchPolicy).toEqual({
    preset: "github-flow",
    allowed: ["*"],
    protected: ["main"],
  });
  const trunk = mergeConfigValues({ preset: "trunk-based" }, current);
  expect(trunk.branchPolicy).toEqual({
    preset: "trunk-based",
    allowed: ["*"],
    protected: ["main"],
  });
  const custom = mergeConfigValues(
    { preset: "custom", allowed: ["codex/*"], protectedNames: ["main", "develop"] },
    current,
  );
  expect(custom.branchPolicy).toEqual({
    preset: "custom",
    allowed: ["codex/*"],
    protected: ["main", "develop"],
  });
});
