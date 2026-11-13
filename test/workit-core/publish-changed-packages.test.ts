import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changedPackages,
  cliOptions,
  publishChanged,
  publishOrder,
  registryBaseTag,
} from "@/packages/workit-core/scripts/publish-changed-packages";
import { npmName, RELEASE_PACKAGES } from "@/packages/workit-core/scripts/analyze-release-scope";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

// The fixture packages declare no internal dependencies, so the publish order
// is the release list with workit-cli moved last (W2.38).
const ORDER = [...RELEASE_PACKAGES.filter((pkg) => pkg !== "workit-cli"), "workit-cli"];

/** `npm view <name>@<version> version` for a package the registry already serves: the version. */
const visible = (args: string[]): string => `${args[1].slice(args[1].lastIndexOf("@") + 1)}\n`;

// Measured over 15 s per test on loaded Windows runners (#415).
if (process.platform === "win32") setDefaultTimeout(60_000);

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
      `{"name":"${npmName(pkg)}","version":"0.8.10"}\n`,
    );
  }
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "chore: seed"]);
  if (tagged) g(["tag", "workit-dev-v0.8.10"]);
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
      expect(changedPackages(r.root, "workit-dev-v0.8.10")).toEqual(["workit-opencode"]);
    } finally {
      r.cleanup();
    }
  });
  test("uncommitted working-tree edits are never counted (B1)", () => {
    const r = repo();
    try {
      r.change("packages/workit-opencode/src/i.ts", "c\n");
      writeFileSync(path.join(r.root, "packages/workit-opencode/src/i.ts"), "dirty\n");
      expect(changedPackages(r.root, "workit-dev-v0.8.10")).toEqual(["workit-opencode"]);
    } finally {
      r.cleanup();
    }
  });
  test("manifest-only edits count (dependency bumps are real content)", () => {
    const r = repo();
    try {
      r.change(
        "packages/workit-opencode/package.json",
        `{"name":"@workit-dev/opencode","version":"0.8.11"}\n`,
      );
      expect(changedPackages(r.root, "workit-dev-v0.8.10")).toEqual(["workit-opencode"]);
    } finally {
      r.cleanup();
    }
  });
  test("non-product roots never appear", () => {
    const r = repo();
    try {
      r.change(".github/workflows/ci.yml", "on: push\n");
      expect(changedPackages(r.root, "workit-dev-v0.8.10")).toEqual([]);
    } finally {
      r.cleanup();
    }
  });
  test("a changed package republishes the internal packages it depends on (#386)", () => {
    const r = repo();
    try {
      // The real CLI depends on workit-cursor; release rewrites the range to
      // ^<new version>, so workit-cursor must publish that version too.
      r.change(
        "packages/workit-cli/package.json",
        `{"name":"@workit-dev/cli","version":"0.8.10","dependencies":{"@workit-dev/cursor":"workspace:*"}}\n`,
      );
      expect(changedPackages(r.root, "workit-dev-v0.8.10")).toEqual([
        "workit-cli",
        "workit-cursor",
        "workit-claude-code",
      ]);
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
      const others = ORDER.filter((pkg) => pkg !== "workit-opencode");
      expect(result.published).toEqual(["workit-opencode"]);
      expect(result.skipped).toEqual(others);
      expect(calls[0]).toBe(
        `publish --access public @ ${path.join(r.root, "packages/workit-opencode")}`,
      );
      const log = spyOn(console, "log");
      publishChanged({ root: r.root, run: () => {} });
      expect(log.mock.calls.map((c) => c[0])).toEqual(
        ORDER.map((pkg) =>
          pkg === "workit-opencode"
            ? `published workit-opencode @ ${path.join(r.root, "packages", "workit-opencode")}`
            : `skip ${pkg} (no payload change since workit-dev-v0.8.10)`,
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
      expect(changedPackages(r.root, "workit-dev-v0.8.10")).toEqual([...RELEASE_PACKAGES]);
      const r2 = repo();
      try {
        r2.change("packages/workit-cli/src/i.ts", "c\n");
        expect(changedPackages(r2.root, "workit-dev-v0.8.10")).toEqual([
          "workit-cli",
          "workit-claude-code",
        ]);
        r2.change("packages/workit-mcp/src/i.ts", "c\n");
        expect(changedPackages(r2.root, "workit-dev-v0.8.10")).toEqual([
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
  test("a dev-tooling lockfile bump releases nothing; an inlined dep bump republishes its bundlers", () => {
    const r = repo();
    const lock = (versions: Record<string, string>) =>
      `{\n  "lockfileVersion": 1,\n  "packages": {\n${Object.entries(versions)
        .map(([name, version]) => `    "${name}": ["${name}@${version}", "", {}, "sha512-x"],\n`)
        .join("")}  }\n}\n`;
    try {
      r.change("bun.lock", lock({ zod: "4.6.5", oxlint: "1.86.0", ink: "7.1.1" }));
      const r0 = r.root;
      execFileSync("git", ["tag", "-f", "workit-dev-v0.8.10"], { cwd: r0 });
      r.change("bun.lock", lock({ zod: "4.6.5", oxlint: "1.87.0", ink: "7.1.1" }));
      expect(changedPackages(r0, "workit-dev-v0.8.10")).toEqual([]);
      r.change("bun.lock", lock({ zod: "4.7.0", oxlint: "1.87.0", ink: "7.1.1" }));
      // Every adapter inlines zod (through core); core ships sources.
      expect(changedPackages(r0, "workit-dev-v0.8.10")).toEqual(
        RELEASE_PACKAGES.filter((pkg) => pkg !== "workit-core"),
      );
      execFileSync("git", ["tag", "-f", "workit-dev-v0.8.10"], { cwd: r0 });
      r.change("bun.lock", lock({ zod: "4.7.0", oxlint: "1.87.0", ink: "7.2.0" }));
      // ink is inlined only by the bundled CLI.
      expect(changedPackages(r0, "workit-dev-v0.8.10")).toEqual([
        "workit-cli",
        "workit-claude-code",
      ]);
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
          pause: () => {},
          run: (_cmd, args, opts) => {
            ran.push(`${args[0]} ${path.basename(opts.cwd)}`);
            if (opts.cwd.endsWith("workit-opencode")) throw new Error("boom");
          },
        });
      } catch (e) {
        err = e;
      }
      // The failed package is checked on the registry and retried once.
      expect(ran).toEqual([
        "publish workit-mcp",
        "publish workit-opencode",
        "view workit-opencode",
        "publish workit-opencode",
        "view workit-opencode",
        "publish workit-cursor",
        "publish workit-codex",
      ]);
      const message = (err as Error).message;
      expect(message).toContain("publish failed for 1 package(s): workit-opencode");
      expect(message).toContain("published: workit-mcp, workit-cursor, workit-codex");
      expect(message).toContain("trusted publisher");
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("publish failed workit-opencode: boom");
      expect(lines.at(-1)).toBe(message);
      log.mockRestore();
    } finally {
      r.cleanup();
    }
  });
  test("first-ever release ships everything when no workit-dev-v* tag exists", () => {
    const r = repo({ tagged: false });
    try {
      const cwds: string[] = [];
      const result = publishChanged({
        root: r.root,
        run: (_cmd, args, opts) => {
          if (args[0] === "view") return visible(args);
          cwds.push(opts.cwd);
        },
      });
      expect(result.published).toEqual(ORDER);
      expect(result.skipped).toEqual([]);
      expect(result.tag).toBeNull();
      expect(cwds).toEqual(ORDER.map((pkg) => path.join(r.root, "packages", pkg)));
      const log = spyOn(console, "log");
      publishChanged({ root: r.root, run: (_cmd, args) => visible(args) });
      expect(log.mock.calls.map((c) => c[0])).toEqual(
        ORDER.map((pkg) => `published ${pkg} @ ${path.join(r.root, "packages", pkg)}`),
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
      execFileSync("git", ["tag", "workit-dev-v0.9.0"], { cwd: r.root });
      const calls: string[] = [];
      const result = publishChanged({
        root: r.root,
        fromTag: "workit-dev-v0.8.10",
        run: (_cmd, args, opts) => {
          calls.push(`${args.join(" ")} @ ${opts.cwd}`);
        },
      });
      expect(result.published).toEqual(["workit-opencode"]);
      expect(result.skipped).toEqual(ORDER.filter((pkg) => pkg !== "workit-opencode"));
      expect(result.tag).toBe("workit-dev-v0.8.10");
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

describe("publishChanged recovers a failed npm publish (v8.41.0)", () => {
  const TLOG =
    "npm error code TLOG_CREATE_ENTRY_ERROR\nnpm error (409) an equivalent entry already exists in the transparency log";

  // One changed package (workit-opencode at 0.8.10); `script` answers each
  // npm call in order and records it.
  function attempt(script: Array<string | Error>) {
    const r = repo();
    r.change("packages/workit-opencode/src/i.ts", "c\n");
    const calls: string[] = [];
    const pauses: number[] = [];
    const log = spyOn(console, "log");
    try {
      const result = publishChanged({
        root: r.root,
        pause: (ms) => pauses.push(ms),
        run: (cmd, args) => {
          calls.push(`${cmd} ${args.join(" ")}`);
          const next = script.shift();
          if (next instanceof Error) throw next;
          return next ?? "";
        },
      });
      return { result, calls, pauses, lines: log.mock.calls.map((c) => String(c[0])) };
    } catch (error) {
      return {
        error: error as Error,
        calls,
        pauses,
        lines: log.mock.calls.map((c) => String(c[0])),
      };
    } finally {
      log.mockRestore();
      r.cleanup();
    }
  }
  const PUBLISH = "npm publish --access public";
  const VIEW = "npm view @workit-dev/opencode@0.8.10 version";

  test("a failed publish whose version is already on the registry counts as published", () => {
    const out = attempt([new Error(TLOG), "0.8.10\n"]);
    expect(out.calls).toEqual([PUBLISH, VIEW]);
    expect(out.result?.published).toEqual(["workit-opencode"]);
    expect(out.pauses).toEqual([]);
    expect(out.lines.find((l) => l.startsWith("published "))).toEndWith(
      "(already on the registry)",
    );
  });

  test("a TLOG 409 with the version absent is retried once and succeeds", () => {
    const out = attempt([new Error(TLOG), new Error("npm error code E404"), "+ published"]);
    expect(out.calls).toEqual([PUBLISH, VIEW, PUBLISH]);
    expect(out.result?.published).toEqual(["workit-opencode"]);
    expect(out.pauses).toHaveLength(1);
    expect(out.lines.some((l) => l.includes("TLOG_CREATE_ENTRY_ERROR"))).toBe(true);
    expect(out.lines.find((l) => l.startsWith("published "))).not.toContain("already on");
  });

  test("only that exact version counts: an older version on the registry is not a success", () => {
    const out = attempt([new Error("ETIMEDOUT"), "0.8.9\n", "+ published"]);
    expect(out.calls).toEqual([PUBLISH, VIEW, PUBLISH]);
    expect(out.result?.published).toEqual(["workit-opencode"]);
  });

  test("a retry that errors but landed on the registry counts as published", () => {
    const out = attempt([new Error(TLOG), "", new Error(TLOG), "0.8.10"]);
    expect(out.calls).toEqual([PUBLISH, VIEW, PUBLISH, VIEW]);
    expect(out.result?.published).toEqual(["workit-opencode"]);
  });

  test("two failures with the version absent fail loudly after exactly one retry", () => {
    const out = attempt([new Error(TLOG), "", new Error("still failing"), ""]);
    expect(out.calls).toEqual([PUBLISH, VIEW, PUBLISH, VIEW]);
    expect(out.error?.message).toContain("publish failed for 1 package(s): workit-opencode");
    expect(out.lines).toContain("publish failed workit-opencode: still failing");
  });
});

describe("the first @workit-dev release and the registry baseline", () => {
  // `npm view <name> version` answers from this table; a missing name throws
  // like npm's E404. Publishes are recorded by package directory.
  const registry = (versions: Record<string, string>) => {
    const published: string[] = [];
    const run = (_cmd: string, args: string[], opts: { cwd: string }) => {
      if (args[0] === "view") {
        // A versioned spec is the visibility poll before the CLI: what this run published is served.
        if (/^@[^@]+@/.test(args[1])) return visible(args);
        const version = versions[args[1]];
        if (version === undefined) throw new Error(`E404 ${args[1]}`);
        return `${version}\n`;
      }
      published.push(path.basename(opts.cwd));
      return "";
    };
    return { run, published };
  };
  const all = (version: string) =>
    Object.fromEntries(RELEASE_PACKAGES.map((pkg) => [npmName(pkg), version]));

  test("only old v* tags: latestTag finds no release, so every package ships", () => {
    const r = repo({ tagged: false });
    try {
      execFileSync("git", ["tag", "v14.6.0"], { cwd: r.root });
      r.change("packages/workit-opencode/src/i.ts", "c\n");
      const result = publishChanged({ root: r.root, run: (_cmd, args) => visible(args) });
      expect(result.tag).toBeNull();
      expect(result.published).toEqual(ORDER);
    } finally {
      r.cleanup();
    }
  });

  test("the release job without a previous tag (first release) ships everything, never latestTag", () => {
    expect(cliOptions([], {})).toEqual({
      fromTag: "",
      all: false,
      dryRun: false,
      registryBaseline: true,
    });
    const r = repo();
    try {
      // semantic-release already tagged HEAD with the release being cut.
      execFileSync("git", ["tag", "workit-dev-v1.0.0"], { cwd: r.root });
      const { run, published } = registry({});
      publishChanged({ root: r.root, ...cliOptions([], {}), run });
      expect(published).toEqual(ORDER);
    } finally {
      r.cleanup();
    }
  });

  test("--all and PUBLISH_ALL=1 ship every package; PUBLISH_DRY_RUN=1 publishes nothing", () => {
    expect(cliOptions(["workit-dev-v1.0.0", "--all"], {}).all).toBe(true);
    expect(cliOptions(["workit-dev-v1.0.0"], { PUBLISH_ALL: "1" })).toEqual({
      fromTag: "workit-dev-v1.0.0",
      all: true,
      dryRun: false,
      registryBaseline: true,
    });
    const r = repo();
    try {
      const { run, published } = registry(all("0.8.10"));
      const result = publishChanged({
        root: r.root,
        ...cliOptions(["workit-dev-v0.8.10"], { PUBLISH_ALL: "1", PUBLISH_DRY_RUN: "1" }),
        run,
      });
      expect(result.published).toEqual(ORDER);
      expect(published).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  test("a package absent from the registry or holding only the 0.0.1 placeholder ships", () => {
    const r = repo();
    try {
      const versions = all("0.8.10");
      delete versions[npmName("workit-pi")];
      versions[npmName("workit-codex")] = "0.0.1";
      const { run } = registry(versions);
      expect(registryBaseTag(r.root, "workit-pi", run)).toBeNull();
      expect(registryBaseTag(r.root, "workit-codex", run)).toBeNull();
      expect(registryBaseTag(r.root, "workit-core", run)).toBe("workit-dev-v0.8.10");
      const result = publishChanged({
        root: r.root,
        fromTag: "workit-dev-v0.8.10",
        registryBaseline: true,
        run,
      });
      expect(result.published.toSorted()).toEqual(["workit-codex", "workit-pi"]);
    } finally {
      r.cleanup();
    }
  });

  test("each package diffs from the tag of the version the registry serves, not the previous release", () => {
    const r = repo();
    try {
      r.change("packages/workit-opencode/src/i.ts", "c\n");
      execFileSync("git", ["tag", "workit-dev-v0.9.0"], { cwd: r.root });
      r.change("packages/workit-cursor/src/i.ts", "c\n");
      // 0.9.0 published everything but workit-opencode, so the registry still
      // serves 0.8.10 for it: it ships again with the cursor change.
      const versions = all("0.9.0");
      versions[npmName("workit-opencode")] = "0.8.10";
      const { run } = registry(versions);
      const result = publishChanged({
        root: r.root,
        fromTag: "workit-dev-v0.9.0",
        registryBaseline: true,
        run,
      });
      expect(result.published.toSorted()).toEqual(["workit-cursor", "workit-opencode"]);
    } finally {
      r.cleanup();
    }
  });

  test("a registry version with no local release tag ships (published from elsewhere)", () => {
    const r = repo();
    try {
      const { run } = registry(all("0.8.11"));
      expect(registryBaseTag(r.root, "workit-core", run)).toBeNull();
    } finally {
      r.cleanup();
    }
  });
});

describe("publish order (W2.38)", () => {
  // npm installs these groups with a published package; devDependencies never.
  const installDeps = (pkg: string): string[] => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "packages", pkg, "package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    return ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((group) =>
      Object.keys(manifest[group] ?? {})
        .filter((name) => name.startsWith("@workit-dev/"))
        .map((name) => `workit-${name.slice("@workit-dev/".length)}`),
    );
  };

  test("the real packages publish after every @workit-dev package they install, the CLI last", () => {
    const order = publishOrder(REPO_ROOT);
    expect(order.toSorted()).toEqual([...RELEASE_PACKAGES].toSorted());
    expect(order.at(-1)).toBe("workit-cli");
    // The v13.0.0 incident: workit-cli requires workit-cursor.
    expect(installDeps("workit-cli")).toContain("workit-cursor");
    for (const pkg of order)
      for (const dep of installDeps(pkg))
        expect(order.indexOf(dep), `${pkg} needs ${dep} first`).toBeLessThan(order.indexOf(pkg));
  });

  test("a package listed early still waits for a dependency listed after it; cycles fail", () => {
    const r = repo();
    try {
      r.change(
        "packages/workit-mcp/package.json",
        `{"name":"@workit-dev/mcp","version":"0.8.10","peerDependencies":{"@workit-dev/pi":"workspace:*"}}\n`,
      );
      const order = publishOrder(r.root);
      expect(order.indexOf("workit-pi")).toBeLessThan(order.indexOf("workit-mcp"));
      expect(order.at(-1)).toBe("workit-cli");
      r.change(
        "packages/workit-pi/package.json",
        `{"name":"@workit-dev/pi","version":"0.8.10","dependencies":{"@workit-dev/mcp":"workspace:*"}}\n`,
      );
      expect(() => publishOrder(r.root)).toThrow(/release dependency cycle/);
    } finally {
      r.cleanup();
    }
  });

  test("npm publish runs dependencies first and the CLI last", () => {
    const r = repo();
    try {
      r.change(
        "packages/workit-cli/package.json",
        `{"name":"@workit-dev/cli","version":"0.8.10","dependencies":{"@workit-dev/cursor":"workspace:*"}}\n`,
      );
      r.change("packages/workit-core/src/i.ts", "c\n");
      const published: string[] = [];
      publishChanged({
        root: r.root,
        run: (_cmd, args, opts) => {
          if (args[0] === "view") return visible(args);
          if (args[0] === "publish") published.push(path.basename(opts.cwd));
        },
      });
      expect(published).toHaveLength(RELEASE_PACKAGES.length);
      expect(published.indexOf("workit-cursor")).toBeLessThan(published.indexOf("workit-cli"));
      expect(published.at(-1)).toBe("workit-cli");
    } finally {
      r.cleanup();
    }
  });

  test("a package whose dependency failed to publish is held back, not published", () => {
    const r = repo();
    try {
      r.change(
        "packages/workit-cli/package.json",
        `{"name":"@workit-dev/cli","version":"0.8.10","dependencies":{"@workit-dev/cursor":"workspace:*"}}\n`,
      );
      const published: string[] = [];
      const log = spyOn(console, "log");
      let err: unknown;
      try {
        publishChanged({
          root: r.root,
          pause: () => {},
          run: (_cmd, args, opts) => {
            if (opts.cwd.endsWith("workit-cursor")) throw new Error("boom");
            if (args[0] === "publish") published.push(path.basename(opts.cwd));
          },
        });
      } catch (e) {
        err = e;
      }
      const lines = log.mock.calls.map((c) => String(c[0]));
      log.mockRestore();
      expect(published).toEqual(["workit-claude-code"]);
      const message = (err as Error).message;
      expect(message).toContain("publish failed for 2 package(s): workit-cursor, workit-cli");
      expect(lines).toContain(
        "publish failed workit-cli: not published: the host package workit-cursor failed to publish",
      );
    } finally {
      r.cleanup();
    }
  });
});

// #792 item 57: npm accepted @workit-dev/opencode@1.9.1 at 11:21 and served it
// at 11:28, after the CLI (11:24): publishing the CLI last did not make it
// visible last. The CLI publish waits for every package before it.
describe("the CLI publish waits until the registry serves the packages before it", () => {
  // A first-ever release ships every package; `visibleOn(pkg)` is the poll
  // on which the registry starts serving it (Infinity: never).
  function release(visibleOn: (pkg: string) => number, failing: string[] = []) {
    const r = repo({ tagged: false });
    const events: string[] = [];
    const pauses: number[] = [];
    const polls = new Map<string, number>();
    const log = spyOn(console, "log");
    let error: Error | undefined;
    let lines: string[] = [];
    try {
      publishChanged({
        root: r.root,
        pause: (ms) => pauses.push(ms),
        run: (_cmd, args, opts) => {
          const pkg = path.basename(opts.cwd);
          if (args[0] === "view") {
            const name = args[1].slice(0, args[1].lastIndexOf("@"));
            const target = RELEASE_PACKAGES.find((each) => npmName(each) === name) ?? name;
            const poll = (polls.get(target) ?? 0) + 1;
            polls.set(target, poll);
            events.push(`view ${target} #${poll}`);
            return poll >= visibleOn(target) ? visible(args) : "";
          }
          if (failing.includes(pkg)) throw new Error("E403 forbidden");
          events.push(`publish ${pkg}`);
          return "";
        },
      });
    } catch (e) {
      error = e as Error;
    } finally {
      lines = log.mock.calls.map((c) => String(c[0]));
      log.mockRestore();
      r.cleanup();
    }
    return { events, pauses, error, lines };
  }
  const HOSTS = ORDER.filter((pkg) => pkg !== "workit-cli");

  test("Given host packages the registry serves only on the third poll, When the publisher runs, Then the CLI publishes after the third poll", () => {
    const out = release(() => 3);
    const cli = out.events.indexOf("publish workit-cli");
    expect(cli).toBe(out.events.length - 1);
    for (const pkg of HOSTS) expect(out.events.indexOf(`view ${pkg} #3`), pkg).toBeGreaterThan(-1);
    expect(out.events.slice(0, cli).filter((e) => e.startsWith("view")).length).toBe(
      HOSTS.length * 3,
    );
    expect(out.pauses).toEqual([15_000, 15_000]);
    expect(out.error).toBeUndefined();
    expect(out.lines.some((line) => line.startsWith("::warning::"))).toBe(false);
  });

  test("Given a host package the registry never serves, When the publisher runs, Then the CLI publishes after the 15-minute bound with a warning naming it", () => {
    const out = release((pkg) => (pkg === "workit-opencode" ? Infinity : 1));
    expect(out.events.at(-1)).toBe("publish workit-cli");
    expect(out.events.filter((e) => e.startsWith("view workit-opencode")).length).toBe(61);
    expect(out.pauses.reduce((sum, ms) => sum + ms, 0)).toBe(15 * 60_000);
    const warnings = out.lines.filter((line) => line.startsWith("::warning::"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("workit-opencode");
    expect(warnings[0]).not.toContain("workit-cursor");
    expect(out.error).toBeUndefined();
  });

  test("Given a host package whose own publish failed, Then the job fails before the CLI publish, with no wait", () => {
    const out = release((pkg) => (pkg === "workit-opencode" ? Infinity : 1), ["workit-opencode"]);
    expect(out.events).not.toContain("publish workit-cli");
    expect(out.events.some((e) => e.startsWith("view workit-cursor"))).toBe(false);
    expect(out.error?.message).toContain("workit-opencode, workit-cli");
  });
});
