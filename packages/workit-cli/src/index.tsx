import { render } from "ink";
import { Wizard } from "./steps";
import type { SetupValues } from "./wizard-state";
import { createLogger } from "@brainervirus/workit-core/src/core/logger";
import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import { setDiagnosticLogger } from "@brainervirus/workit-core/src/core/config";
import { runDoctor } from "@brainervirus/workit-core/src/core/doctor";
import {
  applySetupPreview,
  buildSetupPreview,
  setupCompletionGuidance,
  type SetupResult,
} from "@brainervirus/workit-core/src/core/setup.ts";
import { readSetupState, type SetupState } from "@brainervirus/workit-core/src/core/setup-state";
import { applyWizardBranchPolicy } from "./logic";
import { runFlowCommand, runHandoffCommand } from "./flow";

// Secret-safe diagnostic logger (DG-01-DG-03, DG-05, DG-10). Sink injection
// only: CLI events mirror to stderr, never the Ink-rendered stdout. Routine
// debug/info events stay out of the terminal (they live in the JSONL journal);
// only warn/error surface so interactive sessions stay clean.
export const logger = createLogger({
  stderr: (event) => {
    if (event.level === "debug" || event.level === "info") return;
    process.stderr.write(`${JSON.stringify(event)}\n`);
  },
});

const HELP = `workit — workflow rails for agentic coding

Usage:
  workit init      Run the interactive setup wizard
  workit doctor    Verify the offline installation health (add --json for a machine-readable report)
  workit flow status --plan <path>                 Read the effective flow state for a plan
  workit flow pause --plan <path> [--confirm]      Pause an active plan
  workit flow resume --plan <path> [--confirm]     Resume a paused plan
  workit flow complete --plan <path> [--confirm]   Complete a plan (ledger and verification gated)
  workit handoff --message <text>                  Emit the destination handoff prompt for a plan
  workit           Show this help

Run \`npx workit init\` to configure platforms, YouTrack, VCS and project hygiene.
`;

// WZ-13-WZ-15 / CA-31: Apply prints one line per platform/file (Installed /
// Configured / Skipped / Failed), the post-apply doctor summary, and the
// /wk-status + doctor completion guidance. Partial failures propagate to a
// nonzero exit code.
function printApplySummary(result: SetupResult): void {
  for (const entry of result.entries) {
    console.log(
      `${entry.status.padEnd(11)} ${entry.file}${entry.detail ? ` — ${entry.detail}` : ""}`,
    );
  }
  for (const report of result.doctor) {
    console.log(
      `doctor ${report.host}: ${report.ok ? "healthy" : "problems found"} (${report.summary.failed} failed)`,
    );
  }
  console.log(result.ok ? "Setup complete." : "Setup finished with problems.");
  for (const line of setupCompletionGuidance()) console.log(line);
}

// WZ-06 / RL-01: the one friendly blocked output for malformed setup state,
// shared by the pre-wizard guard and the post-Apply preview guard.
function printMalformedBlocked(state: SetupState): void {
  console.log("Apply blocked — malformed configuration:");
  for (const entry of [state.config, state.youtrack, state.vcs, state.workspaces]) {
    if (entry.status === "malformed") console.log(`  ${entry.error ?? entry.file}`);
  }
}

async function runInit() {
  // RL-01: a malformed config.json used to throw inside the wizard's initial
  // draft (createInitialDraft -> readConfig) and die via the
  // unhandledRejection/uncaughtException handler. Detect it before render and
  // surface the same graceful blocked output Apply would have shown.
  const state = readSetupState();
  if (state.config.status === "malformed") {
    printMalformedBlocked(state);
    process.exit(1);
  }
  // ponytail: no-TTY guard — piping/disabling stdin would hang render(); print
  // guidance and exit nonzero instead of silently pretending setup happened
  if (process.stdin.isTTY !== true) {
    console.log("workit init requires an interactive terminal (TTY).");
    for (const line of setupCompletionGuidance()) console.log(line);
    process.exit(1);
  }
  logger.info(EVENT.installSteps, { step: "wizard_start" });
  const exits: Array<{ complete: boolean; values?: SetupValues }> = [];
  let done: () => void = () => {};
  const { waitUntilExit, unmount } = render(
    <Wizard
      onExit={(complete, values) => {
        exits.push({ complete, values });
        done();
      }}
    />,
  );
  done = unmount;
  await waitUntilExit();
  const exit = exits[0];
  if (exit && exit.complete && exit.values) {
    const preview = buildSetupPreview(exit.values, { cwd: process.cwd(), env: process.env });
    if (!preview.ok) {
      printMalformedBlocked(preview.state);
      process.exit(1);
    }
    const result = applySetupPreview(preview, { cwd: process.cwd(), env: process.env });
    // CA-06: the branch-policy screen is applied separately through the shared
    // proposal→write helper (byte-identical to the host init action) right
    // after the setup preview; its status line joins the summary below. The
    // shared seam builds the hermetic env, so runInit and the parity test
    // cannot drift.
    let exitCode = result.exitCode;
    if (exit.values.branchPolicy) {
      const bp = applyWizardBranchPolicy(
        exit.values.branchPolicy,
        process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd(),
        process.env,
      );
      if (bp.ok) {
        console.log(`${String(bp.status).padEnd(11)} ${bp.config_path} — branch policy`);
      } else {
        console.log("branch policy apply failed — " + (bp.error ?? "unknown"));
        exitCode = 1;
      }
    }
    logger.info(EVENT.installSteps, { step: "wizard_apply", ok: result.ok });
    printApplySummary(result);
    process.exit(exitCode);
  }
  logger.info(EVENT.installSteps, {
    step: "wizard_done",
    complete: exit !== undefined && exit.complete,
  });
  process.exit(exit !== undefined && exit.complete ? 0 : 1);
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
  } else if (subcommand === "flow") {
    process.exit(await runFlowCommand(args.slice(1)));
  } else if (subcommand === "handoff") {
    process.exit(await runHandoffCommand(args.slice(1)));
  } else {
    console.log(HELP);
    process.exit(0);
  }
}
