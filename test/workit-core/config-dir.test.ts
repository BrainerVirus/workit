import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../../packages/workit-core/src/core/config";
import {
  readVcsConfig,
  vcsConfig,
  vcsTokenCreateUrls,
} from "../../packages/workit-core/src/core/vcs-config";
import { configPath } from "../../packages/workit-core/src/core/youtrack-tools";

const savedEnv = new Map<string, string | undefined>();

const isolate = (env: Record<string, string>, fn: () => void) => {
  for (const key of [
    "WORKFLOW_TOOLKIT_CONFIG",
    "WORKFLOW_TOOLKIT_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "HOME",
  ]) {
    savedEnv.set(key, process.env[key]);
  }
  for (const key of ["WORKFLOW_TOOLKIT_CONFIG", "WORKFLOW_TOOLKIT_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
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

test("CA-02: legacy config copied once, second call never re-copies", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-ca02-"));
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "config.json"), '{"locale":"es-CL"}');
  writeFileSync(path.join(legacy, "youtrack.json"), '{"baseUrl":"https://yt.example.test"}');
  writeFileSync(path.join(legacy, "gitlab.token"), "tok-123\n");
  isolate({ XDG_CONFIG_HOME: xdg }, () => {
    const dir = configDir();
    expect(dir).toBe(path.join(xdg, "workit"));
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).toBe('{"locale":"es-CL"}');
    expect(readFileSync(path.join(dir, "youtrack.json"), "utf8")).toBe(
      '{"baseUrl":"https://yt.example.test"}',
    );
    expect(readFileSync(path.join(dir, "gitlab.token"), "utf8")).toBe("tok-123\n");

    writeFileSync(path.join(dir, "config.json"), "MODIFIED");
    expect(configDir()).toBe(dir);
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).toBe("MODIFIED");
    expect(readFileSync(path.join(legacy, "config.json"), "utf8")).toBe('{"locale":"es-CL"}');
  });
  rmSync(xdg, { recursive: true, force: true });
});

test("CA-03: existing workit dir leaves the legacy dir untouched", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-ca03-"));
  const workit = path.join(xdg, "workit");
  mkdirSync(workit, { recursive: true });
  writeFileSync(path.join(workit, "config.json"), "NEW");
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "marker.txt"), "legacy-only");
  isolate({ XDG_CONFIG_HOME: xdg }, () => {
    expect(configDir()).toBe(workit);
    expect(readFileSync(path.join(workit, "config.json"), "utf8")).toBe("NEW");
    expect(readFileSync(path.join(legacy, "marker.txt"), "utf8")).toBe("legacy-only");
    expect(existsSync(path.join(workit, "marker.txt"))).toBe(false);
  });
  rmSync(xdg, { recursive: true, force: true });
});

test("CA-04: WORKFLOW_TOOLKIT_CONFIG override skips migration entirely", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-ca04-"));
  const override = path.join(xdg, "override");
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "config.json"), "LEGACY");
  isolate({ WORKFLOW_TOOLKIT_CONFIG: override }, () => {
    expect(configDir()).toBe(override);
    expect(existsSync(override)).toBe(false);
    expect(existsSync(path.join(xdg, "workit"))).toBe(false);
    expect(readFileSync(path.join(legacy, "config.json"), "utf8")).toBe("LEGACY");
  });
  rmSync(xdg, { recursive: true, force: true });
});

test("CA-05: derived paths resolve under the migrated workit dir", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-ca05-"));
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "youtrack.json"), '{"baseUrl":"https://yt.example.test"}');
  isolate({ XDG_CONFIG_HOME: xdg }, () => {
    const expectedYt = path.join(xdg, "workit", "youtrack.json");
    expect(configPath()).toBe(expectedYt);
    expect(existsSync(expectedYt)).toBe(true);

    const urls = vcsTokenCreateUrls();
    expect(urls.active.tokenFile).toBe(path.join(xdg, "workit", "gitlab.token"));
    expect(urls.gitlab.tokenFile).toBeUndefined();
  });
  rmSync(xdg, { recursive: true, force: true });
});

