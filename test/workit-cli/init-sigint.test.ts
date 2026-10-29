import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// After the wizard unmounts, the apply blocks the thread in spawnSync (host
// CLIs). Ink leaves a SIGINT listener behind; with it Ctrl-C was held until the
// blocking call returned. The child renders and unmounts an Ink tree exactly as
// runInit does, then blocks in a slow "host"; SIGINT must end it promptly.
const inkSignals = path.resolve("packages/workit-cli/src/steps/ink-signals.ts");

function runChild(release: boolean): Promise<{ code: number | null; ms: number }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-sigint-"));
  const script = path.join(dir, "child.tsx");
  writeFileSync(
    script,
    `import { render, Text } from "ink";
import React from "react";
import { spawnSync } from "node:child_process";
import { dropSignalListenersAddedSince, snapshotSignalListeners } from ${JSON.stringify(inkSignals)};
const snapshot = snapshotSignalListeners();
const instance = render(<Text>wizard</Text>, { interactive: true });
instance.unmount();
await instance.waitUntilExit();
${release ? "dropSignalListenersAddedSince(snapshot);" : ""}
process.stdout.write("blocking\\n");
spawnSync("sleep", ["20"]);
process.exit(0);
`,
  );
  // A real pty (Bun.spawn terminal): Ink only arms its signal handling on a
  // terminal, and a ^C byte there makes the line discipline raise the SIGINT.
  return new Promise((resolve) => {
    const began = Date.now();
    const proc = Bun.spawn([process.execPath, script], {
      cwd: path.resolve("."),
      terminal: {
        cols: 80,
        rows: 24,
        data(terminal, chunk) {
          if (String(chunk).includes("blocking")) setTimeout(() => terminal.write("\x03"), 300);
        },
      },
    });
    void proc.exited.then((code) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, ms: Date.now() - began });
    });
  });
}

test("Ctrl-C during a blocking apply after the wizard closed dies of SIGINT (exit 130)", async () => {
  const result = await runChild(true);
  expect(result.code).toBe(130);
  expect(result.ms).toBeLessThan(10_000);
}, 30_000);

test("without dropping Ink's listeners the SIGINT is held behind the blocking call", async () => {
  const result = await runChild(false);
  expect(result.code).not.toBe(130);
}, 40_000);
