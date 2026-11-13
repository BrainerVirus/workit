// `workit upgrade` human text: the plan and result tables are plain for pipes,
// agents and NO_COLOR (byte-identical to before), and colored in a terminal.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { createStyle } from "@/packages/workit-cli/src/style";
import { eraseAbove, runUpgradeCommand } from "@/packages/workit-cli/src/upgrade";
import { summary, table } from "@/packages/workit-cli/src/upgrade/report";
import type { HostOutcome, UpgradePlan } from "@/packages/workit-cli/src/upgrade/shared";

const plan = {
  ok: false,
  blocked: ["a host is running"],
  failed: [{ host: "pi", status: "failed", reason: "unreadable", fix: "pi update" }],
  skipped: [
    { host: "cursor", reason: "already current (1.0.0)" },
    { host: "codex", reason: "not installed", fix: "workit setup --hosts=codex" },
  ],
  entries: [{ host: "opencode", installedVersion: "1.0.0", latest: "1.1.0", commands: [] }],
  configDigests: {},
  cli: {
    latest: "8.41.0",
    root: "/r",
    installed: "8.40.8",
    entry: "/r/versions/8.41.0/node_modules/@workit-dev/cli/dist/index.js",
    install: true,
    copies: ["/n/bin/workit (workit 8.40.8; fnm global prefix /n; PATH #1)"],
  },
  migrations: [{ id: "m", file: "/f", description: "migrate config" }],
  warnings: ["OpenCode 1.x"],
} as unknown as UpgradePlan;
const permissions = [{ host: "cursor", file: "/home/u/.cursor/cli-config.json" }];
const hosts: HostOutcome[] = [
  { host: "opencode", status: "updated", reason: "1.0.0 -> 1.1.0" },
  { host: "cursor", status: "current", reason: "already current (1.0.0)" },
  { host: "codex", status: "skipped", reason: "not installed", fix: "workit setup --hosts=codex" },
  { host: "pi", status: "failed", reason: "npm exited 1", fix: "pi update" },
];

const SUMMARY = `Workit upgrade plan:
  cli         update 8.40.8 -> 8.41.0 under /r
              other installs to migrate (backed up, then removed after a y/N):
                /n/bin/workit (workit 8.40.8; fnm global prefix /n; PATH #1)
  opencode    update 1.0.0 -> 1.1.0
  cursor      already current (1.0.0)
  codex       skip: not installed (run: workit setup --hosts=codex)
  pi          cannot upgrade: unreadable (run: pi update)
  config      migrate config
  permissions refresh the cursor block in /home/u/.cursor/cli-config.json
  blocked: a host is running
  warning: OpenCode 1.x
`;
const TABLE = `Result:
  opencode    updated         1.0.0 -> 1.1.0
  cursor      already current (1.0.0)
  codex       skipped         not installed
                              fix: workit setup --hosts=codex
  pi          FAILED          npm exited 1
                              fix: pi update
`;

test("Given no terminal or NO_COLOR, When the plan and result render, Then the text is unchanged", () => {
  expect(summary(plan, permissions)).toBe(SUMMARY);
  expect(table(hosts)).toBe(TABLE);
  for (const options of [
    { stream: { isTTY: false }, env: {} },
    { stream: { isTTY: true }, env: { NO_COLOR: "1" } },
    { stream: { isTTY: true }, env: { CI: "true" } },
    { stream: undefined, env: { FORCE_COLOR: "1" } },
  ]) {
    expect(summary(plan, permissions, createStyle(options))).toBe(SUMMARY);
    expect(table(hosts, createStyle(options))).toBe(TABLE);
  }
});

test("Given FORCE_COLOR, When the result renders, Then statuses are colored and fixes highlighted", () => {
  const style = createStyle({ stream: {}, env: { FORCE_COLOR: "1" } });
  const text = table(hosts, style);
  expect(stripVTControlCharacters(text)).toBe(TABLE);
  expect(text).toContain("\x1b[32mupdated\x1b[0m");
  expect(text).toContain("\x1b[2malready current\x1b[0m");
  expect(text).toContain("\x1b[33mskipped\x1b[0m");
  expect(text).toContain("\x1b[1;31mFAILED\x1b[0m");
  expect(text).toContain("fix: \x1b[1;36mpi update\x1b[0m");
});

