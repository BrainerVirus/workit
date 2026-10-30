import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyUpgrade,
  previewUpgrade,
  runLaunchCommand,
  runUpgradeCommand,
} from "@/packages/workit-cli/src/upgrade";
import { codexInventoryAnswer } from "./codex-fake";
import { createProgress } from "@/packages/workit-cli/src/progress";

const fixture = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-upgrade-"));
  const config = path.join(home, ".config/workit/config.json");
  const host = path.join(home, ".config/opencode/opencode.json");
  mkdirSync(path.dirname(config), { recursive: true });
  mkdirSync(path.dirname(host), { recursive: true });
  writeFileSync(
    config,
    JSON.stringify({
      locale: "en",
      trustedPaths: ["/old"],
      custom: { keep: true },
    }),
  );
  writeFileSync(
    host,
    JSON.stringify({
      plugins: ["@brainervirus/workit-opencode", "unrelated-plugin"],
      permission: { shell: "ask" },
    }),
  );
  const calls: string[][] = [];
  const piSettings = path.join(home, ".pi/agent/settings.json");
  const piRoot = path.join(home, "pi-resolved");
  mkdirSync(path.dirname(piSettings), { recursive: true });
  mkdirSync(piRoot);
  writeFileSync(piSettings, JSON.stringify({ packages: ["npm:@brainervirus/workit-pi"] }));
  writeFileSync(
    path.join(piRoot, "package.json"),
    JSON.stringify({ name: "@brainervirus/workit-pi", version: "2.0.2" }),
  );
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === "npm") return { status: 0, stdout: "2.1.0\n" };
    if (command === "pi" && args[0] === "update")
      writeFileSync(
        path.join(piRoot, "package.json"),
        JSON.stringify({ name: "@brainervirus/workit-pi", version: "2.1.0" }),
      );
    if (command === "pi" && args[0] === "list")
      return { status: 0, stdout: `npm:@brainervirus/workit-pi\n  ${piRoot}\n` };
    return { status: 0, stdout: "" };
  };
  return {
    home,
    config,
    host,
    calls,
    deps: { home, run, activeHosts: () => [] },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
};

test("upgrade previews without writes, applies one scoped native update and preserves unrelated configuration", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.host, "utf8");
    const plan = previewUpgrade(["pi"], f.deps);
    expect(plan.ok).toBe(true);
    expect(f.calls.some((call) => call[0] === "opencode")).toBe(false);
    expect(JSON.parse(readFileSync(f.config, "utf8")).trustedPaths).toEqual(["/old"]);
    expect(plan.entries[0]?.commands).toEqual([
      { command: "pi", args: ["update", "--extension", "npm:@brainervirus/workit-pi"] },
    ]);
    expect((await applyUpgrade(plan, f.deps)).ok).toBe(true);
    expect(readFileSync(f.host, "utf8")).toBe(before);
    const after = JSON.parse(readFileSync(f.config, "utf8"));
    expect(after.trustedPaths).toBeUndefined();
    expect(after.custom).toEqual({ keep: true });
    expect(previewUpgrade(["pi"], f.deps).migrations).toEqual([]);
    expect(previewUpgrade(["pi"], f.deps).entries).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("local and exact pins stay unchanged; stale previews and running hosts block updates", async () => {
  const f = fixture();
  try {
    for (const pin of [
      "file:///checkout/packages/workit-opencode",
      "@brainervirus/workit-opencode@2.0.2",
    ]) {
      writeFileSync(f.host, JSON.stringify({ plugins: [pin] }));
      const plan = previewUpgrade(["opencode"], f.deps);
      expect(plan.entries).toEqual([]);
      expect(plan.skipped).toHaveLength(1);
    }
    writeFileSync(f.host, JSON.stringify({ plugins: ["@brainervirus/workit-opencode"] }));
    const plan = previewUpgrade(["pi"], f.deps);
    const open = await applyUpgrade(plan, {
      ...f.deps,
      processes: () => [{ pid: 42, state: "S+", args: "pi --session" }],
    });
    expect(open.hosts).toContainEqual({
      host: "pi",
      status: "skipped",
      reason: "close pi (pid 42: pi --session), then rerun",
      fix: "workit upgrade --hosts=pi",
    });
    expect(f.calls.some((call) => call[0] === "pi" && call[1] === "update")).toBe(false);
    writeFileSync(
      f.host,
      JSON.stringify({ plugins: ["@brainervirus/workit-opencode"], model: "changed" }),
    );
    expect((await applyUpgrade(plan, f.deps)).error).toContain("configuration changed");
  } finally {
    f.cleanup();
  }
});

