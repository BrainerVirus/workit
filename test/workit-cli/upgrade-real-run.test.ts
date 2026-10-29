// Gaps from a real `workit upgrade` (8.40.8): Cursor repair re-registers its MCP
// entry, failed host commands keep their stderr, OpenCode's update is retried,
// the table has no repeated status words, doctor names the installed fix and
// Codex processes older than the plugin are reported. Temp HOME, injected deps.
import { expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { cursorMcpServerEntry } from "@/packages/workit-cli/src/admin/registration";
import { createProgress } from "@/packages/workit-cli/src/progress";
import { applyUpgrade, previewUpgrade } from "@/packages/workit-cli/src/upgrade";
import { table } from "@/packages/workit-cli/src/upgrade/report";
import {
  asyncRunner,
  runner,
  stderrTail,
  type CommandResult,
} from "@/packages/workit-cli/src/upgrade/shared";

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
const tempHome = () => mkdtempSync(path.join(os.tmpdir(), "wk-upgrade-real-run-"));

test("Given an old-form Cursor MCP entry, When upgrade repairs Cursor, Then mcp.json is rewritten to the canonical entry, other servers stay, and the npm commands ran on the async runner", async () => {
  const home = tempHome();
  try {
    write(path.join(home, ".config/workit/config.json"), { locale: "en" });
    write(path.join(home, ".cursor/mcp.json"), {
      mcpServers: {
        workit: {
          command: "npx",
          args: ["-y", "--package=@brainervirus/workit-cursor", "workit-cursor-mcp"],
        },
        other: { command: "other" },
      },
    });
    const sync = (command: string, args: string[]): CommandResult =>
      command === "npm" && args[0] === "view"
        ? { status: 0, stdout: "2.0.0\n" }
        : { status: 0, stdout: "" };
    const deps = { home, run: sync, processes: () => [] };
    const plan = previewUpgrade(["cursor"], deps);
    expect(plan.entries[0]).toEqual(expect.objectContaining({ host: "cursor", repair: true }));
    const asyncCalls: string[] = [];
    const runAsync = async (command: string, args: string[]): Promise<CommandResult> => {
      asyncCalls.push(`${command} ${args.join(" ")}`);
      const prefix = args.indexOf("--prefix");
      if (prefix >= 0) {
        const root = path.join(args[prefix + 1], "node_modules/@brainervirus/workit-cursor");
        write(path.join(root, "package.json"), {
          name: "@brainervirus/workit-cursor",
          version: "2.0.0",
        });
        write(path.join(root, ".cursor-plugin/plugin.json"), { name: "workit" });
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = await applyUpgrade(plan, {
      home,
      processes: () => [],
      run: () => {
        throw new Error("the sync runner must not run Cursor's host commands");
      },
      runAsync,
    });
    expect(asyncCalls.some((call) => call.includes("--prefix"))).toBe(true);
    const mcp = JSON.parse(readFileSync(path.join(home, ".cursor/mcp.json"), "utf8"));
    expect(mcp.mcpServers.workit).toEqual(
      cursorMcpServerEntry(path.join(home, ".cursor/plugins/local/workit")),
    );
    expect(mcp.mcpServers.workit.args).toContain("--min-release-age=0");
    expect(mcp.mcpServers.other).toEqual({ command: "other" });
    // The synthetic package fails setup's doctor: the row names why, not the generic text.
    const cursor = result.hosts.find((entry) => entry.host === "cursor");
    expect(cursor?.status).toBe("failed");
    expect(cursor?.reason).not.toContain("did not verify the requested package version");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Given a failing Cursor install command, Then the row carries the stderr tail", async () => {
  const home = tempHome();
  try {
    write(path.join(home, ".config/workit/config.json"), { locale: "en" });
    write(path.join(home, ".cursor/mcp.json"), { mcpServers: { workit: { command: "npx" } } });
    const deps = {
      home,
      processes: () => [],
      run: (command: string, args: string[]): CommandResult =>
        command === "npm" && args[0] === "view"
          ? { status: 0, stdout: "2.0.0\n" }
          : { status: 0, stdout: "" },
    };
    const plan = previewUpgrade(["cursor"], deps);
    const result = await applyUpgrade(plan, {
      ...deps,
      runAsync: async () => ({
        status: 1,
        stdout: "",
        stderr: [
          "line1",
          "line2",
          "line3",
          "line4",
          "line5",
          "line6",
          "ETARGET no matching version",
        ].join("\n"),
      }),
    });
    const cursor = result.hosts.find((entry) => entry.host === "cursor");
    expect(cursor?.status).toBe("failed");
    expect(cursor?.reason).toContain("ETARGET no matching version");
    expect(cursor?.reason).not.toContain("line2");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const opencodeHome = () => {
  const home = tempHome();
  write(path.join(home, ".config/workit/config.json"), { locale: "en" });
  write(path.join(home, ".config/opencode/opencode.json"), {
    plugins: ["@brainervirus/workit-opencode"],
  });
  const calls: string[] = [];
  const run = (command: string, args: string[]): CommandResult => {
    if (command === "opencode" && args.join(" ") === "plugin --help")
      return { status: 0, stdout: "Commands:\n  opencode plugin update <name>\n" };
    return { status: 0, stdout: "" };
  };
  return { home, calls, run };
};

test("Given `opencode plugin update` fails once and then succeeds, Then it is retried and the row is updated", async () => {
  const { home, calls, run } = opencodeHome();
  try {
    const plan = previewUpgrade(["opencode"], { home, run, processes: () => [] });
    let updates = 0;
    const result = await applyUpgrade(plan, {
      home,
      processes: () => [],
      run,
      runAsync: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (args[1] === "update" && ++updates === 1)
          return { status: 1, stdout: "", stderr: "registry timeout" };
        return run(command, args);
      },
    });
    expect(updates).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.hosts.find((entry) => entry.host === "opencode")?.status).toBe("updated");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Given `opencode plugin update` fails twice, Then the row is FAILED with the stderr tail in the reason", async () => {
  const { home, run } = opencodeHome();
  try {
    const plan = previewUpgrade(["opencode"], { home, run, processes: () => [] });
    let updates = 0;
    const result = await applyUpgrade(plan, {
      home,
      processes: () => [],
      run,
      runAsync: async (command, args) => {
        if (args[1] === "update") {
          updates++;
          return { status: 1, stdout: "", stderr: "first\nEAI_AGAIN registry.npmjs.org\n" };
        }
        return run(command, args);
      },
    });
    expect(updates).toBe(2);
    const row = result.hosts.find((entry) => entry.host === "opencode");
    expect(row?.status).toBe("failed");
    expect(row?.reason).toContain("EAI_AGAIN registry.npmjs.org");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("stderrTail keeps the last five non-empty lines", () => {
  expect(stderrTail("a\nb\n\nc\nd\ne\nf\n")).toBe("b | c | d | e | f");
  expect(stderrTail(undefined)).toBe("");
});

test("Given a current row and a permissions row, Then the table never repeats the status and the permissions row is not a host row", () => {
  const text = table([
    { host: "opencode", status: "current", reason: "already current (2.0.0)" },
    { host: "permissions", status: "updated", reason: "cursor block refreshed in /x" },
  ]);
  expect(text).not.toContain("already current already current");
  expect(text).toMatch(/opencode +already current +\(2\.0\.0\)/);
  expect(text).toMatch(/permissions +updated +cursor block refreshed/);
  expect(text.match(/cursor/g)).toHaveLength(1);
});

test("Given an installed (non-dev) Cursor without launchers, Then doctor's launcher fix says workit upgrade, never bun run build", () => {
  const home = tempHome();
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.WORKFLOW_TOOLKIT_DEV;
    const report = runDoctor({
      host: "cursor",
      home,
      cwd: home,
      workspaceRoot: home,
      configDir: path.join(home, ".config/workit"),
      stateDir: path.join(home, ".local/state/workit"),
      env,
    });
    const launcher = report.checks.find((check) => check.id === "launcher")!;
    expect(launcher.status).toBe("fail");
    expect(launcher.fix).toContain("workit upgrade --hosts=cursor");
    expect(launcher.fix).not.toContain("bun run build");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const INSTALLED = Date.parse("2026-10-23T12:29:17.304Z");
const codexDoctor = (
  name: string,
  processes: { pid: number; startedMs: number; args: string }[] | null,
  installed = true,
) => {
  const home = path.join(tempHome(), name);
  const cwd = path.join(home, "cwd");
  mkdirSync(cwd, { recursive: true });
  if (installed) {
    write(
      path.join(home, ".codex/config.toml"),
      '[plugins."workit@workflow-toolkit"]\nenabled = true\n',
    );
    const root = path.join(home, ".codex/plugins/cache/workflow-toolkit/workit/8.40.8");
    mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
    utimesSync(root, INSTALLED / 1000, INSTALLED / 1000);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
  };
  delete env.WORKFLOW_TOOLKIT_DEV;
  const report = runDoctor({
    host: "cli",
    home,
    cwd,
    workspaceRoot: cwd,
    configDir: path.join(home, ".config/workit"),
    stateDir: path.join(home, ".local/state/workit"),
    env,
    codexProcesses: () => processes,
  });
  rmSync(path.dirname(home), { recursive: true, force: true });
  return report.checks.find((check) => check.id === "codex_session_plugin")!;
};

test.skipIf(process.platform === "win32")(
  "Given Codex processes older and newer than the plugin install, Then doctor warns for the older ones and says new sessions load it",
  () => {
    const row = codexDoctor("stale", [
      { pid: 4242, startedMs: INSTALLED - 3_600_000, args: "codex app-server" },
      { pid: 4343, startedMs: INSTALLED + 60_000, args: "codex" },
    ]);
    expect(row.status).toBe("warn");
    expect(row.detail).toContain("pid 4242");
    expect(row.detail).not.toContain("pid 4343");
    expect(row.detail).toContain("Workit 8.40.8");
    expect(row.detail).toContain("new Codex sessions load it");
  },
);

test.skipIf(process.platform === "win32")(
  "Given fresh, unlistable or no Codex install, Then the codex_session_plugin row is info",
  () => {
    expect(codexDoctor("fresh", [{ pid: 1, startedMs: INSTALLED + 1, args: "codex" }]).status).toBe(
      "info",
    );
    expect(codexDoctor("none", null).status).toBe("info");
    expect(codexDoctor("absent", [], false).status).toBe("info");
  },
);

test("Given a spinner on a TTY, When synchronous work runs, Then the ticker draws during it and stops before the step line", () => {
  const writes: string[] = [];
  const events: string[] = [];
  const progress = createProgress({
    stream: { isTTY: true, write: (text) => void (events.push("write"), writes.push(text)) },
    env: {},
    setInterval: () => 0,
    clearInterval: () => {},
    proc: { pid: 1, on: () => {}, off: () => {}, kill: () => {} },
    spawnTicker: (label) => {
      events.push(`start ${label}`);
      return { stop: () => void events.push("stop") };
    },
  });
  progress.runSync("Planning the upgrade", () => events.push("work"));
  expect(events.filter((event) => event !== "write")).toEqual([
    "start Planning the upgrade",
    "work",
    "stop",
  ]);
  expect(writes.at(-1)).toContain("Planning the upgrade");
});

// The default runners, with no injected runner: executables at absolute paths
// (what planHostInstall emits for node and the npm CLI) must run as given.
const script = (file: string, body: string) => {
  write(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

test.skipIf(process.platform === "win32")(
  "Given an absolute executable path, Then both default runners run it, and a missing one reports why on stderr",
  async () => {
    const home = tempHome();
    try {
      const tool = script(path.join(home, "bin/tool"), 'echo "out $1"; echo "err" >&2; exit 3');
      const deps = { home, env: { PATH: path.join(home, "bin") } };
      const sync = runner(deps)(tool, ["x"]);
      const spawned = await asyncRunner(deps)(tool, ["x"]);
      for (const result of [sync, spawned]) {
        expect(result.status).toBe(3);
        expect(result.stdout).toContain("out x");
        expect(result.stderr).toContain("err");
      }
      const missing = path.join(home, "bin/missing");
      for (const result of [runner(deps)(missing, []), await asyncRunner(deps)(missing, [])]) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("does not exist or is not executable");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "Given fake node and npm executables and no injected runner, When upgrade repairs Cursor, Then the real runners run the install and the row is updated with dist files in place",
  async () => {
    const home = tempHome();
    try {
      // A complete Cursor package: the real tree plus launchable dist entries.
      const template = path.join(home, "template");
      cpSync(path.join(import.meta.dir, "../../packages/workit-cursor"), template, {
        recursive: true,
      });
      const manifest = JSON.parse(readFileSync(path.join(template, "package.json"), "utf8"));
      write(path.join(template, "package.json"), { ...manifest, version: "2.0.0" });
      for (const entry of ["mcp-server.js", "cursor-session-start.js"])
        write(path.join(template, "dist", entry), "#!/usr/bin/env node\nconsole.log(1);\n");
      const bin = path.join(home, "bin");
      script(
        path.join(bin, "node"),
        `case "$1" in
  -e|--check) exit 0 ;;
  *npm-cli.js)
    while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && prefix="$2"; shift; done
    mkdir -p "$prefix/node_modules/@brainervirus"
    cp -r "$FAKE_CURSOR_TEMPLATE" "$prefix/node_modules/@brainervirus/workit-cursor"
    echo "$prefix" >> "$FAKE_NPM_LOG" ;;
esac
exit 0`,
      );
      const npmCli = script(
        path.join(home, "npm-lib/node_modules/npm/bin/npm-cli.js"),
        'echo "2.0.0"',
      );
      symlinkSync(npmCli, path.join(bin, "npm"));
      write(path.join(home, ".config/workit/config.json"), { locale: "en" });
      write(path.join(home, ".cursor/mcp.json"), {
        mcpServers: {
          workit: {
            command: "npx",
            args: ["-y", "--package=@brainervirus/workit-cursor", "workit-cursor-mcp"],
          },
        },
      });
      const log = path.join(home, "npm.log");
      const deps = {
        home,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          FAKE_CURSOR_TEMPLATE: template,
          FAKE_NPM_LOG: log,
          WORKFLOW_TOOLKIT_DEV: "",
        },
        processes: () => [],
      };
      const plan = previewUpgrade(["cursor"], deps);
      expect(plan.failed).toEqual([]);
      const result = await applyUpgrade(plan, deps);
      const cursor = result.hosts.find((entry) => entry.host === "cursor");
      expect(cursor?.reason).not.toContain("failed");
      expect(cursor?.status).toBe("updated");
      expect(readFileSync(log, "utf8")).toContain(".workit-package-bootstrap");
      expect(existsSync(path.join(home, ".cursor/plugins/local/workit/dist/mcp-server.js"))).toBe(
        true,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
