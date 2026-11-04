// The doctor's YouTrack row (#711): ytrack's login for the configured host,
// read from a recorded ytrack stub on a temp PATH (never the real ytrack).
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { runDoctor, type DoctorReport } from "@/packages/workit-cli/src/admin/doctor";
import { makeDoctorFixture } from "@/test/shared/helpers/doctor-fixture";

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000);

const fixture = makeDoctorFixture();
afterAll(() => fixture.cleanup());

const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DIR/calls"
key="$1-$2"
if [ -f "$STUB_DIR/$key.json" ]; then cat "$STUB_DIR/$key.json"; fi
if [ -f "$STUB_DIR/$key.exit" ]; then exit "$(cat "$STUB_DIR/$key.exit")"; fi
exit 0
`;
const stubBin = path.join(fixture.root, "ytrack-bin");
mkdirSync(stubBin, { recursive: true });
writeFileSync(path.join(stubBin, "ytrack"), STUB);
chmodSync(path.join(stubBin, "ytrack"), 0o755);

// The developer's PATH without any directory holding a real ytrack.
const basePath = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((dir) => dir && !existsSync(path.join(dir, "ytrack")))
  .join(path.delimiter);

const youtrackJson = path.join(fixture.configDir, "youtrack.json");
const tokenFile = path.join(fixture.configDir, "youtrack.token");
const workspacesJson = path.join(fixture.configDir, "workspaces.json");
let stubDir = "";

beforeEach(() => {
  for (const file of [youtrackJson, tokenFile, workspacesJson]) rmSync(file, { force: true });
  stubDir = mkdtempSync(path.join(fixture.root, "rec-"));
});

const answer = (key: string, stdout: string, exit = 0) => {
  writeFileSync(path.join(stubDir, `${key}.json`), stdout);
  if (exit) writeFileSync(path.join(stubDir, `${key}.exit`), String(exit));
};
const calls = (): string[] => {
  const file = path.join(stubDir, "calls");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
};

const doctor = (withYtrack: boolean): DoctorReport => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: withYtrack ? [stubBin, basePath].join(path.delimiter) : basePath,
    STUB_DIR: stubDir,
  };
  delete env.WORKIT_NO_YTRACK;
  delete env.WORKIT_YOUTRACK_CONFIG;
  delete env.YTRACK_HOST;
  return runDoctor({
    host: "cli",
    home: fixture.home,
    configDir: fixture.configDir,
    stateDir: fixture.stateDir,
    dev: fixture.dev,
    cwd: fixture.cwd,
    env,
  });
};
const row = (report: DoctorReport) => report.checks.find((check) => check.id === "youtrack");

const configure = (baseUrl = "https://acme.youtrack.cloud/") =>
  writeFileSync(youtrackJson, JSON.stringify({ baseUrl }));
const loggedIn = (host: string) => {
  answer("version-", "ytrack version 0.2.0 (2026-10-30)\n");
  answer(
    "auth-status",
    JSON.stringify([{ host, active: true, login: "jdoe", state: "ok", tokenSource: "keyring" }]),
  );
};

test("Given no youtrack.json and no workspace on YouTrack, When doctor runs, Then there is no YouTrack row", () => {
  expect(row(doctor(false))).toBeUndefined();
});

test("Given no ytrack on PATH and a legacy token file, When doctor runs, Then the row warns the fallback is deprecated and names the ytrack install", () => {
  configure();
  writeFileSync(tokenFile, "perm:secret", { mode: 0o600 });
  const found = row(doctor(false));
  expect(found?.status).toBe("warn");
  expect(found?.detail).toContain(`legacy token file ${tokenFile}, deprecated`);
  expect(found?.fix).toContain("install ytrack");
  expect(found?.fix).toContain("ytrack auth login --hostname acme.youtrack.cloud");
  expect(JSON.stringify(found)).not.toContain("perm:secret");
});

test("Given no ytrack on PATH and no token file, When doctor runs, Then the row warns YouTrack is unavailable", () => {
  configure();
  const found = row(doctor(false));
  expect(found?.status).toBe("warn");
  expect(found?.detail).toContain("no token file");
  expect(found?.fix).toContain("install ytrack");
});

describe.skipIf(process.platform === "win32")("ytrack on PATH (POSIX stub)", () => {
  test("Given ytrack logged in to the configured host, When doctor runs, Then the YouTrack row is ok", () => {
    configure();
    loggedIn("acme.youtrack.cloud");
    const found = row(doctor(true));
    expect(found).toEqual({
      id: "youtrack",
      status: "pass",
      detail: "ytrack 0.2.0 logged in to acme.youtrack.cloud as jdoe",
    });
    expect(calls()).toEqual([
      "version",
      "auth status --json host,active,login,state,tokenSource,error",
    ]);
  });

  test("Given ytrack installed but logged out, When doctor runs, Then the row warns and names ytrack auth login --hostname", () => {
    configure();
    answer("version-", "ytrack version 0.2.0\n");
    answer("auth-status", "[]", 4);
    const found = row(doctor(true));
    expect(found?.status).toBe("warn");
    expect(found?.detail).toContain("logged_out for acme.youtrack.cloud");
    expect(found?.fix).toBe("ytrack auth login --hostname acme.youtrack.cloud");
  });

  test("Given ytrack logged in to another host only, When doctor runs, Then the configured host reads logged_out", () => {
    configure();
    loggedIn("other.youtrack.cloud");
    const found = row(doctor(true));
    expect(found?.status).toBe("warn");
    expect(found?.fix).toBe("ytrack auth login --hostname acme.youtrack.cloud");
  });

  test("Given only a workspace on YouTrack, When doctor runs, Then the row checks that workspace's host", () => {
    writeFileSync(
      workspacesJson,
      JSON.stringify({
        workspaces: [
          {
            name: "work",
            glob: `${fixture.root}/elsewhere/**`,
            issues: { provider: "youtrack" },
            youtrack: { baseUrl: "https://yt.example.com" },
          },
        ],
      }),
    );
    loggedIn("yt.example.com");
    expect(row(doctor(true))?.status).toBe("pass");
  });
});
