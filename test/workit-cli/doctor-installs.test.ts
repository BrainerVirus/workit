// Doctor's cli_installs check (#648): every workit on PATH and in a version
// manager's npm global prefix, by realpath, against the Workit-owned launcher.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { writeLaunchers } from "@/packages/workit-cli/src/install/owned";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const write = (file: string, text: string, mode = 0o644) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, mode);
};

const pkgJson = (version: string) => JSON.stringify({ name: "@brainervirus/workit-cli", version });

/** A home with an owned 9.0.0 (current + launcher linked in ~/.local/bin) and a fnm copy of `copy`. */
const home = (copy: string | null) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-doctor-installs-"));
  homes.push(dir);
  const root = path.join(dir, ".local/share/workit");
  write(
    path.join(root, "versions/9.0.0/node_modules/@brainervirus/workit-cli/package.json"),
    pkgJson("9.0.0"),
  );
  symlinkSync(path.join("versions", "9.0.0"), path.join(root, "current"));
  writeLaunchers({ env: { HOME: dir }, installNode: "/usr/bin/node" });
  const prefix = path.join(dir, ".local/share/fnm/node-versions/v24.1.0/installation");
  write(path.join(prefix, "bin/node"), "", 0o755);
  if (copy) {
    const pkg = path.join(prefix, "lib/node_modules/@brainervirus/workit-cli");
    write(path.join(pkg, "package.json"), pkgJson(copy));
    write(path.join(pkg, "dist/index.js"), "", 0o755);
    symlinkSync(path.join(pkg, "dist/index.js"), path.join(prefix, "bin/workit"));
  }
  return { dir, root, prefix, bin: path.join(dir, ".local/bin") };
};

const check = (dir: string, PATH: string) =>
  runDoctor({
    host: "cli",
    home: dir,
    cwd: dir,
    workspaceRoot: dir,
    configDir: path.join(dir, ".config/workit"),
    stateDir: path.join(dir, ".local/state/workit"),
    env: { HOME: dir, PATH },
    cliVersion: "9.0.0",
  }).checks.find((one) => one.id === "cli_installs")!;

test("Given a workit in another Node's prefix that PATH resolves first, Then doctor fails naming both realpaths and versions, with the removal command", () => {
  const h = home("8.52.3");
  const found = check(h.dir, `${path.join(h.prefix, "bin")}:${h.bin}`);
  expect(found.status).toBe("fail");
  expect(found.detail).toContain(
    `PATH runs ${h.prefix}/bin/workit -> ${h.prefix}/lib/node_modules/@brainervirus/workit-cli/dist/index.js (workit 8.52.3; fnm global prefix ${h.prefix}; PATH #1)`,
  );
  expect(found.detail).toContain(
    `ahead of the launcher ${h.bin}/workit -> ${h.root}/bin/workit (workit 9.0.0)`,
  );
  expect(found.fix).toContain(
    `npm uninstall --global --prefix ${h.prefix} @brainervirus/workit-cli`,
  );
});

test("Given the launcher first but an older copy in a fnm prefix PATH misses, Then doctor still fails on the version", () => {
  const h = home("8.52.3");
  const found = check(h.dir, h.bin);
  expect(found.status).toBe("fail");
  expect(found.detail).toContain("other installs with another version");
  expect(found.detail).toContain("workit 8.52.3; fnm global prefix");
});

test("Given only the owned install, Then doctor passes", () => {
  const h = home(null);
  const found = check(h.dir, `${h.bin}:/usr/bin`);
  expect(found.status, found.detail).toBe("pass");
  expect(found.detail).toBe(
    `workit 9.0.0 via the launcher ${h.bin}/workit -> ${h.root}/bin/workit (workit 9.0.0); no other install`,
  );
});
