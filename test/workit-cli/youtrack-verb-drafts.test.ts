// Drafts shown in full (#864): a `workit youtrack` write that needs the
// user's yes prints the whole text and its hash (never only the file's path),
// a revision prints the diff from the text printed last plus the new text,
// and the yes binds to the whole text. A recording ytrack stub on PATH, a
// temp state dir: never a real ytrack, YouTrack or home.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run, type YouTrackDeps } from "@/packages/workit-cli/src/verbs/youtrack";
import {
  approvalHash,
  readApprovalRequest,
  recordApprovalGrant,
  renderApprovalRequest,
} from "@/packages/workit-core/src/approvals/store";
import { youTrackAsk } from "@/packages/workit-core/src/approvals/youtrack-ask";

const STUB = `#!/bin/sh
case "$1 $2" in
  "issue comment") cat > /dev/null; echo '{"id":"4-1"}' ;;
  "issue view") echo '{"comments":[]}' ;;
  "work-item list") echo '[]' ;;
  "api /users/me") echo '{"login":"me"}' ;;
esac
exit 0
`;

let dir = "";
let bin = "";
let stateRun = 0;
const saved = {
  WORKIT_YOUTRACK_CONFIG: process.env.WORKIT_YOUTRACK_CONFIG,
  WORKIT_CONFIG: process.env.WORKIT_CONFIG,
  WORKIT_STATE_DIR: process.env.WORKIT_STATE_DIR,
};

beforeAll(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-yt-drafts-")));
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
});

/** The stub is a POSIX shell script. */
const it = process.platform === "win32" ? test.skip : test;

const ASK: YouTrackDeps = { writes: () => "ask" };

const call = async (argv: string[], json = false) => {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    json,
    cwd: dir,
    env: { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await run(argv, io, undefined, ASK);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const draft = (name: string, text: string): void => writeFileSync(path.join(dir, name), text);

it("Given `workit youtrack note X --file f`, When the verb prints, Then its output holds the full text and its hash, not only the path", async () => {
  const text = "Fixed the login loop\n\n- cause: a stale cookie\n- fix: clear it on 401\n";
  draft("note.md", text);
  const out = await call(["note", "AB2-7", "--file", "note.md"]);
  expect(out.code).toBe(3);
  expect(out.stdout).toBe(
    [
      `--- comment on AB2-7: show this to the user verbatim in chat, in full (sha256 ${sha(text).slice(0, 12)}) ---`,
      text.trimEnd(),
      "--- end of comment on AB2-7 ---",
      "",
    ].join("\n"),
  );
  expect(out.stderr).toContain("approval_needed");
});

it("Given the draft file is edited and the verb runs again, Then the output holds a diff from the previous text and the new full text", async () => {
  draft("rev.md", "Deployed to staging\nAll checks green\n");
  await call(["note", "AB2-8", "--file", "rev.md"]);
  const revised = "Deployed to staging\nTwo checks red: retrying\n";
  draft("rev.md", revised);
  const out = await call(["note", "AB2-8", "--file", "rev.md"]);
  expect(out.stdout).toContain(`(sha256 ${sha(revised).slice(0, 12)})`);
  expect(out.stdout).toContain(
    [
      "changed since last shown (- removed, + added):",
      " Deployed to staging",
      "-All checks green",
      "+Two checks red: retrying",
      "",
      "the new full text:",
      revised.trimEnd(),
      "--- end of comment on AB2-8 ---",
    ].join("\n"),
  );
  // Unchanged since that print: the whole text again, no diff.
  const same = await call(["note", "AB2-8", "--file", "rev.md"], true);
  expect(same.json().data.draft).toEqual({
    target: "youtrack:AB2-8:comment",
    sha256: sha(revised),
    text: revised,
    diff: null,
  });
});

it("Given a time-log text and an update with a comment, When they ask, Then each prints its own text in full", async () => {
  const time = await call(["time", "AB2-9", "--minutes", "30", "--text", "Pairing on the parser"]);
  expect(time.stdout).toContain("--- time-log text on AB2-9: show this to the user verbatim");
  expect(time.stdout).toContain("\nPairing on the parser\n");
  const update = await call([
    "update",
    "AB2-9",
    "--markdown",
    "Done\nShipped in 1.2",
    "--state",
    "Done",
  ]);
  expect(update.stdout).toContain("--- comment on AB2-9: show this");
  expect(update.stdout).toContain("\nDone\nShipped in 1.2\n--- end of comment on AB2-9 ---");
});

it("Given an approval prompt for a long comment, When it renders, Then it holds the full comment capped with 'N more lines', and the hashed subject is the full text", async () => {
  const lines = Array.from({ length: 75 }, (_, index) => `line ${index + 1}`);
  const text = `${lines.join("\n")}\n`;
  draft("long.md", text);
  const out = await call(["update", "AB2-10", "--file", "long.md"], true);
  expect(out.code).toBe(3);
  const request = readApprovalRequest(out.json().data.approval);
  expect(request?.subject.comment).toBe(text);
  expect(request?.hash).toBe(approvalHash(request!));
  const rendered = renderApprovalRequest(request!);
  expect(rendered).toContain("    line 60\n");
  expect(rendered).toContain("… 15 more lines");
  expect(rendered).not.toContain("line 61\n");
  // Changing only a line past the cap changes what the yes binds to.
  const changed = {
    ...request!,
    subject: { ...request!.subject, comment: text.replace("line 75", "line 75!") },
  };
  expect(approvalHash(changed)).not.toBe(request?.hash);
  // The host prompt on the call itself: the same cap in what shows, every byte in its hash.
  const ask = youTrackAsk(["update", "AB2-10", "--file", "long.md"], dir);
  expect(ask?.text).toContain("    line 60\n    … 15 more lines");
  draft("long.md", text.replace("line 75", "line 75!"));
  expect(youTrackAsk(["update", "AB2-10", "--file", "long.md"], dir)?.contentHash).not.toBe(
    ask?.contentHash,
  );
});

it("Given the approved comment posts, Then the next draft for that issue starts fresh with no diff", async () => {
  draft("post.md", "First version\n");
  const asked = await call(["note", "AB2-11", "--file", "post.md"], true);
  expect(
    recordApprovalGrant({
      id: asked.json().data.approval,
      host: "terminal",
      session: null,
      toolUseId: null,
      via: "terminal",
    }).ok,
  ).toBe(true);
  const posted = await call(["note", "AB2-11", "--file", "post.md"], true);
  expect(posted.code).toBe(0);
  draft("post.md", "Second note\n");
  const next = await call(["note", "AB2-11", "--file", "post.md"], true);
  expect(next.json().data.draft.diff).toBeNull();
  expect(readFileSync(path.join(dir, "post.md"), "utf8")).toBe("Second note\n");
});
