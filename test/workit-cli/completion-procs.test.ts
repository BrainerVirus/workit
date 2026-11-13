// #328: completion offers the running registered process ids after `workit stop`
// and the new verbs' flags.
import { expect, test } from "bun:test";
import { complete, type CompleteSources } from "@/packages/workit-cli/src/completion/complete";
import { staticTable } from "@/packages/workit-cli/src/completion/spec";

const sources: CompleteSources = {
  checks: async () => [],
  workspaces: async () => [],
  slices: async () => [],
  procs: async () => ["pmabc0001", "pmabc0002"],
};

test("Given `workit stop `, When completing, Then the running process ids are offered, filtered by prefix", async () => {
  expect(await complete(["stop", ""], "/", sources)).toEqual(["pmabc0001", "pmabc0002"]);
  expect(await complete(["stop", "pmabc0001", "pmabc0002"], "/", sources)).toEqual(["pmabc0002"]);
  expect(await complete(["ps", ""], "/", sources)).toEqual([]);
});

test("Given the static table, Then run, ps and stop are verbs with their flags", () => {
  const table = staticTable();
  expect(table.get("")).toEqual(expect.arrayContaining(["run", "ps", "stop"]));
  expect(table.get("-run")).toEqual(
    expect.arrayContaining(["--bg", "--port", "--name", "--restart", "--no-lease", "--reason"]),
  );
  expect(table.get("-stop")).toEqual(
    expect.arrayContaining(["--session", "--within", "--orphans", "--reason"]),
  );
  expect(table.get("-gc")).toEqual(expect.arrayContaining(["--procs"]));
});
