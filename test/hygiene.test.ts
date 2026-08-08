import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hygieneFiles, ensureHygieneFiles } from "../packages/workit/src/core/hygiene";

test("all files missing on a fresh dir", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-"));
  try {
    const { state } = hygieneFiles(dir);
    expect(state["CHANGELOG.md"]).toBe("missing");
    expect(state["README.md"]).toBe("missing");
    expect(state[".editorconfig"]).toBe("missing");
    expect(state[".gitattributes"]).toBe("missing");
    expect(state.LICENSE).toBe("skip");
    expect(state["CONTRIBUTING.md"]).toBe("skip");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("valid changelog is ok, malformed is invalid", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-ch-"));
  try {
    writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- x\n", "utf8");
    expect(hygieneFiles(dir).state["CHANGELOG.md"]).toBe("ok");

    writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## [1.0.0]\n\n### Added\n\n- x\n", "utf8");
    expect(hygieneFiles(dir).state["CHANGELOG.md"]).toBe("invalid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("openSource heuristic: LICENSE present or private false", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-os-"));
  try {
    writeFileSync(path.join(dir, "LICENSE"), "MIT\n", "utf8");
    expect(hygieneFiles(dir).openSource).toBe(true);

    const dir2 = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-os2-"));
    writeFileSync(path.join(dir2, "package.json"), JSON.stringify({ private: false }), "utf8");
    expect(hygieneFiles(dir2).openSource).toBe(true);
    rmSync(dir2, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ensure creates missing files, preserves existing, requires confirmed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-ensure-"));
  try {
    writeFileSync(path.join(dir, "README.md"), "# Custom README\n", "utf8");
    const no = ensureHygieneFiles(dir, { confirmed: false });
    expect(no.ok).toBe(false);

    const result = ensureHygieneFiles(dir, { confirmed: true, includeOpenSource: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toContain("CHANGELOG.md");
      expect(result.created).toContain(".editorconfig");
      expect(result.created).toContain("LICENSE");
      expect(result.created).not.toContain("README.md");
    }
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# Custom README\n");
    expect(readFileSync(path.join(dir, "CHANGELOG.md"), "utf8")).toContain("## [Unreleased]");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("openSource heuristic: missing private field is public (npm default)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-os3-"));
  try {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }), "utf8");
    expect(hygieneFiles(dir).openSource).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ensure LICENSE uses package.json author when present", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-auth-"));
  try {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", author: "Jane Doe" }), "utf8");
    const result = ensureHygieneFiles(dir, { confirmed: true, includeOpenSource: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const license = readFileSync(path.join(dir, "LICENSE"), "utf8");
      expect(license).toContain("Jane Doe");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
