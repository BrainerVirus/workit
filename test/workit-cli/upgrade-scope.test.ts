// The 14.x bridge (`workit upgrade` moving @brainervirus/workit-* to
// @workit-dev/*): a temp HOME with every host on the old scope, a fake
// registry and fake host CLIs, no real host, process list or ~/.config.
import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { previewUpgrade, runUpgradeCommand } from "@/packages/workit-cli/src/upgrade";
import { codexInventoryAnswer, type CodexRow } from "./codex-fake";

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

const OLD = "14.6.0";
const NEW = "1.0.0";

/** Every host on the old scope at 14.6.0; the registry serves @workit-dev 1.0.0 (or `newCli`). */
const world = (
  options: {
    newCli?: string;
    pathVersion?: (home: string) => string;
    /** Codex recorded an exact version on the old package's source. */
    codexPinned?: boolean;
  } = {},
) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-upgrade-scope-"));
  const calls: string[][] = [];
  const data = path.join(home, ".local/share/workit");
  const versions = path.join(data, "versions");
  // The owned CLI install: current -> versions/14.6.0 (@brainervirus/workit-cli).
  write(path.join(versions, OLD, "node_modules/@brainervirus/workit-cli/package.json"), {
    name: "@brainervirus/workit-cli",
    version: OLD,
  });
  symlinkSync(path.join("versions", OLD), path.join(data, "current"), "dir");
  mkdirSync(path.join(home, "bin"), { recursive: true });
  for (const tool of ["node", "npm"]) {
    const real = Bun.which(tool);
    if (real) symlinkSync(real, path.join(home, "bin", tool));
  }
  write(path.join(home, ".config/workit/config.json"), { locale: "en" });
  // OpenCode: a floating pin beside an unrelated plugin.
  const opencodeConfig = path.join(home, ".config/opencode/opencode.json");
  write(opencodeConfig, {
    $schema: "https://opencode.ai/config.json",
    plugins: ["@brainervirus/workit-opencode@latest", "other-plugin"],
  });
  // Pi: settings source plus the package Pi resolved it to.
  const piSettings = path.join(home, ".pi/agent/settings.json");
  write(piSettings, { packages: ["npm:@brainervirus/workit-pi"], theme: "dark" });
  const piDir = (name: string) => path.join(home, ".pi/agent/npm/node_modules", name);
  write(path.join(piDir("@brainervirus/workit-pi"), "package.json"), {
    name: "@brainervirus/workit-pi",
    version: OLD,
  });
  // Cursor: the managed plugin dir and mcp.json's npx runtime.
  const cursorRoot = path.join(home, ".cursor/plugins/local/workit");
  write(path.join(cursorRoot, "package.json"), {
    name: "@brainervirus/workit-cursor",
    version: OLD,
  });
  const cursorMcp = path.join(home, ".cursor/mcp.json");
  write(cursorMcp, {
    mcpServers: {
      workit: {
        command: "npx",
        args: [
          "-y",
          "--prefer-online",
          "--min-release-age=0",
          "--package=@brainervirus/workit-cursor@latest",
          "workit-cursor-mcp",
          "${workspaceFolder}",
        ],
      },
      other: { command: "other" },
    },
  });
  // Codex: its inventory names the npm source package.
  const codexRows: CodexRow[] = [
    {
      name: "workit",
      marketplaceName: "workit",
      version: OLD,
      source: {
        source: "npm",
        package: "@brainervirus/workit-codex",
        ...(options.codexPinned ? { version: OLD } : {}),
      },
    },
  ];
  // Codex's plugin cache: one directory per version, the old package's 14.6.0 now.
  const codexCache = (version: string, name: string) => {
    const root = path.join(home, ".codex/plugins/cache/workit/workit", version);
    write(path.join(root, "package.json"), { name, version });
    write(path.join(root, "dist/launch-mcp.js"), "");
  };
  codexCache(OLD, "@brainervirus/workit-codex");
  // Claude Code: installed_plugins.json and the cached package.
  const claudeCache = (version: string) =>
    path.join(home, ".claude/plugins/cache/workit/workit", version);
  const claudeInstall = (version: string, name: string) => {
    write(path.join(claudeCache(version), ".claude-plugin/plugin.json"), {
      name: "workit",
      repository: "https://github.com/BrainerVirus/workit",
    });
    write(path.join(claudeCache(version), "package.json"), { name, version });
    write(path.join(home, ".claude/plugins/installed_plugins.json"), {
      version: 2,
      plugins: {
        "workit@workit": [{ installPath: claudeCache(version), version, scope: "user" }],
      },
    });
  };
  claudeInstall(OLD, "@brainervirus/workit-claude-code");
  const state = { currentAtVerify: "" };
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const line = args.join(" ");
    if (command === "npm" && args[0] === "view") {
      if (args[1] === "@workit-dev/cli") return { status: 0, stdout: `${options.newCli ?? NEW}\n` };
      return { status: 0, stdout: `${args[1].startsWith("@workit-dev/") ? NEW : OLD}\n` };
    }
    // The owned CLI install and Cursor's staged adapter: `npm install --prefix <dir> <pkg>@<v>`.
    if (args.includes("install") && args.includes("--prefix")) {
      const prefix = args[args.indexOf("--prefix") + 1];
      const spec = args.at(-1)!;
      const name = spec.slice(0, spec.lastIndexOf("@"));
      const version = spec.slice(spec.lastIndexOf("@") + 1);
      write(path.join(prefix, "node_modules", name, "package.json"), { name, version });
      write(path.join(prefix, "node_modules", name, "dist/index.js"), "");
      return { status: 0, stdout: "" };
    }
    // The staged new CLI proves it runs before `current` moves.
    if (command === "node24" && args.at(-1) === "--version") {
      state.currentAtVerify = readlinkSync(path.join(data, "current"));
      return { status: 0, stdout: `${NEW}\n` };
    }
    if (command === "pi" && args[0] === "list") {
      const sources: string[] = json(piSettings).packages;
      return {
        status: 0,
        stdout: sources
          .map((source) => `${source}\n  ${piDir(source.replace(/^npm:/, ""))}`)
          .join("\n"),
      };
    }
    if (command === "pi" && args[0] === "install") {
      const name = args[1].replace(/^npm:/, "");
      write(path.join(piDir(name), "package.json"), { name, version: NEW });
      const settings = json(piSettings);
      write(piSettings, { ...settings, packages: [...settings.packages, args[1]] });
    }
    if (command === "pi" && args[0] === "remove") {
      const settings = json(piSettings);
      write(piSettings, {
        ...settings,
        packages: settings.packages.filter((one: string) => one !== args[1]),
      });
    }
    if (command === "codex") {
      const answer = codexInventoryAnswer(args, codexRows);
      if (answer) return answer;
      if (line === "plugin remove workit@workit") codexRows.length = 0;
      if (line === "plugin add workit@workit --json") codexCache(NEW, "@workit-dev/codex");
      if (line === "plugin add workit@workit --json")
        codexRows.push({
          name: "workit",
          marketplaceName: "workit",
          version: NEW,
          source: { source: "npm", package: "@workit-dev/codex" },
        });
    }
    // Claude Code keeps 14.6.0 on `plugin update` (it reads 1.0.0 as older);
    // an install from the refreshed marketplace gets the new package.
    if (command === "claude" && line === "plugin install workit@workit --scope user")
      claudeInstall(NEW, "@workit-dev/claude-code");
    if (command === "opencode" && args[0] === "api")
      return { status: 1, stdout: "", stderr: 'Error: unknown command "api"\n' };
    if (command === "opencode" && line === "plugin list")
      return {
        status: 0,
        stdout: `ID      VERSION  SOURCE\nworkit  ${OLD}   @brainervirus/workit-opencode\n`,
      };
    return { status: 0, stdout: "" };
  };
  const out: string[] = [];
  const launcher = path.join(data, "bin/workit");
  const files = [
    opencodeConfig,
    piSettings,
    cursorMcp,
    path.join(cursorRoot, "package.json"),
    path.join(home, ".claude/plugins/installed_plugins.json"),
    launcher,
  ];
  return {
    home,
    data,
    versions,
    calls,
    state,
    opencodeConfig,
    piSettings,
    cursorRoot,
    cursorMcp,
    codexRows,
    launcher,
    text: () => out.join(""),
    clear: () => {
      out.length = 0;
      calls.length = 0;
    },
    snapshot: () =>
      files.map((file) =>
        existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "-",
      ),
    deps: {
      home,
      run,
      processes: () => [],
      confirm: async () => true,
      doctor: () => ({ checks: [] }),
      out: { write: (text: string) => void out.push(text) },
      env: { PATH: path.join(home, "bin") },
      // Not inside the owned install: the run may remove every old version.
      cliEntry: path.join(home, "elsewhere/dist/index.js"),
      installNode: () => ({ node: "node24", npmCli: "npm-cli.js", version: "24.0.0" }),
      pathWorkit: () => ({
        path: path.join(home, ".local/bin/workit"),
        version: options.pathVersion?.(home) ?? NEW,
      }),
      removeCopies: async () => false,
      reexec: () => {
        throw new Error("the scope move finishes in the bridge, never in the new CLI");
      },
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
};

const ran = (calls: string[][], line: string) => calls.some((call) => call.join(" ") === line);
/** A command that changes an install (not a read like `pi list` or `npm view`). */
const mutating = (call: string[]) =>
  /\b(install|update|upgrade|remove|uninstall|add)\b/.test(call.slice(1, 4).join(" ")) &&
  !call.includes("list");

test("Given every host on @brainervirus 14.x and @workit-dev 1.0.0 released, When upgrade previews, Then a 'migrate scope' row names each move by package and nothing changes", async () => {
  const w = world();
  try {
    const before = w.snapshot();
    expect(await runUpgradeCommand(["--preview"], w.deps)).toBe(0);
    const text = w.text();
    expect(text).toContain("migrate scope @brainervirus/workit-* -> @workit-dev/* 1.0.0");
    expect(text).toContain(
      "cli         move @brainervirus/workit-cli 14.6.0 -> @workit-dev/cli 1.0.0",
    );
    expect(text).toContain(
      "opencode    move @brainervirus/workit-opencode -> @workit-dev/opencode@latest 1.0.0",
    );
    expect(text).toContain(
      "pi          move npm:@brainervirus/workit-pi -> npm:@workit-dev/pi 1.0.0",
    );
    expect(text).toContain(
      "cursor      move @brainervirus/workit-cursor -> @workit-dev/cursor 1.0.0",
    );
    expect(text).toContain(
      "codex       move @brainervirus/workit-codex -> @workit-dev/codex 1.0.0",
    );
    expect(text).toContain("claude-code move workit@workit -> @workit-dev/claude-code 1.0.0");
    expect(w.snapshot()).toEqual(before);
    expect(w.calls.some(mutating)).toBe(false);
  } finally {
    w.cleanup();
  }
});

test("Given every host on @brainervirus 14.x, When `workit upgrade --apply --confirm` runs, Then every host names @workit-dev, unrelated config stays, and the old CLI goes only after the new one ran", async () => {
  const w = world();
  try {
    const code = await runUpgradeCommand(["--apply", "--confirm"], w.deps);
    const report = JSON.parse(w.text());
    expect(code, w.text()).toBe(0);
    const row = (host: string) => report.hosts.find((one: { host: string }) => one.host === host);
    for (const host of ["cli", "opencode", "pi", "cursor", "codex", "claude-code"])
      expect(row(host)?.status, JSON.stringify(row(host))).toBe("updated");
    expect(row("cli").reason).toBe("@brainervirus/workit-cli 14.6.0 -> @workit-dev/cli 1.0.0");
    // CLI: the staged @workit-dev/cli ran while current was still 14.6.0; then current moved,
    // the launcher runs the new package, and the old version is gone.
    expect(w.state.currentAtVerify).toBe(path.join("versions", OLD));
    expect(readlinkSync(path.join(w.data, "current"))).toBe(path.join("versions", NEW));
    expect(json(path.join(w.versions, NEW, "node_modules/@workit-dev/cli/package.json")).name).toBe(
      "@workit-dev/cli",
    );
    expect(readFileSync(w.launcher, "utf8")).toContain(
      "node_modules/@workit-dev/cli/dist/index.js",
    );
    expect(existsSync(path.join(w.versions, OLD))).toBe(false);
    // OpenCode: the pin moved, the other plugin and keys stayed.
    expect(json(w.opencodeConfig)).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugins: ["@workit-dev/opencode@latest", "other-plugin"],
    });
    // Pi: the new package was installed before the old one was removed.
    const piInstall = w.calls.findIndex(
      (call) => call.join(" ") === "pi install npm:@workit-dev/pi",
    );
    const piRemove = w.calls.findIndex(
      (call) => call.join(" ") === "pi remove npm:@brainervirus/workit-pi",
    );
    expect(piInstall).toBeGreaterThan(-1);
    expect(piRemove).toBeGreaterThan(piInstall);
    expect(json(w.piSettings)).toEqual({ packages: ["npm:@workit-dev/pi"], theme: "dark" });
    // Cursor: the new adapter in the plugin dir, mcp.json's runtime on the new package.
    expect(json(path.join(w.cursorRoot, "package.json"))).toEqual({
      name: "@workit-dev/cursor",
      version: NEW,
    });
    const mcp = json(w.cursorMcp);
    expect(mcp.mcpServers.workit.args).toContain("--package=@workit-dev/cursor@latest");
    expect(mcp.mcpServers.other).toEqual({ command: "other" });
    // Codex: reinstalled from the refreshed marketplace; its inventory names the new package.
    expect(ran(w.calls, "codex plugin marketplace upgrade workit")).toBe(true);
    expect(w.codexRows.map((one) => (one.source as { package: string }).package)).toEqual([
      "@workit-dev/codex",
    ]);
    // Codex's cache keeps only the new package: by number 14.6.0 would win over 1.0.0.
    const codexCacheDir = path.join(w.home, ".codex/plugins/cache/workit/workit");
    expect(existsSync(path.join(codexCacheDir, OLD))).toBe(false);
    expect(existsSync(path.join(codexCacheDir, NEW))).toBe(true);
    expect(
      ran(w.calls, `node ${path.join(codexCacheDir, NEW, "dist/launch-mcp.js")} --install-agents`),
    ).toBe(true);
    // Cursor staged the package where the new CLI's installer looks for it.
    expect(
      json(
        path.join(
          w.home,
          ".cursor/plugins/local/.workit-package-bootstrap/node_modules/@workit-dev/cursor/package.json",
        ),
      ).name,
    ).toBe("@workit-dev/cursor");
    // Claude Code: `plugin update` kept 14.6.0, so it was reinstalled from the marketplace.
    expect(ran(w.calls, "claude plugin update workit@workit")).toBe(true);
    expect(ran(w.calls, "claude plugin uninstall workit@workit")).toBe(true);
    const claude = json(path.join(w.home, ".claude/plugins/installed_plugins.json"));
    expect(claude.plugins["workit@workit"][0].version).toBe(NEW);
    // Nothing on the old scope is left for the doctor's old_scope row.
    const check = runDoctor({ home: w.home, env: { ...w.deps.env, HOME: w.home } }).checks.find(
      (one) => one.id === "old_scope",
    );
    expect(check?.status).toBe("pass");
  } finally {
    w.cleanup();
  }
});

