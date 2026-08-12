import { execFileSync } from "node:child_process";

const run = (cwd: string, args: string[]): { stdout: string; stderr: string; exitCode: number } => {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      // AR-14: expected negative fixtures (non-repo dirs, unborn HEADs, bogus
      // shas) must not inherit raw git usage/fatal stderr into the suite output.
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: stdout.trimEnd(), stderr: "", exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: (e.stdout ?? "").trimEnd(),
      stderr: (e.stderr ?? "").trimEnd(),
      exitCode: e.status ?? 1,
    };
  }
};

export const gitContext = (workspaceRoot: string, paths: string[] = []) => {
  const cwd = workspaceRoot;
  let failure: { stderr: string; exitCode: number } | undefined;

  const runHere = (args: string[]) => {
    const result = run(cwd, args);
    if (!failure && result.exitCode !== 0) {
      failure = { stderr: result.stderr, exitCode: result.exitCode };
    }
    return result.stdout;
  };

  const branch = runHere(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
  const status_short = runHere(["status", "--porcelain"]);

  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

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
  const diff_stat = runHere(["diff", "--stat", ...pathArgs]);
  const cached_stat = runHere(["diff", "--cached", "--stat", ...pathArgs]);

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
    ...(failure ? { stderr: failure.stderr, exitCode: failure.exitCode } : {}),
  };
};
