// One host's install or repair with no Workit config change (#423): the
// planner on fixtures in a temp HOME; host commands are fakes, never run.
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applySetupPreview,
  planHostOnlyInstall,
  type HostOnlyInstallPlan,
} from "@/packages/workit-cli/src/admin/setup";
import { type HostInstallCommand, type HostId } from "@/packages/workit-cli/src/admin/host-install";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

const CANONICAL = { name: "workit", repository: "https://github.com/BrainerVirus/workit" };

/** A temp HOME with Workit config, every host's own config, and fake host executables. */
const world = (extraEnv: Record<string, string> = {}) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-host-plan-"));
  homes.push(home);
  const bin = path.join(home, "bin");
  for (const tool of ["node", "npm", "claude", "codex", "pi"]) {
    write(path.join(bin, tool), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, tool), 0o755);
  }
  // Cursor's download runs npm through node: the npm CLI script the planner resolves.
  write(path.join(bin, "node_modules/npm/bin/npm-cli.js"), "");
  const configDir = path.join(home, ".config/workit");
  write(path.join(configDir, "config.json"), { locale: "en" });
  write(path.join(configDir, "workspaces.json"), { version: 1, workspaces: [] });
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    WORKIT_STATE_DIR: path.join(home, ".local/state/workit"),
    ...extraEnv,
  };
  const options = { home, env, cwd: home, dir: configDir };
  return {
    home,
    configDir,
    options,
    plan: (host: HostId, extra: Record<string, unknown> = {}) =>
      planHostOnlyInstall(host, { ...options, ...extra }),
  };
};

/** Every file under HOME, path -> bytes, outside the given roots. */
const snapshot = (home: string, skip: string[]): Map<string, string> => {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (skip.some((root) => file === root || file.startsWith(root + path.sep))) continue;
      if (statSync(file).isDirectory()) walk(file);
      else files.set(file, readFileSync(file, "base64"));
    }
  };
  walk(home);
  return files;
};

/** Healthy installs of the hosts other than the one under test, so their bytes can be compared. */
const otherHosts = (home: string) => {
  const claude = path.join(home, ".claude/plugins/cache/workit/workit/1.0.0");
  write(path.join(claude, ".claude-plugin/plugin.json"), CANONICAL);
  write(path.join(home, ".claude/plugins/installed_plugins.json"), {
    version: 2,
    plugins: { "workit@workit": [{ installPath: claude, version: "1.0.0", scope: "user" }] },
  });
  write(
    path.join(home, ".codex/plugins/cache/workit/workit/1.0.0/.codex-plugin/plugin.json"),
    CANONICAL,
  );
  write(path.join(home, ".codex/config.toml"), '[plugins."workit@workit"]\nenabled = true\n');
  write(path.join(home, ".pi/agent/settings.json"), { packages: ["npm:@workit-dev/pi"] });
  const pi = path.join(home, ".pi/agent/npm/node_modules/@workit-dev/pi");
  write(path.join(pi, "package.json"), { name: "@workit-dev/pi", version: "1.0.0" });
  write(path.join(pi, "dist/workit.js"), "");
  write(path.join(home, ".config/opencode/opencode.json"), {
    plugins: ["@workit-dev/opencode"],
    theme: "keep",
  });
};

const commandLines = (plan: HostOnlyInstallPlan) =>
  plan.diff.commands.map((line) => line.split(" ").slice(1).join(" "));

const onlyHost = (plan: HostOnlyInstallPlan) => {
  expect(plan.preview.ok).toBe(true);
  expect(plan.preview.platforms).toEqual([plan.host]);
  for (const mutation of plan.preview.mutations) {
    expect(["install-host", "install-adapter", "register-platform"]).toContain(mutation.type);
    expect("platform" in mutation && mutation.platform).toBe(plan.host);
  }
};

/** A fake runner: answers each host command and lets `effect` stand in for the host's write. */
const fakeRunner =
  (calls: string[], effect: (args: string[]) => void) => (step: HostInstallCommand) => {
    calls.push([path.basename(step.command), ...step.args].join(" "));
    effect(step.args);
    return { exitCode: 0, stdout: "", stderr: "" };
  };