test("Given a migrated home, When `workit upgrade --yes` runs again, Then it changes nothing and every row is already current", async () => {
  const w = world();
  try {
    expect(await runUpgradeCommand(["--yes"], w.deps)).toBe(0);
    const after = w.snapshot();
    w.clear();
    expect(await runUpgradeCommand(["--yes"], w.deps), w.text()).toBe(0);
    expect(w.snapshot()).toEqual(after);
    expect(w.calls.filter(mutating)).toEqual([]);
    const text = w.text();
    expect(text).not.toContain("migrate scope");
    for (const host of ["cli", "opencode", "pi", "cursor", "codex", "claude-code"])
      expect(text).toMatch(new RegExp(`${host} +already current +\\(?on @workit-dev/`));
  } finally {
    w.cleanup();
  }
});

test("Given @workit-dev/cli latest is the 0.0.1 placeholder, When upgrade plans, Then it refuses to move and says the new scope is not released yet", () => {
  const w = world({ newCli: "0.0.1" });
  try {
    const plan = previewUpgrade(undefined, w.deps);
    expect(plan.scope).toBeUndefined();
    expect(plan.entries.some((entry) => entry.scope)).toBe(false);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({
        host: "migrate scope",
        reason: expect.stringContaining(
          "the new scope is not released yet (@workit-dev/cli latest is 0.0.1, below 1.0.0)",
        ),
      }),
    );
  } finally {
    w.cleanup();
  }
});

