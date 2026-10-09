// `workit doctor` (DG-07): offline engine, human or --json report, exit code
// reflects the health. Never writes the report to stderr (the logger owns that).
// `--fix-lock` clears a stale .workit metadata lock first, so the report
// reflects the cleaned state. `--fix` installs the prepare-commit-msg hook that adds the
// Workit-Session trailer to plain git commits, in a Workit workspace only.
import pkg from "../../package.json" with { type: "json" };
import { fixSessionHook, runDoctor } from "../admin/doctor";
import { lintKnowledge } from "@brainervirus/workit-core/src/knowledge";
import {
  clearStaleMetadataLock,
  inspectMetadataLock,
} from "@brainervirus/workit-core/src/core/store-lock";
import { emit, fail, type Io } from "../output";
import { askLine, askOrCancel, cancelled } from "../prompt";
import { workspaceRootFor } from "../task";

// Explicit escape hatch for a lock whose owner cannot be verified (no process
// start time, a foreign pid namespace): show the holder, then require --yes or
// an interactive confirmation.
// Under --json the holder line and the prompt go to stderr; a refusal is a
// `blocked` envelope on stdout.
async function confirmForcedLockClear(
  root: string,
  args: string[],
  io: Io,
): Promise<boolean | "cancelled"> {
  const lock = inspectMetadataLock(root);
  if (!lock.present) return true;
  const owner = lock.owner
    ? `pid ${lock.owner.pid} on ${lock.owner.host} (start ${lock.owner.processStart ?? "unknown"})`
    : "unreadable lock";
  const say = io.json ? io.stderr : io.stdout;
  say(`fix-lock --force: ${lock.path} is held by ${owner}: ${lock.reason}\n`);
  if (args.includes("--yes")) return true;
  if (process.stdin.isTTY !== true) {
    if (!io.json) say("fix-lock --force: refusing without --yes outside an interactive terminal\n");
    return false;
  }
  const answer = await askOrCancel(io, () =>
    askLine(
      "Remove this lock even if its holder may be alive? [y/N] ",
      io.json ? process.stderr : process.stdout,
    ),
  );
  if (answer === null) return "cancelled";
  return /^y(es)?$/i.test(answer.trim());
}

export async function run(argv: string[], io: Io): Promise<number> {
  // Without --force, --fix-lock removes only a lock whose owner is provably gone.
  const root = workspaceRootFor();
  const force = argv.includes("--force");
  let fixLock: ReturnType<typeof clearStaleMetadataLock> | null = null;
  if (argv.includes("--fix-lock")) {
    const confirmed = force ? await confirmForcedLockClear(root, argv, io) : true;
    if (confirmed === "cancelled") return cancelled(io);
    if (!confirmed) {
      // Exit 3 (blocked) in both output modes; the JSON form names the fix.
      if (!io.json) return 3;
      return emit(
        io,
        fail(
          "blocked",
          "fix-lock --force: refusing without --yes outside an interactive terminal",
          {
            data: { lock: inspectMetadataLock(root) },
            unblock: "workit doctor --fix-lock --force --yes",
          },
        ),
      );
    }
    fixLock = clearStaleMetadataLock(root, { force });
  }
  // --fix installs the prepare-commit-msg session hook, in a Workit workspace only.
  let sessionHook: { action: string; detail: string } | null = null;
  if (argv.includes("--fix")) {
    try {
      const fixed = fixSessionHook({ host: "cli", cwd: io.cwd, workspaceRoot: root });
      sessionHook = { action: fixed.action, detail: fixed.detail };
    } catch (error) {
      sessionHook = {
        action: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const report = runDoctor({
    host: "cli",
    cwd: io.cwd,
    workspaceRoot: root,
    cliVersion: pkg.version,
  });
  // Advisory only: knowledge findings never change the doctor's exit code.
  let knowledge: ReturnType<typeof lintKnowledge> | null = null;
  try {
    knowledge = lintKnowledge(root);
    if (knowledge.unreadable.length > 0) knowledge = null;
  } catch {
    knowledge = null;
  }
  const agents = knowledge?.files.find((file) => file.file === "AGENTS.md");
  const knowledgeLine = knowledge
    ? `info knowledge — ${agents ? `AGENTS.md ${agents.bytes} of ${knowledge.budget} bytes` : "no AGENTS.md"}; ${knowledge.findings.length} finding(s) (workit knowledge lint)`
    : "info knowledge — unavailable";
  if (argv.includes("--json")) {
    const summary = knowledge
      ? {
          agentsBytes: agents?.bytes ?? null,
          budget: knowledge.budget,
          findings: knowledge.findings.length,
        }
      : { unavailable: true };
    io.stdout(
      `${JSON.stringify({ ...report, ...(fixLock ? { fixLock } : {}), ...(sessionHook ? { sessionHook } : {}), knowledge: summary }, null, 2)}\n`,
    );
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
  if (sessionHook) io.stdout(`fix: session hook ${sessionHook.action}: ${sessionHook.detail}\n`);
  io.stdout(
    `workit doctor — ${report.ok ? "healthy" : "problems found"} (${report.offline ? "offline" : "online"})\n`,
  );
  for (const check of report.checks) {
    const mark = check.status === "fail" ? "FAIL" : check.status === "warn" ? "WARN" : "ok  ";
    io.stdout(`${mark} ${check.id} — ${check.detail}\n`);
    // A multi-line fix (config lines to paste) stays under its check.
    if (check.fix) io.stdout(`     fix: ${check.fix.replaceAll("\n", "\n          ")}\n`);
  }
  io.stdout(`${knowledgeLine}\n`);
  io.stdout(
    `passed ${report.summary.passed} / warned ${report.summary.warned} / failed ${report.summary.failed}\n`,
  );
  return report.exitCode;
}
