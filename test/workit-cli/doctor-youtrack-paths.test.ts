// ytrack's folder-to-host map (`ytrack auth paths`): the doctor reports a
// workspace glob that does not reach its YouTrack host with the exact fix, and
// `workit setup` runs the `--add` call. A recording ytrack stub on a temp PATH,
// never the real ytrack.
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
import { applySetupPreview, buildSetupPreview } from "@/packages/workit-cli/src/admin/setup";
import { createInitialDraft } from "@/packages/workit-cli/src/wizard-state";
import type { ToolkitConfig } from "@/packages/workit-core/src/core/config";
import type { WorkspaceConfig } from "@/packages/workit-core/src/core/workspaces";
import { makeDoctorFixture } from "@/test/shared/helpers/doctor-fixture";

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000);

const fixture = makeDoctorFixture();
afterAll(() => fixture.cleanup());

// `auth paths --host <h>` answers paths-<h>.json, else no globs (ytrack prints an array of {host, paths}); `old` makes it an older ytrack.
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DIR/calls"
case "$1 $2" in
  "version "*|"version") echo "ytrack version 0.5.0" ;;
  "auth status") cat "$STUB_DIR/status.json" ;;
  "auth paths")
    if [ -f "$STUB_DIR/old" ]; then echo "Error: unknown command \\"paths\\" for \\"ytrack auth\\"" >&2; exit 1; fi
    case "$*" in *--add*|*--remove*) exit 0 ;; esac
    if [ -f "$STUB_DIR/paths-$4.json" ]; then cat "$STUB_DIR/paths-$4.json"; else printf '[{"host":"%s","paths":[]}]' "$4"; fi ;;