test("Given the moved CLI does not run through PATH's owned launcher, When the CLI step applies, Then current goes back to 14.6.0 and the old install stays", async () => {
  const w = world({ pathVersion: () => "" });
  try {
    const deps = {
      ...w.deps,
      pathWorkit: () => ({
        path: path.join(w.data, "bin/workit"),
        version: null,
        error: "exit 1",
      }),
    };
    expect(await runUpgradeCommand(["--hosts=none", "--cli", "--yes"], deps)).toBe(1);
    expect(w.text()).toMatch(/cli +FAILED +@workit-dev\/cli 1\.0\.0 did not run through PATH/);
    expect(readlinkSync(path.join(w.data, "current"))).toBe(path.join("versions", OLD));
    expect(lstatSync(path.join(w.versions, OLD)).isDirectory()).toBe(true);
    expect(readFileSync(w.launcher, "utf8")).toContain(
      "node_modules/@brainervirus/workit-cli/dist/index.js",
    );
  } finally {
    w.cleanup();
  }
});

test("Given installs on the old scope, Then doctor's old_scope row warns with the bridge command", () => {
  const w = world();
  try {
    const check = runDoctor({ home: w.home, env: { ...w.deps.env, HOME: w.home } }).checks.find(
      (one) => one.id === "old_scope",
    );
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("cli 14.6.0");
    expect(check?.detail).toContain("opencode @brainervirus/workit-opencode@latest");
    expect(check?.detail).toContain("pi npm:@brainervirus/workit-pi");
    expect(check?.fix).toBe("npx -y @brainervirus/workit-cli@latest upgrade --yes");
  } finally {
    w.cleanup();
  }
});

