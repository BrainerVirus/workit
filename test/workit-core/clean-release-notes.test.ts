import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { releaseNotes } from "@/scripts/backfill-release-notes";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

interface Context {
  previousTag?: string;
  noteGroups: Array<{ title: string; notes: Array<{ text: string }> }>;
  commitGroups?: Array<{ title: string; commits: Array<Record<string, unknown>> }>;
}

const require = createRequire(import.meta.url);
const finalizeContext = require("../../scripts/clean-release-notes.cjs") as ((
  context: Context,
) => Context) & { cleanNote: (text: string) => string; NOTES_CAP: number };

// GitHub rejects a release body over this many characters (release run
// 42398148393: "body is too long (maximum is 125000 characters)").
const GITHUB_BODY_LIMIT = 125_000;

const commits = (count: number, subject: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => ({
    message: subject(i),
    hash: i.toString(16).padStart(40, "a"),
  }));

const notes = (
  messages: Array<{ message: string; hash: string }>,
  lastTag: string,
  nextTag = "workit-dev-v1.1.0",
): Promise<string> =>
  releaseNotes(REPO_ROOT, {
    commits: messages,
    lastRelease: { gitTag: lastTag },
    nextRelease: { version: nextTag.replace("workit-dev-v", ""), gitTag: nextTag },
    options: { repositoryUrl: "https://github.com/BrainerVirus/workit.git" },
  });

test("breaking notes keep only their first paragraph and never carry git trailers", () => {
  const context = finalizeContext({
    previousTag: "workit-dev-v1.0.0",
    noteGroups: [
      {
        title: "BREAKING CHANGES",
        notes: [
          { text: "old skills are removed.\n\nCo-Authored-By: Bot <b@x>\n\n* test: align" },
          { text: "Co-Authored-By: Bot <b@x>" },
        ],
      },
    ],
  });
  expect(context.noteGroups).toEqual([
    { title: "BREAKING CHANGES", notes: [{ text: "old skills are removed." }] },
  ]);
  expect(finalizeContext.cleanNote("a\nSigned-off-by: me\nb")).toBe("a\nb");
});

test("the first @workit-dev release gets a short body pointing at the changelog (1.0.0)", async () => {
  const history = commits(850, (i) => `feat(core): change number ${i} with a long subject (#${i})`);
  history.push({
    message: "feat!: rename the packages\n\nBREAKING CHANGE: the scope is now @workit-dev",
    hash: "f".repeat(40),
  });
  const body = await notes(history, "", "workit-dev-v1.0.0");
  expect(body.length).toBeLessThan(5000);
  expect(body).toContain("`@brainervirus/workit` 14.6.1");
  expect(body).toContain(
    "https://github.com/BrainerVirus/workit/blob/workit-dev-v1.0.0/CHANGELOG.md",
  );
  expect(body).toContain(
    "https://github.com/BrainerVirus/workit/blob/workit-dev-v1.0.0/docs/guides/migration.md",
  );
  expect(body).not.toContain("change number");
  expect(body).not.toContain("BREAKING");
});

test("a release over the cap is cut under it and links the full comparison", async () => {
  const long = "x".repeat(400);
  const body = await notes(
    commits(600, (i) => `fix(cli): entry ${i} ${long} (#${i})`),
    "workit-dev-v1.0.0",
  );
  expect(body.length).toBeLessThan(finalizeContext.NOTES_CAP);
  expect(finalizeContext.NOTES_CAP).toBeLessThan(GITHUB_BODY_LIMIT);
  expect(body).toContain("entry 0 ");
  expect(body).not.toContain("entry 599 ");
  expect(body).toMatch(/\* \d+ more entries are not listed here; see the full comparison/);
  expect(body).toContain(
    "(https://github.com/BrainerVirus/workit/compare/workit-dev-v1.0.0...workit-dev-v1.1.0)",
  );
});

test("a small release keeps every entry and gains no truncation line", async () => {
  const history = commits(40, (i) => `fix(cli): small change ${i} (#${i})`);
  const body = await notes(history, "workit-dev-v1.0.0");
  for (let i = 0; i < 40; i += 1) expect(body).toContain(`small change ${i} `);
  expect(body).not.toContain("more entries are not listed");
  expect(body).not.toContain("14.6.1");

  const context: Context = {
    previousTag: "workit-dev-v1.0.0",
    noteGroups: [],
    commitGroups: [{ title: "Bug Fixes", commits: [{ subject: "a", hash: "b".repeat(40) }] }],
  };
  const before = structuredClone(context);
  expect(finalizeContext(context)).toEqual(before);
});
