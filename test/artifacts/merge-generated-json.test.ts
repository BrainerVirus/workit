import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMergeDriver } from "@/scripts/install-hooks";
import { MERGE_DRIVER_COMMAND, mergeFlatJson } from "@/scripts/merge-generated-json";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

setDefaultTimeout(60_000);

const FILE = "docs/qualification/context-budget.json";
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...IDENTITY, GIT_EDITOR: "true" };
  delete env.GIT_INDEX_FILE;
  const run = spawnSync("git", args, { cwd, encoding: "utf8", env });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

const write = (cwd: string, json: Record<string, number>) =>
  writeFileSync(path.join(cwd, FILE), `${JSON.stringify(json, null, 2)}\n`);

/** A temp repo: main and `feature` each change their own key and the shared one. */
function fixture(driverCommand?: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workit-merge-json-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  mkdirSync(path.join(dir, "docs/qualification"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"));
  copyFileSync(
    path.join(REPO_ROOT, "scripts/merge-generated-json.ts"),
    path.join(dir, "scripts/merge-generated-json.ts"),
  );
  writeFileSync(path.join(dir, ".gitattributes"), `${FILE} merge=workit-generated-json\n`);
  registerMergeDriver(dir);
  if (driverCommand) git(dir, ["config", "merge.workit-generated-json.driver", driverCommand]);
  write(dir, { a: 1, b: 2, shared: 10 });
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["switch", "-q", "-c", "feature"]);
  write(dir, { a: 1, b: 5, shared: 30 });
  git(dir, ["commit", "-q", "-am", "feature"]);
  git(dir, ["switch", "-q", "main"]);
  write(dir, { a: 4, b: 2, shared: 20 });
  git(dir, ["commit", "-q", "-am", "main"]);
  git(dir, ["switch", "-q", "feature"]);
  return dir;
}

test("a rebase finishes without a conflict and holds both sides' keys", () => {
  const dir = fixture();
  const rebase = git(dir, ["rebase", "main"]);
  expect(rebase.status, rebase.out).toBe(0);
  expect(JSON.parse(readFileSync(path.join(dir, FILE), "utf8"))).toEqual({
    a: 4,
    b: 5,
    shared: 30,
  });
});

test("when the driver cannot run, git leaves normal conflict markers and loses nothing", () => {
  const dir = fixture(MERGE_DRIVER_COMMAND.replace("bun ", "workit-no-such-bun "));
  const rebase = git(dir, ["rebase", "main"]);
  expect(rebase.status).not.toBe(0);
  const text = readFileSync(path.join(dir, FILE), "utf8");
  expect(text).toContain("<<<<<<<");
  expect(text).toContain('"shared": 20');
  expect(text).toContain('"shared": 30');
});

test("mergeFlatJson keeps a one-sided change, the larger number of a double change, and refuses other clashes", () => {
  expect(mergeFlatJson({ a: 1, b: 2 }, { a: 1, b: 3, c: 1 }, { a: 9, b: 2 })).toEqual({
    a: 9,
    b: 3,
    c: 1,
  });
  expect(mergeFlatJson({ a: 1 }, { a: 5 }, { a: 7 })).toEqual({ a: 7 });
  expect(mergeFlatJson({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 })).toEqual({ a: 1 });
  expect(mergeFlatJson({ a: "x" }, { a: "y" }, { a: "z" })).toBeUndefined();
});
