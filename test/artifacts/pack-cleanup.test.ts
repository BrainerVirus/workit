import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

// Packaging runs used to leak one wk-pack-tarballs-* dir (~3 MB) per pack into
// the OS temp dir. Neither a script (process exit) nor a `bun test` run (the
// global afterAll preload) may leave one behind, including after a forced repack.

const helper = pathToFileURL(path.join(REPO_ROOT, "test/shared/helpers/packages.ts")).href;
const PACK_TWICE = [
  `import { packWorkspacePackages } from ${JSON.stringify(helper)};`,
  `import { existsSync } from "node:fs";`,
  `const first = packWorkspacePackages();`,
  `const second = packWorkspacePackages({ force: true });`,
  `if (![...first, ...second].every((p) => existsSync(p.tarball))) process.exit(3);`,
].join("\n");

const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("wk-pack-"));

const isolatedRun = (args: (tmp: string) => string[]) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "wk-cleanup-probe-"));
  try {
    const run = spawnSync(process.execPath, args(tmp), {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}`, left: leftovers(tmp) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

test("a packaging script leaves no wk-pack-* dirs behind", () => {
  const run = isolatedRun(() => ["--eval", PACK_TWICE]);
  expect(run.status, run.output).toBe(0);
  expect(run.left).toEqual([]);
}, 300_000);

test("a bun test run that packs leaves no wk-pack-* dirs behind", () => {
  const run = isolatedRun((tmp) => {
    const file = path.join(tmp, "probe-pack.test.ts");
    writeFileSync(
      file,
      `import { test } from "bun:test";\n${PACK_TWICE.replace("process.exit(3)", "throw new Error('missing tarball')")}\ntest("packs", () => {});\n`,
    );
    return ["test", file];
  });
  expect(run.status, run.output).toBe(0);
  expect(run.left).toEqual([]);
}, 300_000);
