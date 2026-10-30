import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliVersionOnDisk } from "@/packages/workit-cli/src/update-settings";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An npm global prefix: `bin/workit` links into lib/node_modules, as npm installs it. */
const npmPrefix = (version: string): string => {
  const prefix = mkdtempSync(path.join(os.tmpdir(), "wk-cli-on-disk-"));
  dirs.push(prefix);
  const pkgDir = path.join(prefix, "lib/node_modules/@brainervirus/workit-cli");
  mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@brainervirus/workit-cli", version }),
  );
  writeFileSync(path.join(pkgDir, "dist/index.js"), "");
  mkdirSync(path.join(prefix, "bin"));
  symlinkSync(
    "../lib/node_modules/@brainervirus/workit-cli/dist/index.js",
    path.join(prefix, "bin/workit"),
  );
  return prefix;
};

// npm on Windows installs .cmd shims that name the real script, not symlinks.
test.skipIf(process.platform === "win32")(
  "Given the CLI launched through npm's bin symlink, When upgrade reads the version on disk, Then it finds the package behind the link",
  () => {
    const prefix = npmPrefix("9.9.9");
    expect(cliVersionOnDisk(path.join(prefix, "bin/workit"))).toBe("9.9.9");
  },
);

test("Given the real entry script, When upgrade reads the version on disk, Then it reads its package.json", () => {
  const prefix = npmPrefix("9.9.9");
  const entry = path.join(prefix, "lib/node_modules/@brainervirus/workit-cli/dist/index.js");
  expect(cliVersionOnDisk(entry)).toBe("9.9.9");
  expect(cliVersionOnDisk(path.join(prefix, "missing.js"))).toBeUndefined();
});
