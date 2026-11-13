// `workit install --hosts=<h,…> [--preview | --yes]` (#423 part 3): installs or
// repairs the named hosts only, and a second run changes nothing. Every run uses
// a temp fixture HOME passed through io.env, with fake host executables on a
// fixture PATH: no real host, Workit config or host CLI is read or run.
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run as install } from "@/packages/workit-cli/src/verbs/install";
import { run as uninstall } from "@/packages/workit-cli/src/verbs/uninstall";

const scratch = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "wk-install-hosts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};

const CANONICAL = JSON.stringify({
  name: "workit",
  repository: "https://github.com/BrainerVirus/workit",
});

// Each fake host CLI does what the real one leaves on disk for a Workit install.
const FAKES: Record<string, string> = {
  node: "exit 0",
  npm: "exit 0",
  claude: `
if [ "$1 $2 $3" = "plugin marketplace list" ]; then echo '[]'; exit 0; fi
if [ "$1 $2" = "plugin install" ]; then
  dir="$HOME/.claude/plugins/cache/workit/workit/2.0.0"
  mkdir -p "$dir/.claude-plugin"
  printf '%s' '${CANONICAL}' > "$dir/.claude-plugin/plugin.json"
  printf '{"version":2,"plugins":{"workit@workit":[{"installPath":"%s","version":"2.0.0","scope":"user"}]}}' "$dir" > "$HOME/.claude/plugins/installed_plugins.json"
fi
exit 0`,
  codex: `
if [ "$1 $2" = "plugin add" ]; then
  dir="$HOME/.codex/plugins/cache/workit/workit/2.0.0/.codex-plugin"
  mkdir -p "$dir"
  printf '%s' '${CANONICAL}' > "$dir/plugin.json"
  printf '[plugins."workit@workit"]\\nenabled = true\\n' > "$HOME/.codex/config.toml"
fi
exit 0`,
  pi: `
if [ "$1" = "install" ]; then
  dir="$HOME/.pi/agent/npm/node_modules/@workit-dev/pi"
  mkdir -p "$dir/dist" "$HOME/.pi/agent"
  printf '{"name":"@workit-dev/pi","version":"2.0.0"}' > "$dir/package.json"
  : > "$dir/dist/workit.js"
  printf '{"packages":["npm:@workit-dev/pi"]}' > "$HOME/.pi/agent/settings.json"
fi
exit 0`,
};

let homes = 0;
/** A temp HOME with Workit config and fake host CLIs on PATH (all but `missing`). */
const world = (missing: string[] = []) => {
  const home = path.join(scratch, `home-${(homes += 1)}`);
  // The Cursor and OpenCode adapters come from a fixture dev checkout: this
  // repo's packages and skills with Cursor's built launchers stubbed, so no build is needed.
  const dev = path.join(home, "fake-bin/dev");
  for (const adapter of ["workit-cursor", "workit-opencode", "workit-core/skills"])
    cpSync(
      path.join(import.meta.dir, "../../packages", adapter),
      path.join(dev, "packages", adapter),
      {
        recursive: true,
        filter: (source) => !source.includes(`${path.sep}node_modules`),
      },
    );
  for (const file of ["mcp-server.js", "cursor-session-start.js", "workit-hook.js"])
    write(path.join(dev, "packages/workit-cursor/dist", file), "#!/usr/bin/env node\n");
  const bin = path.join(home, "fake-bin");
  for (const [tool, body] of Object.entries(FAKES)) {
    if (missing.includes(tool)) continue;
    write(path.join(bin, tool), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(bin, tool), 0o755);
  }
  write(path.join(bin, "node_modules/npm/bin/npm-cli.js"), "");
  write(path.join(home, ".config/workit/config.json"), { locale: "en" });
  write(path.join(home, ".config/workit/workspaces.json"), { version: 1, workspaces: [] });
  for (const dir of [".claude/plugins", ".codex", ".cursor", ".pi/agent", ".config/opencode"])
    mkdirSync(path.join(home, dir), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    // The running bun: doctor asks a dev checkout for one.
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    WORKIT_STATE_DIR: path.join(home, ".local/state/workit"),
    WORKIT_DEV: dev,
  };
  return { home, env };
};

const io = (home: string, env: NodeJS.ProcessEnv, json = false) => {
  const out: string[] = [];
  const value: Io = {
    json,
    cwd: home,
    env,
    stdout: (text) => void out.push(text),
    stderr: (text) => void out.push(text),
  };
  return { io: value, text: () => out.join("") };
};

