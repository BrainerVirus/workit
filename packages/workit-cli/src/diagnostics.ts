// Secret-safe diagnostic logger (DG-01-DG-03, DG-05, DG-10). Sink injection
// only: CLI events mirror to stderr, never the Ink-rendered stdout. Routine
// debug/info events stay out of the terminal (they live in the JSONL journal);
// only warn/error surface so interactive sessions stay clean.
import { createLogger } from "@brainervirus/workit-core/src/core/logger";
import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import { setDiagnosticLogger } from "@brainervirus/workit-core/src/core/config";
import { setDefaultLockTimeout } from "@brainervirus/workit-core/src/core/store-lock";

export const logger = createLogger({
  stderr: (event) => {
    if (event.level === "debug" || event.level === "info") return;
    process.stderr.write(`${JSON.stringify(event)}\n`);
  },
});

/**
 * Process setup for every routed verb (not --version/help). The CLI owns its
 * process: uncaught failures are logged and surfaced with a
 * nonzero exit instead of a silent crash (DG-04).
 */
export function installDiagnostics(command: string): void {
  setDiagnosticLogger(logger);
  // The CLI owns its process, so a contended write may wait longer than an
  // in-process host could afford before reporting busy.
  setDefaultLockTimeout(2_000);
  logger.info(EVENT.initialization, { host: "cli", command });
  process.on("unhandledRejection", (reason) =>
    logger.error(EVENT.uncaughtFailure, { phase: "unhandledRejection", ...errorDetail(reason) }),
  );
  process.on("uncaughtException", (err) => {
    logger.error(EVENT.uncaughtFailure, { phase: "uncaughtException", ...errorDetail(err) });
    process.exit(1);
  });
}
