// `workit doctor` (DG-07): offline engine, human or --json report, exit code
// reflects the health. Never writes the report to stderr (the logger owns that).
import type { Io } from "../output";
import { runDoctor } from "@brainervirus/workit-core/src/core/doctor";

export async function run(argv: string[], io: Io): Promise<number> {
  const report = runDoctor({ host: "cli", cwd: io.cwd });
  if (argv.includes("--json")) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return report.exitCode;
  }
  io.stdout(
    `workit doctor — ${report.ok ? "healthy" : "problems found"} (${report.offline ? "offline" : "online"})\n`,
  );
  for (const check of report.checks) {
    const mark = check.status === "fail" ? "FAIL" : check.status === "warn" ? "WARN" : "ok  ";
    io.stdout(`${mark} ${check.id} — ${check.detail}\n`);
    if (check.fix) io.stdout(`     fix: ${check.fix}\n`);
  }
  io.stdout(
    `passed ${report.summary.passed} / warned ${report.summary.warned} / failed ${report.summary.failed}\n`,
  );
  return report.exitCode;
}
