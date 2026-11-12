// Several raw ytrack writes on one issue (a comment with files, time, a state
// change, a hand-built API upload) are routed to ONE `workit youtrack update`
// call, so the user answers one ask for the whole update.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { ytrackGate } from "@/packages/workit-core/src/hooks/ytrack-guard";
import { tempRoot } from "./hook-fixtures";

const base = realpathSync(tempRoot("workit-ytrack-update-"));
const root = path.join(base, "repo");
mkdirSync(root, { recursive: true });
beforeEach(() => {
  process.env.WORKIT_CONFIG_DIR = path.join(base, "config");
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const reason = (command: string, ask = false): string => {
  const out = ytrackGate(root, command, "posix", ask);
  expect(out?.kind, command).toBe("deny");
  return out?.kind === "deny" ? out.reason : "";
};

/** Every `workit youtrack …` call a deny names. */
const calls = (text: string): string[] =>
  [...text.matchAll(/`(workit youtrack [^`]+)`/g)].map((match) => match[1]);

test("G a comment, time and a state change on one issue chained with &&, W the hook judges it, T it denies once naming the single update call", () => {
  const command =
    "ytrack issue comment X-1 --body-file c.md && ytrack work-item add X-1 --duration 1h && ytrack issue command X-1 'State Done'";
  for (const ask of [true, false])
    expect(calls(reason(command, ask))).toEqual([
      "workit youtrack update X-1 --file c.md --minutes 60 --state Done",
    ]);
});

/** Raw writes and the one call that makes the same update. */
const ROUTED: Array<[string, string]> = [
  [
    "ytrack issue comment X-1 --body-file c.md --attach a.png --attach b.html",
    "workit youtrack update X-1 --file c.md --attach a.png --attach b.html",
  ],
  [
    "ytrack issue attach X-1 a.png b.html",
    "workit youtrack update X-1 --attach a.png --attach b.html",
  ],
  [
    "ytrack issue command AB2-14 'tag Reviewed'",
    "workit youtrack update AB2-14 --command 'tag Reviewed'",
  ],
  [
    "ytrack api /api/issues/X-1/attachments -X POST -F upload=@a.png -F upload=@b.html",
    "workit youtrack update X-1 --attach a.png --attach b.html",
  ],
  ["ytrack api /issues/X-1/comments -X POST -F text=@c.md", "workit youtrack note X-1 --file c.md"],
  [
    "ytrack issue comment X-1 --body hi; ytrack issue attach X-1 a.png; ytrack work-item add X-1 --duration 30m --text Review",
    "workit youtrack update X-1 --markdown hi --attach a.png --minutes 30 --text Review",
  ],
  [
    "ytrack api /issues/X-1/attachments -F f=@a.png && ytrack issue comment X-1 --body-file c.md",
    "workit youtrack update X-1 --file c.md --attach a.png",
  ],
];

test("G raw writes the update verb covers (attachments, commands, hand-built API uploads, chains), W the hook judges them, T it names the one call that makes them", () => {
  for (const [command, call] of ROUTED) expect(calls(reason(command)), command).toEqual([call]);
});

/** Chains that are not one update: the first write is named, the rest are the user's. */
const SPLIT = [
  // Two issues.
  "ytrack issue comment X-1 --body hi && ytrack work-item add X-2 --duration 1h",
  // `||` runs the second only when the first fails.
  "ytrack issue comment X-1 --body hi || ytrack work-item add X-1 --duration 1h",
  // Two times on one issue.
  "ytrack work-item add X-1 --duration 1h && ytrack work-item add X-1 --duration 2h",
  // Something runs between them.
  "ytrack issue comment X-1 --body hi && cd /tmp && ytrack issue attach X-1 a.png",
  // A write no verb covers.
  "ytrack issue comment X-1 --body hi && ytrack issue delete X-1",
];

test("G a chain that is not one update, W the hook judges it, T no combined call is named and the rest is the user's", () => {
  for (const command of SPLIT) {
    const text = reason(command);
    expect(
      calls(text).filter((call) => call.includes(" update ")),
      command,
    ).toEqual([]);
    expect(text, command).toContain("in their own terminal");
  }
});

/** Hand-built API writes the mapping cannot carry: the user decides. */
const API_GAPS = [
  "ytrack api /issues/X-1/attachments -X POST -F upload=@$FILE",
  "ytrack api /issues/X-1/attachments -X POST -f name=a.png",
  "ytrack api /issues/X-1/comments -X POST -f text=hi -f usesMarkdown=true",
  "ytrack api /issues/X-1/comments -X PUT -f text=hi",
  "ytrack api /issues/X-1/attachments -X POST -H 'Authorization: x' -F f=@a.png",
  "ytrack issue command X-1 State Done",
];

test("G a hand-built write the mapping cannot carry, W the hook judges it, T no workit call is named", () => {
  for (const command of API_GAPS) {
    expect(ytrackGate(root, command, "posix", true)?.kind, command).toBe("ask");
    expect(calls(reason(command)), command).toEqual([]);
  }
});
