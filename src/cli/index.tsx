#!/usr/bin/env bun
import { Box, Text, render, useInput } from "ink";
import { useEffect } from "react";

const HELP = `flowkit — workflow rails for agentic coding

Usage:
  flowkit init    Run the interactive setup wizard
  flowkit         Show this help

Run \`npx flowkit init\` to configure platforms, YouTrack, VCS and project hygiene.
`;

const STEPS = ["Platform", "Config", "YouTrack", "VCS", "Project", "Summary"];

const isTTY = process.stdin.isTTY === true;

function Wizard({ onExit }: { onExit: () => void }) {
  useInput(() => onExit(), { isActive: isTTY });
  useEffect(() => {
    // ponytail: auto-exit fallback so non-TTY (CI) never hangs; real steps replace this in Task 2
    const t = setTimeout(onExit, 5000);
    return () => clearTimeout(t);
  }, [onExit]);

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">
        flowkit — workflow rails for agentic coding
      </Text>
      <Text dimColor>Interactive setup wizard</Text>
      <Box flexDirection="column" gap={0}>
        {STEPS.map((step, i) => (
          <Text key={step}>
            {"  "}
            {i + 1}. {step}
          </Text>
        ))}
      </Box>
      <Text dimColor>Press any key to exit</Text>
    </Box>
  );
}

async function runInit() {
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