// --- Claude Code ---

test("Given Claude Code without Workit, When its install is planned, Then the plan is only Claude's marketplace and user-scope install", () => {
  const w = world();
  const plan = w.plan("claude-code");
  onlyHost(plan);
  expect(plan.preview.mutations).toHaveLength(1);
  expect(plan.diff.files).toEqual([path.join(w.home, ".claude/plugins/installed_plugins.json")]);
  expect(plan.diff.keys).toEqual([]);
  expect(commandLines(plan).slice(1)).toEqual([
    "plugin marketplace list --json",
    "plugin marketplace add BrainerVirus/workit",
    "plugin install workit@workit --scope user",
  ]);
});

test("Given Claude Code registers workit@workit but its install dir is gone, Then the plan removes the stale record before installing again", () => {
  const w = world();
  write(path.join(w.home, ".claude/plugins/installed_plugins.json"), {
    version: 2,
    plugins: {
      "workit@workit": [
        {
          installPath: path.join(w.home, ".claude/plugins/cache/workit/workit/9.9.9"),
          scope: "user",
        },
      ],
    },
  });
  const plan = w.plan("claude-code");
  onlyHost(plan);
  expect(commandLines(plan).slice(-2)).toEqual([
    "plugin uninstall workit@workit --scope user",
    "plugin install workit@workit --scope user",
  ]);
});

test("Given a healthy Claude Code install, Then its plan is empty", () => {
  const w = world();
  otherHosts(w.home);
  const plan = w.plan("claude-code");
  expect(plan.preview.mutations).toEqual([]);
  expect(plan.diff).toEqual({ files: [], keys: [], commands: [] });
});

test("Given a stale Claude Code record, When the repair is applied, Then Claude is healthy again and every other file under HOME is byte-identical", () => {
  const w = world();
  otherHosts(w.home);
  const registry = path.join(w.home, ".claude/plugins/installed_plugins.json");
  const fresh = path.join(w.home, ".claude/plugins/cache/workit/workit/2.0.0");
  write(registry, {
    version: 2,
    plugins: { "workit@workit": [{ installPath: path.join(w.home, "gone"), scope: "user" }] },
  });
  const before = snapshot(w.home, [
    path.join(w.home, ".claude"),
    path.join(w.home, ".local/state"),
  ]);
  const calls: string[] = [];
  const result = applySetupPreview(w.plan("claude-code").preview, {
    ...w.options,
    runHostCommand: fakeRunner(calls, (args) => {
      if (args[1] === "uninstall") write(registry, { version: 2, plugins: {} });
      if (args[1] === "install") {
        write(path.join(fresh, ".claude-plugin/plugin.json"), CANONICAL);
        write(registry, {
          version: 2,
          plugins: { "workit@workit": [{ installPath: fresh, version: "2.0.0", scope: "user" }] },
        });
      }
    }),
  });
  expect(result.ok, JSON.stringify(result.entries)).toBe(true);
  expect(
    calls.filter(
      (call) => call.startsWith("claude plugin u") || call.startsWith("claude plugin i"),
    ),
  ).toEqual([
    "claude plugin uninstall workit@workit --scope user",
    "claude plugin install workit@workit --scope user",
  ]);
  expect(
    snapshot(w.home, [path.join(w.home, ".claude"), path.join(w.home, ".local/state")]),
  ).toEqual(before);
  expect(w.plan("claude-code").preview.mutations).toEqual([]);
});

// --- Codex ---

test("Given Codex enables workit@workit with its plugin cache missing, Then the plan reinstalls through Codex's marketplace and add", () => {
  const w = world();
  write(path.join(w.home, ".codex/config.toml"), '[plugins."workit@workit"]\nenabled = true\n');
  const plan = w.plan("codex");
  onlyHost(plan);
  expect(plan.diff.files).toEqual([path.join(w.home, ".codex/plugins/cache/workit/workit")]);
  expect(commandLines(plan).slice(1)).toEqual([
    "plugin marketplace list",
    "plugin marketplace add https://github.com/BrainerVirus/workit.git",
    "plugin add workit@workit",
  ]);
});

