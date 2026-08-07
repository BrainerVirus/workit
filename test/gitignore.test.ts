import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureProjectGitignore, GITIGNORE_ENTRIES } from "../src/core/gitignore";

test("creates .gitignore with common entries when missing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-gitignore-"));
  try {
    const result = ensureProjectGitignore(dir, true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toContain("docs/*/sdd/");
      expect(result.added).toContain(".DS_Store");
      const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
      expect(content).toContain("docs/*/sdd/");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("appends only missing entries, preserves existing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-gitignore-keep-"));
  try {
    writeFileSync(path.join(dir, ".gitignore"), "# custom\nmy-secret.txt\n", "utf8");
    const result = ensureProjectGitignore(dir, true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toContain("docs/*/sdd/");
      expect(result.added).not.toContain("my-secret.txt");
      const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
      expect(content).toContain("# custom");
      expect(content).toContain("my-secret.txt");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("requires confirmed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-gitignore-conf-"));
  try {
    const no = ensureProjectGitignore(dir, false);
    expect(no.ok).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
