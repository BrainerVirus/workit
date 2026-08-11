#!/usr/bin/env bun
// DG-09: installers run the shared offline doctor after writing configuration and
// return nonzero when a required registration/config check fails. `installer:
// true` limits the enforced checks to the ones the installer just guaranteed, so
// a dev/stub checkout without built assets does not fail a post-install run.
import { runDoctor } from "../src/core/doctor";

const host = process.argv[2] === "cursor" ? "cursor" : "opencode";
const report = runDoctor({ host, installer: true });

if (report.exitCode !== 0) {
  for (const check of report.checks) {
    if (check.status === "fail") {
      process.stderr.write(`FATAL: workit doctor ${check.id}: ${check.detail}\n`);
      if (check.fix) process.stderr.write(`  fix: ${check.fix}\n`);
    }
  }
  process.exit(1);
}
process.exit(0);
