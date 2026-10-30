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
import { codexInventoryAnswer } from "./codex-fake";

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
  let opencodeVersion = "1.0.0";
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
    if (command === "codex") {
      const answer = codexInventoryAnswer(args, [
        {
          name: "workit",
          marketplaceName: "workflow-toolkit",
          version: codexVersion,
          source: { source: "npm", package: "@brainervirus/workit-codex" },
        },
      ]);
      if (answer) return answer;
    }
    if (command === "codex" && args[0] === "plugin" && args[1] === "add") {
      if (state.codexFails) return { status: 1, stdout: "" };
      codexVersion = "2.0.0";
    }
    if (command === "node" && args.at(-1) === "--install-agents" && state.agentsThrow)
      throw new Error("spawn node ENOENT");
    if (command === "codex" && args[0] === "app-server") state.daemon.push(args[2]);
    if (command === "claude" && args[1] === "update") claudeRegistry("2.0.0");
    // An older OpenCode 2.x: no `api` operation, its text listing names Workit.
    if (command === "opencode" && args[0] === "api")
      return { status: 1, stdout: "", stderr: 'Error: unknown command "api"\n' };
    if (command === "opencode" && line === "plugin update @brainervirus/workit-opencode")
      opencodeVersion = "2.0.0";
    if (command === "opencode" && line === "plugin list")
      return {
        status: 0,
        stdout: `ID      VERSION  SOURCE\nworkit  ${opencodeVersion}    @brainervirus/workit-opencode\n`,
      };
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

test("Given Codex's app-server daemon is running, When Codex updates to a new version, Then the daemon is left running and the row says new threads load it", async () => {
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
    expect(w.state.daemon).toEqual([]);
    expect(w.calls.findIndex((call) => call[1] === "plugin" || call[2] === "add")).toBeGreaterThan(
      -1,
    );
    expect(w.text()).toMatch(/codex +updated +.*new Codex threads load it/);
    expect(w.text()).not.toContain("daemon stopped");
  } finally {
    w.cleanup();
  }
});

