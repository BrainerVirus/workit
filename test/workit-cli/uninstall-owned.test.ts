// `workit uninstall` and the Workit-owned CLI install (W2.32): versions/,
// current, bin/ and the PATH launcher link go; a foreign file at the
// launcher's place stays and is reported. Every case runs on a temp HOME (and
// a temp LOCALAPPDATA for the Windows layout); no path reaches the real data dir.
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyUninstall, planUninstall } from "@/packages/workit-cli/src/admin/uninstall";
import { writeLaunchers } from "@/packages/workit-cli/src/install/owned";
import { ownedPaths } from "@/packages/workit-cli/src/install/paths";

const NODE = Bun.which("node") ?? "node";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tempHome = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-uninstall-owned-"));
  roots.push(root);
  return root;
};

const write = (file: string, text: string, mode = 0o644) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, mode);
};

const present = (file: string): boolean => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/** An owned 9.0.0 the way `workit upgrade` leaves it: versions/9.0.0, current, bin/ and (POSIX) the PATH link. */
const ownedInstall = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => {
  const paths = ownedPaths(env, platform);
  write(
    path.join(paths.versions, "9.0.0", "node_modules/@brainervirus/workit-cli/package.json"),
    JSON.stringify({ name: "@brainervirus/workit-cli", version: "9.0.0" }),
  );
  symlinkSync(path.join(paths.versions, "9.0.0"), paths.current, "junction");
  if (platform === "win32") write(paths.launcher, "@echo off\r\nrem workit-launcher 1\r\n", 0o755);
  else writeLaunchers({ env, platform, installNode: NODE });
  return paths;
};

const cliPlan = (options: Parameters<typeof planUninstall>[0]) =>
  planUninstall(options).hosts.find((host) => host.host === "cli")!;

