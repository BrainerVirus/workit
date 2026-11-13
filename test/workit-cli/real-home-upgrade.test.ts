// #859: `main(["upgrade", "--yes"])` called in process with an injected env
// upgraded the real CLI and plugins and wrote the real host settings, since
// the verb resolved paths from the process, not io.env. The full run below
// executes in a child whose own HOME is a decoy: a path not taken from io.env
// lands in the decoy (and fails the test), never in the developer's home.
// npm and the host CLIs are stub scripts on io.env's PATH: no network.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountHome } from "@/packages/workit-core/src/core/account-home";
import { run as upgradeVerb } from "@/packages/workit-cli/src/verbs/upgrade";
import { guardedHome } from "@/packages/workit-cli/src/admin/guarded-fs";
import { createProgress } from "@/packages/workit-cli/src/progress";
import { runUpgradeCommand } from "@/packages/workit-cli/src/upgrade";
import type { UpgradeDeps } from "@/packages/workit-cli/src/upgrade/shared";
import { guardRealHome } from "@/test/shared/real-state-guard";

const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const write = (file: string, text: string, mode = 0o644) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, mode);
};

/** Every file under `dir` (relative), skipping bun's own runtime cache. */
const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .filter((file) => !file.startsWith(".bun/"))
    .toSorted();

/** The npm stub: logs its arguments, `view` prints 99.0.0, anything else succeeds. */
const npmStub = (bin: string) => `#!/bin/sh
echo "$*" >> ${JSON.stringify(path.join(bin, "calls.log"))}
if [ "$1" = view ]; then echo 99.0.0; fi
exit 0
`;

const world = () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-real-home-upgrade-")));
  roots.push(root);
  const fixture = path.join(root, "fixture");
  const decoy = path.join(root, "decoy");
  const bin = path.join(root, "bin");
  mkdirSync(decoy, { recursive: true });
  write(path.join(fixture, ".config/workit/config.json"), '{"locale":"en"}\n');
  write(path.join(fixture, ".claude/settings.json"), "{}\n");
  write(path.join(bin, "npm"), npmStub(bin), 0o755);
  return { root, fixture, decoy, bin };
};

test("Given the upgrade verb with an injected env, When it runs, Then the upgrade gets io.env (never the process env)", async () => {
  const env = { HOME: "/nonexistent/fixture-home", PATH: "/nonexistent/bin" };
  let seen: UpgradeDeps | undefined;
  const code = await upgradeVerb(
    ["--yes"],
    { json: false, cwd: os.tmpdir(), env, stdout: () => {}, stderr: () => {} },
    {
      upgrade: async (_argv, deps) => {
        seen = deps;
        return 1;
      },
    },
  );
  expect(code).toBe(1);
  expect(seen?.env).toBe(env);
});

test("Given main(['setup', …]) then main(['upgrade', '--yes']) in process with io.env on a temp HOME and stubbed npm, When they run, Then every file they write is under the temp home and the real home is unchanged", () => {
  const { root, fixture, decoy, bin } = world();
  const home = accountHome();
  // The real account's grants, seal and host settings, checked at the end.
  let realHomeUnchanged = () => {};
  guardRealHome(home, (check) => {
    realHomeUnchanged = check;
  });
  const PATH = `${bin}:/usr/bin:/bin`;
  const script = `const { main } = await import(${JSON.stringify(MAIN)});
const out = [];
const io = {
  env: { HOME: ${JSON.stringify(fixture)}, PATH: ${JSON.stringify(PATH)} },
  stdout: (text) => void out.push(text),
  stderr: (text) => void out.push(text),
};
const setup = await main(["setup", "--hosts=claude-code", "--yes"], io);
const setupOut = out.splice(0).join("");
// As before #856: the block without its native deny, which the upgrade's closing doctor names.
const fs = await import("node:fs");
const settingsFile = ${JSON.stringify(path.join(fixture, ".claude/settings.json"))};
const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const deny = settings.permissions.deny;
delete settings.permissions.deny;
fs.writeFileSync(settingsFile, JSON.stringify(settings));
const upgrade = await main(["upgrade", "--yes", "--hosts=claude-code"], io);
console.log(JSON.stringify({ setup, upgrade, deny, out: out.join("") }));`;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    // The child's own HOME is the decoy; the run marker and state dir come along.
    env: {
      HOME: decoy,
      PATH,
      WORKIT_TEST_RUN: process.env.WORKIT_TEST_RUN,
      WORKIT_STATE_DIR: process.env.WORKIT_STATE_DIR,
      WORKIT_NO_YTRACK: "1",
      WORKIT_NO_PRESSURE_GATE: "1",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(child.status, child.stderr).toBe(0);
  const lines = child.stdout.trim().split("\n");
  const result = JSON.parse(lines.pop()!) as {
    setup: number;
    upgrade: number;
    deny: string[];
    out: string;
  };
  // The upgrade report and its steps go to io.stdout/io.stderr, never the process's.
  const report = result.out;
  expect([result.setup, result.upgrade], report).toEqual([0, 0]);
  expect(lines).toEqual([]);
  expect(child.stderr).toBe("");
  // Both ran against the fixture: setup wrote its native deny there, and the
  // upgrade's closing doctor read the fixture's settings and found it gone.
  const sealDeny = `Edit(/${path.join(fixture, ".config/workit/workspaces.json.seal")})`;
  expect(result.deny).toContain(sealDeny);
  expect(files(fixture)).toContain(".local/state/workit/host-permissions.json");
  expect(report).toContain("native_deny: claude-code: missing");
  expect(report).toContain(`Edit(/${path.join(fixture, ".local/state/workit/issued")}`);
  expect(readFileSync(path.join(bin, "calls.log"), "utf8")).toContain(
    "view @workit-dev/claude-code",
  );
  // Nothing landed in the process's own home, and nothing names it or the real one.
  expect(files(decoy)).toEqual([]);
  expect(report).not.toContain(decoy);
  if (home) expect(report).not.toContain(path.join(home, ".claude"));
  expect(realHomeUnchanged).not.toThrow();
});

/** A Cursor home whose old-form MCP entry makes `upgrade --hosts=cursor` repair it. */
const cursorHome = (prefix: string): string => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(home);
  write(path.join(home, ".config/workit/config.json"), '{"locale":"en"}\n');
  write(
    path.join(home, ".cursor/mcp.json"),
    JSON.stringify({
      mcpServers: { workit: { command: "npx", args: ["-y", "workit-cursor-mcp"] } },
    }),
  );
  return home;
};