test("failed updates stop before launch; offline registry permits unchanged launch; success orders upgrade before launch", async () => {
  const f = fixture();
  try {
    const offline = {
      ...f.deps,
      run: (command: string, args: string[]) =>
        command === "npm" ? { status: 1, stdout: "" } : f.deps.run(command, args),
      out: { write: () => {} },
    };
    expect(await runLaunchCommand(["pi", "--auto-upgrade", "--", "--version"], offline)).toBe(0);
    expect(f.calls.at(-1)).toEqual(["pi", "--version"]);
    f.calls.length = 0;
    const failed = {
      ...f.deps,
      run: (command: string, args: string[]) =>
        args[0] === "update" ? { status: 1, stdout: "" } : f.deps.run(command, args),
      out: { write: () => {} },
    };
    expect(await runLaunchCommand(["pi", "--auto-upgrade"], failed)).toBe(1);
    expect(f.calls.some((call) => call.length === 1 && call[0] === "pi")).toBe(false);
    f.calls.length = 0;
    expect(
      await runLaunchCommand(["pi", "--auto-upgrade", "--", "--version"], {
        ...f.deps,
        out: { write: () => {} },
      }),
    ).toBe(0);
    expect(f.calls.at(-1)).toEqual(["pi", "--version"]);
    expect(f.calls.findIndex((call) => call[1] === "update")).toBeLessThan(f.calls.length - 1);
  } finally {
    f.cleanup();
  }
});

test("upgrade command rejects unreviewed apply and unknown hosts without mutations", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.config, "utf8");
    const deps = { ...f.deps, out: { write: () => {} } };
    expect(await runUpgradeCommand(["--apply"], deps)).toBe(2);
    expect(await runUpgradeCommand(["--hosts=unknown"], deps)).toBe(2);
    expect(readFileSync(f.config, "utf8")).toBe(before);
    expect(f.calls.some((call) => call[2] === "update")).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("Pi verification rejects a source-only listing and requires the resolved package version", async () => {
  const f = fixture();
  try {
    const settings = path.join(f.home, ".pi/agent/settings.json");
    const resolved = path.join(f.home, "pi-package");
    mkdirSync(path.dirname(settings), { recursive: true });
    mkdirSync(resolved);
    writeFileSync(
      settings,
      JSON.stringify({ packages: ["npm:@brainervirus/workit-pi", "npm:other-workit-pi"] }),
    );
    writeFileSync(
      path.join(resolved, "package.json"),
      JSON.stringify({ name: "@brainervirus/workit-pi", version: "2.0.2" }),
    );
    let updated = false;
    const deps = {
      ...f.deps,
      run: (command: string, args: string[]) => {
        if (command !== "pi") return f.deps.run(command, args);
        if (args[0] === "update") {
          updated = true;
          return { status: 0, stdout: "" };
        }
        return {
          status: 0,
          stdout: updated
            ? "npm:@brainervirus/workit-pi"
            : `npm:@brainervirus/workit-pi\n  ${resolved}\n`,
        };
      },
    };
    const plan = previewUpgrade(["pi"], deps);
    expect(plan.entries).toHaveLength(1);
    expect((await applyUpgrade(plan, deps)).error).toContain("package version");
  } finally {
    f.cleanup();
  }
});

