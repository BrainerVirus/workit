// `scaffold.home` seeds files in the bench world's HOME (a host install a case
// needs, #423), and only there: a path that could leave HOME is refused before
// anything is written.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { loadCases, type EvalCase } from "@/scripts/eval/cases";
import { planUninstall } from "@/packages/workit-cli/src/admin/uninstall";
import { makeWorld } from "@/scripts/eval/scaffold";

const spec = (home: Record<string, string>): EvalCase => ({
  id: "home-seed",
  source: "#423",
  tier: "full",
  prompt: "p",
  scaffold: { home },
});

test("Given scaffold.home, Then its files are written under the world HOME", () => {
  const world = makeWorld(spec({ ".cursor/mcp.json": "{}\n" }));
  try {
    expect(readFileSync(path.join(world.home, ".cursor", "mcp.json"), "utf8")).toBe("{}\n");
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test.each([
  ["an absolute path", path.resolve("/tmp/workit-eval-escape")],
  ["a .. segment", "../escape"],
  ["a .. segment inside", ".cursor/../../escape"],
  ["HOME itself", "."],
])(
  "Given scaffold.home with %s, Then the world is refused and nothing is written",
  (_why, name) => {
    expect(() => makeWorld(spec({ [name]: "x" }))).toThrow(/scaffold\.home/);
    expect(existsSync(path.resolve("/tmp/workit-eval-escape"))).toBe(false);
  },
);

test("Given the uninstall-refused case, Then its world has Workit installed on Cursor only", () => {
  const seeded = loadCases(path.join(import.meta.dir, "..", "..", "evals", "cases")).find(
    (c) => c.id === "uninstall-refused",
  );
  if (!seeded) throw new Error("no uninstall-refused case");
  const world = makeWorld(seeded);
  try {
    const plan = planUninstall({
      home: world.home,
      env: { HOME: world.home },
      stateDir: world.state,
    });
    const installed = plan.hosts.filter((h) => h.installed).map((h) => h.host);
    expect(installed).toEqual(["cursor"]);
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
});
