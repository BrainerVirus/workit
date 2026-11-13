// #860: `workit doctor` reports release-package reader issues and a
// changelogPath with no file as a WARN with a fix; none configured is silent.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";

setDefaultTimeout(60_000);

const scratch = mkdtempSync(path.join(os.tmpdir(), "wk-doctor-release-packages-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;
const row = (entry: Record<string, unknown>, files: string[] = []) => {
  const base = path.join(scratch, `case-${count++}`);
  const repo = path.join(base, "repo");
  const configDir = path.join(base, "config");
  mkdirSync(repo, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  for (const file of files) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), "# Changelog\n");
  }
  if (files.length) {
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: repo,
    });
  }
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${repo.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );
  return runDoctor({
    host: "cli",
    cwd: repo,
    home: base,
    configDir,
    stateDir: path.join(base, "state"),
    env: { PATH: process.env.PATH ?? "", WORKIT_CONFIG: configDir },
  }).checks.find((check) => check.id === "release_packages");
};

test("Given a releasePackages entry whose changelogPath matches no file, When doctor runs, Then a WARN names the package and the path with a fix", () => {
  const check = row({
    releasePackages: { "pkg-a": { changelogPath: "projects/pkg-a/CHANGELOG.md" } },
  });
  expect(check?.status).toBe("warn");
  expect(check?.detail).toContain(
    'release package "pkg-a" changelogPath projects/pkg-a/CHANGELOG.md: no such file in this checkout',
  );
  expect(check?.fix).toContain("workit workspace set w releasePackages.pkg-a.changelogPath=");
});

test("Given no releasePackages configured, When doctor runs, Then there is no release_packages row", () => {
  expect(row({})).toBeUndefined();
});

test("Given a package without changelogPath and no changelog in a directory named after it, When doctor runs, Then a WARN names the package with a changelogPath fix", () => {
  const check = row(
    { changelogPath: ["projects/*/CHANGELOG.md"], releasePackages: { "pkg-x": {} } },
    ["projects/pkg-a/CHANGELOG.md"],
  );
  expect(check?.status).toBe("warn");
  expect(check?.detail).toContain('release package "pkg-x": no changelog found');
  expect(check?.fix).toContain("workit workspace set w releasePackages.pkg-x.changelogPath=");
});

test("Given a scoped package without changelogPath whose directory holds a workspace changelog, When doctor runs, Then the row is ok and names the file found", () => {
  const check = row(
    { changelogPath: ["projects/*/CHANGELOG.md"], releasePackages: { "@s/pkg-a": {} } },
    ["projects/pkg-a/CHANGELOG.md"],
  );
  expect(check?.detail).toContain(
    "@s/pkg-a (@s/pkg-a@<version>; changelog projects/pkg-a/CHANGELOG.md)",
  );
  expect(check?.status).toBe("pass");
});
