import { createElement } from "react";
import { Text, render } from "ink";

// Cleans up any live Ink instance still mounted on the active process.stdout.
// This ink version REUSES a live instance for repeat render() calls on the
// same stdout (stderr warning + the stale instance's stdin binding), so one
// surviving instance hijacks every later Ink-driven drive: keys go to a dead
// stdin and new frames never paint. An interrupted drive (frame-gate deadline,
// runner timeout) strands its instance because the product's unmount lives
// inside the abandoned runInit/runUninstall promise — the drive's finally must
// therefore tear it down. render() returns the reused zombie when one exists,
// so probe.unmount() unmounts it. Never throws: the drive that leaked already
// failed loudly on its own gate; punishing the next (innocent) drive with a
// cascade failure adds nothing.
export function cleanupLiveInkInstances(): void {
  const prevOut = process.stdout.write;
  const prevErr = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const probe = render(createElement(Text, null, "ink-clean-probe"));
    probe.unmount();
  } finally {
    process.stdout.write = prevOut;
    process.stderr.write = prevErr;
  }
}
