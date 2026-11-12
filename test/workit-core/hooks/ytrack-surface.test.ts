// #780 fix round (verdict mwdbd0km): the guard reads ytrack's own surface, not
// only its plain spelling: the `workitem` alias of `work-item` (ytrack's
// `work-item --help`: "Aliases: work-item, workitem") and global flags before
// the command group (`--host`, `--debug`, `--no-color`).
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { ytrackGate } from "@/packages/workit-core/src/hooks/ytrack-guard";
import { tempRoot } from "./hook-fixtures";

const base = realpathSync(tempRoot("workit-ytrack-surface-"));
const root = path.join(base, "repo");
mkdirSync(root, { recursive: true });
beforeEach(() => {
  process.env.WORKIT_CONFIG_DIR = path.join(base, "config");
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("G ytrack's aliases and global flags, W a write is spelled with them, T it is judged like the plain write", () => {
  for (const [command, call] of [
    ["ytrack workitem add X-1 --duration 30m", "workit youtrack time X-1 --minutes 30"],
    ["ytrack --debug issue comment X-1 --body hi", "workit youtrack note X-1 --markdown hi"],
    ["ytrack --no-color issue comment X-1 --body hi", "workit youtrack note X-1 --markdown hi"],
    [
      "ytrack --debug --no-color work-item add X-1 --duration 30m",
      "workit youtrack time X-1 --minutes 30",
    ],
  ]) {
    const out = ytrackGate(root, command, "posix", false);
    expect(out?.kind, command).toBe("deny");
    expect(out?.kind === "deny" ? out.reason : "", command).toContain(`\`${call}\``);
  }
  expect(ytrackGate(root, "ytrack workitem delete X-1 115-3 --yes", "posix", true)?.kind).toBe(
    "ask",
  );
  expect(ytrackGate(root, "ytrack --debug api /issues/X-1 -X DELETE", "posix", true)?.kind).toBe(
    "ask",
  );
});

test("G the same aliases and flags, W the call only reads, T it passes", () => {
  for (const command of [
    "ytrack workitem list X-1",
    "ytrack --debug issue view X-1",
    "ytrack --no-color api /users/me --fields login",
  ])
    expect(ytrackGate(root, command, "posix", true), command).toBeNull();
});
