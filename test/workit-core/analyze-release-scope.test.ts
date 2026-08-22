import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeReleaseScope,
  latestTag,
} from "../../packages/workit-core/scripts/analyze-release-scope";

type Repo = {
  root: string;
  cleanup(): void;
  commit(msg: string, files: Record<string, string>): void;
  tag(name: string): void;
};

function repo(): Repo {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-relscope-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.name", "t"]);
  g(["config", "user.email", "t@t"]);
  writeFileSync(path.join(root, "seed.md"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "chore: seed"]);
  const api: Repo = {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    commit: (msg, files) => {
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), body);
      }
      g(["add", "-A"]);
      g(["commit", "-q", "-m", msg]);
    },
    tag: (name) => g(["tag", name]),
  };
  return api;
}

describe("latestTag", () => {
  test("returns null when no v* tag exists", () => {
    const r = repo();
    try {
      expect(latestTag(r.root)).toBeNull();
    } finally {
      r.cleanup();
    }
  });
  test("returns the newest semver-sorted v* tag", () => {
    const r = repo();
    try {
      r.commit("chore: a", { "x.txt": "a" });
      r.tag("v0.8.9");
      r.commit("chore: b", { "x.txt": "b" });
      r.tag("v0.8.10");
      expect(latestTag(r.root)).toBe("v0.8.10");
    } finally {
      r.cleanup();
    }
  });
  test("skips non-semver v* tags and returns the newest real semver tag", () => {
    const r = repo();
    try {
      r.commit("chore: a", { "a.txt": "a\n" });
      r.tag("v0.8.9");
      r.commit("chore: b", { "b.txt": "b\n" });
      r.tag("vendor-x");
      r.commit("chore: c", { "c.txt": "c\n" });
      r.tag("v0.8.11");
      r.commit("chore: d", { "d.txt": "d\n" });
      r.tag("v10");
      expect(latestTag(r.root)).toBe("v0.8.11");
    } finally {
      r.cleanup();
    }
  });
});

describe("analyzeReleaseScope", () => {
  test("tooling-only commits yield no release", () => {
    const r = repo();
    r.tag("v0.8.11");
    try {
      r.commit("fix(ci): workflow tweak", { ".github/workflows/x.yml": "on: push\n" });
      expect(analyzeReleaseScope(r.root)).toEqual({ level: null, productPkgs: [] });
    } finally {
      r.cleanup();
    }
  });

  test("product fix yields patch scoped to its package", () => {
    const r = repo();
    r.tag("v0.8.11");
    try {
      r.commit("fix(cli): flag parsing", { "packages/workit-cli/src/index.tsx": "export {};\n" });
      expect(analyzeReleaseScope(r.root)).toEqual({ level: "patch", productPkgs: ["workit-cli"] });
    } finally {
      r.cleanup();
    }
  });

  test("feat beats fix; BREAKING beats feat", () => {
    const r = repo();
    r.tag("v0.8.11");
    try {
      r.commit("fix(core): bug", { "packages/workit-core/src/a.ts": "a\n" });
      r.commit("feat(cursor): thing", { "packages/workit-cursor/hooks/h.ts": "h\n" });
      expect(analyzeReleaseScope(r.root).level).toBe("minor");
      r.commit("fix(opencode): boom\n\nBREAKING CHANGE: dropped flag", {
        "packages/workit-opencode/src/b.ts": "b\n",
      });
      expect(analyzeReleaseScope(r.root).level).toBe("major");
    } finally {
      r.cleanup();
    }
  });

  test("conventional !: breaking syntax yields major", () => {
    const r = repo();
    r.tag("v0.8.11");
    try {
      r.commit("feat(cli)!: drop flag", { "packages/workit-cli/src/f.ts": "f\n" });
      expect(analyzeReleaseScope(r.root).level).toBe("major");
    } finally {
      r.cleanup();
    }
  });

  test("!: inside subject body does not imply breaking", () => {
    const r = repo();
    r.tag("v0.8.11");
    try {
      r.commit("fix(cli): parse a!: b", { "packages/workit-cli/src/f.ts": "f\n" });
      expect(analyzeReleaseScope(r.root).level).toBe("patch");
    } finally {
      r.cleanup();
    }
  });

  test("mixed tooling+product counts; squash subjects parse", () => {
    const r = repo();
    r.tag("v0.8.11");
    try {
      r.commit("docs: readme", { "README.md": "# x\n" });
      r.commit("fix(workit-cli): title (#42)", { "packages/workit-cli/src/main.ts": "m\n" });
      expect(analyzeReleaseScope(r.root)).toEqual({ level: "patch", productPkgs: ["workit-cli"] });
    } finally {
      r.cleanup();
    }
  });

  test("first-ever release defaults to minor across all packages", () => {
    const r = repo();
    try {
      r.commit("fix(cli): first", { "packages/workit-cli/src/f.ts": "f\n" });
      expect(analyzeReleaseScope(r.root)).toEqual({
        level: "minor",
        productPkgs: ["workit-core", "workit-opencode", "workit-cursor", "workit-cli"],
      });
    } finally {
      r.cleanup();
    }
  });

  test("merge commit carrying a unique product-path change gates the release", () => {
    const r = repo();
    try {
      const g = (args: string[]) => execFileSync("git", args, { cwd: r.root, encoding: "utf8" });
      // Hotfix released FROM its branch (tag on the branch tip), then merged
      // back to main: the feature commit predates the tag so tag..HEAD holds
      // ONLY the merge commit — its file list must survive collection.
      g(["checkout", "-q", "-b", "hotfix"]);
      r.commit("fix(cli): hotfix payload", { "packages/workit-cli/src/e.ts": "e\n" });
      g(["tag", "v0.8.11"]);
      g(["checkout", "-q", "main"]);
      r.commit("docs: notes", { "docs/x.md": "x\n" });
      g(["merge", "--no-ff", "-q", "-m", "Merge branch 'hotfix'", "hotfix"]);
      expect(analyzeReleaseScope(r.root)).toEqual({ level: null, productPkgs: ["workit-cli"] });
    } finally {
      r.cleanup();
    }
  });

  test("non-ASCII paths survive collection without C-quoting", () => {
    const r = repo();
    r.tag("v0.8.11");
    try {
      r.commit("fix(cli): café", { "packages/workit-cli/src/café.ts": "c\n" });
      expect(analyzeReleaseScope(r.root)).toEqual({ level: "patch", productPkgs: ["workit-cli"] });
    } finally {
      r.cleanup();
    }
  });

  test("BREAKING-CHANGE hyphen alias yields major", () => {
    const r = repo();
    r.tag("v0.8.11");
    try {
      r.commit("fix(cli): boom\n\nBREAKING-CHANGE: dropped flag", {
        "packages/workit-cli/src/h.ts": "h\n",
      });
      expect(analyzeReleaseScope(r.root).level).toBe("major");
    } finally {
      r.cleanup();
    }
  });
});
