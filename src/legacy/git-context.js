import { spawnSync } from "node:child_process";
import { resolveWorkspaceRoot } from "./resolve-workspace-root.js";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    stdout: (r.stdout ?? "").trimEnd(),
    stderr: (r.stderr ?? "").trimEnd(),
    exitCode: r.status ?? 1,
  };
}

export function gitContext(workspaceRoot, paths = []) {
  const cwd = resolveWorkspaceRoot(workspaceRoot);
  const branch =
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "unknown";
  const status_short = git(cwd, ["status", "--porcelain"]).stdout;

  const staged = [];
  const unstaged = [];
  const untracked = [];

  for (const line of status_short.split("\n").filter(Boolean)) {
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === "??") {
      untracked.push(file);
    } else {
      if (code[0] !== " " && code[0] !== "?") staged.push(file);
      if (code[1] !== " " && code[1] !== "?") unstaged.push(file);
    }
  }

  const pathArgs = paths.length ? ["--", ...paths] : [];
  const diff_stat = git(cwd, ["diff", "--stat", ...pathArgs]).stdout;
  const cached_stat = git(cwd, [
    "diff",
    "--cached",
    "--stat",
    ...pathArgs,
  ]).stdout;

  const stagedSet = new Set(staged);
  const unstagedSet = new Set(unstaged);
  const partial_staged = [...stagedSet].filter((f) => unstagedSet.has(f));

  return {
    workspace_root: cwd,
    branch,
    status_short,
    staged,
    unstaged,
    untracked,
    diff_stat: [diff_stat, cached_stat].filter(Boolean).join("\n"),
    partial_staged: partial_staged.length > 0,
    partial_staged_files: partial_staged,
  };
}
