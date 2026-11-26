// The shared-workspace scan (core/workspace-shared.ts, #879): "workit" counts
// only as a whole word, and a letter or digit from any script next to it joins
// it into another word.
import { expect, test } from "bun:test";
import { workitLines } from "@/packages/workit-core/src/core/workspace-shared";

const flagged = (text: string): number[] => workitLines(text).map((hit) => hit.line);

test("Given a non-ASCII letter or digit next to workit, When the scan runs, Then the line is not flagged", () => {
  expect(flagged("Workité\néworkit\nWorkit٣\nworkitß\nﾜworkitｱ")).toEqual([]);
});

test("Given a combining mark directly after workit or before it, When the scan runs, Then the line is not flagged", () => {
  expect(flagged("workit́\néworkit")).toEqual([]);
});

test("Given workit as a whole word next to punctuation or a non-ASCII space, When the scan runs, Then each line is flagged", () => {
  expect(
    flagged("Workit.\n«workit»\nmy-workit-fork\nhttps://x.dev/workit\n`workit`\nuse WORKIT—now"),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("Given an underscore or ASCII letter next to workit, When the scan runs, Then the line is not flagged", () => {
  expect(flagged("workit_cli\nworkits\nmyworkit")).toEqual([]);
});
