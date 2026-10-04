import { describe, expect, test, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changedPackages,
  publishChanged,
} from "@/packages/workit-core/scripts/publish-changed-packages";
import { RELEASE_PACKAGES } from "@/packages/workit-core/scripts/analyze-release-scope";

function repo({ tagged = true }: { tagged?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-pubchg-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.name", "t"]);
  g(["config", "user.email", "t@t"]);
  for (const pkg of RELEASE_PACKAGES) {
    mkdirSync(path.join(root, "packages", pkg, "src"), { recursive: true });
    writeFileSync(path.join(root, "packages", pkg, "src", "i.ts"), "i\n");
    writeFileSync(
      path.join(root, "packages", pkg, "package.json"),
      `{"name":"@brainervirus/${pkg}","version":"0.8.10"}\n`,
    );
  }
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "chore: seed"]);
  if (tagged) g(["tag", "v0.8.10"]);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    change: (rel: string, body: string) => {
      const f = path.join(root, rel);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, body);
      // B1: acceptance tests exercise committed diffs — changedPackages must
      // never see unreviewed working-tree edits.
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "chore: change"]);
    },
  };
}

describe("changedPackages", () => {
  test("lists only packages with payload diffs", () => {
    const r = repo();
    try {
      r.change("packages/workit-opencode/src/i.ts", "c\n");
      expect(changedPackages(r.root, "v0.8.10")).toEqual(["workit-opencode"]);
    } finally {
      r.cleanup();
    }
  });
  test("uncommitted working-tree edits are never counted (B1)", () => {
    const r = repo();
    try {
      r.change("packages/workit-opencode/src/i.ts", "c\n");
      writeFileSync(path.join(r.root, "packages/workit-opencode/src/i.ts"), "dirty\n");
      expect(changedPackages(r.root, "v0.8.10")).toEqual(["workit-opencode"]);
    } finally {
      r.cleanup();
    }
  });
  test("manifest-only edits count (dependency bumps are real content)", () => {
    const r = repo();
    try {
      r.change(
        "packages/workit-opencode/package.json",
        `{"name":"@brainervirus/workit-opencode","version":"0.8.11"}\n`,
      );
      expect(changedPackages(r.root, "v0.8.10")).toEqual(["workit-opencode"]);
    } finally {
      r.cleanup();
    }
  });
  test("non-product roots never appear", () => {
    const r = repo();
    try {
      r.change(".github/workflows/ci.yml", "on: push\n");
      expect(changedPackages(r.root, "v0.8.10")).toEqual([]);
    } finally {
      r.cleanup();
    }
  });
});

