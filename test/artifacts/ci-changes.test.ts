import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

// The CI `changes` job decides whether a PR is docs-only, which skips every
// required test leg. Its real step script runs here against scratch repos.

const ci = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

function classifyScript(): string {
  const lines = ci.split("\n");
  const start = lines.findIndex((line) => line.trim() === "id: diff");
  const run = lines.findIndex((line, i) => i > start && line.trim() === "run: |");
  expect(start).toBeGreaterThan(-1);
  expect(run).toBeGreaterThan(start);
  const indent = (lines[run + 1] ?? "").search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const res = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
};

const write = (root: string, rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

/** Commit a base, apply `change` as one commit on top, return docs_only. */
function docsOnly(change: (root: string) => void): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-ci-changes-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  write(root, "scripts/tool.ts", "export const tool = 1;\n".repeat(20));
  write(root, "docs/guide.md", "# Guide\n");
  write(root, "docs/qualification/q.md", "# Q\n");
  write(root, "README.md", "# Readme\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  change(root);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "change");
  const script = path.join(root, "..", `${path.basename(root)}-classify.sh`);
  const output = path.join(root, "..", `${path.basename(root)}-output`);
  roots.push(script, output);
  writeFileSync(script, classifyScript());
  writeFileSync(output, "");
  const res = spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, EVENT: "pull_request", GITHUB_OUTPUT: output },
  });
  expect(res.status, res.stderr).toBe(0);
  return /docs_only=(\w+)/.exec(readFileSync(output, "utf8"))?.[1] ?? "missing";
}

test("ci changes: a docs/** or root Markdown edit is docs-only", () => {
  expect(docsOnly((root) => write(root, "docs/guide.md", "# Guide v2\n"))).toBe("true");
  expect(docsOnly((root) => write(root, "README.md", "# Readme v2\n"))).toBe("true");
});

test("ci changes: code, docs/qualification and code moved into docs/ all run the tests", () => {
  expect(docsOnly((root) => write(root, "scripts/tool.ts", "export const tool = 2;\n"))).toBe(
    "false",
  );
  expect(docsOnly((root) => write(root, "docs/qualification/q.md", "# Q v2\n"))).toBe("false");
  // A rename would list only the new docs/ path without --no-renames.
  expect(docsOnly((root) => git(root, "mv", "scripts/tool.ts", "docs/tool.ts"))).toBe("false");
});