esac
exit 0
`;
const stubBin = path.join(fixture.root, "ytrack-paths-bin");
mkdirSync(stubBin, { recursive: true });
writeFileSync(path.join(stubBin, "ytrack"), STUB);
chmodSync(path.join(stubBin, "ytrack"), 0o755);

const basePath = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((dir) => dir && !existsSync(path.join(dir, "ytrack")))
  .join(path.delimiter);
const workspacesJson = path.join(fixture.configDir, "workspaces.json");
let stubDir = "";

const CONFIG: ToolkitConfig = {
  locale: "en",
  localeOptions: ["en"],
  branchPolicy: { preset: "gitflow", allowed: [], protected: ["main", "develop"] },
  commitPolicy: { preset: "conventional" },
};

const WORK: WorkspaceConfig = {
  name: "work",
  glob: "/w/work/**",
  youtrack: { baseUrl: "https://acme.youtrack.cloud" },
};

beforeEach(() => {
  rmSync(workspacesJson, { force: true });
  stubDir = mkdtempSync(path.join(fixture.root, "paths-rec-"));
  writeFileSync(
    path.join(stubDir, "status.json"),
    JSON.stringify([
      { host: "acme.youtrack.cloud", active: false, login: "jdoe", state: "ok" },
      { host: "home.youtrack.cloud", active: true, login: "jdoe", state: "ok" },
    ]),
  );
});

const env = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [stubBin, basePath].join(path.delimiter),
    STUB_DIR: stubDir,
  };
  delete out.WORKIT_NO_YTRACK;
  delete out.WORKIT_YOUTRACK_CONFIG;
  delete out.YTRACK_HOST;
  return out;
};

const doctor = (): DoctorReport =>
  runDoctor({
    host: "cli",
    home: fixture.home,
    configDir: fixture.configDir,
    stateDir: fixture.stateDir,
    dev: fixture.dev,
    cwd: fixture.cwd,
    env: env(),
  });
const row = (report: DoctorReport) => report.checks.find((check) => check.id === "ytrack_paths");
const calls = (): string[] => {
  const file = path.join(stubDir, "calls");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
};
const writeWorkspaces = (entries: WorkspaceConfig[]) =>
  writeFileSync(workspacesJson, `${JSON.stringify({ workspaces: entries })}\n`);

describe.skipIf(process.platform === "win32")("ytrack auth paths (POSIX stub)", () => {
  test("Given workspace work on acme.youtrack.cloud and ytrack's map lacking its glob, When doctor runs, Then it warns with the exact add call and changes nothing", () => {
    writeWorkspaces([WORK]);
    const found = row(doctor());
    expect(found?.status).toBe("warn");
    expect(found?.detail).toContain("/w/work/** is not mapped to acme.youtrack.cloud");
    expect(found?.fix).toBe("ytrack auth paths --host acme.youtrack.cloud --add '/w/work/**'");
    expect(calls().filter((call) => /--add|--remove/.test(call))).toEqual([]);
  });

  test("Given the glob mapped to the personal host instead, When doctor runs, Then it names the wrong host and both calls", () => {
    writeWorkspaces([WORK]);
    writeFileSync(
      path.join(stubDir, "paths-home.youtrack.cloud.json"),
      JSON.stringify([{ host: "home.youtrack.cloud", paths: ["/w/work/**"] }]),
    );
    const found = row(doctor());
    expect(found?.detail).toContain(
      "/w/work/** is mapped to home.youtrack.cloud, not acme.youtrack.cloud",
    );
    expect(found?.fix).toContain("ytrack auth paths --host acme.youtrack.cloud --add '/w/work/**'");
    expect(found?.fix).toContain(
      "ytrack auth paths --host home.youtrack.cloud --remove '/w/work/**'",
    );
  });

  test("Given the glob already mapped to its host, When doctor runs, Then the row passes", () => {
    writeWorkspaces([WORK]);
    writeFileSync(
      path.join(stubDir, "paths-acme.youtrack.cloud.json"),
      JSON.stringify([{ host: "acme.youtrack.cloud", paths: ["/w/work/**"] }]),
    );
    expect(row(doctor())).toMatchObject({
      status: "pass",
      detail: "/w/work/** -> acme.youtrack.cloud",
    });
  });

  test("Given a ytrack without auth paths, When doctor runs, Then it says to upgrade ytrack, then the add call", () => {
    writeWorkspaces([WORK]);
    writeFileSync(path.join(stubDir, "old"), "");
    const found = row(doctor());
    expect(found?.status).toBe("warn");
    expect(found?.detail).toContain("has no `ytrack auth paths`");
    expect(found?.fix).toBe(
      "ytrack upgrade; then ytrack auth paths --host acme.youtrack.cloud --add '/w/work/**'",
    );
  });

  test("Given no workspace with a YouTrack baseUrl, When doctor runs, Then there is no row", () => {
    writeWorkspaces([{ name: "other", glob: "/w/other/**" }]);
    expect(row(doctor())).toBeUndefined();
  });

  test("Given workspace work and ytrack's map lacking its glob, When workit setup applies, Then it runs the add call", () => {
    const dir = mkdtempSync(path.join(fixture.root, "setup-"));
    const values = { ...createInitialDraft(CONFIG).values, workspaces: [WORK], baseUrl: "" };
    const preview = buildSetupPreview(values, { dir, cwd: dir, env: env() });
    expect(preview.ytrackPaths).toEqual({
      planned: [
        {
          host: "acme.youtrack.cloud",
          add: ["/w/work/**"],
          remove: [],
          command: "ytrack auth paths --host acme.youtrack.cloud --add '/w/work/**'",
        },
      ],
    });
    // Planning only reads the map.
    expect(calls().filter((call) => call.includes("--add"))).toEqual([]);
    const result = applySetupPreview(preview, { configDir: dir, cwd: dir, env: env() });
    expect(calls()).toContain("auth paths --host acme.youtrack.cloud --add /w/work/**");
    expect(result.entries).toContainEqual(
      expect.objectContaining({ file: "ytrack auth paths", status: "Configured" }),
    );
  });
});
