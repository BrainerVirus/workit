import { render } from "ink";
import { Wizard } from "./steps";
import { createLogger } from "@brainervirus/workit-core/src/core/logger";
import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import { setDiagnosticLogger } from "@brainervirus/workit-core/src/core/config";
import { runDoctor } from "@brainervirus/workit-core/src/core/doctor";

// Secret-safe diagnostic logger (DG-01-DG-03, DG-05, DG-10). Sink injection
// only: CLI events mirror to stderr, never the Ink-rendered stdout.
export const logger = createLogger({
  stderr: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
});

const HELP = `workit — workflow rails for agentic coding

Usage:
  workit init      Run the interactive setup wizard
  workit doctor    Verify the offline installation health (add --json for a machine-readable report)
  workit           Show this help

Run \`npx workit init\` to configure platforms, YouTrack, VCS and project hygiene.
`;

async function runInit() {
  // ponytail: no-TTY guard — piping/disabling stdin would hang render(); print and exit cleanly
  if (process.stdin.isTTY !== true) {
    console.log("workit init requires an interactive terminal (TTY).");
    process.exit(0);
  }
  logger.info(EVENT.installSteps, { step: "wizard_start" });
  let complete = false;
  let done: () => void = () => {};
  const { waitUntilExit, unmount } = render(
    <Wizard
      onExit={(ok) => {
        complete = ok;
        done();
      }}
    />,
  );
  done = unmount;
  await waitUntilExit();
  logger.info(EVENT.installSteps, { step: "wizard_done", complete });
  process.exit(complete ? 0 : 1);
}

// `workit doctor` (DG-07): offline engine, human or --json report, exit code
// reflects the health. Never writes the report to stderr (the logger owns that).
function runDoctorCommand(args: string[]) {
  const report = runDoctor({ host: "cli", cwd: process.cwd() });
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`workit doctor — ${report.ok ? "healthy" : "problems found"} (offline)`);
    for (const check of report.checks) {
      const mark = check.status === "fail" ? "FAIL" : check.status === "warn" ? "WARN" : "ok  ";
      console.log(`${mark} ${check.id} — ${check.detail}`);
      if (check.fix) console.log(`     fix: ${check.fix}`);
    }
    console.log(
      `passed ${report.summary.passed} / warned ${report.summary.warned} / failed ${report.summary.failed}`,
    );
  }
  process.exit(report.exitCode);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [subcommand] = args;
  setDiagnosticLogger(logger);
  logger.info(EVENT.initialization, { host: "cli", command: subcommand });
  // The CLI owns its process: uncaught failures are logged and surfaced with a
  // nonzero exit instead of a silent crash (DG-04).
  process.on("unhandledRejection", (reason) =>
    logger.error(EVENT.uncaughtFailure, { phase: "unhandledRejection", ...errorDetail(reason) }),
  );
  process.on("uncaughtException", (err) => {
    logger.error(EVENT.uncaughtFailure, { phase: "uncaughtException", ...errorDetail(err) });
    process.exit(1);
  });
  if (subcommand === "init") {
    await runInit();
  } else if (subcommand === "doctor") {
    runDoctorCommand(args);
  } else {
    console.log(HELP);
    process.exit(0);
  }
}
