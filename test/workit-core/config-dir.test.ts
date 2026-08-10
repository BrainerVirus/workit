import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir } from "../../packages/workit-core/src/core/config";
import { vcsTokenCreateUrls } from "../../packages/workit-core/src/core/vcs-config";
import { configPath } from "../../packages/workit-core/src/tools/youtrack";

const savedEnv = new Map<string, string | undefined>();

const isolate = (env: Record<string, string>, fn: () => void) => {
  for (const key of ["WORKFLOW_TOOLKIT_CONFIG", "WORKFLOW_TOOLKIT_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME"]) {
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
  } finally { rmSync(home, { recursive: true, force: true }); }
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
    expect(readFileSync(path.join(dir, "youtrack.json"), "utf8")).toBe('{"baseUrl":"https://yt.example.test"}');
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
