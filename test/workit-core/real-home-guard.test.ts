// #859: the test preload snapshots the account's grants, seal and host
// settings and fails the run when a test changed one. Proven on a fake
// "real" home injected into the guard: the real account is never touched.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir as workitConfigDir } from "@/packages/workit-core/src/core/workit-paths.mjs";
import { guardRealHome } from "@/test/shared/real-state-guard";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A fake account home with a sealed workspaces.json and Claude settings, and the guard's afterAll. */
const guarded = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-real-home-guard-"));
  homes.push(home);
  const config = workitConfigDir({ HOME: home });
  mkdirSync(config, { recursive: true });
  writeFileSync(path.join(config, "workspaces.json"), '{"workspaces":[]}\n');
  writeFileSync(path.join(config, "workspaces.json.seal"), '{"version":1}\n');
  mkdirSync(path.join(home, ".claude"));
  writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  let check = (): void => {
    throw new Error("the guard registered no afterAll");
  };
  guardRealHome(home, (registered) => {
    check = registered;
  });
  return { home, config, check: () => check() };
};

test("Given the guard on a fake real home, When a test changes its workspaces.json.seal, Then afterAll fails naming the file", () => {
  const { config, check } = guarded();
  const seal = path.join(config, "workspaces.json.seal");
  writeFileSync(seal, '{"version":1,"sha256":"forged"}\n');
  expect(check).toThrow(seal);
  expect(check).toThrow("changed 1 file(s) of the real account home");
});

test("Given the guard, When nothing under the fake home changes, Then afterAll passes", () => {
  const { check } = guarded();
  expect(check).not.toThrow();
});

test("Given the guard, When a host settings file is only touched (same content, new mtime), Then afterAll fails naming it", () => {
  const { home, check } = guarded();
  const settings = path.join(home, ".claude", "settings.json");
  const later = new Date(Date.now() + 60_000);
  utimesSync(settings, later, later);
  expect(check).toThrow(settings);
});

test("Given the guard, When a test creates a host settings file that did not exist, Then afterAll fails naming it", () => {
  const { home, check } = guarded();
  const rules = path.join(home, ".codex", "rules", "workit.rules");
  mkdirSync(path.dirname(rules), { recursive: true });
  writeFileSync(rules, "prefix_rule()\n");
  expect(check).toThrow(rules);
});
