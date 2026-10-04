import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");
const HOOK_ENTRIES = [
  "packages/workit-codex/hooks/workit-hook.ts",
  "packages/workit-cursor/hooks/workit-hook.ts",
  "packages/workit-core/src/hooks/run.ts",
  "packages/workit-claude-code/src/hook.ts",
];
// Minified bytes. The design target is 300 KB; today's floor is the task
// engine plus zod that compact task context needs (~585 KB), so this pins the
// current size as a regression ceiling until that graph is split. S9b raised
// it by 10 KB: close gates now evaluate CLI-observed checks (worktree tree key
// from git/rev.ts, named-check config from check-config.ts).
const BUDGET = 630_000;
const FORBIDDEN = /\/(doctor|setup|setup-state|uninstall|host-install|init)\.ts$|\/src\/core\.ts$/;

test("a hook bundle loads no doctor/setup modules or the core barrel, within its size budget", () => {
  const out = mkdtempSync(path.join(tmpdir(), "workit-hook-bundle-"));
  try {
    for (const [index, entry] of HOOK_ENTRIES.entries()) {
      const metafile = path.join(out, `meta-${index}.json`);
      const outfile = path.join(out, `bundle-${index}.js`);
      const built = spawnSync(
        process.execPath,
        [
          "build",
          path.join(ROOT, entry),
          "--target",
          "node",
          "--minify",
          "--outfile",
          outfile,
          `--metafile=${metafile}`,
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);
      const inputs = Object.keys(JSON.parse(readFileSync(metafile, "utf8")).inputs).map((input) =>
        input.replaceAll("\\", "/"),
      );
      expect(
        inputs.some((input) => input.includes("workit-core/src/hooks/handle.ts")),
        entry,
      ).toBe(true);
      expect(
        inputs.filter((input) => FORBIDDEN.test(input)),
        entry,
      ).toEqual([]);
      expect(statSync(outfile).size, entry).toBeLessThanOrEqual(BUDGET);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// S18: setup/doctor/upgrade/uninstall/host-install live in the CLI package
// (src/admin), so no host plugin or MCP server may bundle them either.
const PLUGIN_ENTRIES = [
  "packages/workit-opencode/src/index.ts",
  "packages/workit-mcp/src/index.ts",
  "packages/workit-cursor/mcp/run-server.ts",
  "packages/workit-pi/extensions/workit.ts",
  "packages/workit-pi/src/worker.ts",
];
const ADMIN =
  /\/workit-cli\/src\/admin\/|\/(doctor|setup|setup-state|uninstall|host-install|registration|detect-hosts)\.ts$/;

test("a host plugin or MCP bundle loads no setup/doctor/admin modules", () => {
  const out = mkdtempSync(path.join(tmpdir(), "workit-plugin-bundle-"));
  try {
    for (const [index, entry] of PLUGIN_ENTRIES.entries()) {
      const metafile = path.join(out, `meta-${index}.json`);
      const built = spawnSync(
        process.execPath,
        [
          "build",
          path.join(ROOT, entry),
          "--target",
          "node",
          "--outfile",
          path.join(out, `bundle-${index}.js`),
          `--metafile=${metafile}`,
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);
      const inputs = Object.keys(JSON.parse(readFileSync(metafile, "utf8")).inputs).map((input) =>
        input.replaceAll("\\", "/"),
      );
      expect(
        inputs.filter((input) => ADMIN.test(input)),
        entry,
      ).toEqual([]);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
