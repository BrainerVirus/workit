#!/usr/bin/env bun
// DG-09: installers run the shared offline doctor after writing configuration and
// return nonzero when a required registration/config check fails. `installer:
// true` limits the enforced checks to the ones the installer just guaranteed, so
// a dev/stub checkout without built assets does not fail a post-install run.
// CA-02: `cursor --stale` is the installer's self-heal pre-check — it exits 2
// when the doctor's stale_install check fails and 0 otherwise. A
// registry-unreachable comparison warns as registry_unreachable and is NOT
// stale (CA-04): no false stale_install and no install failure. Other check
// failures are left to the post-install gate.
import { runDoctor } from "../src/core/doctor";

const host = process.argv[2] === "cursor" ? "cursor" : "opencode";
const staleOnly = process.argv.includes("--stale");
const report = runDoctor({ host, installer: true });

if (staleOnly) {
  const stale = report.checks.find((c) => c.id === "stale_install");
  if (stale?.status === "fail") {
    process.stderr.write(`STALE: ${stale.detail}\n`);
    if (stale.fix) process.stderr.write(`  fix: ${stale.fix}\n`);
    process.exit(2);
  }
  process.exit(0);
}

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
