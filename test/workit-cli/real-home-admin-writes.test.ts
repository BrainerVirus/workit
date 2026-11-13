// #859: admin/** writes only through admin/guarded-fs.ts, which refuses the OS
// account home's host settings and Workit dirs under the test run marker.
// Proven on a fake account home through the guardedHome seam: setup for each
// host into it is refused naming the file, and nothing lands there; the same
// setup into a home that is not the account's writes normally.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardedHome } from "@/packages/workit-cli/src/admin/guarded-fs";
import {
  applySetupPreview,
  buildSetupPreview,
  type SetupPreviewInput,
  type SetupResult,
} from "@/packages/workit-cli/src/admin/setup";
import type { HostInstallCommand } from "@/packages/workit-cli/src/admin/host-install";
import { TEST_RUN_ENV } from "@/packages/workit-core/src/core/account-home";
import { isolatedEnv } from "@/test/shared/helpers/packages";

// Apply runs the offline doctor after each host write.
setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000);

const ADMIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/admin");
const REPO = path.resolve(import.meta.dir, "../..");
const dirs: string[] = [];
afterEach(() => {
  guardedHome.value = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** Every file under `dir`, relative. */
const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));

const values = (platform: string): SetupPreviewInput => ({
  platforms: [platform],
  locale: "en",
  branchPreset: "gitflow",
  branchAllowed: "feature/*",
  branchProtected: "main",
  baseUrl: "",
  vcsProvider: "skip",
  workspaces: [],
  applyProject: false,
});

/** A PATH dir whose host CLIs only need to exist: they run through the recording stub. */
const stubBin = (): string => {
  const bin = temp("wk-admin-bin-");
  for (const name of ["claude", "codex", "pi", "npm", "node", "opencode"])
    writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bin;
};

/** Setup of one host into `home` (config in its own temp dir); host CLIs are a recording stub. */
const setup = (platform: string, home: string): { result: SetupResult; ran: string[] } => {
  const dir = temp("wk-admin-cfg-");
  const PATH = stubBin();
  const ran: string[] = [];
  const preview = buildSetupPreview(values(platform), { dir, cwd: dir, env: { PATH }, home });
  const result = applySetupPreview(preview, {
    configDir: dir,
    dev: REPO,
    cwd: dir,
    env: isolatedEnv(home, { WORKIT_CONFIG: dir, PATH }),
    runHostCommand: (step: HostInstallCommand) => {
      ran.push([step.command, ...step.args].join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  return { result, ran };
};

const HOSTS = ["opencode", "cursor", "claude-code", "codex", "pi"];

test.each(HOSTS)(
  "Given a test run and %s set up into the fake account home, When setup applies, Then each host write is refused naming its file and nothing lands in the home",
  (platform) => {
    expect(process.env[TEST_RUN_ENV]).toBeDefined();
    const home = temp("wk-admin-account-");
    guardedHome.value = home;
    // A refused write either fails its entry or stops the apply; both name the file.
    let reasons: string;
    let ran: string[] = [];
    try {
      const done = setup(platform, home);
      ran = done.ran;
      const failed = done.result.entries.filter((entry) => entry.status === "Failed");
      expect(failed.length, JSON.stringify(done.result.entries)).toBeGreaterThan(0);
      reasons = failed.map((entry) => entry.detail).join("\n");
    } catch (error) {
      reasons = error instanceof Error ? error.message : String(error);
    }
    expect(reasons).toContain(`${home}`);
    expect(reasons).toContain("a test run (WORKIT_TEST_RUN) never writes the OS account's home");
    expect(files(home)).toEqual([]);
    expect(ran).toEqual([]);
  },
);

test.each(HOSTS)(
  "Given a test run and %s set up into a home that is not the account's, When setup applies, Then it writes there (or runs the host CLI) as usual",
  (platform) => {
    const home = temp("wk-admin-home-");
    guardedHome.value = temp("wk-admin-elsewhere-");
    const { result, ran } = setup(platform, home);
    const refused = result.entries.filter((entry) => entry.detail?.includes(TEST_RUN_ENV));
    expect(refused).toEqual([]);
    expect(files(home).length + ran.length).toBeGreaterThan(0);
  },
);

test("Given admin/**, Then no module writes the filesystem except through guarded-fs", () => {
  const WRITES =
    /\b(writeFileSync|writeFile|appendFileSync|mkdirSync|mkdtempSync|rmSync|rmdirSync|unlinkSync|renameSync|cpSync|copyFileSync|symlinkSync|linkSync|writeFileAtomic|writeFileExclusive)\b/u;
  const offenders: string[] = [];
  for (const file of readdirSync(ADMIN).filter((name) => /\.tsx?$/u.test(name))) {
    if (file === "guarded-fs.ts") continue;
    const text = readFileSync(path.join(ADMIN, file), "utf8");
    for (const match of text.matchAll(/import\s+(\*\s+as\s+\w+|\{[^}]*\})\s+from\s+"([^"]+)"/gu)) {
      const [, names, from] = match;
      const raw = from === "node:fs" || from === "fs" || from.startsWith("node:fs/");
      const safe = from.endsWith("core/safe-write");
      if ((raw || safe) && (names.startsWith("*") || WRITES.test(names)))
        offenders.push(`${file}: ${names.replaceAll(/\s+/gu, " ")} from ${from}`);
    }
  }
  expect(offenders).toEqual([]);
});