test("Given a healthy Codex install, Then its plan is empty", () => {
  const w = world();
  otherHosts(w.home);
  expect(w.plan("codex").preview.mutations).toEqual([]);
});

// --- Pi ---

test("Given Pi without Workit, Then the plan installs the npm package in personal settings", () => {
  const w = world();
  const plan = w.plan("pi", { packageVersion: "2.0.0" });
  onlyHost(plan);
  expect(plan.diff.files).toEqual([path.join(w.home, ".pi/agent/settings.json")]);
  expect(commandLines(plan).slice(1)).toEqual(["install npm:@workit-dev/pi@2.0.0"]);
});

test("Given Pi lists Workit but never installed it, Then the plan reinstalls the listed source", () => {
  const w = world();
  write(path.join(w.home, ".pi/agent/settings.json"), { packages: ["npm:@workit-dev/pi"] });
  const plan = w.plan("pi");
  onlyHost(plan);
  expect(commandLines(plan).slice(1)).toEqual(["install npm:@workit-dev/pi"]);
});

test("Given Pi's Workit package lost its extension, Then the plan removes and reinstalls it", () => {
  const w = world();
  write(path.join(w.home, ".pi/agent/settings.json"), { packages: ["npm:@workit-dev/pi"] });
  write(path.join(w.home, ".pi/agent/npm/node_modules/@workit-dev/pi/package.json"), {
    name: "@workit-dev/pi",
    version: "1.0.0",
  });
  expect(commandLines(w.plan("pi")).slice(1)).toEqual([
    "remove npm:@workit-dev/pi",
    "install npm:@workit-dev/pi",
  ]);
});

test("Given `pi list` names the package root, Then the planner reads that root", () => {
  const w = world();
  write(path.join(w.home, ".pi/agent/settings.json"), { packages: ["npm:@workit-dev/pi"] });
  const listed = path.join(w.home, "pi-resolved");
  write(path.join(listed, "package.json"), { name: "@workit-dev/pi", version: "1.0.0" });
  write(path.join(listed, "dist/workit.js"), "");
  expect(w.plan("pi", { piPackageRoot: listed }).preview.mutations).toEqual([]);
});

test("Given Pi lists a local checkout that does not load, Then nothing is planned and the note says to build it", () => {
  const w = world();
  const checkout = path.join(w.home, "src/workit/packages/workit-pi");
  write(path.join(checkout, "package.json"), { name: "@workit-dev/pi", version: "1.0.0" });
  write(path.join(w.home, ".pi/agent/settings.json"), { packages: [checkout] });
  const plan = w.plan("pi");
  expect(plan.preview.mutations).toEqual([]);
  expect(plan.notes.join("\n")).toContain(`local checkout ${checkout}`);
});

test("Given a healthy Pi install, Then its plan is empty", () => {
  const w = world();
  otherHosts(w.home);
  expect(w.plan("pi").preview.mutations).toEqual([]);
});

test("Given Pi lists Workit but never installed it, When the repair is applied, Then every other file under HOME is byte-identical and Pi is healthy", () => {
  const w = world();
  otherHosts(w.home);
  const root = path.join(w.home, ".pi/agent/npm/node_modules/@workit-dev/pi");
  rmSync(root, { recursive: true });
  const before = snapshot(w.home, [
    path.join(w.home, ".pi/agent/npm"),
    path.join(w.home, ".local/state"),
  ]);
  const calls: string[] = [];
  const result = applySetupPreview(w.plan("pi").preview, {
    ...w.options,
    runHostCommand: fakeRunner(calls, (args) => {
      if (args[0] !== "install") return;
      write(path.join(root, "package.json"), { name: "@workit-dev/pi", version: "2.0.0" });
      write(path.join(root, "dist/workit.js"), "");
    }),
  });
  expect(result.ok, JSON.stringify(result.entries)).toBe(true);
  expect(calls.at(-1)).toBe("pi install npm:@workit-dev/pi");
  expect(
    snapshot(w.home, [path.join(w.home, ".pi/agent/npm"), path.join(w.home, ".local/state")]),
  ).toEqual(before);
  expect(w.plan("pi").preview.mutations).toEqual([]);
});