test("Given FORCE_COLOR, When the plan renders, Then it keeps its columns and highlights versions, skips, paths and commands", () => {
  const text = summary(plan, permissions, createStyle({ stream: {}, env: { FORCE_COLOR: "1" } }));
  expect(stripVTControlCharacters(text)).toBe(SUMMARY);
  expect(text).toContain("-> \x1b[32m8.41.0\x1b[0m");
  expect(text).toContain("\x1b[33mskip:\x1b[0m");
  expect(text).toContain("\x1b[1;31mcannot upgrade:\x1b[0m");
  expect(text).toContain("(run: \x1b[1;36mworkit setup --hosts=codex\x1b[0m)");
  expect(text).toContain("\x1b[2m/home/u/.cursor/cli-config.json\x1b[0m");
});

test("Given hosts that resolve their own update, When the plan renders, Then it shows the published version, not the command", () => {
  const command = { command: "claude", args: ["plugin", "update", "workit@workit"] };
  const own = {
    ...plan,
    blocked: [],
    failed: [],
    skipped: [],
    migrations: [],
    warnings: [],
    cli: undefined,
    entries: [
      {
        host: "opencode",
        latest: "",
        published: "8.45.6",
        installedVersion: "8.45.5",
        commands: [command],
      },
      { host: "pi", latest: "", installedVersion: "8.45.5", commands: [command] },
    ],
  } as unknown as UpgradePlan;
  expect(summary(own, [])).toBe(`Workit upgrade plan:
  opencode    update 8.45.5 -> 8.45.6
  pi          update (claude plugin update workit@workit)
`);
});

test("Given the answered plan, When it is erased, Then the cursor moves up over every row it filled, wrapped lines included", () => {
  const text = `\x1b[1mWorkit upgrade plan:\x1b[0m\n  cli  update\n${"x".repeat(100)}\nApply this upgrade? [y/N] y\n`;
  expect(eraseAbove(text, 80)).toBe("\x1b[5A\r\x1b[0J");
  expect(eraseAbove("", 80)).toBe("");
});

// A repair row shows the host-only planner's diff, one line per entry, in the
// planner's words: the files it writes, the config keys, the host commands.
const repairPlan = (diff: { files: string[]; keys: string[]; commands: string[] }) =>
  ({
    ok: true,
    blocked: [],
    failed: [],
    skipped: [],
    entries: [
      {
        host: "opencode",
        selector: "@workit-dev/opencode",
        latest: "latest",
        commands: [],
        repair: true,
        install: { preview: {}, diff },
        fix: "workit upgrade --hosts=opencode",
      },
    ],
    configDigests: {},
    migrations: [],
  }) as unknown as UpgradePlan;

const ROW = (lines: string[]) =>
  [
    "Workit upgrade plan:",
    "  opencode    repair",
    ...lines.map((line) => `                ${line}`),
    "",
  ].join("\n");

test("Given a repair that writes a file, Then the plan row lists that file on its own line", () => {
  expect(
    summary(
      repairPlan({ files: ["/h/.config/opencode/opencode.json"], keys: [], commands: [] }),
      [],
    ),
  ).toBe(ROW(["/h/.config/opencode/opencode.json"]));
});

test("Given a repair that changes config keys, Then each key is its own line", () => {
  expect(
    summary(
      repairPlan({
        files: [],
        keys: [
          "/h/.config/opencode/opencode.json: plugins",
          "/h/.config/opencode/opencode.json: plugin",
        ],
        commands: [],
      }),
      [],
    ),
  ).toBe(
    ROW([
      "/h/.config/opencode/opencode.json: plugins",
      "/h/.config/opencode/opencode.json: plugin",
    ]),
  );
});

