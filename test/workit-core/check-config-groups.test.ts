import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCheckConfig } from "../../packages/workit-core/src/check-config";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const repo = (config: unknown) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workit-groups-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, ".workit"));
  fs.writeFileSync(path.join(root, ".workit", "checks.json"), JSON.stringify(config));
  return root;
};

test("G a `ci` group of configured checks, T it loads as the group's member names", () => {
  const config = loadCheckConfig(
    repo({ checks: { lint: "x", knip: "y" }, groups: { ci: ["lint", "knip", "lint"] } }),
  );
  expect(config.error).toBeNull();
  expect(config.groups).toEqual({ ci: ["lint", "knip"] });
});

test("G no groups block, T the config has no groups", () => {
  expect(loadCheckConfig(repo({ checks: { lint: "x" } })).groups).toEqual({});
});

test.each([
  [{ checks: { lint: "x" }, groups: { ci: ["nope"] } }, "configured checks"],
  [{ checks: { lint: "x" }, groups: { ci: [] } }, "non-empty"],
  [{ checks: { lint: "x" }, groups: { lint: ["lint"] } }, "name of a configured check"],
  [{ checks: { lint: "x" }, groups: ["lint"] }, "groups must be"],
])("G a bad groups block %#, T the config is invalid and names the problem", (cfg, message) => {
  const config = loadCheckConfig(repo(cfg));
  expect(config.error).toContain(message);
});

test("G this repository's checks config, T knip, react-doctor and packaging resolve to the scripts CI runs and the ci group lists them", () => {
  const config = loadCheckConfig(path.resolve(import.meta.dir, "../.."));
  const argv = (name: string) => config.checks.find((check) => check.name === name)?.argv;
  expect(argv("knip")).toEqual(["bun", "run", "knip"]);
  expect(argv("react-doctor")).toEqual(["bun", "run", "doctor"]);
  expect(argv("packaging")).toEqual(["bun", "run", "test:packaging"]);
  expect(config.groups.ci).toEqual(
    expect.arrayContaining([
      "knip",
      "react-doctor",
      "packaging",
      "lint",
      "format",
      "typecheck",
      "test",
    ]),
  );
});
