// workit doctor's grant_seal row (#819): ok when workspaces.json matches its
// seal, a warning naming `workit workspace seal` while it is missing or does
// not match. Read from the account's dir in a scratch config home.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDoctor, type DoctorCheck } from "@/packages/workit-cli/src/admin/doctor";
import { SEAL_FILE } from "@/packages/workit-core/src/core/grant-seal";
import { sshSeam } from "@/packages/workit-core/src/core/remotes";
import { sealConfig, useConfigHome, type ConfigHome } from "../shared/grant-home";

const scratch = mkdtempSync(path.join(tmpdir(), "workit-doctor-seal-"));
const savedSsh = sshSeam.read;
let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-doctor-seal-config-", { seal: "manual" });
  sshSeam.read = () => ({ text: "", home: tmpdir() });
});
afterAll(() => {
  sshSeam.read = savedSsh;
  configHome.restore();
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  for (const name of ["workspaces.json", SEAL_FILE])
    rmSync(path.join(configHome.configDir, name), { force: true });
});

const cwd = path.join(scratch, "project");
mkdirSync(cwd, { recursive: true });
const seed = (autonomy: Record<string, unknown>) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${cwd.replaceAll("\\", "/")}/**`, autonomy }],
    }),
  );

const row = (): DoctorCheck => {
  const home = path.join(scratch, "home");
  const check = runDoctor({
    host: "cli",
    home,
    cwd,
    configDir: configHome.configDir,
    stateDir: path.join(home, "state"),
    dev: path.join(home, "no-dev"),
    env: { HOME: home, PATH: path.join(scratch, "empty-bin") },
    scopeProbe: () => ({ effective: false, supported: false, reason: "test", delegate: null }),
  }).checks.find((item) => item.id === "grant_seal");
  expect(check).toBeDefined();
  return check!;
};

test("Given no workspace entries, Then grant_seal passes: nothing to seal", () => {
  expect(row()).toMatchObject({ status: "pass", detail: "no workspace entries: nothing to seal" });
});

test("Given entries never sealed, Then grant_seal warns missing with the fix", () => {
  seed({ merge: true });
  const check = row();
  expect(check.status).toBe("warn");
  expect(check.detail).toStartWith("missing:");
  expect(check.fix).toBe("in your own terminal: workit workspace seal");
});

test("Given a matching seal, Then grant_seal is ok; a later edit makes it warn mismatch with the fix", () => {
  seed({ merge: false });
  sealConfig(configHome.configDir);
  expect(row()).toMatchObject({ status: "pass", detail: "ok: workspaces.json matches its seal" });
  seed({ merge: true });
  const check = row();
  expect(check.status).toBe("warn");
  expect(check.detail).toStartWith("mismatch:");
  expect(check.fix).toBe("in your own terminal: workit workspace seal");
});
