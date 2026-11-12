// Bench privacy (scripts/eval/privacy.ts): evals/results is committed to a
// public repo, so no result file may carry an account's home path, a host's
// projects map or a real Workit config. Every fixture here is invented.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { committedLeaks } from "@/scripts/eval/privacy";

const RESULTS = path.join(import.meta.dir, "..", "..", "evals", "results");

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );

test("no committed bench result carries a home path, a projects map or a real config", () => {
  const leaks = filesUnder(RESULTS).flatMap((file) =>
    committedLeaks(readFileSync(file, "utf8")).map(
      (kind) => `${path.relative(RESULTS, file)}: ${kind}`,
    ),
  );
  expect(leaks).toEqual([]);
});

test("an absolute path under a home dir is a leak; placeholders and invented homes are not", () => {
  expect(committedLeaks('{"cwd":"/home/alice-example/src/app"}')).toEqual(["home path"]);
  expect(committedLeaks('"/Users/alice-example/Library/x"')).toEqual(["home path"]);
  expect(committedLeaks('{"cwd":"<world>/home/.claude/projects/x"}')).toEqual([]);
  expect(committedLeaks("--glob '/home/me/work/**' and /home/<user>/x/")).toEqual([]);
});

test("a host config's projects map is a leak, escaped inside a transcript string too", () => {
  expect(committedLeaks('{"projects":{"/srv/acme/app":{"history":[]}}}')).toEqual(["projects map"]);
  expect(committedLeaks('"content":"{\\"projects\\": {\\"~/code/app\\": {}}}"')).toEqual([
    "projects map",
  ]);
  expect(committedLeaks('{"memory_paths":"<world>/home/.claude/projects/x"}')).toEqual([]);
});

test("a workspace glob under the real home is a real config; the world's and redacted ones are not", () => {
  const read = (glob: string): string =>
    JSON.stringify({ content: `1\t${JSON.stringify({ workspaces: [{ name: "w", glob }] })}` });
  expect(committedLeaks(read("~/code/acme/**"))).toEqual(["real config"]);
  expect(committedLeaks(read("<world>/**"))).toEqual([]);
  expect(committedLeaks(read("~/projects/placeholder-1/**"))).toEqual([]);
});
