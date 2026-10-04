// BUNDLED_SOURCES must cover every workspace source a published dist/
// inlines: each build entry is bundled with a metafile, and every input from
// another workspace package must fall under that package's payload paths,
// or a change there would ship without republishing the bundle. Inlined
// third-party packages must match the BUNDLED_DEPS inventory exactly.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUNDLED_DEPS,
  BUNDLED_SOURCES,
  lockResolutions,
  payloadPaths,
  RELEASE_PACKAGES,
} from "@/packages/workit-core/scripts/analyze-release-scope";

/** bun.lock `packages` key for a bundled node_modules input path. */
const lockKey = (rel: string): string =>
  rel
    .split("node_modules/")
    .slice(1)
    .map((segment) => {
      const parts = segment.split("/");
      return (parts[0].startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
    })
    .join("/");

const ROOT = path.resolve(import.meta.dir, "../..");

// The dist entries each package's scripts/build.ts bundles (core ships sources).
const BUILD_ENTRIES: Record<Exclude<(typeof RELEASE_PACKAGES)[number], "workit-core">, string[]> = {
  "workit-mcp": ["src/index.ts"],
  "workit-cli": ["src/main.ts"],
  "workit-opencode": ["src/index.ts"],
  "workit-cursor": ["mcp/run-server.ts", "hooks/session-start.ts", "hooks/workit-hook.ts"],
  "workit-codex": ["hooks/workit-hook.ts", "scripts/launch-mcp.ts"],
  "workit-pi": ["extensions/workit.ts", "src/worker.ts"],
  "workit-claude-code": ["src/hook.ts", "../workit-cli/src/main.ts"],
};

test("every workspace source a dist/ inlines is in its package's payload paths", () => {
  const out = mkdtempSync(path.join(tmpdir(), "workit-bundled-sources-"));
  try {
    const uncovered: string[] = [];
    const inlined: Record<string, Set<string>> = {};
    for (const [pkg, entries] of Object.entries(BUILD_ENTRIES)) {
      for (const [index, entry] of entries.entries()) {
        const metafile = path.join(out, `${pkg}-${index}.json`);
        const built = spawnSync(
          process.execPath,
          [
            "build",
            path.join(ROOT, "packages", pkg, entry),
            "--target",
            "node",
            "--outdir",
            path.join(out, `${pkg}-${index}`),
            `--metafile=${metafile}`,
          ],
          { cwd: ROOT, encoding: "utf8" },
        );
        expect(built.status, built.stderr).toBe(0);
        const covered = payloadPaths(pkg as keyof typeof BUILD_ENTRIES);
        for (const input of Object.keys(JSON.parse(readFileSync(metafile, "utf8")).inputs)) {
          const rel = path.relative(ROOT, path.resolve(ROOT, input)).split(path.sep).join("/");
          // Inlined third-party code: record its bun.lock key
          // (node_modules chain, e.g. `@opencode-ai/plugin/zod`).
          if (rel.includes("node_modules/")) {
            inlined[pkg] ??= new Set();
            inlined[pkg].add(lockKey(rel));
            continue;
          }
          if (!rel.startsWith("packages/")) continue;
          if (!covered.some((prefix) => rel.startsWith(prefix))) uncovered.push(`${pkg}: ${rel}`);
        }
      }
    }
    expect(uncovered).toEqual([]);
    // The checked-in inventory must equal what the bundles inline, so a
    // version change of any inlined package republishes exactly them.
    const actual = Object.fromEntries(
      Object.keys(BUILD_ENTRIES).map((pkg) => [pkg, [...(inlined[pkg] ?? [])].toSorted()]),
    );
    expect(actual).toEqual(BUNDLED_DEPS);
    // Every inventory key resolves in the current lockfile.
    const lock = lockResolutions(readFileSync(path.join(ROOT, "bun.lock"), "utf8"));
    for (const keys of Object.values(BUNDLED_DEPS))
      for (const key of keys ?? []) expect(lock.has(key), key).toBe(true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 120_000);

test("every adapter bundles core, so a core change republishes all of them", () => {
  for (const pkg of RELEASE_PACKAGES.filter((name) => name !== "workit-core"))
    expect(BUNDLED_SOURCES[pkg], pkg).toContain("packages/workit-core/");
});