test("CA-07: copy failure is non-fatal and retried (cache set only post-loop)", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-ca07-"));
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "config.json"), '{"locale":"es-CL"}');
  writeFileSync(path.join(legacy, "youtrack.json"), '{"baseUrl":"https://yt.example.test"}');
  const blocked = path.join(legacy, "blocked.token");
  writeFileSync(blocked, "tok-456\n");
  // EACCES only fires for non-root on unix; elsewhere the failure can't be
  // simulated, so the ordering asserts below still run (fallback per review).
  const canSimulate =
    process.platform !== "win32" &&
    (typeof process.getuid !== "function" || process.getuid() !== 0);
  if (canSimulate) chmodSync(blocked, 0o000);
  try {
    isolate({ XDG_CONFIG_HOME: xdg }, () => {
      const dir = configDir();
      expect(dir).toBe(path.join(xdg, "workit"));
      expect(readFileSync(path.join(dir, "config.json"), "utf8")).toBe('{"locale":"es-CL"}');
      expect(readFileSync(path.join(dir, "youtrack.json"), "utf8")).toBe(
        '{"baseUrl":"https://yt.example.test"}',
      );
      if (canSimulate) {
        expect(existsSync(path.join(dir, "blocked.token"))).toBe(false); // mid-loop failure
        chmodSync(blocked, 0o644);
        expect(configDir()).toBe(dir); // cache not set pre-loop -> migration retries
        expect(readFileSync(path.join(dir, "blocked.token"), "utf8")).toBe("tok-456\n");
      }
      expect(configDir()).toBe(dir); // now cached, post-loop
    });
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("CA-06: TS configDir migration matches the legacy bash resolve_config_dir behavior", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-ca06-"));
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(
    path.join(legacy, "vcs.json"),
    JSON.stringify({ provider: "github", defaultTargetBranch: "main" }),
  );
  try {
    isolate({ XDG_CONFIG_HOME: xdg }, () => {
      const dir = configDir();
      expect(dir).toBe(path.join(xdg, "workit"));
      expect(readFileSync(path.join(dir, "vcs.json"), "utf8")).toContain("github");

      writeFileSync(path.join(dir, "vcs.json"), JSON.stringify({ provider: "gitlab" }), "utf8");
      expect(configDir()).toBe(dir); // workit already exists -> no re-migration
      expect(readFileSync(path.join(dir, "vcs.json"), "utf8")).toContain("gitlab"); // legacy untouched as source
      expect(readFileSync(path.join(legacy, "vcs.json"), "utf8")).toContain("github");

      const load = vcsConfig("load");
      expect(load.ok).toBe(true);
      expect(load.provider).toBe("gitlab");
      expect(load.tokenReady).toBe(false);
    });
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("RL-01: vcsConfig load reports a path-specific malformed diagnostic (no generic fallback)", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-rl01-"));
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "vcs.json"), "{ broken !!");
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

// RL-07: migration cache contract. The memo is process-local (a fresh process
// re-runs the migration check); the on-disk workit dir is the cross-process
// authority — an existing dir is never re-copied over, an absent dir migrates.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const spawnMigrate = (env: Record<string, string>) => {
  const script = `import { configDir } from "./packages/workit-core/src/core/config.ts"; import { readFileSync } from "node:fs"; import path from "node:path"; const dir = configDir(); console.log(JSON.stringify({ dir, cfg: readFileSync(path.join(dir, "config.json"), "utf8") }));`;
  const childEnv = { ...process.env, ...env };
  delete childEnv.WORKFLOW_TOOLKIT_CONFIG;
  delete childEnv.WORKFLOW_TOOLKIT_CONFIG_DIR;
  return spawnSync("bun", ["-e", script], { cwd: REPO_ROOT, env: childEnv, encoding: "utf8" });
};

test("RL-07: a fresh process never re-copies over an existing migrated workit dir", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-rl07-"));
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "config.json"), '{"locale":"es-CL"}');
  try {
    isolate({ XDG_CONFIG_HOME: xdg }, () => {
      expect(configDir()).toBe(path.join(xdg, "workit"));
      writeFileSync(path.join(xdg, "workit", "config.json"), "MODIFIED");
      const child = spawnMigrate({ XDG_CONFIG_HOME: xdg });
      expect(child.status, child.stderr).toBe(0);
      const out = JSON.parse(child.stdout);
      expect(out.dir).toBe(path.join(xdg, "workit"));
      expect(out.cfg).toBe("MODIFIED");
    });
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("RL-07: migration runs again in a fresh process when the workit dir is absent (memo is per-process)", () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wk-rl07b-"));
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "config.json"), '{"locale":"es-CL"}');
  try {
    const child = spawnMigrate({ XDG_CONFIG_HOME: xdg });
    expect(child.status, child.stderr).toBe(0);
    const out = JSON.parse(child.stdout);
    expect(out.cfg).toBe('{"locale":"es-CL"}');
    expect(existsSync(path.join(xdg, "workit", "config.json"))).toBe(true);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});
