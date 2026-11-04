// The Workit-owned CLI install (#648): versions/<v> + an atomic `current`
// link + a launcher that finds a Node 24 itself. Every case runs on a temp
// HOME with a fake npm (the runner seam); the launcher and the PATH probe run
// for real with the Node that runs the suite.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { installOwned, writeLaunchers } from "@/packages/workit-cli/src/install/owned";
import { installRoot, launcherDir, ownedPaths } from "@/packages/workit-cli/src/install/paths";
import { runUpgradeCommand } from "@/packages/workit-cli/src/upgrade";

const NODE = Bun.which("node") ?? "";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const tempHome = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-install-owned-"));
  homes.push(home);
  return home;
};

const write = (file: string, text: string, mode = 0o644) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, mode);
};

/** What `npm install --prefix <dir> @brainervirus/workit-cli@<v>` leaves: a package whose entry prints <v>. */
const stagePackage = (prefixDir: string, version: string) => {
  const pkg = path.join(prefixDir, "node_modules/@brainervirus/workit-cli");
  write(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@brainervirus/workit-cli", version }),
  );
  write(path.join(pkg, "dist/index.js"), `console.log(${JSON.stringify(version)});\n`);
};

/** The fake npm: `install --prefix` stages the requested version; `uninstall --prefix` removes it. */
const fakeNpm =
  (calls: string[][] = []) =>
  async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const prefix = args[args.indexOf("--prefix") + 1];
    if (args[1] === "install") stagePackage(prefix, args.at(-1)!.split("@").at(-1)!);
    if (args[1] === "uninstall")
      rmSync(path.join(prefix, "lib/node_modules/@brainervirus/workit-cli"), {
        recursive: true,
        force: true,
      });
    return { status: 0, stdout: "" };
  };

const installNode = { node: NODE, npmCli: "npm-cli.js", version: "24.0.0" };

/** A fnm Node (the suite's real node) whose npm global prefix holds workit `version`, linked the way npm links bins. */
const fnmNode = (home: string, node: string, version: string) => {
  const prefix = path.join(home, ".local/share/fnm/node-versions", node, "installation");
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  symlinkSync(NODE, path.join(prefix, "bin/node"));
  const pkg = path.join(prefix, "lib/node_modules/@brainervirus/workit-cli");
  write(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@brainervirus/workit-cli", version }),
  );
  write(
    path.join(pkg, "dist/index.js"),
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
    0o755,
  );
  symlinkSync(
    "../lib/node_modules/@brainervirus/workit-cli/dist/index.js",
    path.join(prefix, "bin/workit"),
  );
  return { prefix, bin: path.join(prefix, "bin"), pkg };
};

const runLauncher = (file: string, env: NodeJS.ProcessEnv) =>
  spawnSync(file, ["--version"], { encoding: "utf8", env });

test("installRoot and launcherDir derive from XDG, the install override and Windows' LOCALAPPDATA", () => {
  expect(installRoot({ HOME: "/h" }, "linux")).toBe("/h/.local/share/workit");
  expect(installRoot({ HOME: "/h", XDG_DATA_HOME: "/d" }, "darwin")).toBe("/d/workit");
  expect(installRoot({ HOME: "/h", WORKIT_INSTALL_ROOT: "/x" }, "linux")).toBe("/x");
  expect(installRoot({ LOCALAPPDATA: "C:\\L" }, "win32")).toBe(
    path.join("C:\\L", "workit", "install"),
  );
  expect(launcherDir({ HOME: "/h" }, "linux")).toBe("/h/.local/bin");
  expect(ownedPaths({ LOCALAPPDATA: "C:\\L" }, "win32").linked).toBe(
    path.join("C:\\L", "workit", "install", "bin", "workit.cmd"),
  );
});

test("Given an install killed before the swap, Then current still points to the previous version, the launcher still runs it, and the next install clears the leftover", async () => {
  const home = tempHome();
  const env = { HOME: home, PATH: "/usr/bin:/bin", WORKIT_NODE: NODE };
  expect((await installOwned("1.0.0", { env, node: installNode, run: fakeNpm() })).ok).toBe(true);
  const { launcher, current, versions } = ownedPaths(env);
  writeLaunchers({ env, installNode: NODE });
  // The killed run: npm wrote part of 2.0.0 into staging, then the process died.
  const killed = installOwned("2.0.0", {
    env,
    node: installNode,
    run: async (_command, args) => {
      stagePackage(args[args.indexOf("--prefix") + 1], "2.0.0");
      throw new Error("SIGKILL");
    },
  });
  await expect(killed).rejects.toThrow("SIGKILL");
  expect(readlinkSync(current)).toBe(path.join("versions", "1.0.0"));
  expect(readdirSync(versions).some((name) => name.startsWith(".staging-"))).toBe(true);
  const ran = runLauncher(launcher, env);
  expect(ran.stdout.trim(), ran.stderr).toBe("1.0.0");
  // The next install removes the leftover staging and swaps.
  const next = await installOwned("2.0.0", { env, node: installNode, run: fakeNpm() });
  expect(next).toEqual({ ok: true, dir: path.join(versions, "2.0.0"), previous: "1.0.0" });
  expect(readdirSync(versions).toSorted()).toEqual(["1.0.0", "2.0.0"]);
  expect(runLauncher(launcher, env).stdout.trim()).toBe("2.0.0");
});

