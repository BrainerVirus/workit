// `workit upgrade` repairs a registered-but-missing plugin on every host
// (#423): Claude Code, OpenCode and Pi through the host-only planner, next to
// the Cursor and Codex repairs upgrade-hosts.test.ts covers. Temp HOME, fake
// host commands, no real host or ~/.config.
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyUpgrade, previewUpgrade, type HostProcess } from "@/packages/workit-cli/src/upgrade";
import { codexInventoryAnswer } from "./codex-fake";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

const CANONICAL = { name: "workit", repository: "https://github.com/BrainerVirus/workit" };

/** Every host healthy at 1.0.0; each test breaks one. */
const world = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-upgrade-repair-"));
  homes.push(home);
  const bin = path.join(home, "bin");
  for (const tool of ["node", "npm", "claude", "codex", "pi"]) {
    write(path.join(bin, tool), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, tool), 0o755);
  }
  // Cursor's download runs npm through node: the npm CLI script the planner resolves.
  write(path.join(bin, "node_modules/npm/bin/npm-cli.js"), "");
  // Setup's post-apply doctor needs a real git.
  const git = Bun.which("git");
  if (git) symlinkSync(git, path.join(bin, "git"));
  write(path.join(home, ".config/workit/config.json"), { locale: "en" });
  write(path.join(home, ".config/workit/workspaces.json"), { version: 1, workspaces: [] });
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
  const piRoot = path.join(home, ".pi/agent/npm/node_modules/@workit-dev/pi");
  write(path.join(piRoot, "package.json"), { name: "@workit-dev/pi", version: "1.0.0" });
  write(path.join(piRoot, "dist/workit.js"), "");
  write(path.join(home, ".config/opencode/opencode.json"), {
    plugins: ["@workit-dev/opencode"],
    theme: "keep",
  });
  const state = {
    codex: [
      {
        name: "workit",
        marketplaceName: "workit",
        version: "1.0.0",
        source: { source: "npm", package: "@workit-dev/codex" },
      },
    ],
  };
  const calls: string[] = [];
  const effects: Record<string, (args: string[]) => void> = {};
  const run = (command: string, args: string[]) => {
    const name = path.basename(command);
    calls.push([name, ...args].join(" "));
    if (name === "npm" && args[0] === "view") return { status: 0, stdout: "2.0.0\n" };
    if (name === "pi" && args[0] === "list") {
      const listed = readdirSync(path.dirname(piRoot)).includes("pi");
      return { status: 0, stdout: `npm:@workit-dev/pi\n${listed ? `  ${piRoot}\n` : ""}` };
    }
    if (name === "codex") {
      const answer = codexInventoryAnswer(args, state.codex);
      if (answer) return answer;
    }
    effects[name]?.(args);
    return { status: 0, stdout: "" };
  };
  return {
    home,
    calls,
    effects,
    state,
    piRoot,
    deps: {
      home,
      run,
      processes: (): HostProcess[] => [],
      env: {
        PATH: bin,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_STATE_HOME: path.join(home, ".local/state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        WORKIT_STATE_DIR: path.join(home, ".local/state/workit"),
      },
    },
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

test("Given every host healthy, When upgrade previews each host, Then no repair is planned", () => {
  const w = world();
  for (const host of ["claude-code", "opencode", "pi", "codex", "cursor"] as const)
    expect(
      previewUpgrade([host], w.deps).entries.filter((entry) => entry.repair),
      host,
    ).toEqual([]);
});

test("Given Claude Code registers workit@workit with its install dir gone, When upgrade --hosts=claude-code previews and applies, Then it reinstalls and nothing outside ~/.claude changes", async () => {
  const w = world();
  const registry = path.join(w.home, ".claude/plugins/installed_plugins.json");
  rmSync(path.join(w.home, ".claude/plugins/cache"), { recursive: true });
  const fresh = path.join(w.home, ".claude/plugins/cache/workit/workit/2.0.0");
  w.effects.claude = (args) => {
    if (args[1] === "uninstall") write(registry, { version: 2, plugins: {} });
    if (args[1] === "install") {
      write(path.join(fresh, ".claude-plugin/plugin.json"), CANONICAL);
      write(registry, {
        version: 2,
        plugins: { "workit@workit": [{ installPath: fresh, version: "2.0.0", scope: "user" }] },
      });
    }
  };
  const plan = previewUpgrade(["claude-code"], w.deps);
  expect(plan.entries).toEqual([expect.objectContaining({ host: "claude-code", repair: true })]);
  expect(plan.entries[0].commands.map((step) => step.args.join(" ")).slice(-2)).toEqual([
    "plugin uninstall workit@workit --scope user",
    "plugin install workit@workit --scope user",
  ]);
  const skip = [path.join(w.home, ".claude"), path.join(w.home, ".local/state")];
  const before = snapshot(w.home, skip);
  const result = await applyUpgrade(plan, w.deps);
  expect(result.hosts).toEqual([
    expect.objectContaining({ host: "claude-code", status: "updated" }),
  ]);
  expect(snapshot(w.home, skip)).toEqual(before);
  expect(previewUpgrade(["claude-code"], w.deps).entries.filter((entry) => entry.repair)).toEqual(
    [],
  );
});

test("Given Pi lists Workit but its package is gone, When upgrade --hosts=pi previews and applies, Then pi install restores it and nothing outside Pi's package dir changes", async () => {
  const w = world();
  rmSync(w.piRoot, { recursive: true });
  w.effects.pi = (args) => {
    if (args[0] !== "install") return;
    write(path.join(w.piRoot, "package.json"), { name: "@workit-dev/pi", version: "2.0.0" });
    write(path.join(w.piRoot, "dist/workit.js"), "");
  };
  const plan = previewUpgrade(["pi"], w.deps);
  expect(plan.entries).toEqual([expect.objectContaining({ host: "pi", repair: true })]);
  expect(plan.entries[0].commands.at(-1)?.args).toEqual(["install", "npm:@workit-dev/pi"]);
  const skip = [path.join(w.home, ".pi/agent/npm"), path.join(w.home, ".local/state")];
  const before = snapshot(w.home, skip);
  const result = await applyUpgrade(plan, w.deps);
  expect(result.hosts).toEqual([expect.objectContaining({ host: "pi", status: "updated" })]);
  expect(w.calls).toContain("pi install npm:@workit-dev/pi");
  expect(snapshot(w.home, skip)).toEqual(before);
});

test("Given OpenCode registers Workit under the deprecated plugin key, When upgrade --hosts=opencode previews and applies, Then the registration moves and only opencode.json changes", async () => {
  const w = world();
  const config = path.join(w.home, ".config/opencode/opencode.json");
  write(config, { plugin: ["@workit-dev/opencode"], theme: "keep" });
  const plan = previewUpgrade(["opencode"], w.deps);
  expect(plan.entries).toEqual([expect.objectContaining({ host: "opencode", repair: true })]);
  const skip = [config, path.join(w.home, ".local/state")];
  const before = snapshot(w.home, skip);
  const result = await applyUpgrade(plan, w.deps);
  expect(result.hosts).toEqual([expect.objectContaining({ host: "opencode", status: "updated" })]);
  const after = JSON.parse(readFileSync(config, "utf8"));
  expect(after).toEqual({ theme: "keep", plugins: ["@workit-dev/opencode"] });
  expect(snapshot(w.home, skip)).toEqual(before);
});

test("Given Codex enables workit@workit with its cache gone, When upgrade --hosts=codex repairs it, Then nothing outside ~/.codex changes", async () => {
  const w = world();
  const cache = path.join(w.home, ".codex/plugins/cache");
  rmSync(cache, { recursive: true });
  w.state.codex = [];
  w.effects.codex = (args) => {
    if (args[1] !== "add") return;
    write(path.join(cache, "workit/workit/2.0.0/.codex-plugin/plugin.json"), CANONICAL);
    w.state.codex = [
      {
        name: "workit",
        marketplaceName: "workit",
        version: "2.0.0",
        source: { source: "npm", package: "@workit-dev/codex" },
      },
    ];
  };
  const plan = previewUpgrade(["codex"], w.deps);
  expect(plan.entries).toEqual([expect.objectContaining({ host: "codex", repair: true })]);
  const skip = [path.join(w.home, ".codex"), path.join(w.home, ".local/state")];
  const before = snapshot(w.home, skip);
  const result = await applyUpgrade(plan, w.deps);
  expect(result.hosts).toEqual([expect.objectContaining({ host: "codex", status: "updated" })]);
  expect(snapshot(w.home, skip)).toEqual(before);
});

test("Given Cursor registered with an empty plugin dir, When upgrade --hosts=cursor repairs it, Then nothing outside ~/.cursor changes", async () => {
  const w = world();
  const cursor = path.join(w.home, ".cursor");
  mkdirSync(path.join(cursor, "plugins/local/workit"), { recursive: true });
  write(path.join(cursor, "settings.json"), {
    plugin_dirs: [path.join(cursor, "plugins/local/workit")],
  });
  w.effects.node = (args) => {
    const prefix = args.indexOf("--prefix");
    if (prefix < 0) return;
    const root = path.join(args[prefix + 1], "node_modules/@workit-dev/cursor");
    write(path.join(root, "package.json"), { name: "@workit-dev/cursor", version: "2.0.0" });
  };
  const plan = previewUpgrade(["cursor"], w.deps);
  expect(plan.entries).toEqual([expect.objectContaining({ host: "cursor", repair: true })]);
  const skip = [cursor, path.join(w.home, ".local/state")];
  const before = snapshot(w.home, skip);
  await applyUpgrade(plan, w.deps);
  // The plugin files came back (setup's doctor rejects this synthetic package; upgrade-hosts covers that row).
  expect(
    JSON.parse(readFileSync(path.join(cursor, "plugins/local/workit/package.json"), "utf8"))
      .version,
  ).toBe("2.0.0");
  expect(snapshot(w.home, skip)).toEqual(before);
});

test("Given Claude Code's plugin registry is not valid JSON, When upgrade previews Claude Code, Then it reports the file instead of reading as healthy", () => {
  const w = world();
  const registry = path.join(w.home, ".claude/plugins/installed_plugins.json");
  write(registry, "{not json");
  const plan = previewUpgrade(["claude-code"], w.deps);
  expect(plan.entries).toEqual([]);
  expect(plan.failed).toEqual([
    expect.objectContaining({
      host: "claude-code",
      reason: `cannot read ${registry}: not valid JSON: not repaired`,
    }),
  ]);
});
