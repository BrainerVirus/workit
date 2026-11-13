// `workit youtrack update`: one yes covers a whole issue update (comment with
// attachments, time, state), made through a recording ytrack stub on PATH,
// never a real ytrack or YouTrack.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run, type YouTrackDeps } from "@/packages/workit-cli/src/verbs/youtrack";
import { recordApprovalGrant } from "@/packages/workit-core/src/approvals/store";

const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DIR/calls"
case "$1 $2" in
  "issue comment")
    case "$*" in *--help*)
      if [ -f "$STUB_DIR/old" ]; then echo "Usage: ytrack issue comment <ISSUE> --body <t>"; else echo "Usage: ytrack issue comment <ISSUE> --body <t> [--attach <file>]..."; fi
      exit 0 ;;
    esac
    cat > /dev/null
    echo '{"id":"4-1"}' ;;
  "issue attach")
    case "$*" in *--help*) echo "Usage: ytrack issue attach <ISSUE> <file>..."; exit 0 ;; esac ;;
  "issue view") echo '{"comments":[]}' ;;
  "work-item list") echo '[]' ;;
  "api /users/me") echo '{"login":"me"}' ;;
  "work-item add")
    if [ -f "$STUB_DIR/time.fail" ]; then echo "server error" >&2; exit 1; fi
    echo '{"id":"9-1"}' ;;
  "issue command") ;;
  "issue create") cat > /dev/null; echo '{"idReadable":"AB2-7","url":null}' ;;
