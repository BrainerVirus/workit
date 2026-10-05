import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { binDirWithRuntimes } from "@/test/shared/helpers/doctor-fixture";

test("doctor checks the OpenCode SDK pin in devDependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-doctor-"));
  try {
    for (const name of ["workit-core", "workit-opencode", "workit-cursor", "workit-cli"])
      mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(
      join(root, "packages", "workit-core", "package.json"),
      JSON.stringify({ name: "core" }),
    );
    for (const name of ["workit-cursor", "workit-cli"])
      writeFileSync(
        join(root, "packages", name, "package.json"),
        JSON.stringify({ dependencies: { "@brainervirus/workit-core": "workspace:*" } }),
      );
    writeFileSync(
      join(root, "packages", "workit-opencode", "package.json"),
      JSON.stringify({
        dependencies: { "@brainervirus/workit-core": "workspace:*" },
        devDependencies: { "@opencode/plugin": "1.0.0" },
      }),
    );
    // Offline and hermetic: only node and bun on PATH, so the doctor's
    // registry (npm view) and provider identity (gh/glab) probes cannot reach
    // the network and stall the test on a slow runner.
    const report = runDoctor({
      host: "opencode",
      dev: root,
      home: root,
      configDir: join(root, "config"),
      env: { ...process.env, HOME: root, PATH: binDirWithRuntimes(root) },
    });
    const versions = report.checks.find((check) => check.id === "versions");
    expect(versions?.status).toBe("fail");
    expect(versions?.detail).toContain("@opencode/plugin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