test("Given Codex fails to update while its daemon runs, Then the daemon is never touched and only Codex fails", async () => {
  const w = world();
  try {
    w.state.codexFails = true;
    const plan = previewUpgrade(["codex"], w.deps);
    const result = await applyUpgrade(plan, {
      ...w.deps,
      processes: () => [{ pid: 12, state: "Ssl", args: "codex app-server" }],
    });
    expect(w.state.daemon).toEqual([]);
    expect(result.ok).toBe(false);
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
    expect(w.text()).toMatch(/opencode +updated +1\.0\.0 -> 2\.0\.0; OpenCode V2 loads it live/);
    expect(w.text()).not.toContain("restart opencode serve");
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
    const result = await applyUpgrade(plan, { ...w.deps, run });
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
    if (command === "npm" && line === "view @brainervirus/workit-opencode version")
      return { status: 0, stdout: `${versions.after}\n` };
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
    expect(w.text()).toMatch(/opencode +already current +\(2\.0\.0\)/);
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
      if (command === "codex") {
        w.calls.push([command, ...args]);
        const answer = codexInventoryAnswer(
          args,
          added
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
        );
        if (answer) return answer;
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

/** OpenCode whose `plugin list` reports the new version only some calls after the update. */
const laggingOpencode = (lag: number) => {
  const { w, run: base } = opencodeWorld({ before: "8.40.8", after: "8.40.8" });
  let updated = false;
  let listsAfter = 0;
  const run = (command: string, args: string[]) => {
    const line = args.join(" ");
    if (command === "npm" && line === "view @brainervirus/workit-opencode version")
      return { status: 0, stdout: "8.44.0\n" };
    if (command === "opencode" && args[1] === "update") updated = true;
    if (command === "opencode" && line === "plugin list" && updated && ++listsAfter > lag) {
      w.calls.push([command, ...args]);
      return {
        status: 0,
        stdout: "ID      VERSION  SOURCE\nworkit  8.44.0   @brainervirus/workit-opencode\n",
      };
    }
    return base(command, args);
  };
  return { w, run };
};

test("Given `opencode plugin list` still reports the old version right after the update, When upgrade runs, Then the row reads the target as updated, never already current", async () => {
  const { w, run } = laggingOpencode(1);
  try {
    expect(await runUpgradeCommand(["--hosts=opencode", "--yes"], { ...w.deps, run })).toBe(0);
    expect(w.text()).toMatch(/opencode +updated +8\.40\.8 -> 8\.44\.0/);
    expect(w.text()).not.toContain("already current (8.40.8)");
  } finally {
    w.cleanup();
  }
});

test("Given `opencode plugin list` never reports the target, When upgrade runs, Then the row never calls an older version current and names the target", async () => {
  const { w, run } = laggingOpencode(Number.POSITIVE_INFINITY);
  try {
    await runUpgradeCommand(["--hosts=opencode", "--yes"], {
      ...w.deps,
      run,
      opencodeReady: { timeoutMs: 20, intervalMs: 1 },
    });
    expect(w.text()).not.toMatch(/already current/);
    expect(w.text()).toMatch(/opencode .*8\.40\.8.*8\.44\.0/);
  } finally {
    w.cleanup();
  }
});

test("Given OpenCode V2 that loads the update live after several readings, When upgrade runs with its service up, Then it waits for the new version and asks for no restart", async () => {
  const { w, run } = laggingOpencode(5);
  try {
    const processes = () => [{ pid: 77, state: "S", args: "opencode serve --service" }];
    expect(
      await runUpgradeCommand(["--hosts=opencode", "--yes"], {
        ...w.deps,
        run,
        processes,
        opencodeReady: { intervalMs: 1 },
      }),
    ).toBe(0);
    expect(w.text()).toMatch(/opencode +updated +8\.40\.8 -> 8\.44\.0; OpenCode V2 loads it live/);
    expect(w.text()).not.toContain("still lists");
    expect(w.text()).not.toContain("restart opencode serve");
  } finally {
    w.cleanup();
  }
});

test("Given OpenCode never lists the update while its service runs, When upgrade gives up waiting, Then the row says so and names the service to restart", async () => {
  const { w, run } = laggingOpencode(Number.POSITIVE_INFINITY);
  try {
    const processes = () => [{ pid: 77, state: "S", args: "opencode serve --service" }];
    await runUpgradeCommand(["--hosts=opencode", "--yes"], {
      ...w.deps,
      run,
      processes,
      opencodeReady: { timeoutMs: 20, intervalMs: 1 },
    });
    expect(w.text()).toMatch(/still lists 8\.40\.8 \(published 8\.44\.0\)/);
    expect(w.text()).toContain("restart opencode serve (pid 77");
  } finally {
    w.cleanup();
  }
});

/** The new binary, in process: the same command with the env the old one hands it. */
const newBinary =
  (w: ReturnType<typeof world>, seen: { argv: string[]; env: Record<string, string> }[]) =>
  async (argv: string[], env: Record<string, string>) => {
    seen.push({ argv, env });
    return runUpgradeCommand(argv, { ...w.deps, env: { ...env } });
  };

test("Given a plain `workit upgrade` with a newer CLI, When it applies, Then the CLI installs first and the new binary upgrades the hosts with one table and exit code", async () => {
  const w = world();
  try {
    const seen: { argv: string[]; env: Record<string, string> }[] = [];
    const code = await runUpgradeCommand([], {
      ...w.deps,
      cliOnDisk: () => "2.0.0",
      reexec: newBinary(w, seen),
    });
    expect(code, w.text()).toBe(0);
    const install = w.calls.findIndex((call) => call.join(" ").startsWith("npm install --global"));
    const firstHost = w.calls.findIndex((call) =>
      /^(?:claude plugin update|codex plugin add|pi update)\b/.test(call.join(" ")),
    );
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(firstHost);
    // Re-executed once, with the hosts only, confirmed, and never re-planning the CLI.
    expect(seen).toHaveLength(1);
    expect(seen[0].argv).toEqual(["--yes", "--hosts=opencode,cursor,codex,pi,claude-code"]);
    expect(
      w.calls.filter((call) => call.join(" ").startsWith("npm install --global")),
    ).toHaveLength(1);
    expect(w.calls.filter((call) => call.join(" ") === "npm root --global")).toHaveLength(2);
    const text = w.text();
    expect(text).toContain("Continuing the upgrade with the new CLI");
    expect(text).toMatch(/cli +updated +1\.0\.0 -> 2\.0\.0/);
    expect(text).toMatch(/claude-code +updated +1\.0\.0 -> 2\.0\.0/);
    expect(text).toMatch(/pi +updated +1\.0\.0 -> 2\.0\.0/);
    expect(text.match(/^Result:/gm)).toHaveLength(1);
  } finally {
    w.cleanup();
  }
});

test("Given the new binary fails a host, Then the exit code is 1 and the table still has the CLI row", async () => {
  const w = world();
  try {
    w.state.codexFails = true;
    const seen: { argv: string[]; env: Record<string, string> }[] = [];
    const rows: string[] = [];
    const code = await runUpgradeCommand(["--yes"], {
      ...w.deps,
      cliOnDisk: () => "2.0.0",
      reexec: newBinary(w, seen),
      onResult: (hosts) => rows.push(...hosts.map((h) => `${h.host}:${h.status}`)),
    });
    expect(code).toBe(1);
    expect(w.text()).toMatch(/cli +updated/);
    expect(w.text()).toMatch(/codex +FAILED/);
    expect(rows).toContain("cli:updated");
    expect(rows).toContain("codex:failed");
  } finally {
    w.cleanup();
  }
});

test("Given the CLI install fails, Then the hosts still upgrade with the current code, the CLI row says so, and nothing is re-executed", async () => {
  const w = world();
  try {
    const seen: { argv: string[]; env: Record<string, string> }[] = [];
    const run = (command: string, args: string[]) =>
      command === "npm" && args[0] === "install"
        ? { status: 1, stdout: "", stderr: "EACCES" }
        : w.deps.run(command, args);
    const code = await runUpgradeCommand(["--yes"], {
      ...w.deps,
      run,
      cliOnDisk: () => "1.0.0",
      reexec: newBinary(w, seen),
    });
    expect(code).toBe(1);
    expect(seen).toHaveLength(0);
    const text = w.text();
    expect(text).toMatch(
      /cli +FAILED +CLI update failed.*hosts upgraded with workit \d+\.\d+\.\d+/,
    );
    expect(text).toMatch(/pi +updated +1\.0\.0 -> 2\.0\.0/);
    expect(text).toMatch(/claude-code +updated/);
  } finally {
    w.cleanup();
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Given every host probe takes 1 s, When upgrade plans, Then the probes run at once and planning takes about one probe, not their sum", async () => {
  const w = world();
  try {
    let probes = 0;
    const runAsync = async (command: string, args: string[]) => {
      probes++;
      await sleep(1000);
      return w.deps.run(command, args);
    };
    const started = Date.now();
    expect(await runUpgradeCommand(["--preview"], { ...w.deps, runAsync })).toBe(0);
    const elapsed = Date.now() - started;
    expect(probes).toBeGreaterThanOrEqual(5);
    expect(elapsed).toBeLessThan(3000);
    expect(w.text()).toContain("cli         update 1.0.0 -> 2.0.0");
    expect(w.text()).toMatch(/codex +update 1\.0\.0 -> 2\.0\.0/);
  } finally {
    w.cleanup();
  }
});

const hangs =
  (line: string, then: (command: string, args: string[]) => any) =>
  async (command: string, args: string[]) =>
    command === "codex" && args.join(" ") === line
      ? new Promise<never>(() => {})
      : then(command, args);

test("Given an unscoped `codex plugin list` that hangs past the probe timeout while the scoped calls answer, When upgrade plans, Then Codex is planned with no timeout", async () => {
  const w = world();
  try {
    const runAsync = hangs("plugin list --json", w.deps.run);
    const started = Date.now();
    expect(
      await runUpgradeCommand(["--preview"], {
        ...w.deps,
        runAsync,
        probeTimeoutMs: 200,
      }),
    ).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(w.text()).toMatch(/codex +update 1\.0\.0 -> 2\.0\.0/);
    expect(w.text()).not.toMatch(/timed out/);
    expect(w.text()).toMatch(/pi +update 1\.0\.0 -> 2\.0\.0/);
  } finally {
    w.cleanup();
  }
});

test("Given the unscoped `codex plugin list` hangs, When upgrade applies, Then the post-update verification reports Codex updated", async () => {
  const w = world();
  try {
    const runAsync = hangs("plugin list --json", w.deps.run);
    expect(
      await runUpgradeCommand(["--hosts=codex", "--yes"], {
        ...w.deps,
        runAsync,
      }),
    ).toBe(0);
    expect(w.text()).toMatch(/codex +updated +1\.0\.0 -> 2\.0\.0/);
  } finally {
    w.cleanup();
  }
});

test("Given a scoped Codex listing that never answers, When upgrade plans, Then Codex reads could not check after the probe timeout and the others still plan", async () => {
  const w = world();
  try {
    const runAsync = hangs("plugin list --json --marketplace workflow-toolkit", w.deps.run);
    expect(
      await runUpgradeCommand(["--preview"], {
        ...w.deps,
        runAsync,
        probeTimeoutMs: 200,
      }),
    ).toBe(0);
    expect(w.text()).toMatch(
      /codex +cannot upgrade: could not check: `codex plugin list --json --marketplace <configured>` timed out/,
    );
    expect(w.text()).toMatch(/pi +update 1\.0\.0 -> 2\.0\.0/);
  } finally {
    w.cleanup();
  }
});

/** The Codex-only world with `codex` answering through `answer`; the rest as in `world`. */
const codexWith = (answer: (args: string[]) => ReturnType<typeof codexInventoryAnswer>) => {
  const w = world();
  const run = (command: string, args: string[]) =>
    (command === "codex" ? answer(args) : undefined) ?? w.deps.run(command, args);
  return { w, run };
};

const WORKIT_ROW = {
  name: "workit",
  marketplaceName: "workflow-toolkit",
  version: "1.0.0",
  source: { source: "npm", package: "@brainervirus/workit-codex" },
};

test("Given Workit installed from a marketplace other than the default and remote marketplaces configured, When upgrade plans, Then only local marketplaces are listed and the row is found and classified as local", () => {
  const listed: string[] = [];
  const { w, run } = codexWith((args) => {
    listed.push(args.join(" "));
    return codexInventoryAnswer(
      args,
      [
        {
          ...WORKIT_ROW,
          marketplaceName: "my-fork",
          version: "0.9.0",
          source: undefined,
        },
      ],
      ["openai-curated-remote", "openai-bundled", "my-fork", "workspace-directory"],
    );
  });
  try {
    const plan = previewUpgrade(["codex"], { ...w.deps, run });
    expect(plan.skipped.map((entry) => entry.reason)).toEqual([
      "local source preserved; change its source explicitly to upgrade",
    ]);
    expect(listed).toEqual([
      "plugin marketplace list --json",
      "plugin list --json --marketplace openai-bundled",
      "plugin list --json --marketplace my-fork",
    ]);
  } finally {
    w.cleanup();
  }
});

test("Given a Codex without `plugin marketplace list --json`, When upgrade plans, Then the unscoped list is the fallback", () => {
  const { w, run } = codexWith((args) => {
    const line = args.join(" ");
    if (line === "plugin marketplace list --json") return { status: 2, stdout: "" };
    if (line === "plugin list --json")
      return { status: 0, stdout: JSON.stringify({ installed: [WORKIT_ROW] }) };
    return undefined;
  });
  try {
    expect(previewUpgrade(["codex"], { ...w.deps, run }).entries).toEqual([
      expect.objectContaining({ host: "codex", installedVersion: "1.0.0" }),
    ]);
  } finally {
    w.cleanup();
  }
});

test("Given a Codex listing marketplaces as a bare JSON array, When upgrade plans, Then the scoped listings still run", () => {
  const { w, run } = codexWith((args) =>
    args.join(" ") === "plugin marketplace list --json"
      ? { status: 0, stdout: JSON.stringify([{ name: "workflow-toolkit" }]) }
      : codexInventoryAnswer(args, [WORKIT_ROW]),
  );
  try {
    expect(previewUpgrade(["codex"], { ...w.deps, run }).entries).toEqual([
      expect.objectContaining({ host: "codex", installedVersion: "1.0.0" }),
    ]);
  } finally {
    w.cleanup();
  }
});

test("Given a Codex that rejects `--marketplace`, When upgrade plans, Then the unscoped list is the fallback", () => {
  const { w, run } = codexWith((args) => {
    const line = args.join(" ");
    if (line === "plugin list --json")
      return { status: 0, stdout: JSON.stringify({ installed: [WORKIT_ROW] }) };
    if (line.includes("--marketplace")) return { status: 2, stdout: "" };
    return codexInventoryAnswer(args, []);
  });
  try {
    expect(previewUpgrade(["codex"], { ...w.deps, run }).entries).toEqual([
      expect.objectContaining({ host: "codex", installedVersion: "1.0.0" }),
    ]);
  } finally {
    w.cleanup();
  }
});

test("Given `codex plugin marketplace list --json` that is not JSON, When upgrade plans, Then Codex cannot be checked and the reason says so", () => {
  const { w, run } = codexWith((args) =>
    args.join(" ") === "plugin marketplace list --json"
      ? { status: 0, stdout: "not json" }
      : undefined,
  );
  try {
    const plan = previewUpgrade(["codex"], { ...w.deps, run });
    expect(plan.ok).toBe(false);
    expect(JSON.stringify(plan)).toContain("Codex plugin inventory");
  } finally {
    w.cleanup();
  }
});

/** A stand-in for the new CLI's entry script: one JSON report on stdout, its code in the rows file. */
const fakeEntry = (home: string, code: number) => {
  const file = path.join(home, "new-cli.mjs");
  write(
    file,
    `import { writeFileSync } from "node:fs";
const rows = [{ host: "cli", status: "updated", reason: "1.0.0 -> 2.0.0" }, { host: "pi", status: ${code ? '"failed"' : '"updated"'}, reason: "x" }];
writeFileSync(process.env.WORKIT_UPGRADE_ROWS, JSON.stringify({ code: ${code}, rows }));
process.stdout.write(JSON.stringify({ ok: ${code === 0}, argv: process.argv.slice(2), hosts: rows }, null, 2) + "\\n");
`,
  );
  return file;
};

test("Given --yes --json and a CLI that updates, When the new CLI finishes, Then stdout is one JSON document and the exit code is the new CLI's", async () => {
  for (const code of [0, 1]) {
    const w = world();
    try {
      const rows: string[] = [];
      const result = await runUpgradeCommand(["--yes", "--json"], {
        ...w.deps,
        cliEntry: fakeEntry(w.home, code),
        cliOnDisk: () => "2.0.0",
        onResult: (hosts) => rows.push(...hosts.map((h) => `${h.host}:${h.status}`)),
      });
      expect(result).toBe(code);
      const report = JSON.parse(w.text());
      expect(report.argv).toEqual([
        "upgrade",
        "--yes",
        "--json",
        "--hosts=opencode,cursor,codex,pi,claude-code",
      ]);
      expect(rows).toEqual(["cli:updated", code ? "pi:failed" : "pi:updated"]);
    } finally {
      w.cleanup();
    }
  }
});

test("Given --yes --json and a failed CLI install, Then stdout is one JSON document with the CLI row failed", async () => {
  const w = world();
  try {
    const run = (command: string, args: string[]) =>
      command === "npm" && args[0] === "install"
        ? { status: 1, stdout: "", stderr: "EACCES" }
        : w.deps.run(command, args);
    expect(
      await runUpgradeCommand(["--yes", "--json"], { ...w.deps, run, cliOnDisk: () => "1.0.0" }),
    ).toBe(1);
    const report = JSON.parse(w.text());
    expect(report.hosts.find((h: { host: string }) => h.host === "cli").status).toBe("failed");
  } finally {
    w.cleanup();
  }
});

test("Given the re-executed upgrade fails a host, Then it hands its exit code back and exits 0, so the failure line prints once (from the older CLI)", async () => {
  const w = world();
  try {
    w.state.codexFails = true;
    const rowsFile = path.join(w.home, "rows.json");
    const code = await runUpgradeCommand(["--yes", "--hosts=codex"], {
      ...w.deps,
      env: {
        WORKIT_UPGRADE_CONTINUE: JSON.stringify([
          { host: "cli", status: "updated", reason: "1.0.0 -> 2.0.0" },
        ]),
        WORKIT_UPGRADE_ROWS: rowsFile,
      },
    });
    expect(code).toBe(0);
    const back = JSON.parse(readFileSync(rowsFile, "utf8"));
    expect(back.code).toBe(1);
    expect(
      back.rows.map((row: { host: string; status: string }) => `${row.host}:${row.status}`),
    ).toEqual(["cli:updated", "codex:failed"]);
  } finally {
    w.cleanup();
  }
});

/**
 * OpenCode v2 behind its background service, as measured on 2.2.0:
 * - `opencode api plugin.list` answers for the service's default location
 *   (HOME) whatever the cwd; it errors for its first `apiErrorsFor` calls and
 *   lists only builtins until its PluginBoot fiber activated Workit (`bootAfter`).
 * - `plugin list` / `plugin update` act on the cwd's location, which boots on
 *   its first plugin command and stays cold for `coldFor` commands there: `No
 *   plugins found`, and the update fails with `Plugin is not configured`.
 */
const servicedOpencode = (options: {
  bootAfter: number;
  coldFor?: number;
  apiErrorsFor?: number;
  before?: string;
  after?: string;
  updateError?: string;
}) => {
  const w = world();
  write(path.join(w.home, ".config/opencode/opencode.json"), {
    plugins: ["@brainervirus/workit-opencode"],
  });
  let apiCalls = 0;
  let updated = false;
  const locations = new Map<string, number>();
  const invocations: { args: string; cwd: string | undefined }[] = [];
  const warm = (cwd: string | undefined) => {
    const key = cwd ?? process.cwd();
    const seen = (locations.get(key) ?? 0) + 1;
    locations.set(key, seen);
    return seen > (options.coldFor ?? 0);
  };
  const version = () => (updated ? (options.after ?? "2.0.0") : (options.before ?? "1.0.0"));
  const builtin = { id: "builtin-auth", source: { type: "builtin" }, state: { status: "active" } };
  const run = (command: string, args: string[], where?: { cwd?: string }) => {
    const line = args.join(" ");
    if (command === "opencode" && line === "plugin --help")
      return { status: 0, stdout: OPENCODE_HELP };
    if (command === "opencode" && args[0] !== "--version")
      invocations.push({ args: line, cwd: where?.cwd });
    if (command === "opencode" && args[0] === "api" && args[1] === "plugin.list") {
      w.calls.push([command, ...args]);
      if (++apiCalls <= (options.apiErrorsFor ?? 0))
        return {
          status: 1,
          stdout: "",
          stderr: "Error: Unable to connect to the background service\n",
        };
      const booted = apiCalls - (options.apiErrorsFor ?? 0) > options.bootAfter;
      return {
        status: 0,
        stdout: JSON.stringify({
          location: { directory: w.home },
          data: [
            builtin,
            ...(booted
              ? [
                  {
                    id: "workit",
                    source: {
                      type: "package",
                      target: "@brainervirus/workit-opencode",
                      version: version(),
                      ...(updated ? {} : { outdated: true }),
                    },
                    state: { status: "active" },
                  },
                ]
              : []),
          ],
        }),
      };
    }
    if (command === "opencode" && line === "plugin list") {
      w.calls.push([command, ...args]);
      return warm(where?.cwd)
        ? {
            status: 0,
            stdout: `ID      VERSION  SOURCE\nworkit  ${version()}   @brainervirus/workit-opencode\n`,
          }
        : { status: 0, stdout: "No plugins found\n" };
    }
    if (command === "opencode" && args[1] === "update") {
      w.calls.push([command, ...args]);
      if (!warm(where?.cwd))
        return {
          status: 1,
          stdout: "",
          stderr:
            "Error: Plugin is not configured: @brainervirus/workit-opencode\n    at <anonymous> (/$bunfs/root/chunk-a.js:6:22917)\n",
        };
      if (options.updateError) return { status: 1, stdout: "", stderr: options.updateError };
      updated = true;
      return { status: 0, stdout: "" };
    }
    if (command === "npm" && line === "view @brainervirus/workit-opencode version")
      return { status: 0, stdout: `${options.after ?? "2.0.0"}\n` };
    return w.deps.run(command, args);
  };
  return { w, run, invocations };
};

/** Every OpenCode plugin command ran in HOME's location, and the api named it. */
const expectHomeLocation = (
  invocations: { args: string; cwd: string | undefined }[],
  home: string,
) => {
  expect(invocations.length).toBeGreaterThan(0);
  for (const call of invocations) {
    expect(call.cwd).toBe(home);
    if (call.args.startsWith("api "))
      expect(call.args).toBe(`api plugin.list -H x-opencode-directory:${home}`);
  }
};

test("Given the api is ready for HOME while the update's location is still cold, When upgrade runs, Then it waits for that location and the update runs once", async () => {
  const { w, run, invocations } = servicedOpencode({ bootAfter: 0, coldFor: 3 });
  try {
    const code = await runUpgradeCommand(["--hosts=opencode", "--yes"], {
      ...w.deps,
      run,
      opencodeReady: { intervalMs: 1 },
    });
    expect(code).toBe(0);
    expect(updates(w.calls)).toBe(1);
    expect(w.text()).toMatch(/opencode +updated +1\.0\.0 -> 2\.0\.0; OpenCode V2 loads it live/);
    expect(w.text()).not.toContain("Plugin is not configured");
    expectHomeLocation(invocations, w.home);
  } finally {
    w.cleanup();
  }
});

test("Given `opencode api plugin.list` errors for a few calls and then answers, When upgrade runs, Then it keeps waiting and the update succeeds once", async () => {
  const { w, run, invocations } = servicedOpencode({ bootAfter: 0, apiErrorsFor: 3 });
  try {
    const code = await runUpgradeCommand(["--hosts=opencode", "--yes"], {
      ...w.deps,
      run,
      opencodeReady: { intervalMs: 1 },
    });
    expect(code).toBe(0);
    expect(updates(w.calls)).toBe(1);
    expect(w.text()).toMatch(/opencode +updated +1\.0\.0 -> 2\.0\.0/);
    expectHomeLocation(invocations, w.home);
  } finally {
    w.cleanup();
  }
});

test("Given the text listing says `No plugins found` for the whole wait, When upgrade runs, Then OpenCode is not ready and nothing is updated", async () => {
  const { w, run } = servicedOpencode({ bootAfter: 0, coldFor: Number.POSITIVE_INFINITY });
  try {
    await runUpgradeCommand(["--hosts=opencode", "--yes"], {
      ...w.deps,
      run,
      opencodeReady: { timeoutMs: 60, intervalMs: 5 },
    });
    expect(updates(w.calls)).toBe(0);
    expect(w.text()).toContain("OpenCode did not finish loading its plugins");
  } finally {
    w.cleanup();
  }
});

const updates = (calls: string[][]) =>
  calls.filter((call) => call.join(" ") === "opencode plugin update @brainervirus/workit-opencode")
    .length;

test("Given OpenCode's service lists Workit only after a few readings, When upgrade runs, Then it waits and the update runs once", async () => {
  const { w, run } = servicedOpencode({ bootAfter: 3 });
  try {
    const code = await runUpgradeCommand(["--hosts=opencode", "--yes"], {
      ...w.deps,
      run,
      opencodeReady: { intervalMs: 1 },
    });
    expect(code).toBe(0);
    expect(updates(w.calls)).toBe(1);
    expect(w.text()).toMatch(/opencode +updated +1\.0\.0 -> 2\.0\.0; OpenCode V2 loads it live/);
    expect(w.text()).not.toContain("Plugin is not configured");
  } finally {
    w.cleanup();
  }
});

test("Given OpenCode's service never lists Workit, When upgrade runs, Then the wait is bounded, nothing is updated and the row says OpenCode did not finish loading", async () => {
  const { w, run } = servicedOpencode({ bootAfter: Number.POSITIVE_INFINITY });
  try {
    const began = Date.now();
    await runUpgradeCommand(["--hosts=opencode", "--yes"], {
      ...w.deps,
      run,
      opencodeReady: { timeoutMs: 60, intervalMs: 5 },
    });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(updates(w.calls)).toBe(0);
    expect(w.text()).toContain(
      "OpenCode did not finish loading its plugins (opencode api plugin.list never listed @brainervirus/workit-opencode)",
    );
    expect(w.text()).toContain("opencode plugin update @brainervirus/workit-opencode");
    expect(w.text()).not.toMatch(/opencode .*\b\d+\.\d+\.\d+ -> /);
  } finally {
    w.cleanup();
  }
});

test("Given `opencode plugin update` fails with an Error line followed by stack frames, When upgrade runs, Then the row shows the Error line, not only frames", async () => {
  const frames = Array.from(
    { length: 8 },
    (_, index) => `    at frame${index} (/x/opencode.js:${index}:1)`,
  );
  const { w, run } = servicedOpencode({
    bootAfter: 0,
    updateError: `Error: Plugin is not configured: @brainervirus/workit-opencode\n${frames.join("\n")}\n`,
  });
  try {
    await runUpgradeCommand(["--hosts=opencode", "--yes"], {
      ...w.deps,
      run,
      opencodeReady: { intervalMs: 1 },
    });
    expect(updates(w.calls)).toBe(2);
    expect(w.text()).toMatch(
      /opencode +FAILED +`opencode plugin update @brainervirus\/workit-opencode` failed: Error: Plugin is not configured: @brainervirus\/workit-opencode \| at frame3/,
    );
  } finally {
    w.cleanup();
  }
});
