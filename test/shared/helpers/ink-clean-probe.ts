import { createElement } from "react";
import { Text, render } from "ink";

// Asserts that no Ink instance is still mounted on the active process.stdout.
// This ink version REUSES a live instance for repeat render() calls on the
// same stdout (stderr warning + the stale instance's stdin binding), so one
// surviving instance hijacks every later Ink-driven drive: keys go to a dead
// stdin and new frames never paint. Run at the end of a drive, while its
// swapped stdout is still installed; probe frame writes are swallowed.
export async function assertNoLiveInkInstance(): Promise<void> {
  const warnings: string[] = [];
  const prevOut = process.stdout.write;
  const prevErr = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const probe = render(createElement(Text, null, "ink-clean-probe"));
    const reused = warnings.join("").includes("render() was called again");
    probe.unmount();
    if (reused) {
      throw new Error(
        "a live Ink instance survived the drive; the next render() on this stdout would reuse it and hang",
      );
    }
  } finally {
    process.stdout.write = prevOut;
    process.stderr.write = prevErr;
  }
}