test("explicit CLI upgrade changes only an existing global package and verifies its version", async () => {
  const f = fixture();
  try {
    const root = path.join(f.home, "global/node_modules");
    const pkg = path.join(root, "@brainervirus/workit-cli/package.json");
    mkdirSync(path.dirname(pkg), { recursive: true });
    writeFileSync(pkg, JSON.stringify({ name: "@brainervirus/workit-cli", version: "2.0.2" }));
    const deps = {
      ...f.deps,
      out: { write: () => {} },
      run: (command: string, args: string[]) => {
        if (command === "npm" && args[0] === "root") return { status: 0, stdout: root };
        if (command === "npm" && args[0] === "install") {
          expect(args).toEqual(["install", "--global", "@brainervirus/workit-cli@2.1.0"]);
          writeFileSync(
            pkg,
            JSON.stringify({ name: "@brainervirus/workit-cli", version: "2.1.0" }),
          );
          return { status: 0, stdout: "" };
        }
        return f.deps.run(command, args);
      },
    };
    expect(await runUpgradeCommand(["--hosts=none", "--cli", "--apply", "--confirm"], deps)).toBe(
      0,
    );
    expect(JSON.parse(readFileSync(pkg, "utf8")).version).toBe("2.1.0");
    expect(readFileSync(f.host, "utf8")).toContain("unrelated-plugin");
  } finally {
    f.cleanup();
  }
});

test("explicit home isolates inherited config overrides and explicit config roots stay supported", () => {
  const f = fixture();
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG = "/must-not-read/config";
    expect(Object.hasOwn(previewUpgrade(["opencode"], f.deps).configDigests, f.config)).toBe(true);
    const custom = path.join(f.home, "custom-workit");
    mkdirSync(custom);
    writeFileSync(
      path.join(custom, "config.json"),
      JSON.stringify({ locale: "en", timezone: "UTC" }),
    );
    const plan = previewUpgrade([], { ...f.deps, env: { WORKFLOW_TOOLKIT_CONFIG: custom } });
    expect(Object.hasOwn(plan.configDigests, path.join(custom, "config.json"))).toBe(true);
    expect(plan.migrations).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previous;
    f.cleanup();
  }
});

test("Codex current inventory skips updates and other marketplaces remain untouched", () => {
  const f = fixture();
  try {
    const rows = [
      {
        name: "workit",
        marketplaceName: "workflow-toolkit",
        version: "2.1.0",
        source: {
          source: "npm",
          package: "@brainervirus/workit-codex",
          version: "latest",
        },
      },
      {
        name: "workit",
        marketplaceName: "unrelated",
        version: "0.1.0",
        source: { source: "npm", package: "unrelated-workit" },
      },
    ];
    const run = (command: string, args: string[]) =>
      (command === "codex"
        ? codexInventoryAnswer(args, rows, ["workflow-toolkit", "unrelated"])
        : undefined) ?? f.deps.run(command, args);
    const plan = previewUpgrade(["codex"], { ...f.deps, run });
    expect(plan.entries).toEqual([]);
    expect(plan.skipped.map((entry) => entry.reason)).toEqual([
      "already current (2.1.0)",
      "local source preserved; change its source explicitly to upgrade",
    ]);
  } finally {
    f.cleanup();
  }
});

test("env-only HOME isolates inherited roots and Codex inventory failure blocks launch", async () => {
  const f = fixture();
  const saved = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = "/must-not-read";
    const plan = previewUpgrade([], { env: { HOME: f.home }, run: f.deps.run });
    expect(Object.hasOwn(plan.configDigests, f.config)).toBe(true);
    const codexConfig = path.join(f.home, ".codex/config.toml");
    mkdirSync(path.dirname(codexConfig), { recursive: true });
    writeFileSync(codexConfig, "");
    let launched = false;
    const deps = {
      ...f.deps,
      out: { write: () => {} },
      run: (command: string, args: string[]) => {
        if (command === "codex") {
          if (!args.length) launched = true;
          return { status: 1, stdout: "" };
        }
        return f.deps.run(command, args);
      },
    };
    expect(previewUpgrade(["codex"], deps).ok).toBe(false);
    expect(await runLaunchCommand(["codex", "--auto-upgrade"], deps)).toBe(1);
    expect(launched).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    f.cleanup();
  }
});

test("Cursor package drift rejects a reviewed plan before installation", async () => {
  const f = fixture();
  try {
    const pkg = path.join(f.home, ".cursor/plugins/local/workit/package.json");
    mkdirSync(path.dirname(pkg), { recursive: true });
    writeFileSync(pkg, JSON.stringify({ name: "@brainervirus/workit-cursor", version: "2.0.2" }));
    const plan = previewUpgrade([], f.deps);
    writeFileSync(pkg, JSON.stringify({ name: "@brainervirus/workit-cursor", version: "2.0.3" }));
    expect((await applyUpgrade(plan, f.deps)).error).toContain("configuration changed");
  } finally {
    f.cleanup();
  }
});

