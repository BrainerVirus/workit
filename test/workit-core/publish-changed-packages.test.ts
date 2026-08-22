import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changedPackages,
  publishChanged,
} from "../../packages/workit-core/scripts/publish-changed-packages";

type Repo = ReturnType<typeof repo>;
function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-pubchg-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.name", "t"]);
  g(["config", "user.email", "t@t"]);
  for (const pkg of ["workit-core", "workit-opencode", "workit-cursor", "workit-cli"]) {
    mkdirSync(path.join(root, "packages", pkg, "src"), { recursive: true });
    writeFileSync(path.join(root, "packages", pkg, "src", "i.ts"), "i\n");
    writeFileSync(path.join(root, "packages", pkg, "package.json"), `{"name":"@brainervirus/${pkg}","version":"0.8.10"}\n`);
  }
  g(["add", "-A"]); g(["commit", "-q", "-m", "chore: seed"]); g(["tag", "v0.8.10"]);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    change: (rel: string, body: string) => {
      const f = path.join(root, rel);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, body);
    },
  };
}

describe("changedPackages", () => {
  test("lists only packages with payload diffs", () => {
    const r = repo();
    try {
      r.change("packages/workit-cli/src/i.ts", "c\n");
      expect(changedPackages(r.root, "v0.8.10")).toEqual(["workit-cli"]);
    } finally { r.cleanup(); }
  });
  test("manifest-only edits count (dependency bumps are real content)", () => {
    const r = repo();
    try {
      r.change("packages/workit-opencode/package.json", `{"name":"@brainervirus/workit-opencode","version":"0.8.11"}\n`);
      expect(changedPackages(r.root, "v0.8.10")).toEqual(["workit-opencode"]);
    } finally { r.cleanup(); }
  });
  test("non-product roots never appear", () => {
    const r = repo();
    try {
      r.change(".github/workflows/ci.yml", "on: push\n");
      expect(changedPackages(r.root, "v0.8.10")).toEqual([]);
    } finally { r.cleanup(); }
  });
});

describe("publishChanged", () => {
  test("publishes changed, skips unchanged, exact skip line", () => {
    const r = repo();
    try {
      r.change("packages/workit-core/src/i.ts", "c\n");
      const calls: string[] = [];
      const result = publishChanged({
        root: r.root,
        run: (_cmd, args, opts) => { calls.push(`${args.join(" ")} @ ${opts.cwd}`); },
      });
      expect(result.published).toEqual(["workit-core"]);
      expect(result.skipped).toEqual([
        "workit-opencode",
        "workit-cursor",
        "workit-cli",
      ]);
      expect(calls[0]).toBe(`publish --access public @ ${path.join(r.root, "packages/workit-core")}`);
    } finally { r.cleanup(); }
  });
  test("dryRun records without invoking npm", () => {
    const r = repo();
    try {
      r.change("packages/workit-cli/src/i.ts", "c\n");
      let ran = 0;
      const result = publishChanged({ root: r.root, dryRun: true, run: () => { ran++; } });
      expect(result.published).toEqual(["workit-cli"]);
      expect(ran).toBe(0);
    } finally { r.cleanup(); }
  });
});
