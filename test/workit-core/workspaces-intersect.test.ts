import { expect, test } from "bun:test";
import { globsIntersect, intersectingEntries } from "@/packages/workit-core/src/core/workspaces";

// #656: the overlap list names only entries whose globs can match a common folder.

test("a nested glob intersects its parent and not an unrelated sibling tree", () => {
  expect(globsIntersect("/w/libs/kit/**", "/w/**")).toBe(true);
  expect(globsIntersect("/w/libs/kit/**", "/w/other/**")).toBe(false);
  expect(globsIntersect("/w/libs/kit/**", "/elsewhere/**")).toBe(false);
});

test("a wildcard segment intersects only the folders it can match", () => {
  expect(globsIntersect("/w/*/x/**", "/w/a/**")).toBe(true);
  expect(globsIntersect("/w/team-*/**", "/w/solo/**")).toBe(false);
  expect(globsIntersect("/w/team-*/**", "/w/team-a/**")).toBe(true);
  expect(globsIntersect("/w/**/deep/**", "/w/a/b/**")).toBe(true);
});

test("intersectingEntries filters entries by their glob", () => {
  const entries = [
    { name: "parent", glob: "/w/**" },
    { name: "sibling", glob: "/w/other/**" },
    { name: "far", glob: "/elsewhere/**" },
  ];
  expect(intersectingEntries("/w/libs/kit/**", entries).map((entry) => entry.name)).toEqual([
    "parent",
  ]);
});
