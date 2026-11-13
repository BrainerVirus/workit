// #780 review: a YouTrack backlink is a YouTrack write, so in ask mode (the
// default) it never posts behind WORKIT_YT_WRITE alone. The PR still opens;
// the backlink records a request through the approval channel and is pending
// until the user's yes, which a re-run of `workit pr create` consumes.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inlineAskFor, inlineCallIn } from "@/packages/workit-core/src/approvals/inline";
import { postBacklinks, type IssueLink } from "@/packages/workit-core/src/forge/issue-link";
import type { ResolvedForge } from "@/packages/workit-core/src/forge/resolve";
import { useConfigHome } from "../../shared/grant-home";

const dir = mkdtempSync(path.join(os.tmpdir(), "wk-backlink-ask-"));
const saved = {
  WORKIT_YOUTRACK_CONFIG: process.env.WORKIT_YOUTRACK_CONFIG,
  WORKIT_CONFIG: process.env.WORKIT_CONFIG,
  WORKIT_STATE_DIR: process.env.WORKIT_STATE_DIR,
};
let stateRun = 0;
beforeAll(() => {
  process.env.WORKIT_YOUTRACK_CONFIG = path.join(dir, "youtrack.json");
  process.env.WORKIT_CONFIG = dir;
});
// Each test gets its own approvals registry, never the real one.
beforeEach(() => {
  process.env.WORKIT_STATE_DIR = path.join(dir, `state-${++stateRun}`);
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});

const resolved = {
  forge: { kind: "github", apiHost: "github.com", repo: "o/r" },
} as unknown as ResolvedForge;
const LINK = { tracker: "youtrack", id: "IRPT-74", repo: null, host: null } as unknown as IssueLink;
const PR = { number: 5, url: "https://github.com/o/r/pull/5" };
/** No ytrack anywhere: a post attempt would fail, never reach a tracker. */
const env = { PATH: path.join(dir, "empty"), WORKIT_YT_WRITE: "1" };

test("Given the default (ask), When pr create backlinks a YouTrack issue, Then it is pending on a youtrack-write request to approve, even with WORKIT_YT_WRITE=1", async () => {
  const [outcome] = await postBacklinks(dir, resolved, PR, [LINK], { env });
  expect(outcome).toMatchObject({ issue: "IRPT-74", status: "pending" });
  expect(outcome.approval).toMatch(/^ap_[a-z2-7]{8}$/u);
  expect(outcome.note).toStartWith("approval_needed: nothing was posted");
  // #864: the one pending request needs no id at the terminal.
  expect(outcome.note).toContain("`workit approve` in a terminal");
  expect(outcome.note).toContain("re-run workit pr create to post it once");
});

test("Given Claude Code or Pi, When the backlink is pending, Then the note names one plain workit youtrack call whose host ask shows the full backlink text, with no id", async () => {
  for (const host of [{ CLAUDECODE: "1" }, { PI_CODING_AGENT: "1" }]) {
    const [outcome] = await postBacklinks(dir, resolved, PR, [LINK], { env: { ...env, ...host } });
    expect(outcome).toMatchObject({ issue: "IRPT-74", status: "pending" });
    const call = /`(workit youtrack note [^`]+)`/u.exec(outcome.note ?? "")?.[1] ?? "";
    expect(call, JSON.stringify(host)).toStartWith("workit youtrack note IRPT-74 --markdown ");
    expect(outcome.note).not.toMatch(/ap_[a-z2-7]{8}|workit approve/u);
    const plain = inlineCallIn(call);
    expect(plain?.plain).toBe(true);
    const ask = plain?.plain ? inlineAskFor(plain.words, dir) : null;
    expect(ask?.text).toContain("Linked from PR #5: https://github.com/o/r/pull/5");
  }
});

test("Given youtrack.writes auto in the account's sealed file, Then the backlink keeps today's WORKIT_YT_WRITE gate", async () => {
  // Only the account's own, sealed file gives auto (#819): a temp account home.
  const home = useConfigHome("wk-backlink-ask-config-");
  try {
    writeFileSync(
      path.join(home.configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [{ name: "w", glob: `${dir}/**`, youtrack: { writes: "auto" } }],
      }),
    );
    const [gated] = await postBacklinks(dir, resolved, PR, [LINK], { env: { PATH: env.PATH } });
    expect(gated).toMatchObject({ status: "failed" });
    expect(gated.note).toContain("WORKIT_YT_WRITE=1");
  } finally {
    home.restore();
    process.env.WORKIT_CONFIG = dir;
  }
});
