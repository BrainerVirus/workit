#!/usr/bin/env bun
// Pack-only release-candidate gate (Task 24, AR-01/AR-02, CA-33): pack every
// workspace package into fresh local tarballs, verify the candidate, and exit
// nonzero on any failure. Runs before semantic-release in the release job;
// never publishes, tags, or touches a registry or marketplace.
import { packReleaseCandidate } from "../test/shared/helpers/packages.ts";
import { verifyDeterministicQualification } from "../test/acceptance/harness.ts";

const packs = packReleaseCandidate();
for (const pack of packs) {
  console.log(`${pack.packageName}\t${pack.sha256}\t${pack.tarball}`);
}
console.log(`verified ${packs.length} local tarballs`);

const qualification = verifyDeterministicQualification();
if (!qualification.ok) {
  console.error("deterministic qualification failed:");
  for (const reason of qualification.reasons) console.error(`  - ${reason}`);
  process.exit(1);
}
console.log("deterministic qualification passed (live 90-run batch still requires authorization)");
