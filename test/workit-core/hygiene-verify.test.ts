import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runVerifyProject } from "../../packages/workit-core/src/core/verify-project";

test("verify passes with valid changelog, fails without", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-verify-"));
  try {
    writeFileSync(
      path.join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- x\n",
      "utf8",
    );
    const ok = runVerifyProject(dir);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("CHANGELOG.md format");

    rmSync(path.join(dir, "CHANGELOG.md"));
    const fail = runVerifyProject(dir);
    expect(fail.exitCode).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify dry-run skips changelog check", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-verify-dry-"));
  try {
    const result = runVerifyProject(dir, true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("skipped (dry run)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