// --- OpenCode ---

test("Given OpenCode registers Workit under the deprecated plugin key, Then the plan moves it, naming both keys", () => {
  const w = world();
  const config = path.join(w.home, ".config/opencode/opencode.json");
  write(config, { plugin: ["@workit-dev/opencode", "other"], theme: "keep" });
  const plan = w.plan("opencode");
  onlyHost(plan);
  expect(plan.preview.mutations).toEqual([
    { type: "register-platform", platform: "opencode", path: config },
  ]);
  expect(plan.diff).toEqual({
    files: [config],
    keys: [`${config}: plugins`, `${config}: plugin`],
    commands: [],
  });
});

test("Given a healthy OpenCode registration, Then its plan is empty and says OpenCode fetches the package itself", () => {
  const w = world();
  otherHosts(w.home);
  const plan = w.plan("opencode");
  expect(plan.preview.mutations).toEqual([]);
  expect(plan.notes.join("\n")).toContain("OpenCode downloads");
});

test("Given OpenCode under the deprecated key, When the repair is applied, Then only opencode.json changed, its other keys stay, and a second plan is empty", () => {
  const w = world();
  otherHosts(w.home);
  const config = path.join(w.home, ".config/opencode/opencode.json");
  write(config, { plugin: ["@workit-dev/opencode"], theme: "keep" });
  const before = snapshot(w.home, [config, path.join(w.home, ".local/state")]);
  applySetupPreview(w.plan("opencode").preview, w.options);
  const after = JSON.parse(readFileSync(config, "utf8"));
  expect(after.plugins).toEqual(["@workit-dev/opencode"]);
  expect(after.plugin).toBeUndefined();
  expect(after.theme).toBe("keep");
  expect(snapshot(w.home, [config, path.join(w.home, ".local/state")])).toEqual(before);
  expect(w.plan("opencode").preview.mutations).toEqual([]);
});

// --- Cursor ---

test("Given Cursor registered with an empty plugin dir and no local adapter, Then the plan downloads the requested version and rewrites only Cursor's files", () => {
  const dev = mkdtempSync(path.join(os.tmpdir(), "wk-host-plan-dev-"));
  homes.push(dev);
  // An empty dev checkout: no local adapter, so the package is downloaded.
  const w = world({ WORKIT_DEV: dev });
  mkdirSync(path.join(w.home, ".cursor/plugins/local/workit"), { recursive: true });
  write(path.join(w.home, ".cursor/settings.json"), {
    plugin_dirs: ["~/.cursor/plugins/local/workit"],
  });
  const plan = w.plan("cursor", { packageVersion: "2.0.0" });
  onlyHost(plan);
  expect(plan.preview.mutations.map((mutation) => mutation.type)).toEqual([
    "install-host",
    "install-adapter",
    "register-platform",
    "register-platform",
  ]);
  expect(plan.diff.commands.at(-1)).toEndWith("@workit-dev/cursor@2.0.0");
  expect(plan.diff.files).toContain(path.join(w.home, ".cursor/plugins/local/workit"));
  expect(plan.diff.keys).toContain(`${path.join(w.home, ".cursor/mcp.json")}: mcpServers`);
});

test("Given Cursor without Workit, When its install is applied twice, Then the second plan is empty and nothing outside Cursor changed", () => {
  const w = world();
  otherHosts(w.home);
  const cursor = path.join(w.home, ".cursor");
  const before = snapshot(w.home, [cursor, path.join(w.home, ".local/state")]);
  const plan = w.plan("cursor");
  onlyHost(plan);
  expect(plan.preview.mutations.map((mutation) => mutation.type)).toEqual([
    "install-adapter",
    "register-platform",
    "register-platform",
  ]);
  applySetupPreview(plan.preview, w.options);
  expect(existsSync(path.join(cursor, "plugins/local/workit/package.json"))).toBe(true);
  expect(snapshot(w.home, [cursor, path.join(w.home, ".local/state")])).toEqual(before);
  expect(w.plan("cursor").preview.mutations).toEqual([]);
});
