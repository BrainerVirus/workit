// `workit upgrade` as one command (#484): every host through injected deps,
// a temp HOME, no real host, process list, registry or ~/.config.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyUpgrade,
  classifyProcess,
  previewUpgrade,
  runUpgradeCommand,
  type HostProcess,
} from "@/packages/workit-cli/src/upgrade";

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};

/** A home with Pi, Codex, Claude Code and a global CLI, all one version behind. */
const world = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-upgrade-hosts-"));
  const calls: string[][] = [];
  const piRoot = path.join(home, "pi-resolved");
  const globalRoot = path.join(home, "global/node_modules");
  const cliPkg = path.join(globalRoot, "@brainervirus/workit-cli/package.json");
  const claudePlugin = path.join(home, ".claude/plugins/cache/workit/workit/1.0.0");
  const codexCache = path.join(home, ".codex/plugins/cache/workflow-toolkit/workit");
  write(path.join(home, ".config/workit/config.json"), { locale: "en" });
  write(path.join(home, ".pi/agent/settings.json"), {
    packages: ["npm:@brainervirus/workit-pi"],
  });
  write(path.join(piRoot, "package.json"), {
    name: "@brainervirus/workit-pi",
    version: "1.0.0",
  });
  write(cliPkg, { name: "@brainervirus/workit-cli", version: "1.0.0" });
  write(path.join(claudePlugin, ".claude-plugin/plugin.json"), {
    name: "workit",
    repository: "https://github.com/BrainerVirus/workit",
  });
  const claudeRegistry = (version: string) =>
    write(path.join(home, ".claude/plugins/installed_plugins.json"), {
      version: 2,
      plugins: {
        "workit@workit": [{ installPath: claudePlugin, version, scope: "user" }],
      },
    });
  claudeRegistry("1.0.0");
  write(path.join(codexCache, "2.0.0/dist/launch-mcp.js"), "");
  let codexVersion = "1.0.0";
  const state = {
    codexFails: false,
    agentsThrow: false,
    daemon: [] as string[],
  };
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const line = args.join(" ");
    if (command === "npm" && args[0] === "root") return { status: 0, stdout: globalRoot };
    if (command === "npm" && args[0] === "view") return { status: 0, stdout: "2.0.0\n" };
    if (command === "npm" && args[0] === "install") {
      write(cliPkg, { name: "@brainervirus/workit-cli", version: "2.0.0" });
      return { status: 0, stdout: "" };
    }
    if (command === "pi" && args[0] === "update")
      write(path.join(piRoot, "package.json"), {
        name: "@brainervirus/workit-pi",
        version: "2.0.0",
      });
    if (command === "pi" && args[0] === "list")
      return {
        status: 0,
        stdout: `npm:@brainervirus/workit-pi\n  ${piRoot}\n`,
      };
    if (command === "codex" && line === "plugin list --json")
      return {
        status: 0,
        stdout: JSON.stringify({
          installed: [
            {
              name: "workit",
              marketplaceName: "workflow-toolkit",
              version: codexVersion,
              source: { source: "npm", package: "@brainervirus/workit-codex" },
            },
          ],
        }),
      };
    if (command === "codex" && args[0] === "plugin" && args[1] === "add") {
      if (state.codexFails) return { status: 1, stdout: "" };
      codexVersion = "2.0.0";
    }
    if (command === "node" && args.at(-1) === "--install-agents" && state.agentsThrow)
      throw new Error("spawn node ENOENT");
    if (command === "codex" && args[0] === "app-server") state.daemon.push(args[2]);
    if (command === "claude" && args[1] === "update") claudeRegistry("2.0.0");
    return { status: 0, stdout: "" };
  };
  const out: string[] = [];
  return {
    home,
    calls,
    state,
    out,
    text: () => out.join(""),
    deps: {
      home,
      run,
      processes: (): HostProcess[] => [],
      confirm: async () => true,
      doctor: () => ({ checks: [] }),
      out: { write: (text: string) => void out.push(text) },
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
};

const ran = (calls: string[][], line: string) => calls.some((call) => call.join(" ") === line);

test("Given a plain `workit upgrade`, When it is confirmed once, Then the CLI, Claude Code, Codex and Pi are updated and the run ends doctor-verified", async () => {
  const w = world();
  try {
    let asked = 0;
    const code = await runUpgradeCommand([], {
      ...w.deps,
      confirm: async () => {
        asked++;
        return true;
      },
    });
    expect(code, w.text()).toBe(0);
    expect(asked).toBe(1);
    const text = w.text();
    expect(text).toContain("Workit upgrade plan:");
    expect(text).toContain("cli         update 1.0.0 -> 2.0.0");
    expect(ran(w.calls, "npm install --global @brainervirus/workit-cli@2.0.0")).toBe(true);
    expect(ran(w.calls, "claude plugin marketplace update workit")).toBe(true);
    expect(ran(w.calls, "claude plugin update workit@workit")).toBe(true);
    expect(ran(w.calls, "codex plugin add workit@workflow-toolkit --json")).toBe(true);
    expect(ran(w.calls, "pi update --extension npm:@brainervirus/workit-pi")).toBe(true);
    // Codex agents are refreshed from the cached plugin's launcher.
    expect(w.calls.some((call) => call[0] === "node" && call.at(-1) === "--install-agents")).toBe(
      true,
    );
    expect(text).toMatch(/claude-code +updated +1\.0\.0 -> 2\.0\.0/);
    expect(text).toMatch(/codex +updated +1\.0\.0 -> 2\.0\.0; agents refreshed/);
    expect(text).toMatch(/cli +updated +1\.0\.0 -> 2\.0\.0/);
    expect(text).toContain("Verified: workit doctor is clean");
  } finally {
    w.cleanup();
  }
});

test("Given a declined confirmation or --preview, Then nothing changes and the apply command is printed", async () => {
  const w = world();
  try {
    expect(await runUpgradeCommand([], { ...w.deps, confirm: async () => false })).toBe(0);
    expect(w.text()).toEndWith("preview only; nothing changed. Apply with: workit upgrade --yes\n");
    w.out.length = 0;
    let asked = false;
    expect(
      await runUpgradeCommand(["--preview"], {
        ...w.deps,
        confirm: async () => (asked = true),
      }),
    ).toBe(0);
    expect(asked).toBe(false);
    expect(w.text()).toEndWith("preview only; nothing changed. Apply with: workit upgrade --yes\n");
    expect(w.calls.some((call) => ["install", "update", "add"].includes(call[1] ?? call[0]))).toBe(
      false,
    );
    expect(
      JSON.parse(
        readFileSync(
          path.join(w.home, "global/node_modules/@brainervirus/workit-cli/package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("1.0.0");
  } finally {
    w.cleanup();
  }
});

test("Given --yes, Then it applies without asking; --apply --confirm stays the JSON alias", async () => {
  const w = world();
  try {
    const never = async () => {
      throw new Error("must not ask");
    };
    expect(
      await runUpgradeCommand(["--hosts=pi", "--yes"], {
        ...w.deps,
        confirm: never,
      }),
    ).toBe(0);
    expect(w.text()).toMatch(/pi +updated +1\.0\.0 -> 2\.0\.0/);
    // --hosts narrows the run: the CLI is only included by default or with --cli.
    expect(w.calls.some((call) => call[0] === "npm" && call[1] === "install")).toBe(false);
    w.out.length = 0;
    expect(
      await runUpgradeCommand(["--hosts=none", "--cli", "--apply", "--confirm"], {
        ...w.deps,
        confirm: never,
      }),
    ).toBe(0);
    const report = JSON.parse(w.text());
    expect(report.hosts).toContainEqual({
      host: "cli",
      status: "updated",
      reason: "1.0.0 -> 2.0.0",
    });
    expect(report.doctor).toEqual({ clean: true, left: [] });
  } finally {
    w.cleanup();
  }
});

test("Given one host fails, Then the others and the CLI still upgrade, the table names the fix, and the exit code is 1", async () => {
  const w = world();
  try {
    w.state.codexFails = true;
    expect(await runUpgradeCommand(["--yes"], w.deps)).toBe(1);
    const text = w.text();
    expect(text).toMatch(/codex +FAILED +`codex plugin add workit@workflow-toolkit --json` failed/);
    expect(text).toContain(
      "fix: codex plugin marketplace upgrade workflow-toolkit && codex plugin add workit@workflow-toolkit",
    );
    expect(text).toMatch(/pi +updated/);
    expect(text).toMatch(/claude-code +updated/);
    expect(text).toMatch(/cli +updated/);
  } finally {
    w.cleanup();
  }
});

test("Given zombies and Codex's pid-update-loop watcher, Then neither counts as a running host", () => {
  expect(classifyProcess({ pid: 1, state: "Zs", args: "[codex] <defunct>" })).toBeNull();
  expect(
    classifyProcess({
      pid: 2,
      state: "Ssl",
      args: "/usr/lib/codex/codex app-server daemon pid-update-loop",
    }),
  ).toBeNull();
  expect(
    classifyProcess({
      pid: 3,
      state: "Ssl",
      args: "/opt/codex/codex app-server",
    }),
  ).toEqual(expect.objectContaining({ host: "codex", kind: "daemon" }));
  expect(classifyProcess({ pid: 4, state: "S+", args: "codex --model x" })).toEqual(
    expect.objectContaining({ host: "codex", kind: "session" }),
  );
  expect(classifyProcess({ pid: 5, state: "S", args: "opencode serve --service" })).toEqual(
    expect.objectContaining({ host: "opencode", kind: "daemon" }),
  );
  expect(classifyProcess({ pid: 6, state: "S", args: "/usr/bin/vim codex.ts" })).toBeNull();
});

test("Given Codex's app-server daemon is running, Then it is stopped, Codex updates, and the daemon is started again", async () => {
  const w = world();
  try {
    const processes = () => [
      { pid: 10, state: "Zs", args: "[codex] <defunct>" },
      {
        pid: 11,
        state: "Ssl",
        args: "codex app-server daemon pid-update-loop",
      },
      { pid: 12, state: "Ssl", args: "codex app-server" },
    ];
    expect(
      await runUpgradeCommand(["--hosts=codex", "--yes"], {
        ...w.deps,
        processes,
      }),
    ).toBe(0);
    expect(w.state.daemon).toEqual(["stop", "start"]);
    const stop = w.calls.findIndex((call) => call.join(" ") === "codex app-server daemon stop");
    const add = w.calls.findIndex((call) => call[1] === "plugin" || call[2] === "add");
    expect(stop).toBeLessThan(
      w.calls.findIndex((call) => call.join(" ") === "codex app-server daemon start"),
    );
    expect(add).toBeGreaterThan(-1);
    expect(w.text()).toContain("app-server daemon stopped and started again");
  } finally {
    w.cleanup();
  }
});

test("Given Codex fails while its daemon is stopped, Then the daemon is still started again", () => {
  const w = world();
  try {
    w.state.codexFails = true;
    const plan = previewUpgrade(["codex"], w.deps);
    const result = applyUpgrade(plan, {
      ...w.deps,
      processes: () => [{ pid: 12, state: "Ssl", args: "codex app-server" }],
    });
    expect(w.state.daemon).toEqual(["stop", "start"]);
    expect(result.ok).toBe(false);
  } finally {
    w.cleanup();
  }
});

test("Given the Codex agent refresh throws while its daemon is stopped, Then the daemon is still started and only Codex fails", () => {
  const w = world();
  try {
    w.state.agentsThrow = true;
    const plan = previewUpgrade(["codex"], w.deps);
    const result = applyUpgrade(plan, {
      ...w.deps,
      processes: () => [{ pid: 12, state: "Ssl", args: "codex app-server" }],
    });
    expect(w.state.daemon).toEqual(["stop", "start"]);
    expect(result.hosts.find((entry) => entry.host === "codex")).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("spawn node ENOENT"),
    });
  } finally {
    w.cleanup();
  }
});

test("Given an interactive Codex session, Then only Codex is skipped, naming host, pid and command line", async () => {
  const w = world();
  try {
    const processes = () => [{ pid: 4242, state: "S+", args: "codex --model gpt" }];
    expect(
      await runUpgradeCommand(["--hosts=codex,pi", "--yes"], {
        ...w.deps,
        processes,
      }),
    ).toBe(0);
    const text = w.text();
    expect(text).toMatch(/codex +skipped +close codex \(pid 4242: codex --model gpt\), then rerun/);
    expect(text).toMatch(/pi +updated/);
    expect(w.calls.some((call) => call[0] === "codex" && call[2] === "add")).toBe(false);
  } finally {
    w.cleanup();
  }
});

test("Given OpenCode with `opencode plugin update`, Then upgrade runs the scoped update and never blocks on a running OpenCode", async () => {
  const w = world();
  try {
    write(path.join(w.home, ".config/opencode/opencode.json"), {
      plugins: ["@brainervirus/workit-opencode", "unrelated-plugin"],
    });
    const run = (command: string, args: string[]) => {
      if (command === "opencode" && args.join(" ") === "plugin --help") {
        w.calls.push([command, ...args]);
        return {
          status: 0,
          stdout: "Commands:\n  opencode plugin check\n  opencode plugin update <name>\n",
        };
      }
      return w.deps.run(command, args);
    };
    const processes = () => [{ pid: 77, state: "S", args: "opencode serve --service" }];
    expect(
      await runUpgradeCommand(["--hosts=opencode", "--yes"], {
        ...w.deps,
        run,
        processes,
      }),
    ).toBe(0);
    expect(ran(w.calls, "opencode plugin update @brainervirus/workit-opencode")).toBe(true);
    expect(
      w.calls.some((call) => call[0] === "opencode" && call[2] === "update" && call.length === 3),
    ).toBe(false);
    expect(w.text()).toMatch(
      /opencode +updated +scoped update ran; OpenCode V2 loads it live; restart opencode serve \(pid 77/,
    );
  } finally {
    w.cleanup();
  }
});

test("Given Cursor registered in mcp.json with its plugin dir missing, Then upgrade reinstalls it with the wizard's installer and leaves other config alone", async () => {
  const w = world();
  try {
    const mcp = {
      mcpServers: {
        workit: {
          command: "npx",
          args: ["--package=@brainervirus/workit-cursor", "workit-mcp"],
        },
        other: { command: "other" },
      },
    };
    write(path.join(w.home, ".cursor/mcp.json"), mcp);
    const workspaces = path.join(w.home, ".config/workit/workspaces.json");
    write(workspaces, { version: 1, workspaces: [] });
    const before = readFileSync(workspaces, "utf8");
    const plan = previewUpgrade(["cursor"], w.deps);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toEqual(
      expect.objectContaining({
        host: "cursor",
        repair: true,
        latest: "2.0.0",
      }),
    );
    const install = plan.entries[0].commands.find((command) => command.args.includes("--prefix"));
    expect(install?.args.at(-1)).toBe("@brainervirus/workit-cursor@2.0.0");
    const run = (command: string, args: string[]) => {
      const prefix = args.indexOf("--prefix");
      if (prefix >= 0) {
        w.calls.push([command, ...args]);
        const root = path.join(args[prefix + 1], "node_modules/@brainervirus/workit-cursor");
        write(path.join(root, "package.json"), {
          name: "@brainervirus/workit-cursor",
          version: "2.0.0",
        });
        write(path.join(root, ".cursor-plugin/plugin.json"), {
          name: "workit",
        });
        return { status: 0, stdout: "" };
      }
      return w.deps.run(command, args);
    };
    const result = applyUpgrade(plan, { ...w.deps, run });
    const cursor = result.hosts.find((entry) => entry.host === "cursor");
    // The wizard's installer ran: the plugin dir is back with the requested version.
    expect(
      JSON.parse(
        readFileSync(path.join(w.home, ".cursor/plugins/local/workit/package.json"), "utf8"),
      ).version,
    ).toBe("2.0.0");
    // Setup's own post-install doctor refuses this synthetic package (no skills,
    // no launcher), and upgrade reports that as Cursor's failure only.
    expect(cursor).toEqual(
      expect.objectContaining({
        status: "failed",
        fix: "workit upgrade --hosts=cursor",
      }),
    );
    expect(w.calls.some((call) => call.includes("--prefix"))).toBe(true);
    expect(readFileSync(workspaces, "utf8")).toBe(before);
    expect(
      JSON.parse(readFileSync(path.join(w.home, ".cursor/mcp.json"), "utf8")).mcpServers.other,
    ).toEqual({ command: "other" });
    expect(existsSync(path.join(w.home, ".config/workit/config.json"))).toBe(true);
  } finally {
    w.cleanup();
  }
});

test("Given doctor still finds an upgrade-fixable row, Then the run prints what is left with doctor's fix", async () => {
  const w = world();
  try {
    const doctor = () => ({
      checks: [
        { id: "versions" as const, status: "pass" as const, detail: "ok" },
        {
          id: "codex_agents" as const,
          status: "warn" as const,
          detail: "workit-reviewer.toml outdated",
          fix: "node launch-mcp.js --install-agents",
        },
      ],
    });
    expect(await runUpgradeCommand(["--hosts=pi", "--yes"], { ...w.deps, doctor })).toBe(0);
    expect(w.text()).toContain(
      "Left after upgrade (workit doctor):\n  codex_agents: workit-reviewer.toml outdated\n    fix: node launch-mcp.js --install-agents\n",
    );
  } finally {
    w.cleanup();
  }
});

const OPENCODE_HELP = "Commands:\n  opencode plugin check\n  opencode plugin update <name>\n";

const opencodeWorld = (versions: { before: string; after: string }, extraRow = false) => {
  const w = world();
  write(path.join(w.home, ".config/opencode/opencode.json"), {
    plugins: ["@brainervirus/workit-opencode"],
  });
  let updated = false;
  const run = (command: string, args: string[]) => {
    const line = args.join(" ");
    if (command === "opencode" && line === "plugin --help") {
      w.calls.push([command, ...args]);
      return { status: 0, stdout: OPENCODE_HELP };
    }
    if (command === "opencode" && line === "plugin list") {
      w.calls.push([command, ...args]);
      const version = updated ? versions.after : versions.before;
      return {
        status: 0,
        stdout: `ID           VERSION  SOURCE\n${
          extraRow ? "commandcode  0.12.17  @brainervirus/opencode-commandcode\n" : ""
        }workit       ${version}   @brainervirus/workit-opencode\n`,
      };
    }
    if (command === "opencode" && args[1] === "update") updated = true;
    return w.deps.run(command, args);
  };
  return { w, run };
};

test("Given OpenCode whose version moved, When upgrade runs, Then the row says updated with both versions", async () => {
  const { w, run } = opencodeWorld({ before: "1.0.0", after: "2.0.0" });
  try {
    expect(
      await runUpgradeCommand(["--hosts=opencode", "--yes"], {
        ...w.deps,
        run,
      }),
    ).toBe(0);
    expect(w.text()).toMatch(/opencode +updated +1\.0\.0 -> 2\.0\.0; OpenCode V2 loads it live/);
  } finally {
    w.cleanup();
  }
});

test("Given OpenCode already at the newest version, When upgrade runs, Then the row says already current, not updated", async () => {
  const { w, run } = opencodeWorld({ before: "2.0.0", after: "2.0.0" });
  try {
    expect(
      await runUpgradeCommand(["--hosts=opencode", "--yes"], {
        ...w.deps,
        run,
      }),
    ).toBe(0);
    expect(w.text()).toMatch(/opencode +already current +already current \(2\.0\.0\)/);
    expect(w.text()).not.toMatch(/opencode +updated/);
  } finally {
    w.cleanup();
  }
});

test("Given Codex registered in config.toml with its plugin cache missing, When upgrade runs, Then Codex's own add command reinstalls it", async () => {
  const w = world();
  try {
    write(
      path.join(w.home, ".codex/config.toml"),
      '[plugins."workit@workflow-toolkit"]\nenabled = true\n',
    );
    let added = false;
    const run = (command: string, args: string[]) => {
      const line = args.join(" ");
      if (command === "codex" && line === "plugin list --json") {
        w.calls.push([command, ...args]);
        return {
          status: 0,
          stdout: JSON.stringify({
            installed: added
              ? [
                  {
                    name: "workit",
                    marketplaceName: "workflow-toolkit",
                    version: "2.0.0",
                    source: {
                      source: "npm",
                      package: "@brainervirus/workit-codex",
                    },
                  },
                ]
              : [],
          }),
        };
      }
      if (command === "codex" && args[0] === "plugin" && args[1] === "add") added = true;
      return w.deps.run(command, args);
    };
    const plan = previewUpgrade(["codex"], { ...w.deps, run });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toEqual(
      expect.objectContaining({ host: "codex", repair: true, latest: "2.0.0" }),
    );
    expect(await runUpgradeCommand(["--hosts=codex", "--yes"], { ...w.deps, run })).toBe(0);
    expect(ran(w.calls, "codex plugin add workit@workflow-toolkit --json")).toBe(true);
    expect(w.text()).toMatch(/codex +updated +reinstalled missing plugin files \(2\.0\.0\)/);
  } finally {
    w.cleanup();
  }
});

test("Given a host launched as `node …/codex.js`, Then the process is detected by its script basename", () => {
  expect(
    classifyProcess({
      pid: 1,
      state: "Sl",
      args: "node /opt/lib/node_modules/@openai/codex/bin/codex.js --model x",
    }),
  ).toEqual(expect.objectContaining({ host: "codex", kind: "session" }));
  expect(
    classifyProcess({
      pid: 2,
      state: "Sl",
      args: "/usr/bin/node --no-warnings /x/codex.js app-server",
    }),
  ).toEqual(expect.objectContaining({ host: "codex", kind: "daemon" }));
  expect(classifyProcess({ pid: 3, state: "S", args: "node /srv/app/server.js" })).toBeNull();
  expect(classifyProcess({ pid: 4, state: "S", args: "node /usr/bin/vim codex.ts" })).toBeNull();
});

test("Given a plain `workit upgrade` without a TTY and without --yes, Then nothing changes and it says to rerun with --yes", async () => {
  const w = world();
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
  try {
    const { confirm: _confirm, ...deps } = w.deps;
    expect(await runUpgradeCommand([], deps)).toBe(0);
    expect(w.text()).toContain("Not a terminal: rerun with --yes to apply.");
    expect(w.text()).toContain("nothing changed");
    expect(
      w.calls.some(
        (call) =>
          (call[0] === "npm" && call[1] === "install") ||
          (call[0] === "codex" && call[2] === "add") ||
          (call[0] === "pi" && call[1] === "update") ||
          (call[0] === "claude" && call[1] === "plugin" && call[2] === "update"),
      ),
    ).toBe(false);
  } finally {
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    w.cleanup();
  }
});

test("Given an unrelated plugin row above Workit's in `opencode plugin list`, When upgrade runs, Then the Workit row's version is the one reported", async () => {
  const { w, run } = opencodeWorld({ before: "8.37.0", after: "8.38.0" }, true);
  try {
    expect(
      await runUpgradeCommand(["--hosts=opencode", "--yes"], {
        ...w.deps,
        run,
      }),
    ).toBe(0);
    expect(w.text()).toMatch(/opencode +updated +8\.37\.0 -> 8\.38\.0; OpenCode V2 loads it live/);
  } finally {
    w.cleanup();
  }
});
