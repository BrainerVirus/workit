import { render } from "ink";
import { Wizard } from "./steps";
import { createLogger } from "@brainervirus/workit-core/src/core/logger";

// Secret-safe diagnostic logger (DG-01-DG-03, DG-05, DG-10). Sink injection
// only: CLI events mirror to stderr, never the Ink-rendered stdout.
export const logger = createLogger({
  stderr: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
});

const HELP = `workit — workflow rails for agentic coding

Usage:
  workit init    Run the interactive setup wizard
  workit         Show this help

Run \`npx workit init\` to configure platforms, YouTrack, VCS and project hygiene.
`;

async function runInit() {
  // ponytail: no-TTY guard — piping/disabling stdin would hang render(); print and exit cleanly
  if (process.stdin.isTTY !== true) {
    console.log("workit init requires an interactive terminal (TTY).");
    process.exit(0);
  }
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
  process.exit(complete ? 0 : 1);
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
