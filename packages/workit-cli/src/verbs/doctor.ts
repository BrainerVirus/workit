// `workit doctor` (DG-07): offline engine, human or --json report, exit code
// reflects the health. Never writes the report to stderr (the logger owns that).
// `--fix-lock` clears a stale .workit metadata lock first, so the report
// reflects the cleaned state. `--fix` installs the prepare-commit-msg hook that adds the
// Workit-Session trailer to plain git commits, in a Workit workspace only.
import pkg from "../../package.json" with { type: "json" };
import { fixChecksConfig, fixSessionHook, runDoctor, type DoctorReport } from "../admin/doctor";
import { lintKnowledge } from "@brainervirus/workit-core/src/knowledge";
import {
  clearStaleMetadataLock,
  inspectMetadataLock,
} from "@brainervirus/workit-core/src/core/store-lock";
import { emit, fail, type Io } from "../output";
import { progressFor } from "../progress";
import { createStyle, wrap, type Style } from "../style";
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
  let checksConfig: { action: string; detail: string } | null = null;
  if (argv.includes("--fix")) {
    try {
      checksConfig = fixChecksConfig({ host: "cli", cwd: io.cwd });
    } catch (error) {
      checksConfig = {
        action: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  // The spinner draws only on a TTY and never under --json; the checks block the
  // thread, so its helper process keeps the frames moving.
  const report = progressFor(io).runSync(
    "Checking Workit (workit doctor)",
    () =>
      runDoctor({
        host: "cli",
        cwd: io.cwd,
        workspaceRoot: root,
        cliVersion: pkg.version,
      }),
    (done) => (done.ok ? "done" : "failed"),
  );
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
    // Shared envelope fields (ok, code, error, unblock) beside the report's own.
    const firstFix = report.fixes[0]?.fix;
    const envelope = {
      ok: report.ok,
      code: report.ok ? "ok" : "failed",
      ...(report.ok
        ? {}
        : {
            error: `${report.summary.failed} check(s) failed, ${report.summary.warned} warned (see checks)`,
          }),
      ...(firstFix ? { unblock: firstFix } : {}),
    };
    io.stdout(
      `${JSON.stringify({ ...report, ...envelope, ...(fixLock ? { fixLock } : {}), ...(sessionHook ? { sessionHook } : {}), ...(checksConfig ? { checksConfig } : {}), knowledge: summary }, null, 2)}\n`,
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
  if (checksConfig && checksConfig.action !== "none")
    io.stdout(`fix: checks config ${checksConfig.action}: ${checksConfig.detail}\n`);
  for (const line of renderDoctor(
    report,
    knowledgeLine,
    createStyle({ stream: io.terminals?.stdout, env: io.env, json: io.json }),
  ))
    io.stdout(`${line}\n`);
  return report.exitCode;
}

const ID_COLUMN = 28;

/**
 * The human report. Without color it is the plain line format agents and pipes
 * have always read; with color the status words and ids are highlighted, the
 * details wrap under one column, and failures and warnings repeat at the end.
 */
export function renderDoctor(report: DoctorReport, knowledgeLine: string, style: Style): string[] {
  const summary = `passed ${report.summary.passed} / warned ${report.summary.warned} / failed ${report.summary.failed}`;
  const header = `workit doctor — ${report.ok ? "healthy" : "problems found"} (${report.offline ? "offline" : "online"})`;
  if (!style.enabled) {
    const lines = [header];
    for (const check of report.checks) {
      const mark = check.status === "fail" ? "FAIL" : check.status === "warn" ? "WARN" : "ok  ";
      lines.push(`${mark} ${check.id} — ${check.detail}`);
      // A multi-line fix (config lines to paste) stays under its check.
      if (check.fix) lines.push(`     fix: ${check.fix.replaceAll("\n", "\n          ")}`);
    }
    return [...lines, knowledgeLine, summary];
  }
  const marks: Record<DoctorReport["checks"][number]["status"], string> = {
    pass: style.ok("ok  "),
    info: style.info("info"),
    warn: style.warn("WARN"),
    fail: style.fail("FAIL"),
  };
  const idWidth = Math.min(
    ID_COLUMN,
    Math.max(0, ...report.checks.map((check) => check.id.length)),
  );
  const column = 5 + idWidth + 2;
  const fixLines = (fix: string) =>
    `     fix: ${fix
      .split("\n")
      .map((line) => style.command(line))
      .join("\n          ")}`;
  const row = (check: DoctorReport["checks"][number]) => {
    const id = check.id.padEnd(idWidth);
    const used = 5 + id.length + 2;
    return `${marks[check.status]} ${style.bold(id)}  ${wrap(check.detail, style.width, column, used)}`;
  };
  const lines = [
    `workit doctor — ${report.ok ? style.ok("healthy") : style.fail("problems found")} ${style.dim(`(${report.offline ? "offline" : "online"})`)}`,
  ];
  for (const check of report.checks) {
    lines.push(row(check));
    if (check.fix) lines.push(fixLines(check.fix));
  }
  lines.push(style.dim(wrap(knowledgeLine, style.width, 5)));
  const attention = report.checks.filter((c) => c.status === "fail" || c.status === "warn");
  if (attention.length > 0) {
    lines.push("", style.bold("Needs attention:"));
    for (const check of attention) {
      lines.push(row(check));
      if (check.fix) lines.push(fixLines(check.fix));
    }
  }
  const paint =
    report.summary.failed > 0 ? style.fail : report.summary.warned > 0 ? style.warn : style.ok;
  lines.push(paint(summary));
  return lines;
}