/** Every file under `dir` with its content, to compare before and after. */
const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(files(dir).map((file) => [file, readFileSync(path.join(dir, file), "utf8")]));

/** `upgrade --yes --hosts=cursor` in process: npm view answers 2.0.0, every apply command is recorded. */
const cursorUpgrade = async (home: string) => {
  const spawned: string[] = [];
  const out: string[] = [];
  const code = await runUpgradeCommand(["--yes", "--hosts=cursor"], {
    home,
    processes: () => [],
    out: { write: (text) => void out.push(text) },
    progress: createProgress({ json: true }),
    run: (command, args) =>
      command === "npm" && args[0] === "view"
        ? { status: 0, stdout: "2.0.0\n" }
        : { status: 0, stdout: "" },
    // Probes (npm view, --version, list) read; anything else is a mutating spawn.
    runAsync: async (command, args) => {
      if (command === "npm" && args[0] === "view") return { status: 0, stdout: "2.0.0\n" };
      if (!args.includes("--version") && !args.includes("list"))
        spawned.push([command, ...args].join(" "));
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  return { code, spawned, out: out.join("") };
};

test("Given a test run and upgrade --yes into the fake account home, When it applies, Then it is refused before any write or host command, naming the home", async () => {
  expect(process.env.WORKIT_TEST_RUN).toBeDefined();
  const home = cursorHome("wk-upgrade-account-");
  guardedHome.value = home;
  try {
    const before = snapshot(home);
    const { code, spawned, out } = await cursorUpgrade(home);
    expect(code).not.toBe(0);
    expect(out).toContain(`refusing to run workit upgrade against ${home}`);
    expect(spawned).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  } finally {
    guardedHome.value = undefined;
  }
});

test("Given a test run and upgrade --yes into a temp home that is not the account's, When it applies, Then it repairs Cursor there with the stubbed npm", async () => {
  const home = cursorHome("wk-upgrade-home-");
  guardedHome.value = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-upgrade-elsewhere-")));
  roots.push(guardedHome.value);
  try {
    const { spawned, out } = await cursorUpgrade(home);
    expect(out).not.toContain("refusing");
    expect(spawned.some((call) => call.includes("--prefix"))).toBe(true);
    // The old-form entry was rewritten to the canonical one.
    expect(readFileSync(path.join(home, ".cursor/mcp.json"), "utf8")).toContain(
      "--min-release-age=0",
    );
  } finally {
    guardedHome.value = undefined;
  }
});

/** `upgrade --check --json` in process: npm view answers 2.0.0 on both runners. */
const checkUpgrade = async (home: string) => {
  const out: string[] = [];
  const view = (command: string, args: string[]) =>
    command === "npm" && args[0] === "view"
      ? { status: 0, stdout: "2.0.0\n", stderr: "" }
      : { status: 0, stdout: "", stderr: "" };
  const code = await runUpgradeCommand(["--check", "--json"], {
    home,
    processes: () => [],
    out: { write: (text) => void out.push(text) },
    progress: createProgress({ json: true }),
    run: view,
    runAsync: async (command, args) => view(command, args),
  });
  return { code, out: out.join("") };
};

test("Given a test run and upgrade --check against the fake account home, When it checks, Then it reports and writes no update cache there", async () => {
  const home = cursorHome("wk-check-account-");
  guardedHome.value = home;
  try {
    const before = snapshot(home);
    const { out } = await checkUpgrade(home);
    expect(out).toContain("2.0.0");
    expect(snapshot(home)).toEqual(before);
  } finally {
    guardedHome.value = undefined;
  }
});

test("Given a test run and upgrade --check against a temp home that is not the account's, When it checks, Then it writes its update cache there", async () => {
  const home = cursorHome("wk-check-home-");
  guardedHome.value = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-check-elsewhere-")));
  roots.push(guardedHome.value);
  try {
    const before = snapshot(home);
    const { out } = await checkUpgrade(home);
    expect(out).toContain("2.0.0");
    const added = Object.keys(snapshot(home)).filter((file) => !(file in before));
    expect(added.some((file) => file.startsWith(".local/state/workit/"))).toBe(true);
  } finally {
    guardedHome.value = undefined;
  }
});
