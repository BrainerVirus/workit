import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "@/packages/workit-cli/src/verbs/changelog";
import type { Io } from "@/packages/workit-cli/src/output";

// Each repo spawns a dozen git processes and a bun CLI per merge.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: process.env });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr };
};

const sh = (cwd: string, ...args: string[]) => {
  const result = git(cwd, ...args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.err}`);
  return result.out;
};

const io = (cwd: string): Io & { out: string } => {
  const state = { out: "" };
  return Object.assign(state, {
    json: false,
    cwd,
    env: process.env,
    stdout: (text: string) => void (state.out += text),
    stderr: () => undefined,
  });
};

const changelog = (unreleased: string) => `# Changelog

## [Unreleased]

${unreleased}## [1.0.0] - 2026-01-01

### Added

- first
`;

const repo = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-clmerge-cli-"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "T");
  sh(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "CHANGELOG.md"), changelog("### Added\n\n- base\n\n"));
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
};

test("Given install runs twice, Then .gitattributes and git config do not change the second time", async () => {
  const dir = repo();
  expect(await run(["driver", "install"], io(dir))).toBe(0);
  const attributes = readFileSync(path.join(dir, ".gitattributes"), "utf8");
  const config = readFileSync(path.join(dir, ".git", "config"), "utf8");
  const second = io(dir);
  expect(await run(["driver", "install"], second)).toBe(0);
  expect(second.out).toContain("already installed");
  expect(readFileSync(path.join(dir, ".gitattributes"), "utf8")).toBe(attributes);
  expect(readFileSync(path.join(dir, ".git", "config"), "utf8")).toBe(config);
  expect(attributes).toBe("CHANGELOG.md merge=workit-changelog\n");
});

test("Given the driver is installed, When git rebase replays an Unreleased bullet onto a main that added another, Then it completes without a conflict", async () => {
  const dir = repo();
  expect(await run(["driver", "install"], io(dir))).toBe(0);
  sh(dir, "add", ".gitattributes");
  sh(dir, "commit", "-q", "-m", "attrs");

  // A `workit` on PATH that runs this checkout's CLI, as git's driver command expects.
  const bin = path.join(dir, ".bin");
  mkdirSync(bin);
  const main = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
  const shim = path.join(bin, "workit");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${main}" "$@"\n`);
  chmodSync(shim, 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };

  sh(dir, "switch", "-q", "-c", "feature");
  writeFileSync(
    path.join(dir, "CHANGELOG.md"),
    changelog("### Added\n\n- feature entry\n- base\n\n### Fixed\n\n- feature fix\n\n"),
  );
  sh(dir, "commit", "-q", "-am", "feature");
  sh(dir, "switch", "-q", "main");
  writeFileSync(
    path.join(dir, "CHANGELOG.md"),
    changelog("### Added\n\n- main entry\n- base\n\n### Fixed\n\n- main fix\n\n"),
  );
  sh(dir, "commit", "-q", "-am", "main change");
  sh(dir, "switch", "-q", "feature");

  const rebase = spawnSync("git", ["rebase", "main"], { cwd: dir, encoding: "utf8", env });
  expect(rebase.status).toBe(0);
  const text = readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  expect(text).not.toContain("<<<<<<<");
  expect(text.match(/### Added/g)).toHaveLength(2);
  expect(text.match(/### Fixed/g)).toHaveLength(1);
  for (const entry of ["feature entry", "main entry", "feature fix", "main fix"])
    expect(text).toContain(`- ${entry}`);
}, 60_000);

test("Given the merge verb gets too few files, Then it is a usage error", async () => {
  expect(await run(["merge", "a"], io(os.tmpdir()))).toBe(2);
});
