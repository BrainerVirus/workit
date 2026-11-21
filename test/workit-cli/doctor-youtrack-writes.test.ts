// `youtrack.writes: auto` with no `youtrack.autoHosts` posts unasked to any
// YouTrack a write reaches: the doctor warns and names the `workspace set`
// call that scopes it. A temp config dir; ytrack is never on PATH.
import { afterAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { makeDoctorFixture } from "@/test/shared/helpers/doctor-fixture";

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000);

const fixture = makeDoctorFixture();
afterAll(() => fixture.cleanup());
const workspacesJson = path.join(fixture.configDir, "workspaces.json");
beforeEach(() => rmSync(workspacesJson, { force: true }));

const row = (youtrack: Record<string, unknown>) => {
  writeFileSync(
    workspacesJson,
    `${JSON.stringify({ workspaces: [{ name: "personal", glob: "/w/personal/**", youtrack }] })}\n`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: "" };
  return runDoctor({
    host: "cli",
    home: fixture.home,
    configDir: fixture.configDir,
    stateDir: fixture.stateDir,
    dev: fixture.dev,
    cwd: fixture.cwd,
    env,
  }).checks.find((check) => check.id === "youtrack_writes");
};

test("G writes auto without autoHosts, W doctor runs, T it warns that auto is unscoped and names the autoHosts call", () => {
  expect(row({ writes: "auto", baseUrl: "https://Sandbox.youtrack.cloud/" })).toEqual({
    id: "youtrack_writes",
    status: "warn",
    detail: expect.stringContaining(
      "youtrack.writes is auto with no youtrack.autoHosts in personal",
    ),
    fix: `workit workspace set personal youtrack.autoHosts='["sandbox.youtrack.cloud"]'`,
  });
  expect(row({ writes: "auto" })?.fix).toBe(
    `workit workspace set personal youtrack.autoHosts='["<host>"]'`,
  );
});

test("G writes auto with autoHosts, or writes ask, W doctor runs, T there is no youtrack_writes row", () => {
  expect(row({ writes: "auto", autoHosts: ["sandbox.youtrack.cloud"] })).toBeUndefined();
  expect(row({ writes: "ask" })).toBeUndefined();
});
