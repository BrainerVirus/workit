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

// Decision for PR #827: a word that clears a call (`--help`, `-h`, `--dry-run`,
// `-X GET`) clears it only when it stands alone; after an option Workit does not
// know it may be that option's value, so the call is judged as the write.
const NOT_ALONE = [
  "ytrack issue comment X-1 --body hi --template --help",
  "ytrack issue comment X-1 --body hi -t -h",
  "ytrack issue edit X-1 --summary x --template -h",
  "ytrack api /issues -X POST -H -h",
  "ytrack issue comment X-1 --body hi -- --help",
  "ytrack issue --template x comment X-1 --body hi",
  "ytrack -H x issue comment X-1 --body hi",
  "ytrack issue command X-1 'State Fixed' --comment --dry-run",
  "ytrack api /issues -f a=b -X GET -X POST",
  "ytrack api /issues -f -X GET",
  "ytrack -H 'X: y' api /issues -X POST",
];

test("G a clearing word after an option Workit does not know, W the hook judges it, T it is the write no verb covers", () => {
  for (const command of NOT_ALONE) {
    expect(ytrackGate(root, command, "posix", true)?.kind, command).toBe("ask");
    const out = ytrackGate(root, command, "posix", false);
    expect(out?.kind, command).toBe("deny");
    const reason = out?.kind === "deny" ? out.reason : "";
    expect(reason, command).toContain("in their own terminal");
    expect(reason, command).not.toContain("`workit youtrack");
  }
});

test("G a clearing word that stands alone, W the hook judges it, T it still passes", () => {
  for (const command of [
    "ytrack --debug issue comment --help",
    "ytrack help issue comment",
    "ytrack --host acme issue comment --help",
    "ytrack work-item add X-1 --duration 30m --meeting --help",
    "ytrack api /issues --paginate -X GET -f q=x",
    "ytrack issue command X-1 'State Fixed' --dry-run",
  ])
    for (const ask of [true, false])
      expect(ytrackGate(root, command, "posix", ask), `${ask}: ${command}`).toBeNull();
});
