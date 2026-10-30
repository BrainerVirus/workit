import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const repo = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-bounds-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "1\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature/x");
  return root;
};

test("G a huge --note and --next, T the printed brief stays within 4 KB and the file keeps the full text", async () => {
  const root = repo();
  let stdout = "";
  const code = await main(["handoff", "--note", "n".repeat(20_000), "--next", "m".repeat(20_000)], {
    cwd: root,
    env: { ...process.env, WORKIT_SESSION_ID: "s-reviewer" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  expect(code).toBe(0);
  expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(4096);
  expect(stdout).toContain("(cut)");
  const file = stdout.match(/full brief: (\S+)/u)?.[1];
  expect(file).toBeDefined();
  const full = readFileSync(file!, "utf8");
  expect(full).toContain("n".repeat(20_000));
  expect(full).toContain("m".repeat(20_000));
});

test("G a handoff with --next, T the next line is among the first lines", async () => {
  const root = repo();
  let stdout = "";
  const code = await main(["handoff", "--next", "run the tests"], {
    cwd: root,
    env: { ...process.env, WORKIT_SESSION_ID: "s-reviewer" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  expect(code).toBe(0);
  const lines = stdout.split("\n");
  expect(lines.findIndex((line) => line.startsWith("next:"))).toBeLessThan(4);
});
