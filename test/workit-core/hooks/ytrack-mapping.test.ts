// #780 fix round (verdict mwdbd0km): the `workit youtrack …` call a deny names
// does exactly what the raw ytrack write would. It is offered only when every
// option is one the mapping carries and every value is a literal; otherwise
// the write is the user's to decide, never a placeholder call.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { segmentsOf } from "@/packages/workit-core/src/hooks/shell-words";
import { ytrackGate } from "@/packages/workit-core/src/hooks/ytrack-guard";
import { tempRoot } from "./hook-fixtures";

const base = realpathSync(tempRoot("workit-ytrack-mapping-"));
const root = path.join(base, "repo");
mkdirSync(root, { recursive: true });
beforeEach(() => {
  process.env.WORKIT_CONFIG_DIR = path.join(base, "config");
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

type Write = {
  verb: string;
  issue?: string;
  text?: string;
  file?: string;
  minutes?: number;
  date?: string;
  project?: string;
  summary?: string;
  description?: string;
};

/** The write a `workit youtrack …` call makes, read back from its shell words. */
const parseCall = (call: string): Write => {
  const [segment] = segmentsOf(call);
  const [workit, youtrack, verb, ...args] = segment.words;
  expect([workit, youtrack]).toEqual(["workit", "youtrack"]);
  const out: Write = { verb };
  const keys: Record<string, keyof Write> = {
    "--markdown": "text",
    "--text": "text",
    "--file": "file",
    "--date": "date",
    "--project": "project",
    "--summary": "summary",
    "--description": "description",
  };
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (!flag.startsWith("-")) {
      out.issue = arg;
      continue;
    }
    // A bare value never starts with `-`: workit reads that as the next flag.
    const value = eq > 0 && flag !== arg ? arg.slice(eq + 1) : args[++at];
    expect(value.startsWith("-") && flag === arg, `${call}: ${flag}`).toBe(false);
    if (flag === "--minutes") out.minutes = Number(value);
    else (out as Record<string, unknown>)[keys[flag]] = value;
  }
  return out;
};

/** The one `workit youtrack …` call a deny names. */
const callIn = (reason: string): string => {
  const found = /`(workit youtrack [^`]+)`/.exec(reason);
  expect(found, reason).not.toBeNull();
  return found![1];
};

/** Raw ytrack writes and the write they make (what ytrack itself would post). */
const MAPPED: Array<[string, Write]> = [
  ["ytrack issue comment X-1 --body hi", { verb: "note", issue: "X-1", text: "hi" }],
  ["ytrack issue comment X-1 -b hi", { verb: "note", issue: "X-1", text: "hi" }],
  ["ytrack issue comment --body hi X-1", { verb: "note", issue: "X-1", text: "hi" }],
  ["ytrack issue comment X-1 --body '-1 ok'", { verb: "note", issue: "X-1", text: "-1 ok" }],
  ["ytrack issue comment X-1 --body='a b'", { verb: "note", issue: "X-1", text: "a b" }],
  ["T='lit'; ytrack issue comment X-1 --body \"$T\"", { verb: "note", issue: "X-1", text: "lit" }],
  ["ytrack issue comment X-1 --body-file r.md", { verb: "note", issue: "X-1", file: "r.md" }],
  ["ytrack --debug issue comment X-1 --body hi", { verb: "note", issue: "X-1", text: "hi" }],
  [
    "ytrack work-item add X-1 --duration 1h30m --text 'Code review' --date 2026-10-06",
    { verb: "time", issue: "X-1", minutes: 90, text: "Code review", date: "2026-10-06" },
  ],
  ["ytrack work-item add X-1 --duration 90", { verb: "time", issue: "X-1", minutes: 90 }],
  ["ytrack work-item add X-1 --duration 1.5h", { verb: "time", issue: "X-1", minutes: 90 }],
  [
    "ytrack work-item add X-1 --duration '2 hours 15 minutes' --text -x",
    { verb: "time", issue: "X-1", minutes: 135, text: "-x" },
  ],
  [
    "ytrack issue create -p APP -s 'Crash on start' --description 'Steps'",
    { verb: "create", project: "APP", summary: "Crash on start", description: "Steps" },
  ],
  [
    "ytrack issue create --project APP --summary S --description-file notes.md",
    { verb: "create", project: "APP", summary: "S", file: "notes.md" },
  ],
];

/** Writes the mapping cannot carry faithfully, and the part the deny names. */
const UNCARRIED: Array<[string, string]> = [
  ["ytrack --host acme issue comment X-1 --body hi", "--host"],
  ["ytrack issue create --project APP --summary S --tag a", "--tag"],
  ["ytrack issue create --project APP --summary S --field Type=Bug", "--field"],
  ["ytrack issue create --project APP --summary S --assignee me", "--assignee"],
  ["ytrack work-item add X-1 --duration 30m --type Development", "--type"],
  ["ytrack work-item add X-1 --duration 30m --meeting --text Planning", "--meeting"],
  ["ytrack work-item add X-1 --duration 2d", "--duration 2d"],
  ["ytrack work-item add X-1 --duration 1h30", "--duration 1h30"],
  ["ytrack work-item add X-1 --duration 0", "--duration 0"],
  ['ytrack issue comment X-1 --body "$HOME"', "--body"],
  ['ytrack issue comment X-1 --body "$l"', "--body"],
  ['ytrack issue comment X-1 --body "`date`"', "--body"],
  ['ytrack issue comment X-1 --body "$(date)"', "--body"],
  ["ytrack issue comment X-1 --body-file -", "standard input"],
  ["ytrack issue comment https://acme.youtrack.cloud/issue/X-1 --body hi", "the issue"],
  ["ytrack issue comment X-1", "--body"],
  ["ytrack work-item add X-1 --text t", "--duration"],
];

test("G a raw write the mapping carries, W the hook denies it, T the named call parses back to the same issue, text, minutes, date, project and summary", () => {
  for (const [command, write] of MAPPED) {
    const out = ytrackGate(root, command, "posix", true);
    expect(out?.kind, command).toBe("deny");
    expect(parseCall(callIn(out?.kind === "deny" ? out.reason : "")), command).toEqual(write);
  }
});

test("G a raw write with a part the mapping cannot carry, W the hook judges it, T no workit call is offered and the user decides", () => {
  for (const [command, part] of UNCARRIED) {
    const ask = ytrackGate(root, command, "posix", true);
    expect(ask?.kind, command).toBe("ask");
    const deny = ytrackGate(root, command, "posix", false);
    expect(deny?.kind, command).toBe("deny");
    for (const out of [ask, deny]) {
      const reason = out?.kind === "ask" || out?.kind === "deny" ? out.reason : "";
      expect(reason, command).not.toContain("`workit youtrack");
      expect(reason, command).not.toContain("<");
      expect(reason, command).toContain("cannot carry");
      expect(reason, command).toContain(part);
      expect(reason, command).toContain("the user decides");
    }
  }
});
