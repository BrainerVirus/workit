// The doctor `workit upgrade` ends with: a stale OpenCode package cache must
// read as stale_install even when the Cursor install is stale too.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";

const base = mkdtempSync(path.join(os.tmpdir(), "wk-doctor-upgrade-stale-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

test("Given a stale Cursor install and a stale OpenCode @latest cache, When upgrade's closing doctor runs, Then stale_install names both", () => {
  const home = path.join(base, "home");
  const cwd = path.join(base, "cwd");
  mkdirSync(cwd, { recursive: true });
  const cache = path.join(home, "oc-cache");
  write(path.join(cache, "node_modules/@brainervirus/workit-opencode/package.json"), {
    name: "@brainervirus/workit-opencode",
    version: "8.40.8",
  });
  write(path.join(home, ".config/opencode/opencode.json"), {
    plugin: ["@brainervirus/workit-opencode"],
  });
  write(path.join(home, ".cursor/plugins/local/workit/mcp.json"), {
    mcpServers: {
      // An old exact pin, built at runtime: the manifest scan keeps source selectors canonical.
      workit: {
        command: "npx",
        args: ["-y", ["--package=@brainervirus/workit-cursor", "1.0.0"].join("@")],
      },
    },
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "8.44.0",
  };
  delete env.WORKFLOW_TOOLKIT_DEV;
  const report = runDoctor({
    host: "cli",
    only: "upgrade",
    home,
    cwd,
    workspaceRoot: cwd,
    configDir: path.join(home, ".config/workit"),
    stateDir: path.join(home, ".local/state/workit"),
    opencodePackageCacheDir: cache,
    env,
  });
  const stale = report.checks.find((check) => check.id === "stale_install");
  expect(stale?.status).toBe("fail");
  expect(stale?.detail).toContain("legacy selector");
  expect(stale?.detail).toContain("workit-opencode 8.40.8 behind published 8.44.0");
  expect(stale?.fix).toContain("opencode plugin update");
});

test("Given XDG_CONFIG_HOME, When doctor checks the OpenCode cache, Then it reads the OpenCode config there, as upgrade does", () => {
  const home = path.join(base, "xdg-home");
  const cwd = path.join(base, "xdg-cwd");
  mkdirSync(cwd, { recursive: true });
  const xdg = path.join(home, "xdg-config");
  const cache = path.join(home, "oc-cache");
  write(path.join(cache, "node_modules/@brainervirus/workit-opencode/package.json"), {
    name: "@brainervirus/workit-opencode",
    version: "8.40.8",
  });
  write(path.join(xdg, "opencode/opencode.json"), { plugin: ["@brainervirus/workit-opencode"] });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "8.44.0",
  };
  delete env.WORKFLOW_TOOLKIT_DEV;
  const report = runDoctor({
    host: "cli",
    only: "upgrade",
    home,
    cwd,
    workspaceRoot: cwd,
    configDir: path.join(home, ".config/workit"),
    stateDir: path.join(home, ".local/state/workit"),
    opencodePackageCacheDir: cache,
    env,
  });
  const stale = report.checks.find((check) => check.id === "stale_install");
  expect(stale?.status).toBe("fail");
  expect(stale?.detail).toContain("workit-opencode 8.40.8 behind published 8.44.0");
});
