// workit doctor `updates`: the launch update check's setting and cached latest
// CLI version, read from local files only. Always info, never a failure.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";

const scratch = mkdtempSync(path.join(tmpdir(), "workit-doctor-updates-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emptyBin = path.join(scratch, "empty-bin");
mkdirSync(emptyBin, { recursive: true });

let count = 0;
const json = (value: object | string): string =>
  typeof value === "string" ? value : JSON.stringify(value);
const row = (config?: object | string, cache?: object | string) => {
  const root = path.join(scratch, `case-${count++}`);
  const configDir = path.join(root, "config");
  const stateDir = path.join(root, "state");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  if (config) writeFileSync(path.join(configDir, "config.json"), json(config));
  if (cache) writeFileSync(path.join(stateDir, "update-check.json"), json(cache));
  return runDoctor({
    host: "cli",
    home: root,
    cwd: root,
    configDir,
    stateDir,
    dev: path.join(root, "no-dev"),
    // A registry call would need npm on PATH: the empty PATH proves none is made.
    env: { HOME: root, PATH: emptyBin },
  }).checks.find((check) => check.id === "updates")!;
};

test("Given no config and no cache, When doctor runs, Then updates is info with the default prompt mode", () => {
  const found = row();
  expect(found.status).toBe("info");
  expect(found.detail).toBe("updates: prompt; no latest CLI version cached yet");
});

test("Given updates=auto and a cached latest version, When doctor runs, Then it shows both and the cache age", () => {
  const found = row(
    { locale: "en", updates: "auto" },
    { checkedAt: Date.now() - 3 * 60 * 60 * 1000, latest: "9.1.0", skipped: "9.0.0" },
  );
  expect(found.status).toBe("info");
  expect(found.detail).toBe("updates: auto; latest CLI 9.1.0 (checked 3 h ago); 9.0.0 skipped");
});

test("Given a malformed config or cache, When doctor runs, Then updates stays info", () => {
  const unknownMode = row({ updates: "sometimes" }, "{not json");
  expect(unknownMode.status).toBe("info");
  expect(unknownMode.detail).toBe("updates: prompt; no latest CLI version cached yet");
  expect(row("[1, 2]", "null").status).toBe("info");
});

test("Given XDG_CONFIG_HOME and XDG_STATE_HOME, When doctor runs without explicit dirs, Then it reads the same files as --set-updates and the launch check", () => {
  const root = path.join(scratch, "xdg");
  const xdgConfig = path.join(root, "xdg-config");
  const xdgState = path.join(root, "xdg-state");
  mkdirSync(path.join(xdgConfig, "workit"), { recursive: true });
  mkdirSync(path.join(xdgState, "workit"), { recursive: true });
  writeFileSync(path.join(xdgConfig, "workit/config.json"), JSON.stringify({ updates: "off" }));
  writeFileSync(
    path.join(xdgState, "workit/update-check.json"),
    JSON.stringify({ checkedAt: Date.now(), latest: "9.2.0" }),
  );
  const found = runDoctor({
    host: "cli",
    home: root,
    cwd: root,
    dev: path.join(root, "no-dev"),
    env: { HOME: root, PATH: emptyBin, XDG_CONFIG_HOME: xdgConfig, XDG_STATE_HOME: xdgState },
  }).checks.find((check) => check.id === "updates")!;
  expect(found.detail).toBe("updates: off; latest CLI 9.2.0 (checked just now)");
});
