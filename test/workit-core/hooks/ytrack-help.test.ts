// #780 fix round (verdict mwdbd0km): `ytrack <write> --help` only prints help,
// and the ytrack skill tells agents to run it before guessing a flag, so the
// raw-ytrack guard never denies or asks on it; a `--help` that is an option's
// value is still the write it carries.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { ytrackGate } from "@/packages/workit-core/src/hooks/ytrack-guard";
import { tempRoot } from "./hook-fixtures";

const base = realpathSync(tempRoot("workit-ytrack-help-"));
const root = path.join(base, "repo");
mkdirSync(root, { recursive: true });
beforeEach(() => {
  process.env.WORKIT_CONFIG_DIR = path.join(base, "config");
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("G a ytrack write subcommand, W the call asks for its help, T neither Claude Code nor the deny-only hosts stop it", () => {
  for (const command of [
    "ytrack issue comment --help",
    "ytrack issue comment -h",
    "ytrack issue create --help",
    "ytrack work-item add --help",
    "ytrack work-item add --help 2>&1 | head -30",
    "ytrack issue edit --help",
    "ytrack issue command --help",
    "ytrack issue comment X-1 --help",
    "ytrack api --help",
    "bash -c 'ytrack issue comment -h'",
  ])
    for (const ask of [true, false])
      expect(ytrackGate(root, command, "posix", ask), `${ask}: ${command}`).toBeNull();
});

test("G a write whose body value is the text --help, W it runs, T it is still judged as the write", () => {
  for (const command of [
    "ytrack issue comment X-1 --body --help",
    "ytrack issue comment X-1 --body=-h",
  ])
    expect(ytrackGate(root, command, "posix", false)?.kind, command).toBe("deny");
});
