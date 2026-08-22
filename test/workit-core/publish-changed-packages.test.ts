import { describe, expect, test, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changedPackages,
  publishChanged,
} from "../../packages/workit-core/scripts/publish-changed-packages";

function repo({ tagged = true }: { tagged?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-pubchg-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.name", "t"]);
  g(["config", "user.email", "t@t"]);
  for (const pkg of ["workit-core", "workit-opencode", "workit-cursor", "workit-cli"]) {
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
      r.change("packages/workit-cli/src/i.ts", "c\n");
      expect(changedPackages(r.root, "v0.8.10")).toEqual(["workit-cli"]);
    } finally {
      r.cleanup();
    }
  });
  test("uncommitted working-tree edits are never counted (B1)", () => {
    const r = repo();
    try {
      r.change("packages/workit-cli/src/i.ts", "c\n");
      writeFileSync(path.join(r.root, "packages/workit-opencode/src/i.ts"), "dirty\n");
      expect(changedPackages(r.root, "v0.8.10")).toEqual(["workit-cli"]);
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
      r.change("packages/workit-core/src/i.ts", "c\n");
      const calls: string[] = [];
      const result = publishChanged({
        root: r.root,
        run: (_cmd, args, opts) => {
          calls.push(`${args.join(" ")} @ ${opts.cwd}`);
        },
      });
      expect(result.published).toEqual(["workit-core"]);
      expect(result.skipped).toEqual(["workit-opencode", "workit-cursor", "workit-cli"]);
      expect(calls[0]).toBe(
        `publish --access public @ ${path.join(r.root, "packages/workit-core")}`,
      );
      const log = spyOn(console, "log");
      publishChanged({ root: r.root, run: () => {} });
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        `published workit-core @ ${path.join(r.root, "packages", "workit-core")}`,
        `skip workit-opencode (no payload change since v0.8.10)`,
        `skip workit-cursor (no payload change since v0.8.10)`,
        `skip workit-cli (no payload change since v0.8.10)`,
      ]);
      log.mockRestore();
    } finally {
      r.cleanup();
    }
  });
  test("publish failure logs shipped state, names the package, and stops", () => {
    const r = repo();
    try {
      r.change("packages/workit-core/src/i.ts", "c\n");
      r.change("packages/workit-opencode/src/i.ts", "c\n");
      const log = spyOn(console, "log");
      const ran: string[] = [];
      let err: unknown;
      try {
        publishChanged({
          root: r.root,
          run: (_cmd, _args, opts) => {
            ran.push(opts.cwd);
            if (opts.cwd.endsWith("workit-opencode")) throw new Error("boom");
          },
        });
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).toBe("boom");
      expect(ran).toEqual([
        path.join(r.root, "packages", "workit-core"),
        path.join(r.root, "packages", "workit-opencode"),
      ]);
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        `published workit-core @ ${path.join(r.root, "packages", "workit-core")}`,
        `publish failed workit-opencode: boom`,
      ]);
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
      expect(result.published).toEqual([
        "workit-core",
        "workit-opencode",
        "workit-cursor",
        "workit-cli",
      ]);
      expect(result.skipped).toEqual([]);
      expect(result.tag).toBeNull();
      expect(cwds).toEqual(
        ["workit-core", "workit-opencode", "workit-cursor", "workit-cli"].map((pkg) =>
          path.join(r.root, "packages", pkg),
        ),
      );
      const log = spyOn(console, "log");
      publishChanged({ root: r.root, run: () => {} });
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        `published workit-core @ ${path.join(r.root, "packages", "workit-core")}`,
        `published workit-opencode @ ${path.join(r.root, "packages", "workit-opencode")}`,
        `published workit-cursor @ ${path.join(r.root, "packages", "workit-cursor")}`,
        `published workit-cli @ ${path.join(r.root, "packages", "workit-cli")}`,
      ]);
      log.mockRestore();
    } finally {
      r.cleanup();
    }
  });
  test("dryRun records without invoking npm", () => {
    const r = repo();
    try {
      r.change("packages/workit-cli/src/i.ts", "c\n");
      let ran = 0;
      const result = publishChanged({
        root: r.root,
        dryRun: true,
        run: () => {
          ran++;
        },
      });
      expect(result.published).toEqual(["workit-cli"]);
      expect(ran).toBe(0);
    } finally {
      r.cleanup();
    }
  });
});