test("Given a 14.x CLI run through npx (the new CLI's doctor fix), When `upgrade` is confirmed once, Then every host and the CLI move in that one invocation", async () => {
  const w = world();
  try {
    let asked = 0;
    const code = await runUpgradeCommand([], {
      ...w.deps,
      cliEntry: path.join(
        w.home,
        ".npm/_npx/0a1b/node_modules/@brainervirus/workit-cli/dist/index.js",
      ),
      confirm: async () => {
        asked++;
        return true;
      },
    });
    expect(code, w.text()).toBe(0);
    expect(asked).toBe(1);
    for (const host of ["cli", "opencode", "pi", "cursor", "codex", "claude-code"])
      expect(w.text()).toMatch(new RegExp(`\\n  ${host} +updated +.*@workit-dev/`));
  } finally {
    w.cleanup();
  }
});

test("Given Codex recorded an exact version on @brainervirus/workit-codex, When upgrade plans, Then the Codex install is moved, not kept as a pin or a local source", () => {
  const w = world({ codexPinned: true });
  try {
    const plan = previewUpgrade(["codex"], w.deps);
    expect(plan.entries).toContainEqual(
      expect.objectContaining({
        host: "codex",
        scope: { from: "@brainervirus/workit-codex", to: "@workit-dev/codex" },
      }),
    );
    expect(plan.skipped.filter((row) => row.host === "codex")).toEqual([]);
  } finally {
    w.cleanup();
  }
});
