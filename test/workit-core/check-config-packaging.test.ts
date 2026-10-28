import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gateCheckNames, loadCheckConfig } from "../../packages/workit-core/src/check-config";

test("G a `test:packaging` script, T it is the named check `packaging` run as `bun run test:packaging`", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workit-pkgcheck-"));
  fs.writeFileSync(path.join(root, "bun.lock"), "");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "x", "test:packaging": "y" } }),
  );
  const config = loadCheckConfig(root);
  const packaging = config.checks.find((check) => check.name === "packaging");
  expect(packaging?.argv).toEqual(["bun", "run", "test:packaging"]);
  expect(gateCheckNames(config, "verification")).toEqual(["test", "packaging"]);
  fs.rmSync(root, { recursive: true, force: true });
});
