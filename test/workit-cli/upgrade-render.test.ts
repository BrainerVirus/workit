// `workit upgrade` human text: the plan and result tables are plain for pipes,
// agents and NO_COLOR (byte-identical to before), and colored in a terminal.
import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createStyle } from "@/packages/workit-cli/src/style";
import { eraseAbove } from "@/packages/workit-cli/src/upgrade";
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
  cli: { latest: "8.41.0", root: "/r", installed: "8.40.8" },
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
  cli         update 8.40.8 -> 8.41.0
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
