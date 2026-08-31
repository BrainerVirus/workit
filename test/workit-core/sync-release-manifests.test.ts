import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncManifests } from "../../packages/workit-core/scripts/sync-release-manifests";

const manifestPaths = [
  "package.json",
  "packages/workit-core/package.json",
  "packages/workit-opencode/package.json",
  "packages/workit-cursor/package.json",
  "packages/workit-cli/package.json",
  "packages/workit-cursor/.cursor-plugin/plugin.json",
];

const fixtureRoot = (versions: Record<string, string>, name = "workflow-toolkit") => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sync-manifests-"));
  for (const rel of manifestPaths) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ name: rel === "package.json" ? name : `pkg-${rel}`, version: versions[rel] ?? "0.1.0" }, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
};

describe("syncManifests", () => {
  test("strips the v prefix and writes every tracked manifest", () => {
    const root = fixtureRoot({ "package.json": "0.4.0" }, "workit");
    try {
      const result = syncManifests(root, "v0.8.9");
      expect(result.changed.sort()).toEqual([...manifestPaths].sort());
      for (const rel of manifestPaths) {
        const parsed = JSON.parse(readFileSync(path.join(root, rel), "utf8"));
        expect(parsed.version).toBe("0.8.9");
      }
      // The root package NAME is never touched by the sync (one-time change).
      expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name).toBe("workit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is a no-op when every manifest already carries the released version", () => {
    const versions = Object.fromEntries(manifestPaths.map((rel) => [rel, "0.8.9"]));
    const root = fixtureRoot(versions);
    try {
      const before = manifestPaths.map((rel) => readFileSync(path.join(root, rel), "utf8"));
      expect(syncManifests(root, "0.8.9").changed).toEqual([]);
      const after = manifestPaths.map((rel) => readFileSync(path.join(root, rel), "utf8"));
      expect(after).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only rewrites drifted manifests in a partially synced tree", () => {
    const root = fixtureRoot({
      "package.json": "0.8.9",
      "packages/workit-cli/package.json": "0.8.9",
    });
    try {
      const result = syncManifests(root, "v0.8.9");
      expect(result.version).toBe("0.8.9");
      expect(result.changed).toEqual([
        "packages/workit-core/package.json",
        "packages/workit-opencode/package.json",
        "packages/workit-cursor/package.json",
        "packages/workit-cursor/.cursor-plugin/plugin.json",
      ]);
      expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version).toBe(
        "0.8.9",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a tag without a leading v or a bare semver-less value", () => {
    const root = fixtureRoot({});
    try {
      expect(() => syncManifests(root, "0.8.9-v2")).not.toThrow();
      expect(() => syncManifests(root, "latest")).toThrow(/invalid version tag/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
