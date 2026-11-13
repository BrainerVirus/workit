// #780 review: a YouTrack backlink is a YouTrack write, so in ask mode (the
// default) it never posts behind WORKIT_YT_WRITE alone. The PR still opens;
// the backlink records a request through the approval channel and is pending
// until the user's yes, which a re-run of `workit pr create` consumes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { postBacklinks, type IssueLink } from "@/packages/workit-core/src/forge/issue-link";
import type { ResolvedForge } from "@/packages/workit-core/src/forge/resolve";
import { useConfigHome } from "../../shared/grant-home";

const dir = mkdtempSync(path.join(os.tmpdir(), "wk-backlink-ask-"));
const saved = {
  WORKIT_YOUTRACK_CONFIG: process.env.WORKIT_YOUTRACK_CONFIG,
  WORKIT_CONFIG: process.env.WORKIT_CONFIG,
};
beforeAll(() => {
  process.env.WORKIT_YOUTRACK_CONFIG = path.join(dir, "youtrack.json");
  process.env.WORKIT_CONFIG = dir;
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
  expect(outcome.note).toContain(`workit approve ${outcome.approval}`);
  expect(outcome.note).toContain("re-run workit pr create to post it once");
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
