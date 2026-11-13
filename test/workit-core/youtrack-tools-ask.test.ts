// #780: every YouTrack write Workit's own code makes asks the user first.
// `ytrackWrite` (defaultOperations.postComment / logTime) consumes the user's
// yes through the approval channel in ask mode (the default), and keeps the
// WORKIT_YT_WRITE gate with `youtrack.writes: auto`. A ytrack stub on PATH
// stands in for YouTrack; nothing reaches a real instance.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordApprovalGrant } from "@/packages/workit-core/src/approvals/store";
import { defaultOperations } from "@/packages/workit-core/src/core/youtrack-tools";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-yt-tools-ask-")));
const work = path.join(dir, "work");
const KEYS = [
  "WORKIT_CONFIG",
  "WORKIT_YOUTRACK_CONFIG",
  "WORKIT_STATE_DIR",
  "WORKIT_YT_WRITE",
  "WORKIT_NO_YTRACK",
  "PATH",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
let stateRun = 0;

/** A ytrack stub: `issue view` lists its comments, `issue comment` and `work-item add` add one. */
const STUB = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const dir = path.dirname(process.argv[1]);
fs.appendFileSync(path.join(dir, "calls"), args.join(" ") + "\\n");
const store = path.join(dir, "comments.json");
const comments = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : [];
if (args[0] === "issue" && args[1] === "view") process.stdout.write(JSON.stringify({ comments }));
else if (args[0] === "issue" && args[1] === "comment") {
  const comment = { id: "c" + (comments.length + 1), text: fs.readFileSync(0, "utf8") };
  fs.writeFileSync(store, JSON.stringify([...comments, comment]));
  process.stdout.write(JSON.stringify({ id: comment.id }));
} else if (args[0] === "work-item" && args[1] === "add") process.stdout.write(JSON.stringify({ id: "w1" }));
else process.exit(1);
`;

// The account's own config (a temp home): only its sealed file gives writes auto (#819).
let configHome: ConfigHome;
beforeAll(() => {
  writeFileSync(path.join(dir, "ytrack"), STUB);
  chmodSync(path.join(dir, "ytrack"), 0o755);
  configHome = useConfigHome("wk-yt-tools-ask-config-");
  process.env.WORKIT_YOUTRACK_CONFIG = path.join(dir, "youtrack.json");
  writeFileSync(
    process.env.WORKIT_YOUTRACK_CONFIG,
    JSON.stringify({ baseUrl: "https://yt.example.test" }),
  );
  delete process.env.WORKIT_NO_YTRACK;
  process.env.PATH = [dir, saved.PATH ?? ""].join(path.delimiter);
});
afterEach(() => {
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
  for (const name of ["calls", "comments.json"]) rmSync(path.join(dir, name), { force: true });
  process.env.WORKIT_STATE_DIR = path.join(dir, `state-${++stateRun}`);
  delete process.env.WORKIT_YT_WRITE;
});
afterAll(() => {
  configHome.restore();
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  rmSync(dir, { recursive: true, force: true });
});

const writesMode = (writes: "auto" | null) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${work}/**`, ...(writes ? { youtrack: { writes } } : {}) }],
    }),
  );

const posts = (): string[] =>
  existsSync(path.join(dir, "calls"))
    ? readFileSync(path.join(dir, "calls"), "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("issue comment") || line.startsWith("work-item add"))
    : [];

const requests = (): string[] => {
  try {
    return readdirSync(path.join(process.env.WORKIT_STATE_DIR!, "approvals", "requests"));
  } catch {
    return [];
  }
};

const storedRequest = (id: string): unknown =>
  JSON.parse(
    readFileSync(
      path.join(process.env.WORKIT_STATE_DIR ?? "", "approvals", "requests", `${id}.json`),
      "utf8",
    ),
  );

const userApproves = (id: string) =>
  expect(
    recordApprovalGrant({ id, host: "terminal", session: null, toolUseId: null, via: "terminal" })
      .ok,
  ).toBe(true);

test.skipIf(process.platform === "win32")(
  "Given the default (ask), When a caller reaches ytrackWrite for a comment, Then a youtrack-write request is recorded and nothing is posted until the user's yes is consumed; the retry posts once",
  async () => {
    process.env.WORKIT_STATE_DIR = path.join(dir, `state-${++stateRun}`);
    writesMode(null);
    // WORKIT_YT_WRITE=1 is no bypass in ask mode.
    process.env.WORKIT_YT_WRITE = "1";
    const first = await defaultOperations.postComment("NSR-40", "hello", work);
    expect(first).toMatchObject({ ok: false, outcome: "not_applied" });
    expect(String(first?.error)).toStartWith("approval_needed: nothing was posted");
    const id = String(first?.approval);
    // #864: the one pending request needs no id at the terminal.
    expect(String(first?.unblock)).toContain("`workit approve` in a terminal");
    const stored = storedRequest(id);
    expect(stored).toMatchObject({
      kind: "youtrack-write",
      action: "workit youtrack note NSR-40",
      subject: { comment: "hello" },
    });
    expect(posts()).toEqual([]);

    userApproves(id);
    const second = await defaultOperations.postComment("NSR-40", "hello", work);
    expect(second).toMatchObject({ id: "c1" });
    expect(posts()).toEqual(["issue comment NSR-40 --body-file - --json id,url"]);

    // One yes covers one write: a third call asks again and posts nothing.
    const third = await defaultOperations.postComment("NSR-40", "hello", work);
    expect(third).toMatchObject({ ok: false, outcome: "not_applied" });
    expect(posts()).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "Given the default (ask), When a caller reaches ytrackWrite for time, Then it asks with the youtrack time fields and logs once after the yes",
  async () => {
    writesMode(null);
    const input = { issueId: "NSR-40", minutes: 15, text: "review", date: "2026-11-10" };
    const first = await defaultOperations.logTime({ ...input, workspace_root: work });
    expect(first).toMatchObject({ ok: false, outcome: "not_applied" });
    expect(requests()).toHaveLength(1);
    const id = String(first?.approval);
    const stored = storedRequest(id);
    expect(stored).toMatchObject({
      action: "workit youtrack time NSR-40 --minutes 15",
      subject: { minutes: 15, text: "review", date: "2026-11-10" },
    });
    expect(posts()).toEqual([]);
    userApproves(id);
    expect(await defaultOperations.logTime({ ...input, workspace_root: work })).toMatchObject({
      workItemId: "w1",
    });
    expect(posts()).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "Given youtrack.writes auto, Then ytrackWrite posts behind WORKIT_YT_WRITE=1 as today, with no request",
  async () => {
    writesMode("auto");
    const gated = await defaultOperations.postComment("NSR-40", "hello", work);
    expect(String(gated?.error)).toContain("WORKIT_YT_WRITE=1");
    process.env.WORKIT_YT_WRITE = "1";
    expect(await defaultOperations.postComment("NSR-40", "hello", work)).toMatchObject({
      id: "c1",
    });
    expect(posts()).toHaveLength(1);
    expect(requests()).toEqual([]);
  },
);