describe("publishChanged", () => {
  test("publishes changed, skips unchanged, exact skip line", () => {
    const r = repo();
    try {
      r.change("packages/workit-opencode/src/i.ts", "c\n");
      const calls: string[] = [];
      const result = publishChanged({
        root: r.root,
        run: (_cmd, args, opts) => {
          calls.push(`${args.join(" ")} @ ${opts.cwd}`);
        },
      });
      const others = RELEASE_PACKAGES.filter((pkg) => pkg !== "workit-opencode");
      expect(result.published).toEqual(["workit-opencode"]);
      expect(result.skipped).toEqual(others);
      expect(calls[0]).toBe(
        `publish --access public @ ${path.join(r.root, "packages/workit-opencode")}`,
      );
      const log = spyOn(console, "log");
      publishChanged({ root: r.root, run: () => {} });
      expect(log.mock.calls.map((c) => c[0])).toEqual(
        RELEASE_PACKAGES.map((pkg) =>
          pkg === "workit-opencode"
            ? `published workit-opencode @ ${path.join(r.root, "packages", "workit-opencode")}`
            : `skip ${pkg} (no payload change since v0.8.10)`,
        ),
      );
      log.mockRestore();
    } finally {
      r.cleanup();
    }
  });
  test("bundling packages republish when the core, MCP or CLI sources they inline change", () => {
    const r = repo();
    try {
      r.change("packages/workit-core/src/i.ts", "c\n");
      // Every adapter inlines core into its dist/ (BUNDLED_SOURCES).
      expect(changedPackages(r.root, "v0.8.10")).toEqual([...RELEASE_PACKAGES]);
      const r2 = repo();
      try {
        r2.change("packages/workit-cli/src/i.ts", "c\n");
        expect(changedPackages(r2.root, "v0.8.10")).toEqual(["workit-cli", "workit-claude-code"]);
        r2.change("packages/workit-mcp/src/i.ts", "c\n");
        expect(changedPackages(r2.root, "v0.8.10")).toEqual([
          "workit-mcp",
          "workit-cli",
          "workit-cursor",
          "workit-codex",
          "workit-claude-code",
        ]);
      } finally {
        r2.cleanup();
      }
    } finally {
      r.cleanup();
    }
  });
  test("a lockfile change republishes every package that inlines third-party code", () => {
    const r = repo();
    try {
      r.change("bun.lock", "{}\n");
      expect(changedPackages(r.root, "v0.8.10")).toEqual(
        RELEASE_PACKAGES.filter((pkg) => pkg !== "workit-core"),
      );
    } finally {
      r.cleanup();
    }
  });
  test("a publish failure does not stop the others; failures throw at the end with a summary", () => {
    const r = repo();
    try {
      r.change("packages/workit-mcp/src/i.ts", "c\n");
      r.change("packages/workit-opencode/src/i.ts", "c\n");
      const log = spyOn(console, "log");
      const ran: string[] = [];
      let err: unknown;
      try {
        publishChanged({
          root: r.root,
          run: (_cmd, _args, opts) => {
            ran.push(path.basename(opts.cwd));
            if (opts.cwd.endsWith("workit-opencode")) throw new Error("boom");
          },
        });
      } catch (e) {
        err = e;
      }
      expect(ran).toEqual(["workit-mcp", "workit-opencode", "workit-cursor", "workit-codex"]);
      const message = (err as Error).message;
      expect(message).toContain("publish failed for 1 package(s): workit-opencode");
      expect(message).toContain("published: workit-mcp, workit-cursor, workit-codex");
      expect(message).toContain("npm token");
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("publish failed workit-opencode: boom");
      expect(lines.at(-1)).toBe(message);
      log.mockRestore();
    } finally {
      r.cleanup();
    }
  });
  test("first-ever release ships everything when no v* tag exists", () => {
    const r = repo({ tagged: false });
    try {
      const cwds: string[] = [];
      const result = publishChanged({
        root: r.root,
        run: (_cmd, _args, opts) => {
          cwds.push(opts.cwd);
        },
      });
      expect(result.published).toEqual([...RELEASE_PACKAGES]);
      expect(result.skipped).toEqual([]);
      expect(result.tag).toBeNull();
      expect(cwds).toEqual(RELEASE_PACKAGES.map((pkg) => path.join(r.root, "packages", pkg)));
      const log = spyOn(console, "log");
      publishChanged({ root: r.root, run: () => {} });
      expect(log.mock.calls.map((c) => c[0])).toEqual(
        RELEASE_PACKAGES.map((pkg) => `published ${pkg} @ ${path.join(r.root, "packages", pkg)}`),
      );
      log.mockRestore();
    } finally {
      r.cleanup();
    }
  });
  test("explicit fromTag wins over latestTag (semantic-release tags the release before publish)", () => {
    const r = repo();
    try {
      // Real CI ordering: product changes land, then semantic-release creates
      // the NEW release tag on HEAD before publish plugins run — diffing
      // against latestTag() at that point is always empty.
      r.change("packages/workit-opencode/src/i.ts", "c\n");
      execFileSync("git", ["tag", "v0.9.0"], { cwd: r.root });
      const calls: string[] = [];
      const result = publishChanged({
        root: r.root,
        fromTag: "v0.8.10",
        run: (_cmd, args, opts) => {
          calls.push(`${args.join(" ")} @ ${opts.cwd}`);
        },
      });
      expect(result.published).toEqual(["workit-opencode"]);
      expect(result.skipped).toEqual(RELEASE_PACKAGES.filter((pkg) => pkg !== "workit-opencode"));
      expect(result.tag).toBe("v0.8.10");
      expect(calls[0]).toBe(
        `publish --access public @ ${path.join(r.root, "packages/workit-opencode")}`,
      );
    } finally {
      r.cleanup();
    }
  });
  test("dryRun records without invoking npm", () => {
    const r = repo();
    try {
      r.change("packages/workit-opencode/src/i.ts", "c\n");
      let ran = 0;
      const result = publishChanged({
        root: r.root,
        dryRun: true,
        run: () => {
          ran++;
        },
      });
      expect(result.published).toEqual(["workit-opencode"]);
      expect(ran).toBe(0);
    } finally {
      r.cleanup();
    }
  });
});