test("Given no WORKIT_NODE and a PATH node below 24, When the launcher runs, Then it skips both and runs a version-manager Node 24+", () => {
  const home = tempHome();
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: path.join(home, "old-node") };
  // A PATH `node` that says it is 18 and cannot run anything.
  write(path.join(home, "old-node/node"), "#!/bin/sh\necho v18.0.0\n", 0o755);
  write(path.join(home, "old-node/sed"), `#!/bin/sh\nexec /bin/sed "$@"\n`, 0o755);
  write(path.join(home, "old-node/head"), `#!/bin/sh\nexec /usr/bin/head "$@"\n`, 0o755);
  stagePackage(path.join(home, ".local/share/workit/versions/3.0.0"), "3.0.0");
  symlinkSync(path.join("versions", "3.0.0"), path.join(home, ".local/share/workit/current"));
  const { launcher } = writeLaunchers({ env, installNode: "/nowhere/node" });
  expect(runLauncher(launcher, env).status).toBe(127);
  // A version manager's Node 24.
  mkdirSync(path.join(home, ".nvm/versions/node/v24.1.0/bin"), { recursive: true });
  symlinkSync(NODE, path.join(home, ".nvm/versions/node/v24.1.0/bin/node"));
  expect(runLauncher(launcher, env).stdout.trim()).toBe("3.0.0");
  // A recorded node that is gone falls through to the scan.
  write(
    path.join(home, ".local/state/workit/node.json"),
    JSON.stringify({ path: path.join(home, "missing-node"), version: "24.0.0" }),
  );
  expect(runLauncher(launcher, env).stdout.trim()).toBe("3.0.0");
});

test("Given two fnm Nodes each holding workit 8.52.3 and PATH resolving one, When `workit upgrade` runs, Then the new version is current and the upgrade fails naming each install until the launcher comes first on PATH", async () => {
  const home = tempHome();
  const first = fnmNode(home, "v24.1.0", "8.52.3");
  const second = fnmNode(home, "v24.2.0", "8.52.3");
  const bin = path.join(home, ".local/bin");
  let out = "";
  const deps = (PATH: string) => ({
    home,
    env: { PATH, WORKIT_NODE: NODE },
    run: (command: string, args: string[]) =>
      command === "npm" && args[0] === "view"
        ? { status: 0, stdout: "9.0.0\n" }
        : { status: 0, stdout: "" },
    runAsync: async (command: string, args: string[]) =>
      command === "npm" && args[0] === "view"
        ? { status: 0, stdout: "9.0.0\n" }
        : fakeNpm()(command, args),
    installNode: () => installNode,
    removeCopies: async () => false,
    doctor: () => ({ checks: [] }),
    processes: () => [],
    out: { write: (text: string) => void (out += text) },
  });
  const argv = ["--hosts=none", "--cli", "--yes", "--json"];
  expect(await runUpgradeCommand(argv, deps(`${first.bin}:${bin}:/usr/bin:/bin`))).toBe(1);
  const root = path.join(home, ".local/share/workit");
  expect(readlinkSync(path.join(root, "current"))).toBe(path.join("versions", "9.0.0"));
  const cli = JSON.parse(out).hosts.find((row: { host: string }) => row.host === "cli");
  expect(cli.status).toBe("failed");
  expect(cli.reason).toContain(`PATH runs ${first.bin}/workit (8.52.3), not 9.0.0`);
  const listing = cli.details.join("\n");
  expect(listing).toContain(`${first.bin}/workit -> ${first.pkg}/dist/index.js (workit 8.52.3`);
  expect(listing).toContain(`${second.bin}/workit -> ${second.pkg}/dist/index.js (workit 8.52.3`);
  expect(listing).toContain(`npm uninstall --global --prefix ${first.prefix}`);
  // The launcher first on PATH: the same upgrade now verifies and passes.
  out = "";
  expect(await runUpgradeCommand(argv, deps(`${bin}:${first.bin}:/usr/bin:/bin`))).toBe(0);
  const passed = JSON.parse(out).hosts.find((row: { host: string }) => row.host === "cli");
  expect(passed.status).toBe("updated");
  expect(passed.details[0]).toBe(`PATH runs ${bin}/workit (workit 9.0.0)`);
  expect(existsSync(first.pkg) && existsSync(second.pkg)).toBe(true);
  expect(readFileSync(path.join(bin, "workit"), "utf8")).toContain("workit-owned-launcher");
});

