import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./repo-context";

// Port of scripts/verify-project.sh — discover + run project verification checks
// (npm/pnpm/yarn, cargo, pytest/ruff, CHANGELOG format). Output is parsed by
// verify-parse.ts and keeps the same ## section text shape.

export type VerifyResult = { stdout: string; stderr: string; exitCode: number; cwd: string };

const commandOnPath = (name: string): boolean => {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      statSync(candidate);
      if (process.platform !== "win32") {
        const mode = statSync(candidate).mode & 0o111;
        if (mode === 0) continue;
      }
      return true;
    } catch {
      /* keep scanning */
    }
  }
  return false;
};

const hasScript = (cwd: string, name: string): boolean => {
  const pkgPath = path.join(cwd, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts && typeof pkg.scripts[name] === "string");
  } catch {
    return false;
  }
};

const packageRunner = (cwd: string): string => {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  const pkgPath = path.join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { packageManager?: string };
      if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("pnpm")) {
        return "pnpm";
      }
    } catch {
      /* fall through */
    }
  }
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
};

export function runVerifyProject(root: string, dryRun = false): VerifyResult {
  // Shell parity: verify-project.sh did `root=$(git rev-parse --show-toplevel || pwd); cd "$root"`,
  // so a run from a repo subdirectory still checks the repo root.
  const cwd = repoRoot(root);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const lines: string[] = [];
  const stderrParts: string[] = [];

  const runCheck = (label: string, cmd: string, args: string[]) => {
    lines.push(`\n## ${label}\n\n`);
    lines.push(`command: ${[cmd, ...args].join(" ")}\n\n`);
    if (dryRun) {
      lines.push("status: skipped (dry run)\n");
      skipped += 1;
      return;
    }
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    const so = (r.stdout ?? "").trimEnd();
    if (so) lines.push(so + "\n");
    const se = (r.stderr ?? "").trimEnd();
    if (se) stderrParts.push(se);
    if (r.status === 0) {
      lines.push("\nstatus: pass\n");
      passed += 1;
    } else {
      lines.push(`\nstatus: fail (exit ${r.status})\n`);
      failed += 1;
    }
  };

  const skipCheck = (label: string, reason: string) => {
    lines.push(`\n## ${label}\n\nstatus: skipped (${reason})\n`);
    skipped += 1;
  };

  lines.push("# Verification Context\n");
  lines.push(`\nroot: ${cwd}\n`);
  lines.push(`dry_run: ${String(dryRun)}\n`);

  const pkgPath = path.join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    const runner = packageRunner(cwd);
    for (const script of ["lint", "format:check", "test", "build"]) {
      if (hasScript(cwd, script)) {
        if (runner === "npm") runCheck(script, "npm", ["run", script]);
        else runCheck(script, runner, [script]);
      } else {
        skipCheck(script, `package.json has no ${script} script`);
      }
    }
  } else {
    skipCheck("javascript", "package.json not found");
  }

  const cargoManifest = existsSync(path.join(cwd, "Cargo.toml"))
    ? "Cargo.toml"
    : existsSync(path.join(cwd, "src-tauri/Cargo.toml"))
      ? "src-tauri/Cargo.toml"
      : "";
  if (cargoManifest) {
    runCheck("cargo fmt", "cargo", ["fmt", "--manifest-path", cargoManifest, "--", "--check"]);
    runCheck("cargo clippy", "cargo", [
      "clippy",
      "--manifest-path",
      cargoManifest,
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ]);
    runCheck("cargo test", "cargo", ["test", "--manifest-path", cargoManifest, "--all-targets"]);
  } else {
    skipCheck("rust", "Cargo.toml not found");
  }

  if (
    existsSync(path.join(cwd, "pyproject.toml")) ||
    existsSync(path.join(cwd, "pytest.ini")) ||
    existsSync(path.join(cwd, "tests"))
  ) {
    if (commandOnPath("pytest")) runCheck("pytest", "pytest", []);
    else skipCheck("pytest", "pytest not available");
    if (commandOnPath("ruff")) runCheck("ruff check", "ruff", ["check", "."]);
    else skipCheck("ruff check", "ruff not available");
  }

  lines.push("\n## CHANGELOG.md format\n\n");
  lines.push('command: grep -qi "## [Unreleased]" CHANGELOG.md\n\n');
  const changelogPath = path.join(cwd, "CHANGELOG.md");
  if (dryRun) {
    lines.push("status: skipped (dry run)\n");
    skipped += 1;
  } else if (existsSync(changelogPath)) {
    if (/## \[Unreleased\]/i.test(readFileSync(changelogPath, "utf8"))) {
      lines.push("status: pass\n");
      passed += 1;
    } else {
      lines.push("status: fail (missing ## [Unreleased])\n");
      failed += 1;
    }
  } else {
    lines.push("status: fail (missing CHANGELOG.md)\n");
    failed += 1;
  }

  lines.push("\n# Summary\n\n");
  lines.push(`passed: ${passed}\n`);
  lines.push(`failed: ${failed}\n`);
  lines.push(`skipped: ${skipped}\n`);

  return {
    stdout: lines.join(""),
    stderr: stderrParts.join("\n"),
    exitCode: failed > 0 ? 1 : 0,
    cwd,
  };
}
