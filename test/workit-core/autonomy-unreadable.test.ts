// A confined host (a bench run's) may not read the account's workspaces.json
// or its seal: EACCES or EPERM. Such an account reads as one with no entries,
// never as more authority: no grants, no models, the D4 defaults, with a note
// that says why. A readable file and a broken seal keep their behavior.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_GRANTS, resolveAutonomy, sealStatus } from "@/packages/workit-core/src/autonomy";
import { SEAL_FILE } from "@/packages/workit-core/src/core/grant-seal";
import { modelSources } from "@/packages/workit-core/src/core/workspaces";
import { sealConfig, useConfigHome, type ConfigHome } from "../shared/grant-home";

// Root reads a mode-000 file, and Windows has no POSIX modes: nothing to deny there.
const denies = process.platform !== "win32" && process.getuid?.() !== 0;

let configHome: ConfigHome;
let root = "";
const savedName = process.env.WORKIT_WORKSPACE_NAME;
beforeAll(() => {
  delete process.env.WORKIT_WORKSPACE_NAME;
  configHome = useConfigHome("wk-unreadable-config-", { seal: "manual" });
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-unreadable-"))).replaceAll("\\", "/");
  mkdirSync(path.join(root, "open/repo"), { recursive: true });
});
afterAll(() => {
  if (savedName !== undefined) process.env.WORKIT_WORKSPACE_NAME = savedName;
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  for (const name of ["workspaces.json", SEAL_FILE]) {
    const file = path.join(configHome.configDir, name);
    try {
      chmodSync(file, 0o600);
    } catch {
      // Not written by this test.
    }
    rmSync(file, { force: true });
  }
});

const cwd = () => `${root}/open/repo`;
const open = (merge: unknown = "verified") => ({
  name: "open",
  glob: `${root}/open/**`,
  vcs: { provider: "github", account: "me" },
  autonomy: { push: true, pr: true, merge },
  defaultEndpoint: "pr",
});
const write = (workspaces: unknown[]) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({ models: { roles: { implementer: "opus" } }, workspaces }),
  );
const writeSealed = () => {
  write([open()]);
  sealConfig(configHome.configDir);
};
const deny = (name: string) => chmodSync(path.join(configHome.configDir, name), 0o000);

test("Given a readable, sealed workspaces.json, Then its grants and global models apply", () => {
  writeSealed();
  const autonomy = resolveAutonomy(cwd());
  expect(autonomy.grants.merge).toBe("verified");
  expect(autonomy.note).toBeUndefined();
  expect(modelSources(cwd(), configHome.configDir).some((source) => source.global)).toBe(true);
});

test.skipIf(!denies)(
  "Given workspaces.json fails to read with EACCES, Then no grants, no models, the D4 defaults and a note saying why",
  () => {
    writeSealed();
    deny("workspaces.json");
    const autonomy = resolveAutonomy(cwd());
    expect(autonomy.grants).toEqual({ ...DEFAULT_GRANTS });
    expect(autonomy.note).toContain("cannot be read (permission denied)");
    expect(autonomy.note).toContain("workspaces.json");
    expect(modelSources(cwd(), configHome.configDir)).toEqual([]);
    const status = sealStatus();
    expect(status.state).toBe("no_account");
    expect(status.state === "no_account" && status.note).toContain("permission denied");
  },
);

test.skipIf(!denies)(
  "Given only the seal fails to read with EACCES, Then the grants fall to the D4 defaults, never above",
  () => {
    writeSealed();
    deny(SEAL_FILE);
    const autonomy = resolveAutonomy(cwd());
    expect(autonomy.grants).toEqual({ ...DEFAULT_GRANTS });
    expect(autonomy.note).toContain(`${SEAL_FILE} cannot be read (permission denied)`);
  },
);

test("Given a readable workspaces.json that no longer matches its seal, Then the raised grant is still refused", () => {
  write([open(false)]);
  sealConfig(configHome.configDir);
  write([open()]);
  const autonomy = resolveAutonomy(cwd());
  expect(autonomy.grants.merge).toBe(false);
  expect(autonomy.note).toContain("does not match its seal");
});
