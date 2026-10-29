#!/usr/bin/env bun
// `bun run hooks:install`: lefthook install, then drop the absolute lefthook
// path it bakes into each hook script. Hooks live in the clone's shared hooks
// directory, so a path into one worktree's node_modules goes stale when that
// worktree is removed, and every other worktree then runs a different (or no)
// lefthook. The generated script already falls back to
// `$(git rev-parse --show-toplevel)/node_modules/...`, the committing
// worktree's own install, which is what we want.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

/** The hook script without its `elif <absolute path>/lefthook …` branch. */
export function stripAbsoluteLefthook(script: string): string {
  const lines = script.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    // elif /abs/…/lefthook -h >/dev/null 2>&1 / then / /abs/…/lefthook "$@"
    if (/^\s*elif \/\S*lefthook\S* -h /.test(line) && (lines[index + 1] ?? "").trim() === "then") {
      index += 2;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function git(root: string, args: string[]): string {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

/** Install the hooks of the checkout at `root` (a main checkout or a linked worktree). */
export function installHooks(root: string = repoRoot): void {
  const lefthook = path.join(root, "node_modules/.bin/lefthook");
  const run = spawnSync(lefthook, ["install", "--force"], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) throw new Error("lefthook install failed (run bun install first)");
  const hooksDir = path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks"]));
  for (const name of readdirSync(hooksDir)) {
    const file = path.join(hooksDir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("call_lefthook")) continue;
    const stripped = stripAbsoluteLefthook(text);
    if (stripped !== text) writeFileSync(file, stripped);
  }
}

if (import.meta.main) installHooks();