/** Two fnm copies and a hand-written ~/.local/bin wrapper, and the upgrade deps around them. */
const migrationWorld = () => {
  const home = tempHome();
  const first = fnmNode(home, "v24.1.0", "8.52.3");
  const second = fnmNode(home, "v24.2.0", "8.52.3");
  const bin = path.join(home, ".local/bin");
  const wrapper = path.join(bin, "workit");
  write(wrapper, `#!/bin/sh\nexec node ${first.pkg}/dist/index.js "$@"\n`, 0o755);
  const calls: string[][] = [];
  const out: string[] = [];
  const deps = {
    home,
    env: { PATH: `${bin}:${first.bin}:/usr/bin:/bin`, WORKIT_NODE: NODE },
    run: () => ({ status: 0, stdout: "" }),
    runAsync: async (command: string, args: string[]) =>
      command === "npm" && args[0] === "view"
        ? { status: 0, stdout: "9.0.0\n" }
        : fakeNpm(calls)(command, args),
    installNode: () => installNode,
    doctor: () => ({ checks: [] }),
    processes: () => [],
    out: { write: (text: string) => void out.push(text) },
  };
  return { home, first, second, bin, wrapper, calls, out, deps };
};

test("Given the migration at a terminal and the answer y, Then each copy is backed up under the upgrade backup, uninstalled with its prefix, and listed", async () => {
  const w = migrationWorld();
  const asked: string[] = [];
  const code = await runUpgradeCommand(["--hosts=none", "--cli", "--yes", "--json"], {
    ...w.deps,
    removeCopies: async (question: string) => {
      asked.push(question);
      return true;
    },
  });
  const report = JSON.parse(w.out.join(""));
  expect(code, w.out.join("")).toBe(0);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("Back up and remove the 3 other workit installs");
  expect(existsSync(w.first.pkg) || existsSync(w.second.pkg)).toBe(false);
  for (const copy of [w.first, w.second])
    expect(w.calls).toContainEqual([
      NODE,
      "npm-cli.js",
      "uninstall",
      "--global",
      "--prefix",
      copy.prefix,
      "@brainervirus/workit-cli",
    ]);
  const backups = path.join(report.backup, "cli-copies");
  const saved = readdirSync(backups).toSorted();
  expect(saved).toEqual(["1-wrapper-8.52.3", "2-fnm-8.52.3", "3-fnm-8.52.3", "manifest.json"]);
  expect(readFileSync(path.join(backups, "1-wrapper-8.52.3/workit"), "utf8")).toContain(
    "exec node",
  );
  expect(
    JSON.parse(readFileSync(path.join(backups, "2-fnm-8.52.3/package/package.json"), "utf8"))
      .version,
  ).toBe("8.52.3");
  const manifest = JSON.parse(readFileSync(path.join(backups, "manifest.json"), "utf8"));
  expect(manifest.map((entry: { path: string }) => entry.path)).toContain(w.wrapper);
  // The wrapper's place now links to the owned launcher, which PATH runs.
  expect(readlinkSync(w.wrapper)).toBe(path.join(w.home, ".local/share/workit/bin/workit"));
  const cli = report.hosts.find((row: { host: string }) => row.host === "cli");
  expect(cli.status).toBe("updated");
  expect(cli.details.filter((line: string) => line.startsWith("removed (backup in"))).toHaveLength(
    3,
  );
});

test("Given the answer N, Then every copy stays, the CLI row prints the commands, and the PATH check fails while the wrapper shadows the launcher", async () => {
  const w = migrationWorld();
  const code = await runUpgradeCommand(["--hosts=none", "--cli", "--yes", "--json"], {
    ...w.deps,
    removeCopies: async () => false,
  });
  expect(code).toBe(1);
  expect(existsSync(w.first.pkg) && existsSync(w.second.pkg)).toBe(true);
  expect(readFileSync(w.wrapper, "utf8")).toContain("exec node");
  const cli = JSON.parse(w.out.join("")).hosts.find((row: { host: string }) => row.host === "cli");
  const details = cli.details.join("\n");
  expect(details).toContain(`npm uninstall --global --prefix ${w.second.prefix}`);
  expect(details).toContain(
    `ln -sf ${path.join(w.home, ".local/share/workit/bin/workit")} ${w.wrapper}`,
  );
  expect(w.calls.some((call) => call.includes("uninstall"))).toBe(false);
});

test("Given a non-TTY shell (no removeCopies seam), Then nothing is removed and the exact removal commands are printed", async () => {
  const w = migrationWorld();
  rmSync(w.wrapper);
  const tty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
  let code: number;
  try {
    code = await runUpgradeCommand(["--hosts=none", "--cli", "--yes"], w.deps);
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  }
  const text = w.out.join("");
  expect(code, text).toBe(0);
  expect(existsSync(w.first.pkg) && existsSync(w.second.pkg)).toBe(true);
  expect(text).toContain("other installs left in place; back them up and remove them with:");
  expect(text).toContain(
    `cp -R ${w.first.pkg} ${path.join(w.home, ".local/state/workit/upgrades")}`,
  );
  expect(text).toContain(
    `npm uninstall --global --prefix ${w.first.prefix} @brainervirus/workit-cli`,
  );
  expect(w.calls.some((call) => call.includes("uninstall"))).toBe(false);
});