test.skipIf(process.platform === "win32")(
  "Given an owned install and a launcher link into it, When uninstall applies, Then versions/, current, bin/ and the link are gone and nothing else is touched",
  () => {
    const home = tempHome();
    const env = { HOME: home };
    const paths = ownedInstall(env, "linux");
    expect(lstatSync(paths.linked).isSymbolicLink()).toBe(true);
    // Neighbours that must survive: other data, another tool on PATH, the config.
    const dataCanary = path.join(paths.root, "state-canary.json");
    const binCanary = path.join(path.dirname(paths.linked), "other-tool");
    const config = path.join(home, ".config", "workit", "config.json");
    for (const file of [dataCanary, binCanary, config]) write(file, "keep\n");

    const plan = cliPlan({ home, platform: "linux" });
    expect(plan.installed).toBe(true);
    expect(plan.actions.map((action) => [action.kind, action.path])).toEqual([
      ["remove-owned-cli", paths.linked],
      ["remove-owned-cli", path.dirname(paths.launcher)],
      ["remove-owned-cli", paths.current],
      ["remove-owned-cli", paths.versions],
    ]);

    const result = applyUninstall({ hosts: [plan] }, { home, platform: "linux" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.entries.map((entry) => entry.status)).toEqual([
      "removed",
      "removed",
      "removed",
      "removed",
    ]);
    for (const gone of [paths.linked, path.dirname(paths.launcher), paths.current, paths.versions])
      expect(present(gone), gone).toBe(false);
    for (const kept of [dataCanary, binCanary, config])
      expect(readFileSync(kept, "utf8"), kept).toBe("keep\n");
    expect(readdirSync(paths.root)).toEqual(["state-canary.json"]);
    // Nothing left: the next plan has no CLI actions.
    expect(cliPlan({ home, platform: "linux" })).toEqual({
      host: "cli",
      installed: false,
      actions: [],
    });
  },
);

test.skipIf(process.platform === "win32")(
  "Given a foreign file at the launcher path, When uninstall applies, Then it stays byte-identical and the result says so",
  () => {
    const home = tempHome();
    const env = { HOME: home, XDG_DATA_HOME: path.join(home, "data") };
    const paths = ownedInstall(env, "darwin");
    rmSync(paths.linked);
    const own = "#!/bin/sh\necho my own tool\n";
    write(paths.linked, own, 0o755);

    const plan = cliPlan({ env, platform: "darwin" });
    expect(plan.actions[0]).toEqual({
      kind: "keep-foreign",
      path: paths.linked,
      detail:
        "foreign file at the launcher path, left untouched; move it to let the launcher link there",
    });
    const result = applyUninstall({ hosts: [plan] }, { env, platform: "darwin" });
    expect(result.ok).toBe(true);
    expect(result.entries[0]).toEqual({
      host: "cli",
      path: paths.linked,
      status: "skipped",
      detail:
        "foreign file at the launcher path, left untouched; move it to let the launcher link there",
    });
    expect(readFileSync(paths.linked, "utf8")).toBe(own);
    expect(present(paths.versions) || present(paths.current)).toBe(false);
  },
);

test.skipIf(process.platform === "win32")(
  "Given a link at the launcher path into another workit, Then uninstall keeps the link",
  () => {
    const home = tempHome();
    const env = { HOME: home };
    const paths = ownedInstall(env, "linux");
    const other = path.join(home, "elsewhere", "workit");
    write(other, "#!/bin/sh\n", 0o755);
    rmSync(paths.linked);
    symlinkSync(other, paths.linked);
    const plan = cliPlan({ home, platform: "linux" });
    expect(plan.actions[0]?.kind).toBe("keep-foreign");
    applyUninstall({ hosts: [plan] }, { home, platform: "linux" });
    expect(lstatSync(paths.linked).isSymbolicLink()).toBe(true);
    expect(existsSync(other)).toBe(true);
  },
);

test("Given the Windows layout (launcher in the install's bin, no PATH link), When uninstall applies, Then the install dirs go and the PATH entry is named for the person to drop", () => {
  const home = tempHome();
  const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local") };
  const paths = ownedInstall(env, "win32");
  expect(paths.linked).toBe(paths.launcher);
  const plan = cliPlan({ env, platform: "win32" });
  expect(plan.actions.map((action) => action.path)).toEqual([
    path.dirname(paths.launcher),
    paths.current,
    paths.versions,
  ]);
  expect(plan.actions[0]?.detail).toContain("drop its directory from your PATH");
  const result = applyUninstall({ hosts: [plan] }, { env, platform: "win32" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(readdirSync(paths.root)).toEqual([]);
});

test("Given a plan whose CLI path was changed after review, Then apply refuses it and removes nothing", () => {
  const home = tempHome();
  const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local") };
  const paths = ownedInstall(env, "win32");
  const victim = path.join(home, "Documents");
  write(path.join(victim, "notes.txt"), "mine\n");
  const result = applyUninstall(
    {
      hosts: [
        {
          host: "cli",
          installed: true,
          actions: [{ kind: "remove-owned-cli", part: "versions", path: victim, detail: "x" }],
        },
      ],
    },
    { env, platform: "win32" },
  );
  expect(result.ok).toBe(false);
  expect(result.entries[0]?.detail).toContain("not the owned install");
  expect(readFileSync(path.join(victim, "notes.txt"), "utf8")).toBe("mine\n");
  expect(existsSync(paths.versions)).toBe(true);
});

test("Given only a fixture home, Then the CLI plan never reads the ambient data dir", () => {
  const home = tempHome();
  const saved = process.env.WORKIT_INSTALL_ROOT;
  process.env.WORKIT_INSTALL_ROOT = path.join(home, "ambient");
  try {
    mkdirSync(path.join(home, "ambient", "versions"), { recursive: true });
    expect(cliPlan({ home }).actions).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.WORKIT_INSTALL_ROOT;
    else process.env.WORKIT_INSTALL_ROOT = saved;
  }
});
