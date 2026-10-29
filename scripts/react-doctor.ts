#!/usr/bin/env bun
// `bun run doctor`: runs the pinned react-doctor on the CLI UI and prints one
// unambiguous result line. The raw CLI appends "React Doctor is not installed in
// this project" (an install prompt for agents) even after a clean scan, which
// made agents report the gate as not run; this wrapper reads its --json report
// instead. Exit code: non-zero on any warning or error, as `--blocking warning`.
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const target = process.argv[2] ?? "packages/workit-cli/src";

type Diagnostic = {
  filePath: string;
  line?: number;
  rule: string;
  severity: string;
  message: string;
};
type Report = {
  diagnostics: Diagnostic[];
  summary: { totalDiagnosticCount: number };
  projects: { scannedFileCount: number }[];
  error?: { message?: string } | null;
};

// `doctor:raw` (package.json) pins the binary and flags; the scan target is appended.
const run = spawnSync("bun", ["run", "--silent", "doctor:raw", target], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

let report: Report | undefined;
try {
  report = JSON.parse(run.stdout) as Report;
} catch {
  // handled below
}
if (!report || report.error) {
  process.stderr.write(`${run.stderr}${report?.error?.message ?? run.stdout.slice(0, 2000)}\n`);
  console.log("react-doctor: FAILED to scan (no report), gate not passed");
  process.exit(run.status || 1);
}

for (const d of report.diagnostics) {
  console.log(`${d.severity} ${d.filePath}:${d.line ?? 0} ${d.rule}: ${d.message}`);
}
const files = report.projects.reduce((n, p) => n + p.scannedFileCount, 0);
const issues = report.summary.totalDiagnosticCount;
console.log(`react-doctor: scanned ${files} files, ${issues} issues`);
process.exit(issues > 0 || run.status ? 1 : 0);
