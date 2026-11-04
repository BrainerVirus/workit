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
import {
  describeInstall,
  describeInstallAt,
  hostLauncherOf,
  listInstalls,
} from "@/packages/workit-cli/src/install/discover";
import { migrationCopies } from "@/packages/workit-cli/src/install/migrate";
import { pathResolvedWorkit } from "@/packages/workit-cli/src/install/verify";
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
    2,
  );
  expect(cli.details.join("\n")).toContain(
    `replaced with a link to ${path.join(w.home, ".local/share/workit/bin/workit")}`,
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

test("Given a user's own script at the launcher's place that runs no workit-cli, Then migration never lists it as a copy to move", () => {
  const home = tempHome();
  const bin = path.join(home, ".local/bin");
  write(path.join(bin, "workit"), "#!/bin/sh\necho my own tool\n", 0o755);
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  expect(migrationCopies(env, "linux").map((copy) => copy.path)).not.toContain(
    path.join(bin, "workit"),
  );
  // A wrapper that does run a workit-cli package is still a copy.
  const first = fnmNode(home, "v24.1.0", "8.52.3");
  write(path.join(bin, "workit"), `#!/bin/sh\nexec node ${first.pkg}/dist/index.js "$@"\n`, 0o755);
  expect(migrationCopies(env, "linux").map((copy) => copy.path)).toContain(
    path.join(bin, "workit"),
  );
});

/**
 * W2.39 as it happened: ~/.local/bin/workit is a hand-written sh wrapper that
 * execs fnm's bin/workit by path (no workit-cli path in its text), and the
 * upgrade runs through npx, whose cache .bin sits first on PATH.
 */
const wrapperWorld = (wrapperText?: string) => {
  const home = tempHome();
  const fnm = fnmNode(home, "v24.20.0", "8.55.0");
  const bin = path.join(home, ".local", "bin");
  const wrapper = path.join(bin, "workit");
  write(
    wrapper,
    wrapperText ??
      `#!/bin/sh\nexec "${path.join(fnm.bin, "node")}" "${path.join(fnm.bin, "workit")}" "$@"\n`,
    0o755,
  );
  // The npx cache copy `npx -y @brainervirus/workit-cli@latest upgrade` runs.
  const npx = path.join(home, ".npm", "_npx", "4b6b", "node_modules");
  stagePackage(path.dirname(npx), "9.0.0");
  mkdirSync(path.join(npx, ".bin"), { recursive: true });
  symlinkSync("../@brainervirus/workit-cli/dist/index.js", path.join(npx, ".bin", "workit"));
  write(
    path.join(npx, "@brainervirus/workit-cli/dist/index.js"),
    `#!/usr/bin/env node\nconsole.log("9.0.0");\n`,
    0o755,
  );
  const login = `${bin}:${fnm.bin}:/usr/bin:/bin`;
  const calls: string[][] = [];
  const out: string[] = [];
  const deps = {
    home,
    env: { PATH: `${path.join(npx, ".bin")}:${login}`, WORKIT_NODE: NODE },
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
  return { home, fnm, bin, wrapper, npx, login, calls, out, deps };
};

/** `workit --version` the way a new login shell resolves it. */
const loginWorkit = (home: string, PATH: string) => {
  const first = Bun.which("workit", { PATH });
  expect(first).not.toBeNull();
  return spawnSync(first!, ["--version"], { encoding: "utf8", env: { HOME: home, PATH } });
};

test.skipIf(process.platform === "win32")(
  "Given ~/.local/bin/workit is a sh wrapper that execs the fnm install the upgrade removes, When upgrade runs through npx with yes, Then the wrapper is backed up and becomes the owned launcher link, and PATH's workit prints the new version",
  async () => {
    const w = wrapperWorld();
    expect(loginWorkit(w.home, w.login).stdout.trim()).toBe("8.55.0");
    const asked: string[] = [];
    const code = await runUpgradeCommand(["--hosts=none", "--cli", "--yes", "--json"], {
      ...w.deps,
      removeCopies: async (question: string) => {
        asked.push(question);
        return true;
      },
    });
    const text = w.out.join("");
    expect(code, text).toBe(0);
    // The wrapper and the fnm copy; never the npx cache copy.
    expect(asked[0]).toContain("Back up and remove the 2 other workit installs");
    expect(text).not.toContain("_npx");
    expect(w.calls.filter((call) => call.includes("uninstall"))).toEqual([
      [
        NODE,
        "npm-cli.js",
        "uninstall",
        "--global",
        "--prefix",
        w.fnm.prefix,
        "@brainervirus/workit-cli",
      ],
    ]);
    expect(existsSync(w.fnm.pkg)).toBe(false);
    const report = JSON.parse(text);
    const launcher = path.join(w.home, ".local", "share", "workit", "bin", "workit");
    expect(readlinkSync(w.wrapper)).toBe(launcher);
    expect(
      readFileSync(path.join(report.backup, "cli-copies", "1-wrapper-8.55.0", "workit"), "utf8"),
    ).toContain(path.join(w.fnm.bin, "workit"));
    const cli = report.hosts.find((row: { host: string }) => row.host === "cli");
    expect(cli.status).toBe("updated");
    expect(cli.details[0]).toBe(`PATH runs ${w.wrapper} (workit 9.0.0)`);
    expect(cli.details.join("\n")).toContain(`replaced with a link to ${launcher}`);
    const after = loginWorkit(w.home, w.login);
    expect(after.stdout.trim(), after.stderr).toBe("9.0.0");
  },
);

test.skipIf(process.platform === "win32")(
  "Given the PATH workit still misses the owned install after upgrade, Then upgrade exits 1 naming the exact fix, never prints Verified, and the fix makes workit print the new version",
  async () => {
    // A user's own script at the launcher's place: not a workit copy, so never moved.
    const w = wrapperWorld("#!/bin/sh\necho my own tool\n");
    const code = await runUpgradeCommand(["--hosts=none", "--cli", "--yes"], {
      ...w.deps,
      removeCopies: async () => true,
    });
    const text = w.out.join("");
    expect(code, text).toBe(1);
    expect(text).not.toContain("Verified");
    expect(text).toContain("Not verified:");
    expect(text).toContain(`but PATH runs ${w.wrapper} (`);
    const fix = /fix: (mkdir -p .*)$/m.exec(text)?.[1];
    expect(fix, text).toContain(
      `ln -s ${path.join(w.home, ".local/share/workit/bin/workit")} ${w.wrapper}`,
    );
    const ran = spawnSync("sh", ["-c", fix!], { encoding: "utf8" });
    expect(ran.status, ran.stderr).toBe(0);
    expect(loginWorkit(w.home, w.login).stdout.trim()).toBe("9.0.0");
  },
);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "Given a wrapper that execs a copy and cannot be replaced, Then the copy it runs is kept and the report says why",
  async () => {
    const w = wrapperWorld();
    rmSync(w.wrapper);
    const other = path.join(w.home, "bin", "workit");
    write(other, `#!/bin/sh\nexec ${path.join(w.fnm.bin, "workit")} "$@"\n`, 0o755);
    chmodSync(path.dirname(other), 0o555);
    try {
      await runUpgradeCommand(["--hosts=none", "--cli", "--yes", "--json"], {
        ...w.deps,
        env: {
          ...w.deps.env,
          PATH: `${path.dirname(other)}:${w.deps.env.PATH}`,
        },
        removeCopies: async () => true,
      });
    } finally {
      chmodSync(path.dirname(other), 0o755);
    }
    expect(existsSync(w.fnm.pkg)).toBe(true);
    expect(readFileSync(other, "utf8")).toContain("exec ");
    const cli = JSON.parse(w.out.join("")).hosts.find(
      (row: { host: string }) => row.host === "cli",
    );
    expect(cli.details.join("\n")).toContain(`[not removed: kept: ${other} still runs it`);
  },
);

test("Given scripts that only mention a workit path (a comment, a cd into a workit dir, a target that does not exist), Then none is a copy to migrate and each stays a foreign wrapper", () => {
  const home = tempHome();
  const fnm = fnmNode(home, "v24.1.0", "8.52.3");
  const bin = path.join(home, ".local", "bin");
  const script = path.join(bin, "workit");
  const projects = path.join(home, "projects", "workit");
  mkdirSync(projects, { recursive: true });
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  for (const text of [
    `#!/bin/sh\n# docs: ${path.join(fnm.bin, "workit")}\necho my own tool\n`,
    `#!/bin/sh\ncd ${projects} && make "$@"\n`,
    `#!/bin/sh\nexec node ${path.join(home, "gone", "bin", "workit")} "$@"\n`,
  ]) {
    write(script, text, 0o755);
    const found = listInstalls(env, "linux").find((install) => install.path === script);
    expect(found?.kind, text).toBe("wrapper");
    expect(found?.runs, text).toBeNull();
    expect(
      migrationCopies(env, "linux").map((copy) => copy.path),
      text,
    ).not.toContain(script);
  }
  // The exec line still decides when a comment names another path.
  write(
    script,
    `#!/bin/sh\n# was: /usr/local/bin/workit\nexec "${path.join(fnm.bin, "node")}" "${path.join(fnm.bin, "workit")}" "$@"\n`,
    0o755,
  );
  const copy = migrationCopies(env, "linux").find((one) => one.path === script);
  expect(copy?.runs).toBe(path.join(fnm.bin, "workit"));
  expect(copy?.version).toBe("8.52.3");
});

test.skipIf(process.platform === "win32")(
  "Given ~/.local/bin/workit is a wrapper that execs the owned launcher, Then it counts as owned, is never replaced, and each upgrade plans nothing for the CLI",
  async () => {
    const home = tempHome();
    const bin = path.join(home, ".local", "bin");
    const wrapper = path.join(bin, "workit");
    const launcher = path.join(home, ".local", "share", "workit", "bin", "workit");
    const env = { PATH: `${bin}:/usr/bin:/bin`, WORKIT_NODE: NODE };
    // An owned 9.0.0, then the person's own wrapper in place of the launcher link.
    const root = path.join(home, ".local", "share", "workit");
    stagePackage(path.join(root, "versions", "9.0.0"), "9.0.0");
    symlinkSync(path.join("versions", "9.0.0"), path.join(root, "current"));
    writeLaunchers({ env: { ...env, HOME: home }, installNode: NODE });
    rmSync(wrapper);
    const text = `#!/bin/sh\nexec "${launcher}" "$@"\n`;
    write(wrapper, text, 0o755);
    const run = async () => {
      let out = "";
      const code = await runUpgradeCommand(["--hosts=none", "--cli", "--yes", "--json"], {
        home,
        env,
        run: (command: string, args: string[]) =>
          command === "npm" && args[0] === "view"
            ? { status: 0, stdout: "9.0.0\n" }
            : { status: 0, stdout: "" },
        runAsync: async (command: string, args: string[]) =>
          command === "npm" && args[0] === "view"
            ? { status: 0, stdout: "9.0.0\n" }
            : fakeNpm()(command, args),
        installNode: () => installNode,
        removeCopies: async () => true,
        doctor: () => ({ checks: [] }),
        processes: () => [],
        out: { write: (chunk: string) => void (out += chunk) },
      });
      return {
        code,
        cli: JSON.parse(out).hosts.find((row: { host: string }) => row.host === "cli"),
      };
    };
    const found = listInstalls({ ...env, HOME: home }, "linux").find((one) => one.path === wrapper);
    expect(found?.kind).toBe("owned");
    expect(migrationCopies({ ...env, HOME: home }, "linux")).toEqual([]);
    for (const _ of [1, 2]) {
      const again = await run();
      expect(again.code).toBe(0);
      expect(again.cli.status).toBe("current");
      expect(again.cli.reason).toBe("already current (9.0.0)");
      expect(readFileSync(wrapper, "utf8")).toBe(text);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "Given PATH holds `.`, an empty entry and a relative dir, When the upgrade verifies PATH's workit, Then it never runs a workit from the current directory",
  () => {
    const home = tempHome();
    const evil = path.join(home, "evil");
    const marker = path.join(home, "EVIL-RAN");
    write(path.join(evil, "workit"), `#!/bin/sh\ntouch ${marker}\necho 9.0.0\n`, 0o755);
    write(path.join(evil, "rel", "workit"), `#!/bin/sh\ntouch ${marker}\necho 9.0.0\n`, 0o755);
    const cwd = process.cwd();
    process.chdir(evil);
    try {
      const seen = pathResolvedWorkit({ HOME: home, PATH: ".::rel:/usr/bin:/bin" }, "linux");
      expect(seen.path).toBeNull();
      expect(seen.error).toBe("no workit on PATH");
    } finally {
      process.chdir(cwd);
    }
    expect(existsSync(marker)).toBe(false);
  },
);

test("A host plugin launcher is only the plugin's bin/workit (workit.cmd on Windows), never another file in its bin", () => {
  const plugin = path.join(tempHome(), "plugin");
  write(
    path.join(plugin, "package.json"),
    JSON.stringify({ name: "@brainervirus/workit-claude-code", version: "8.0.0" }),
  );
  expect(hostLauncherOf(path.join(plugin, "bin", "workit"), "linux")).toEqual({
    name: "@brainervirus/workit-claude-code",
    version: "8.0.0",
  });
  expect(hostLauncherOf(path.join(plugin, "bin", "workit.cmd"), "win32")?.version).toBe("8.0.0");
  expect(hostLauncherOf(path.join(plugin, "bin", "workit.cmd"), "linux")).toBeNull();
  expect(hostLauncherOf(path.join(plugin, "bin", "node-resolve.mjs"), "linux")).toBeNull();
});

test("Given a script whose heredoc prints `exec node <a real workit>`, Then it is not parsed as a wrapper of that workit", () => {
  const home = tempHome();
  const fnm = fnmNode(home, "v24.1.0", "8.52.3");
  const bin = path.join(home, ".local", "bin");
  const script = path.join(bin, "workit");
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const entry = path.join(fnm.pkg, "dist", "index.js");
  for (const opener of ["<<EOF", "<<'EOF'", '<<"EOF"', "<<-EOF", "<< EOF"]) {
    const text = `#!/bin/sh\ncat ${opener}\nexec node ${entry} "$@"\nEOF\necho done\n`;
    write(script, text, 0o755);
    const found = listInstalls(env, "linux").find((install) => install.path === script);
    expect(found?.kind, opener).toBe("wrapper");
    expect(found?.runs, opener).toBeNull();
    expect(
      migrationCopies(env, "linux").map((copy) => copy.path),
      opener,
    ).not.toContain(script);
  }
  // The exec line after the heredoc still decides.
  write(script, `#!/bin/sh\ncat <<EOF\nusage\nEOF\nexec node ${entry} "$@"\n`, 0o755);
  expect(migrationCopies(env, "linux").find((copy) => copy.path === script)?.runs).toBe(entry);
  // A here-string is not a heredoc: the next line is still read.
  write(script, `#!/bin/sh\ncat <<< "hi"\nexec node ${entry} "$@"\n`, 0o755);
  expect(migrationCopies(env, "linux").find((copy) => copy.path === script)?.runs).toBe(entry);
});

test("Given a foreign file at the launcher path, Then it reads as a foreign file left untouched, never a wrapper of an unknown workit", () => {
  const home = tempHome();
  const bin = path.join(home, ".local", "bin");
  const script = path.join(bin, "workit");
  write(script, "#!/bin/sh\necho my own tool\n", 0o755);
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const found = listInstalls(env, "linux").find((install) => install.path === script)!;
  expect(describeInstallAt(found, script)).toBe(
    `${script} (foreign file, left untouched; move it to let the launcher link there; PATH #1)`,
  );
  expect(describeInstall(found)).toBe(`${script} (foreign file, left untouched; PATH #1)`);
});

test.skipIf(process.platform === "win32")(
  "Given a foreign file at the launcher path, When the upgrade cannot reach the owned launcher, Then the listing calls it a foreign file left untouched and the removal list leaves it out",
  async () => {
    const w = migrationWorld();
    const own = "#!/bin/sh\necho my own tool\n";
    write(w.wrapper, own, 0o755);
    const code = await runUpgradeCommand(["--hosts=none", "--cli", "--yes", "--json"], {
      ...w.deps,
      removeCopies: async () => false,
    });
    expect(code).toBe(1);
    const cli = JSON.parse(w.out.join("")).hosts.find(
      (row: { host: string }) => row.host === "cli",
    );
    const details: string[] = cli.details;
    expect(details).toContain(
      `  ${w.wrapper} (foreign file, left untouched; move it to let the launcher link there; PATH #1)`,
    );
    expect(details.join("\n")).not.toContain("hand-written wrapper");
    const removal = details.slice(
      details.indexOf("other installs left in place; back them up and remove them with:"),
    );
    expect(removal.length).toBeGreaterThan(1);
    expect(removal.join("\n")).not.toContain(w.wrapper);
    expect(readFileSync(w.wrapper, "utf8")).toBe(own);
  },
);