esac
exit 0
`;

let dir = "";
let bin = "";
let stubDir = "";
let stateRun = 0;
const saved = {
  WORKIT_YOUTRACK_CONFIG: process.env.WORKIT_YOUTRACK_CONFIG,
  WORKIT_CONFIG: process.env.WORKIT_CONFIG,
  WORKIT_STATE_DIR: process.env.WORKIT_STATE_DIR,
};

beforeAll(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-yt-update-")));
  writeFileSync(
    path.join(dir, "youtrack.json"),
    JSON.stringify({ baseUrl: "https://acme.youtrack.cloud", timezone: "UTC" }),
  );
  process.env.WORKIT_YOUTRACK_CONFIG = path.join(dir, "youtrack.json");
  mkdirSync(path.join(dir, "config"), { recursive: true });
  process.env.WORKIT_CONFIG = path.join(dir, "config");
  bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "ytrack"), STUB);
  chmodSync(path.join(bin, "ytrack"), 0o755);
  writeFileSync(
    path.join(dir, "c.md"),
    "Deployed the fix\n\n![](a.png)\n\nSee b.html for the report\n",
  );
  writeFileSync(path.join(dir, "a.png"), "png-bytes");
  writeFileSync(path.join(dir, "b.html"), "<p>report</p>");
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  stateRun += 1;
  process.env.WORKIT_STATE_DIR = path.join(dir, `state-${stateRun}`);
  stubDir = mkdtempSync(path.join(dir, "rec-"));
});

/** The stub is a POSIX shell script. */
const it = process.platform === "win32" ? test.skip : test;

const ASK: YouTrackDeps = { writes: () => "ask" };

const call = async (argv: string[], deps: YouTrackDeps = ASK) => {
  let stdout = "";
  const io: Io = {
    json: true,
    cwd: dir,
    env: {
      PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      STUB_DIR: stubDir,
    },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await run(argv, io, undefined, deps);
  return { code, json: () => JSON.parse(stdout) };
};

/** The writes the stub received, past the probes and read-backs. */
const writes = (): string[] => {
  const file = path.join(stubDir, "calls");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => /^(issue (comment|attach|command|create)|work-item add) /.test(line))
    .filter((line) => !line.includes("--help"));
};

const requests = (): string[] => {
  try {
    return readdirSync(path.join(process.env.WORKIT_STATE_DIR!, "approvals", "requests"));
  } catch {
    return [];
  }
};

const stored = (id: string) =>
  JSON.parse(
    readFileSync(
      path.join(process.env.WORKIT_STATE_DIR!, "approvals", "requests", `${id}.json`),
      "utf8",
    ),
  );

const userApproves = (id: string) => {
  const granted = recordApprovalGrant({
    id,
    host: "terminal",
    session: null,
    toolUseId: null,
    via: "terminal",
  });
  expect(granted.ok).toBe(true);
};

const UPDATE = [
  "update",
  "AB2-142",
  "--file",
  "c.md",
  "--attach",
  "a.png",
  "--attach",
  "b.html",
  "--minutes",
  "165",
  "--state",
  "Done",
];

it("Given an update with a comment, two files, 165 minutes and a state, When it runs in ask mode, Then exactly one approval_needed names every effect and nothing is written", async () => {
  const out = await call(UPDATE);
  expect(out.code).toBe(3);
  const refusal = out.json();
  expect(refusal.data).toMatchObject({
    reason: "approval_needed",
    posted: false,
  });
  expect(requests()).toHaveLength(1);
  const request = stored(refusal.data.approval);
  const preview = `${request.effect} ${JSON.stringify(request.subject)}`;
  expect(preview).toContain("Deployed the fix");
  expect(preview).toContain("a.png (9 B");
  expect(preview).toContain("b.html (13 B");
  expect(preview).toContain("2h45m");
  expect(preview).toContain("State Done");
  expect(request.target).toMatchObject({ issue: "AB2-142" });
  expect(request.effect).toContain("acme.youtrack.cloud");
  expect(writes()).toEqual([]);
});

it("Given that yes, When the same update runs again, Then ytrack gets the comment with both files, then the work item, then State Done, once each", async () => {
  userApproves((await call(UPDATE)).json().data.approval);
  const out = await call(UPDATE);
  expect(out.code).toBe(0);
  expect(out.json().data.steps).toEqual([
    { step: "comment", status: "done" },
    { step: "time", status: "done" },
    { step: "command", status: "done" },
  ]);
  const sent = writes().map(copied);
  expect(sent).toHaveLength(3);
  expect(sent[0]).toStartWith("issue comment AB2-142 --body-file - ");
  expect(sent[0]).toContain("--attach <copy>/a.png --attach <copy>/b.html");
  expect(sent[1]).toStartWith("work-item add AB2-142 --duration 165 ");
  expect(sent[2]).toBe("issue command AB2-142 State Done");
});

it("Given the comment lands and the work item fails, When the update runs, Then it exits non-zero, names the comment as landed and the time and state as not applied", async () => {
  writeFileSync(path.join(stubDir, "time.fail"), "");
  userApproves((await call(UPDATE)).json().data.approval);
  const out = await call(UPDATE);
  expect(out.code).not.toBe(0);
  const body = out.json();
  expect(body.data.steps).toEqual([
    { step: "comment", status: "done" },
    { step: "time", status: "failed" },
    { step: "command", status: "not_applied" },
  ]);
  expect(body.error).toContain("landed: comment");
  expect(body.error).toContain("not applied: command");
  expect(writes().filter((line) => line.startsWith("issue command"))).toEqual([]);
});

it("Given --attach missing.png, When the update runs, Then it fails naming the file before any request is made", async () => {
  const out = await call(["update", "AB2-142", "--markdown", "hi", "--attach", "missing.png"]);
  expect(out.code).toBe(2);
  expect(out.json().error).toContain("missing.png");
  expect(requests()).toEqual([]);
  expect(writes()).toEqual([]);
});

it("Given a ytrack without --attach, When an update attaches a file, Then it fails with the ytrack upgrade unblock before asking", async () => {
  writeFileSync(path.join(stubDir, "old"), "");
  const out = await call(["update", "AB2-142", "--markdown", "hi", "--attach", "a.png"]);
  expect(out.code).toBe(5);
  expect(out.json().unblock).toStartWith("ytrack upgrade");
  expect(out.json().error).toContain("--attach");
  expect(requests()).toEqual([]);
});

it("Given no effect, When update runs, Then it is refused as invalid input", async () => {
  const out = await call(["update", "AB2-142"]);
  expect(out.code).toBe(2);
  expect(out.json().error).toContain("at least one of");
});

/**
 * An attachment posts from a private copy of the bytes Workit read and the user
 * approved (#864), never from its own path, which could change after the yes.
 */
const copied = (line: string): string => line.replaceAll(/\S*workit-attach-[^/\s]+\//gu, "<copy>/");

it("Given only files and a command, When the approved update runs, Then the files go through issue attach and the command after them", async () => {
  const args = ["update", "AB2-142", "--attach", "a.png", "--command", "tag Reviewed"];
  userApproves((await call(args)).json().data.approval);
  expect((await call(args)).code).toBe(0);
  expect(writes().map(copied)).toEqual([
    "issue attach AB2-142 <copy>/a.png",
    "issue command AB2-142 tag Reviewed",
  ]);
});

it("Given create with a file and a command, When the user's one yes is used, Then the issue is created, the file attached and the command applied", async () => {
  const args = [
    "create",
    "--project",
    "AB2",
    "--summary",
    "Crash",
    "--attach",
    "a.png",
    "--command",
    "State Open",
  ];
  const first = await call(args);
  expect(first.code).toBe(3);
  expect(stored(first.json().data.approval).effect).toContain("a.png");
  userApproves(first.json().data.approval);
  const out = await call(args);
  expect(out.code).toBe(0);
  expect(out.json().data.issueId).toBe("AB2-7");
  expect(writes().map(copied)).toEqual([
    "issue create --project AB2 --summary Crash --json idReadable,url",
    "issue attach AB2-7 <copy>/a.png",
    "issue command AB2-7 State Open",
  ]);
});

it("Given two --attach files with the same name, When the update runs, Then it fails naming both before any request", async () => {
  mkdirSync(path.join(dir, "sub"), { recursive: true });
  writeFileSync(path.join(dir, "sub", "a.png"), "other");
  const out = await call([
    "update",
    "AB2-142",
    "--markdown",
    "hi",
    "--attach",
    "a.png",
    "--attach",
    "sub/a.png",
  ]);
  expect(out.code).toBe(2);
  expect(out.json().error).toContain("same name");
  expect(requests()).toEqual([]);
});

/** Ask, have the user say yes, change something, then rerun with `args`. */
const changedAfterYes = async (change: () => void, args: string[]) => {
  userApproves((await call(args)).json().data.approval);
  change();
  return call(args);
};

it("Given a yes, When an attachment's bytes change before the rerun, Then nothing is written and the yes is stale", async () => {
  const out = await changedAfterYes(
    () => writeFileSync(path.join(dir, "a.png"), "other-bytes"),
    UPDATE,
  );
  expect(out.code).toBe(3);
  expect(out.json().data.reason).toBe("approval_stale");
  expect(writes()).toEqual([]);
});

it("Given a yes, When a comment line past the 3-line preview changes, Then nothing is written and the yes is stale", async () => {
  writeFileSync(path.join(dir, "d.md"), "l1\nl2\nl3\nl4 original\n");
  const out = await changedAfterYes(
    () => writeFileSync(path.join(dir, "d.md"), "l1\nl2\nl3\nl4 changed\n"),
    ["update", "AB2-142", "--file", "d.md", "--minutes", "5"],
  );
  expect(out.code).toBe(3);
  expect(out.json().data.reason).toBe("approval_stale");
  expect(writes()).toEqual([]);
});

it("Given a yes for 5 minutes with text x, When the rerun asks 6 minutes or text y, Then neither rides on that yes", async () => {
  userApproves(
    (await call(["update", "AB2-142", "--minutes", "5", "--text", "x"])).json().data.approval,
  );
  expect((await call(["update", "AB2-142", "--minutes", "6", "--text", "x"])).code).toBe(3);
  expect((await call(["update", "AB2-142", "--minutes", "5", "--text", "y"])).code).toBe(3);
  expect(writes()).toEqual([]);
});

it("Given a yes already used, When the same update runs a third time, Then it asks again and writes nothing more", async () => {
  const args = ["update", "AB2-142", "--command", "tag A"];
  userApproves((await call(args)).json().data.approval);
  expect((await call(args)).code).toBe(0);
  expect((await call(args)).code).toBe(3);
  expect(writes()).toEqual(["issue command AB2-142 tag A"]);
});
