import { expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const finalizeContext = require("../../scripts/clean-release-notes.cjs") as ((context: {
  noteGroups: Array<{ title: string; notes: Array<{ text: string }> }>;
}) => { noteGroups: Array<{ title: string; notes: Array<{ text: string }> }> }) & {
  cleanNote: (text: string) => string;
};

test("breaking notes keep only their first paragraph and never carry git trailers", () => {
  const context = finalizeContext({
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