test("Given a repair that runs host commands, Then each command is its own line, in order", () => {
  expect(
    summary(
      repairPlan({
        files: [],
        keys: [],
        commands: [
          "/h/bin/claude plugin uninstall workit@workit --scope user",
          "/h/bin/claude plugin install workit@workit --scope user",
        ],
      }),
      [],
    ),
  ).toBe(
    ROW([
      "/h/bin/claude plugin uninstall workit@workit --scope user",
      "/h/bin/claude plugin install workit@workit --scope user",
    ]),
  );
});

test("Given a repair with an empty diff, Then the row is the host and repair alone, never the fixed reinstall text", () => {
  const text = summary(repairPlan({ files: [], keys: [], commands: [] }), []);
  expect(text).toBe(ROW([]));
  expect(text).not.toContain("reinstall missing plugin files");
});

// #792 item 57: the OpenCode package reached the registry after the CLI and
// after this run's plan read it, so OpenCode installed the older release.
test("Given an OpenCode step that installed 1.9.0 while 1.9.1 was published before the doctor pass, Then the report asks for another `workit upgrade` and never calls OpenCode updated", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-upgrade-late-release-"));
  const write = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  try {
    const cache = path.join(home, "oc-cache");
    write(path.join(home, ".config/opencode/opencode.json"), {
      plugins: ["@workit-dev/opencode"],
    });
    let installed = "1.7.0";
    // The fake registry: 1.9.0 while the plan reads it, 1.9.1 once the update ran.
    let published = "1.9.0";
    const run = (command: string, args: string[]) => {
      const line = args.join(" ");
      if (command === "npm" && line === "view @workit-dev/opencode version")
        return { status: 0, stdout: `${published}\n` };
      if (command === "npm" && args[0] === "view") return { status: 0, stdout: "1.9.1\n" };
      if (command === "opencode" && line === "plugin --help")
        return { status: 0, stdout: "Commands:\n  opencode plugin update <name>\n" };
      if (command === "opencode" && args[0] === "api")
        return { status: 1, stdout: "", stderr: 'Error: unknown command "api"\n' };
      if (command === "opencode" && line === "plugin list")
        return {
          status: 0,
          stdout: `ID      VERSION  SOURCE\nworkit  ${installed}    @workit-dev/opencode\n`,
        };
      if (command === "opencode" && line === "plugin update @workit-dev/opencode") {
        installed = "1.9.0";
        write(path.join(cache, "node_modules/@workit-dev/opencode/package.json"), {
          name: "@workit-dev/opencode",
          version: installed,
        });
        published = "1.9.1";
      }
      return { status: 0, stdout: "" };
    };
    const doctor = () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        WORKIT_DOCTOR_STALE_REGISTRY_VERSION: published,
      };
      delete env.WORKIT_DEV;
      delete env.XDG_CONFIG_HOME;
      const report = runDoctor({
        host: "cli",
        only: "upgrade",
        home,
        cwd: home,
        workspaceRoot: home,
        configDir: path.join(home, ".config/workit"),
        stateDir: path.join(home, ".local/state/workit"),
        opencodePackageCacheDir: cache,
        env,
      });
      return { checks: report.checks.filter((check) => check.id === "stale_install") };
    };
    const out: string[] = [];
    const code = await runUpgradeCommand(["--hosts=opencode", "--yes"], {
      home,
      env: { PATH: path.join(home, "bin") },
      run,
      processes: () => [],
      confirm: async () => true,
      doctor,
      out: { write: (text: string) => void out.push(text) },
      opencodeReady: { timeoutMs: 0, intervalMs: 0, sleep: async () => {} },
      removeCopies: async () => false,
    });
    const text = out.join("");
    expect(code, text).toBe(0);
    expect(text).toContain("published 1.9.1 appeared after this run read the registry");
    expect(text).not.toMatch(/opencode +updated/);
    expect(text).not.toMatch(/opencode +already current/);
    expect(text).toContain(
      "stale_install: OpenCode @latest cache has workit-opencode 1.9.0 behind published 1.9.1",
    );
    const last = text.trimEnd().split("\n").at(-1) ?? "";
    expect(last).toMatch(/^ +fix: workit upgrade \(run it again if one just ran/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
