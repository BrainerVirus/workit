#!/usr/bin/env bun
import { render } from "ink";
import { Wizard } from "./steps";

const HELP = `flowkit — workflow rails for agentic coding

Usage:
  flowkit init    Run the interactive setup wizard
  flowkit         Show this help

Run \`npx flowkit init\` to configure platforms, YouTrack, VCS and project hygiene.
`;

async function runInit() {
  // ponytail: no-TTY guard — piping/disabling stdin would hang render(); print and exit cleanly
  if (process.stdin.isTTY !== true) {
    console.log("flowkit init requires an interactive terminal (TTY).");
    process.exit(0);
  }
  let done: () => void = () => {};
  const { waitUntilExit, unmount } = render(<Wizard onExit={() => done()} />);
  done = unmount;
  await waitUntilExit();
  process.exit(0);
}

if (import.meta.main) {
  const [subcommand] = process.argv.slice(2);
  if (subcommand === "init") {
    await runInit();
  } else {
    console.log(HELP);
    process.exit(0);
  }
}
