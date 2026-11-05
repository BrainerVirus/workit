import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { stripSessionTrailers } from "@/packages/workit-core/src/git/ops";

// Issue #292: Workit-Session lines are dropped from the trailer block git
// interpret-trailers finds, so a mixed final paragraph (prose, Signed-off-by,
// Workit-Session) loses the session trailer and nothing else.

const strip = (text: string, subject = true) => stripSessionTrailers(text, { subject });

/** The trailers git itself parses from `message`, with the repository-independent config. */
const gitTrailers = (message: string): string[] => {
  const run = spawnSync(
    "git",
    [
      "-c",
      "trailer.separators=:",
      "-c",
      "trailer.where=end",
      "interpret-trailers",
      "--parse",
      "--no-divider",
    ],
    {
      input: `${message}\n`,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.split("\n").filter((line) => line.trim());
};

test("Given a final paragraph of prose, Signed-off-by and Workit-Session, When stripped, Then only Workit-Session goes", () => {
  const message = "feat: a\n\nprose\nSigned-off-by: a\nWorkit-Session: s";
  expect(strip(message)).toBe("feat: a\n\nprose\nSigned-off-by: a");
  expect(strip("prose\nSigned-off-by: a\nWorkit-Session: s", false)).toBe(
    "prose\nSigned-off-by: a",
  );
});

test("Given a folded Workit-Session trailer and a cherry-pick line, When stripped, Then its continuation goes and the rest stays", () => {
  const message =
    "fix: b\n\nbody\n\nmore prose\n(cherry picked from commit abc)\nWorkit-Session: s\n  folded\nCo-Authored-By: A <a@b.c>\n";
  expect(strip(message)).toBe(
    "fix: b\n\nbody\n\nmore prose\n(cherry picked from commit abc)\nCo-Authored-By: A <a@b.c>\n",
  );
});

test("Given a last paragraph git does not read as trailers, When stripped, Then the text is unchanged", () => {
  for (const message of [
    // Prose beside a trailer with no git-generated one: not a block.
    "feat: c\n\nprose\nWorkit-Session: s",
    // Too much prose for its trailers (under a quarter of the lines).
    "feat: c\n\n1\n2\n3\n4\n5\n6\n7\nSigned-off-by: a\nWorkit-Session: s",
    // A one-paragraph commit message: the subject is never a trailer block.
    "Workit-Session: s",
  ])
    expect(strip(message)).toBe(message);
});

test("Given a trailer block of only Workit-Session lines, When stripped, Then the block and the blank lines before it go", () => {
  expect(strip("feat: d\n\nbody\n\nWorkit-Session: a\nWorkit-Session: b\n")).toBe(
    "feat: d\n\nbody\n",
  );
  expect(strip("Workit-Session: a", false)).toBe("");
});

test("Given messages of every shape, When stripped, Then git parses the same trailers less Workit-Session", () => {
  const messages = [
    "feat: e\n\nprose\nSigned-off-by: a\nWorkit-Session: s",
    "feat: e\n\nprose\nWorkit-Session: s",
    "feat: e\n\n# note\nWorkit-Session: s\nKey : v",
    "feat: e\n\nKey: v\n  cont\nWorkit-Session: s\n\tmore\nOther: w",
    "feat: e\n\nx\ny\nSigned-off-by: a\nWorkit-Session: s",
    "feat: e\n\na\nb\nc\nSigned-off-by: a\nWorkit-Session: s",
    "feat: e\n\nWorkit-Session: s\n\nprose after",
  ];
  for (const message of messages) {
    const expected = gitTrailers(message).filter((line) => !/^workit-session\s*:/iu.test(line));
    expect(gitTrailers(strip(message))).toEqual(expected);
  }
});