test("failed global CLI update keeps an executable backup of the previous package", async () => {
  const f = fixture();
  try {
    const root = path.join(f.home, "global/node_modules");
    const pkg = path.join(root, "@brainervirus/workit-cli");
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@brainervirus/workit-cli", version: "2.0.2" }),
    );
    writeFileSync(path.join(pkg, "dist/index.js"), "console.log('old CLI');\n");
    let output = "";
    const deps = {
      ...f.deps,
      out: {
        write: (text: string) => {
          output += text;
        },
      },
      run: (command: string, args: string[]) => {
        if (command === "npm" && args[0] === "root") return { status: 0, stdout: root };
        if (command === "npm" && args[0] === "install") {
          rmSync(pkg, { recursive: true });
          return { status: 1, stdout: "" };
        }
        return f.deps.run(command, args);
      },
    };
    expect(await runUpgradeCommand(["--hosts=none", "--cli", "--apply", "--confirm"], deps)).toBe(
      1,
    );
    const result = JSON.parse(output);
    expect(readFileSync(path.join(result.backup, "cli-package/dist/index.js"), "utf8")).toContain(
      "old CLI",
    );
  } finally {
    f.cleanup();
  }
});

test("OpenCode unsupported scoped update is visible and never falls back to updating every plugin", async () => {
  const f = fixture();
  try {
    const plan = previewUpgrade(["opencode"], f.deps);
    expect(plan.ok).toBe(true);
    expect(plan.entries).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain("no `opencode plugin update`");
    expect(plan.skipped[0]?.fix).toBe("opencode plugin update @brainervirus/workit-opencode");
    let output = "";
    expect(
      await runLaunchCommand(["opencode", "--auto-upgrade", "--", "--version"], {
        ...f.deps,
        out: {
          write: (text) => {
            output += text;
          },
        },
      }),
    ).toBe(0);
    expect(output).toContain("opencode plugin update @brainervirus/workit-opencode");
    // Only probes and the launch itself; never a plugin update.
    const opencodeCalls = f.calls.filter((call) => call[0] === "opencode");
    expect(opencodeCalls.at(-1)).toEqual(["opencode", "--version"]);
    expect(
      opencodeCalls.every((call) =>
        ["opencode --version", "opencode plugin --help"].includes(call.join(" ")),
      ),
    ).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("conflicting Workit registrations stop upgrade without changing either source", async () => {
  const f = fixture();
  try {
    const pins = ["@brainervirus/workit-opencode", "@brainervirus/workit-opencode@2.0.1"];
    writeFileSync(f.host, JSON.stringify({ plugins: pins }));
    const plan = previewUpgrade(["opencode"], f.deps);
    expect(plan.ok).toBe(false);
    expect(plan.failed[0]?.reason).toContain("conflicting Workit registrations");
    expect((await applyUpgrade(plan, f.deps)).ok).toBe(false);
    expect(JSON.parse(readFileSync(f.host, "utf8")).plugins).toEqual(pins);
  } finally {
    f.cleanup();
  }
});

test("upgrade warns before applying when the OpenCode host is 1.x (Workit 3 is V2-only)", async () => {
  const f = fixture();
  try {
    const run = (command: string, args: string[]) =>
      command === "opencode" && args[0] === "--version"
        ? { status: 0, stdout: "1.18.34\n" }
        : f.deps.run(command, args);
    const plan = previewUpgrade(["opencode"], { ...f.deps, run });
    expect(plan.warnings?.[0]).toContain("opencode 1.18.34");
    expect(plan.warnings?.[0]).toContain("upgrade OpenCode");
    expect(plan.warnings?.[0]).not.toContain("workit-opencode@2");
    const out: string[] = [];
    await runUpgradeCommand(["--hosts=opencode", "--apply", "--confirm"], {
      ...f.deps,
      run,
      out: { write: (text: string) => out.push(text) },
    });
    expect(out[0]).toStartWith("warning: opencode 1.18.34");

    const current = (command: string, args: string[]) =>
      command === "opencode"
        ? { status: 0, stdout: "opencode v2.0.21\n" }
        : f.deps.run(command, args);
    expect(previewUpgrade(["opencode"], { ...f.deps, run: current }).warnings).toBeUndefined();
  } finally {
    f.cleanup();
  }
});

test("--preview is the explicit name of the default preview and refuses --apply", async () => {
  const f = fixture();
  try {
    const out: string[] = [];
    const deps = { ...f.deps, out: { write: (text: string) => out.push(text) } };
    expect(await runUpgradeCommand(["--hosts=pi", "--preview"], deps)).toBe(0);
    expect(out.join("")).toContain("pi          update 2.0.2 -> 2.1.0");
    expect(out.join("")).toEndWith(
      "preview only; nothing changed. Apply with: workit upgrade --hosts=pi --yes\n",
    );
    expect(f.calls.some((call) => call[0] === "pi" && call[1] === "update")).toBe(false);
    out.length = 0;
    expect(await runUpgradeCommand(["--preview", "--apply", "--confirm"], deps)).toBe(2);
    expect(await runUpgradeCommand(["--preview", "--yes"], deps)).toBe(2);
    expect(out.join("")).toContain("[--preview | --yes | --apply --confirm]");
  } finally {
    f.cleanup();
  }
});

// The real probe (no injected runner) points OpenCode's XDG data/state/cache
// dirs at a throwaway directory, so a preview never writes OpenCode's log
// into the home it inspects.
test.skipIf(process.platform === "win32")(
  "the opencode version probe never writes into the inspected home",
  () => {
    const f = fixture();
    try {
      const bin = path.join(f.home, "fake-bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        path.join(bin, "opencode"),
        '#!/bin/sh\nmkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/log"\n' +
          'echo probe > "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/log/opencode.log"\n' +
          "echo 1.18.34\n",
        { mode: 0o755 },
      );
      const plan = previewUpgrade(["opencode"], {
        home: f.home,
        env: { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` },
        activeHosts: () => [],
      });
      expect(plan.warnings?.[0]).toContain("opencode 1.18.34");
      expect(existsSync(path.join(f.home, ".local/share/opencode"))).toBe(false);
    } finally {
      f.cleanup();
    }
  },
);

test("upgrade shows a step per host and action on a TTY and nothing for --json or a non-TTY", async () => {
  const stepsFor = async (argv: string[], isTTY: boolean) => {
    const f = fixture();
    try {
      const writes: string[] = [];
      const progress = createProgress({
        stream: { isTTY, write: (text) => writes.push(text) },
        env: { NO_COLOR: "1" },
        json: argv.includes("--json"),
      });
      const out: string[] = [];
      const code = await runUpgradeCommand(argv, {
        ...f.deps,
        progress,
        out: { write: (text) => out.push(text) },
        doctor: () => ({ checks: [] }),
      });
      return { code, writes, out: out.join("") };
    } finally {
      f.cleanup();
    }
  };
  const tty = await stepsFor(["--hosts=pi", "--yes"], true);
  expect(tty.code).toBe(0);
  expect(tty.writes).toEqual([
    "✓ Checking 1 host\n",
    "✓ Updating pi\n",
    "✓ Checking the result with workit doctor\n",
  ]);
  expect(tty.out).toContain("Verified: workit doctor is clean");
  expect((await stepsFor(["--hosts=pi", "--yes"], false)).writes).toEqual([]);
  expect((await stepsFor(["--hosts=pi", "--yes", "--json"], true)).writes).toEqual([]);
});

test("upgrade keeps the spinner ticking while a host command runs asynchronously", async () => {
  const f = fixture();
  try {
    const writes: string[] = [];
    const ticks: (() => void)[] = [];
    const progress = createProgress({
      stream: { isTTY: true, write: (text) => writes.push(text) },
      env: {},
      setInterval: (tick) => ticks.push(tick),
      clearInterval: () => {},
    });
    const sync = f.deps.run;
    let during = 0;
    const code = await runUpgradeCommand(["--hosts=pi", "--yes"], {
      ...f.deps,
      progress,
      out: { write: () => {} },
      doctor: () => ({ checks: [] }),
      runAsync: async (command, args) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const before = writes.length;
        for (const tick of ticks) tick();
        during += writes.length - before;
        return sync(command, args);
      },
    });
    expect(code).toBe(0);
    expect(during).toBeGreaterThan(0);
    expect(writes.some((text) => text.includes("Updating pi (0s)"))).toBe(true);
  } finally {
    f.cleanup();
  }
});
