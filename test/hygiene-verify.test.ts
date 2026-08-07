import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const run = (cwd: string, args: string[]) => spawnSync("bash", args, { cwd, encoding: "utf8" });

test("verify passes with valid changelog, fails without", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-verify-"));
  try {
    writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- x\n", "utf8");
    const ok = run(dir, [path.resolve(import.meta.dir, "../scripts/verify-project.sh")]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("CHANGELOG.md format");

    rmSync(path.join(dir, "CHANGELOG.md"));
    const fail = run(dir, [path.resolve(import.meta.dir, "../scripts/verify-project.sh")]);
    expect(fail.status).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verify dry-run skips changelog check", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-verify-dry-"));
  try {
    const run = (args: string[]) => spawnSync("bash", args, { cwd: dir, encoding: "utf8" });
    const result = run([path.resolve(import.meta.dir, "../scripts/verify-project.sh"), "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped (dry run)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
