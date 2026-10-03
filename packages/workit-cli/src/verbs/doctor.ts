// `workit doctor` (DG-07): offline engine, human or --json report, exit code
// reflects the health. Never writes the report to stderr (the logger owns that).
// `--fix-lock` clears a stale .workit metadata lock first, so the report
// reflects the cleaned state.
import { createInterface } from "node:readline/promises";
import { runDoctor } from "@brainervirus/workit-core/src/core/doctor";
import {
  clearStaleMetadataLock,
  inspectMetadataLock,
} from "@brainervirus/workit-core/src/core/store-lock";
import type { Io } from "../output";
import { workspaceRootFor } from "../task";

// Explicit escape hatch for a lock whose owner cannot be verified (no process
// start time, a foreign pid namespace): show the holder, then require --yes or
// an interactive confirmation.
async function confirmForcedLockClear(root: string, args: string[], io: Io): Promise<boolean> {
  const lock = inspectMetadataLock(root);
  if (!lock.present) return true;
  const owner = lock.owner
    ? `pid ${lock.owner.pid} on ${lock.owner.host} (start ${lock.owner.processStart ?? "unknown"})`
    : "unreadable lock";
  io.stdout(`fix-lock --force: ${lock.path} is held by ${owner}: ${lock.reason}\n`);
  if (args.includes("--yes")) return true;
  if (process.stdin.isTTY !== true) {
    io.stdout("fix-lock --force: refusing without --yes outside an interactive terminal\n");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Remove this lock even if its holder may be alive? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function run(argv: string[], io: Io): Promise<number> {
  // Without --force, --fix-lock removes only a lock whose owner is provably gone.
  const root = workspaceRootFor();
  const force = argv.includes("--force");
  let fixLock: ReturnType<typeof clearStaleMetadataLock> | null = null;
  if (argv.includes("--fix-lock")) {
    if (force && !(await confirmForcedLockClear(root, argv, io))) return 1;
    fixLock = clearStaleMetadataLock(root, { force });
  }
  const report = runDoctor({ host: "cli", cwd: io.cwd, workspaceRoot: root });
  if (argv.includes("--json")) {
    io.stdout(`${JSON.stringify(fixLock ? { ...report, fixLock } : report, null, 2)}\n`);
    return report.exitCode;
  }
  if (fixLock) {
    const what = fixLock.cleared
      ? `cleared ${force ? "" : "stale "}lock ${fixLock.path} (${fixLock.reason})`
      : fixLock.state === "absent"
        ? "no metadata lock to clear"
        : `kept lock ${fixLock.path}: ${fixLock.skipped ?? fixLock.reason}`;
    io.stdout(
      `fix-lock: ${what}${fixLock.guardCleared ? "; removed abandoned reclaim guard" : ""}\n`,
    );
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