const runIn = async (verb: typeof install, w: ReturnType<typeof world>, argv: string[]) => {
  const run = io(w.home, w.env);
  const code = await verb(argv, run.io);
  return { code, text: run.text() };
};

/** Every file under HOME, path -> bytes, outside the given roots. */
const snapshot = (home: string, skip: string[] = []): Map<string, string> => {
  const roots = [...skip, path.join(home, ".local/state"), path.join(home, "fake-bin")];
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (roots.some((root) => file === root || file.startsWith(root + path.sep))) continue;
      if (statSync(file).isDirectory()) walk(file);
      else files.set(file, readFileSync(file, "base64"));
    }
  };
  walk(home);
  return files;
};

/** Healthy installs of every host but Cursor, so their bytes can be compared. */
const otherHostsHealthy = (home: string) => {
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

test("Given Cursor registered with an empty plugin dir, When `workit install --hosts=cursor --yes` runs, Then Cursor's plugin, MCP and hooks are restored and every other file is byte-identical", async () => {
  const w = world();
  otherHostsHealthy(w.home);
  const cursor = path.join(w.home, ".cursor");
  const pluginDir = path.join(cursor, "plugins/local/workit");
  mkdirSync(pluginDir, { recursive: true });
  write(path.join(cursor, "settings.json"), { plugin_dirs: [pluginDir] });
  const before = snapshot(w.home, [cursor]);

  const { code, text } = await runIn(install, w, ["--hosts=cursor", "--yes"]);

  expect(code, text).toBe(0);
  expect(text).toContain("Installed Workit on cursor.");
  expect(existsSync(path.join(pluginDir, "package.json"))).toBe(true);
  expect(existsSync(path.join(pluginDir, "hooks/hooks-cursor.json"))).toBe(true);
  const mcp = JSON.parse(readFileSync(path.join(cursor, "mcp.json"), "utf8"));
  expect(Object.keys(mcp.mcpServers)).toContain("workit");
  // The other hosts and the Workit config (under .config/workit) did not change.
  expect(snapshot(w.home, [cursor])).toEqual(before);
});

test("Given Cursor's settings name the plugin dir as ~/…, When install runs twice, Then one plugin_dirs entry stays, in the user's spelling, and the second run changes nothing", async () => {
  const w = world();
  const cursor = path.join(w.home, ".cursor");
  const settings = path.join(cursor, "settings.json");
  write(settings, { plugin_dirs: ["~/.cursor/plugins/local/workit"] });

  const first = await runIn(install, w, ["--hosts=cursor", "--yes"]);
  expect(first.code, first.text).toBe(0);
  expect(first.text).not.toContain("duplicate_registration");
  expect(JSON.parse(readFileSync(settings, "utf8")).plugin_dirs).toEqual([
    "~/.cursor/plugins/local/workit",
  ]);
  const between = snapshot(w.home);

  const second = await runIn(install, w, ["--hosts=cursor", "--yes"]);
  expect(second.code, second.text).toBe(0);
  expect(second.text).toContain("Workit is already installed on cursor: nothing to change.");
  expect(snapshot(w.home)).toEqual(between);
});

for (const host of ["claude-code", "codex", "cursor", "opencode", "pi"]) {
  test(`Given ${host} without Workit, When install runs twice, Then the second run plans and changes nothing and says so`, async () => {
    const w = world();
    const first = await runIn(install, w, [`--hosts=${host}`, "--yes"]);
    expect(first.code, first.text).toBe(0);
    expect(first.text).toContain(`Installed Workit on ${host}.`);
    const between = snapshot(w.home);

    const second = await runIn(install, w, [`--hosts=${host}`, "--yes"]);

    expect(second.code, second.text).toBe(0);
    expect(second.text).toContain(`Workit is already installed on ${host}: nothing to change.`);
    expect(second.text).not.toMatch(/ (write|run) /);
    expect(snapshot(w.home)).toEqual(between);
  });
}

test("Given --preview, Then it prints the files, config keys, host commands and notes and changes nothing", async () => {
  const w = world();
  const before = snapshot(w.home);

  const { code, text } = await runIn(install, w, [
    "--hosts=claude-code,cursor,opencode",
    "--preview",
  ]);

  expect(code, text).toBe(0);
  expect(text).toContain(`cursor write ${path.join(w.home, ".cursor/plugins/local/workit")}`);
  expect(text).toContain(`+ ${path.join(w.home, ".cursor/mcp.json")}: mcpServers`);
  expect(text).toContain("claude-code run ");
  expect(text).toContain("plugin install workit@workit --scope user");
  expect(text).toContain("opencode note: OpenCode downloads");
  expect(text).toContain(
    "Preview: nothing changed. `workit install --hosts=claude-code,cursor,opencode --yes` installs it",
  );
  expect(snapshot(w.home)).toEqual(before);
});

test("Given a bad argument list, Then install refuses it naming the valid hosts and plans nothing", async () => {
  const w = world();
  const hosts = "hosts: claude-code, codex, cursor, opencode, pi";
  for (const [argv, message] of [
    [["--hosts=cursor", "--preview", "--yes"], "--preview and --yes cannot be combined"],
    [["--hosts=vim"], `unknown host vim; ${hosts}`],
    [["--hosts="], `--hosts needs a value; ${hosts}`],
    [["--yes"], `--hosts=<h,…> names the hosts to install; ${hosts}`],
  ] as const) {
    const { code, text } = await runIn(install, w, [...argv]);
    expect(code, argv.join(" ")).toBe(2);
    expect(text).toContain(message);
    expect(text).not.toContain(" write ");
  }
});

test("Given an agent session marker, When --yes is passed, Then install is refused before anything is planned, naming the user's command", async () => {
  const w = world();
  const run = io(w.home, { ...w.env, CLAUDECODE: "1" });
  const before = snapshot(w.home);

  const code = await install(["--hosts=cursor,pi", "--yes"], run.io);

  expect(code).toBe(3);
  expect(run.text()).toBe(
    "workit: an agent cannot run this (CLAUDECODE is set): hand the user `workit install --hosts=cursor,pi --yes` to run in their own terminal\n",
  );
  expect(snapshot(w.home)).toEqual(before);
});

test("Given no --yes and no terminal, Then install shows the plan and asks for the user's consent, changing nothing", async () => {
  const w = world();
  const before = snapshot(w.home);
  const { code, text } = await runIn(install, w, ["--hosts=cursor"]);
  expect(code).toBe(3);
  expect(text).toContain("installing Workit on these hosts needs your consent");
  expect(snapshot(w.home)).toEqual(before);
});

const NOT_ON_PATH = (name: string) =>
  `${name} executable was not found on PATH or supported user bin directories`;

for (const [host, binary] of [
  ["claude-code", "claude"],
  ["codex", "codex"],
  ["pi", "pi"],
] as const) {
  test(`Given ${binary} missing from PATH, Then install's preview and apply show the same blocked row and apply reports no step of ${host} done`, async () => {
    const w = world([binary]);
    const row = `${host} blocked: ${NOT_ON_PATH(binary)}`;
    const before = snapshot(w.home);

    const preview = await runIn(install, w, [`--hosts=${host}`, "--preview"]);
    expect(preview.code, preview.text).toBe(0);
    expect(preview.text).toContain(row);
    expect(preview.text).toContain("would install nothing: each blocked row above says why");

    const applied = await runIn(install, w, [`--hosts=${host}`, "--yes"]);
    expect(applied.code, applied.text).toBe(1);
    expect(applied.text).toContain(row);
    expect(applied.text).not.toMatch(/Installed|Configured/);
    expect(snapshot(w.home)).toEqual(before);
  });
}

test("Given Workit on Claude Code and claude missing from PATH, Then uninstall's preview shows the not-on-PATH row apply produces, and apply removes nothing of Claude Code", async () => {
  const w = world(["claude"]);
  otherHostsHealthy(w.home);
  const before = snapshot(w.home);

  const preview = await runIn(uninstall, w, ["--hosts=claude-code", "--preview"]);
  expect(preview.code, preview.text).toBe(0);
  expect(preview.text).toContain(
    `claude-code missing-executable claude\n  ${NOT_ON_PATH("claude")}`,
  );
  expect(preview.text).toContain("would remove nothing");

  const applied = await runIn(uninstall, w, ["--hosts=claude-code", "--yes"]);
  expect(applied.code, applied.text).toBe(1);
  expect(applied.text).toContain(`failed claude (${NOT_ON_PATH("claude")}`);
  expect(applied.text).not.toContain("removed ");
  expect(snapshot(w.home)).toEqual(before);
});
