import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_LEGACY_MARKETPLACE as OLD,
  codexMigrationSteps,
} from "@/packages/workit-cli/src/upgrade/codex-marketplace";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const configWith = (toml: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workit-codex-mkt-"));
  dirs.push(dir);
  const file = path.join(dir, "config.toml");
  writeFileSync(file, toml);
  return file;
};

const commands = (steps: ReturnType<typeof codexMigrationSteps>): string[] =>
  (steps ?? []).map((step) => step.args.join(" "));

test("an inventory-only old install never removes a marketplace config.toml does not list", () => {
  // `codex plugin marketplace remove <absent>` exits 1, which would fail the upgrade.
  const file = configWith(`[plugins."workit@${OLD}"]\nenabled = true\n`);
  const steps = commands(codexMigrationSteps(file, { installed: true }));
  expect(steps.some((step) => step.startsWith("plugin marketplace remove"))).toBe(false);
  expect(steps[0]).toBe(`plugin remove workit@${OLD}`);
  expect(steps.at(-1)).toBe("plugin add workit@workit");
});

test("an old marketplace in config.toml is removed before the new one is added", () => {
  const file = configWith(
    `[marketplaces.${OLD}]\nsource = "x"\n\n[plugins."workit@${OLD}"]\nenabled = true\n`,
  );
  expect(commands(codexMigrationSteps(file))).toEqual([
    `plugin remove workit@${OLD}`,
    `plugin marketplace remove ${OLD}`,
    "plugin marketplace add https://github.com/BrainerVirus/workit.git",
    "plugin add workit@workit",
  ]);
});

test("a config.toml already on workit needs no migration", () => {
  const file = configWith('[marketplaces.workit]\nsource = "x"\n\n[plugins."workit@workit"]\n');
  expect(codexMigrationSteps(file)).toBeNull();
});
