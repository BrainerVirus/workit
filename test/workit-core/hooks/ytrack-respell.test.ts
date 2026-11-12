// #780 fix round (verdict mwdbd0km): the cheap respellings of ytrack the shell
// analysis can already see: an alias or function defined in the same command,
// and the binary named through `$(which ytrack)`, `command -v` or backticks.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { ytrackGate } from "@/packages/workit-core/src/hooks/ytrack-guard";
import { tempRoot } from "./hook-fixtures";

const base = realpathSync(tempRoot("workit-ytrack-respell-"));
const root = path.join(base, "repo");
mkdirSync(root, { recursive: true });
beforeEach(() => {
  process.env.WORKIT_CONFIG_DIR = path.join(base, "config");
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const args = "issue comment X-1 --body hi";

test("G ytrack respelled through an alias, a function or its resolved path, W the write runs, T it is denied without a named call (not a plain command)", () => {
  for (const command of [
    `alias yt=ytrack; yt ${args}`,
    `alias yt='ytrack issue'; yt comment X-1 --body hi`,
    `yt() { ytrack "$@"; }; yt ${args}`,
    `function yt { ytrack "$@"; }; yt ${args}`,
    `$(which ytrack) ${args}`,
    `$(command -v ytrack) ${args}`,
    `\`which ytrack\` ${args}`,
  ]) {
    const out = ytrackGate(root, command, "posix", false);
    expect(out?.kind, command).toBe("deny");
    // Not a plain command: still denied, but no workit call is named.
    expect(out?.kind === "deny" ? out.reason : "", command).not.toContain("`workit youtrack");
    expect(out?.kind === "deny" ? out.reason : "", command).toContain("in their own terminal");
  }
});

test("G the same respellings, W the call only reads or names another tool, T it passes", () => {
  for (const command of [
    "alias yt=ytrack; yt issue view X-1",
    "alias ll='ls -l'; ll",
    "$(which ytrack) issue view X-1",
    "yt() { echo ytrack; }; yt issue comment X-1 --body hi",
  ])
    expect(ytrackGate(root, command, "posix", true), command).toBeNull();
});
