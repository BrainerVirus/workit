import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// CRLF guard (#415): a Windows checkout with core.autocrlf turns LF into CRLF,
// so a test that compares a committed fixture byte for byte fails there only.
// That broke CI four times on 2026-11-04. Every committed fixture must resolve
// to `eol=lf` (or `-text`, left alone) through .gitattributes.

const repoRoot = path.resolve(import.meta.dir, "..", "..");

/** Committed files a test may read byte for byte. */
const FIXTURE = /(^|\/)(testdata|fixtures)\/|\.(golden|snap)$/;

const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });

const committedFixtures = (cwd: string): string[] =>
  git(cwd, ["ls-files", "-z"])
    .split("\0")
    .filter((file) => FIXTURE.test(file));

/** Fixtures whose line endings a checkout may rewrite: neither `eol=lf` nor `-text`. */
const fixturesWithoutEolRule = (cwd: string): string[] => {
  const files = committedFixtures(cwd);
  if (files.length === 0) return [];
  // -z output: <path>\0<attribute>\0<value>\0 per attribute.
  const fields = git(cwd, ["check-attr", "-z", "--stdin", "text", "eol"], files.join("\0")).split(
    "\0",
  );
  const attrs = new Map<string, Record<string, string>>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [file, name, value] = [fields[i], fields[i + 1], fields[i + 2]];
    attrs.set(file, { ...attrs.get(file), [name]: value });
  }
  return files.filter((file) => {
    const { text, eol } = attrs.get(file) ?? {};
    return eol !== "lf" && text !== "unset";
  });
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repoWith = (gitattributes: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-gitattributes-"));
  dirs.push(dir);
  git(dir, ["init", "-q"]);
  writeFileSync(path.join(dir, ".gitattributes"), gitattributes);
  for (const file of ["test/fixtures/reply.json", "pkg/testdata/a.txt", "out.golden", "src/a.ts"]) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), "line\n");
  }
  git(dir, ["add", "-A"]);
  return dir;
};

test("Given this repo's .gitattributes, Then every committed fixture, golden and snapshot resolves to eol=lf or -text", () => {
  expect(committedFixtures(repoRoot).length).toBeGreaterThan(0);
  expect(fixturesWithoutEolRule(repoRoot)).toEqual([]);
});

test("Given a committed fixture without an eol rule, Then the guard names it; an eol=lf or -text rule clears it", () => {
  expect(fixturesWithoutEolRule(repoWith("* text=auto\n"))).toEqual([
    "out.golden",
    "pkg/testdata/a.txt",
    "test/fixtures/reply.json",
  ]);
  expect(fixturesWithoutEolRule(repoWith("* text=auto eol=lf\n"))).toEqual([]);
  expect(
    fixturesWithoutEolRule(
      repoWith("**/fixtures/** eol=lf\n**/testdata/** -text\n*.golden eol=lf\n"),
    ),
  ).toEqual([]);
});
