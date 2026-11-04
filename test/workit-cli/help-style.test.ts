// Help at a color terminal: bold headings, commands and flags in the accent,
// dim descriptions (the grant palette in style.ts). NO_COLOR, --json, a pipe
// and TERM=dumb get the plain layout byte for byte.
import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { main } from "@/packages/workit-cli/src/main";
import type { TerminalStream } from "@/packages/workit-cli/src/style";

const BOLD = "\x1b[1m";
const COMMAND = "\x1b[1;36m";
const ACCENT = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const helpOut = async (
  argv: string[],
  stdout: TerminalStream | undefined,
  env: NodeJS.ProcessEnv = {},
): Promise<string> => {
  const out: string[] = [];
  const code = await main(argv, {
    env: { PATH: process.env.PATH, ...env },
    stdout: (text) => void out.push(text),
    stderr: () => {},
    terminals: stdout ? { stdout } : {},
  });
  expect(code).toBe(0);
  return out.join("");
};

const TTY = { isTTY: true, columns: 120 };

for (const argv of [
  ["help"],
  ["help", "check"],
  ["help", "fanout", "worktree"],
  ["fanout", "--help"],
])
  test(`Given ${argv.join(" ")}, When stdout is not a color terminal, Then the text is the plain layout byte for byte`, async () => {
    const plain = await helpOut(argv, undefined);
    expect(plain).not.toContain("\x1b[");
    expect(await helpOut(argv, { isTTY: false })).toBe(plain);
    expect(await helpOut(argv, TTY, { NO_COLOR: "1" })).toBe(plain);
    expect(await helpOut(argv, TTY, { TERM: "dumb" })).toBe(plain);
    expect(await helpOut(argv, TTY, { CI: "true" })).toBe(plain);
    const styled = await helpOut(argv, TTY);
    expect(styled).toContain("\x1b[");
    expect(stripVTControlCharacters(styled)).toBe(plain);
  });

test("Given workit help at a color terminal, Then headings are bold, verbs and flags accented, summaries dim", async () => {
  const styled = await helpOut(["help"], TTY);
  expect(styled).toContain(`${BOLD}Setup:${RESET}\n`);
  expect(styled).toContain(`${BOLD}Global flags:${RESET}\n`);
  expect(styled).toContain(`  ${COMMAND}workit setup${RESET} [${ACCENT}--hosts${RESET}=`);
  expect(styled).toContain(`${DIM}      Run the interactive setup wizard${RESET}\n`);
  expect(styled).toContain(`  ${ACCENT}--json${RESET}             ${DIM}Machine-readable output`);
});

test("Given workit help check at a color terminal, Then the verb, the usage heading and its flags are styled", async () => {
  const styled = await helpOut(["help", "check"], TTY);
  expect(styled).toStartWith(`${COMMAND}workit check${RESET}: Run a configured`);
  expect(styled).toContain(
    `${BOLD}usage:${RESET} ${COMMAND}workit check${RESET} <name> [${ACCENT}--full${RESET}]`,
  );
  expect(styled).toContain(`| ${COMMAND}workit check${RESET} [${ACCENT}--name${RESET} <n>]`);
  expect(styled).toContain(`${BOLD}examples:${RESET}\n`);
});

test("Given --json at a color terminal, Then the help envelope carries the plain text", async () => {
  const plain = await helpOut(["help", "check"], undefined);
  const json = JSON.parse(await helpOut(["--json", "help", "check"], TTY));
  expect(`${json.data.text}\n`).toBe(plain);
});
