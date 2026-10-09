// `workit doctor` through the CLI entry (main → verbs/doctor.ts), not
// runDoctor directly: what the verb passes to the engine (cliVersion) and the
// `--fix` session hook install. Every home, config and repository is scratch.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import cliPkg from "@/packages/workit-cli/package.json" with { type: "json" };
import type { DoctorCheck, DoctorReport } from "@/packages/workit-cli/src/admin/doctor";
import {
  manualTrailerLine,
  SESSION_HOOK_SCRIPT,
} from "@/packages/workit-core/src/git/session-hook";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(repoRoot, "packages/workit-cli/src/main.ts");
const scratch = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "wk-doctor-verb-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Ambient variables that would point the doctor at the developer's real
// homes, config or session never reach the CLI under test.
const STRIPPED = new Set([
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "WORKIT_SESSION_ID",
  "WORKIT_HOST",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
  "CODEX_THREAD_ID",
  "WORKIT_DOCTOR_STALE_REGISTRY_VERSION",
]);
let n = 0;
const sandbox = () => {
  const root = path.join(scratch, `case-${++n}`);
  const home = path.join(root, "home");
  const configDir = path.join(root, "config");
  const work = path.join(root, "work");
  for (const dir of [home, configDir, work]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !STRIPPED.has(k) && !k.startsWith("WORKFLOW_") && !k.startsWith("GIT_"))
      env[k] = v;
  Object.assign(env, {
    HOME: home,
    WORKFLOW_TOOLKIT_CONFIG: configDir,
    WORKFLOW_TOOLKIT_STATE: path.join(root, "state"),
    WORKFLOW_TOOLKIT_DEV: path.join(root, "no-dev"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "no-gitconfig"),
    GIT_AUTHOR_NAME: "Workit Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Workit Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  });
  return { root, home, configDir, work, env };
};
type Sandbox = ReturnType<typeof sandbox>;

const doctor = (box: Sandbox, args: string[] = [], extra: Record<string, string> = {}) => {
  const r = spawnSync("bun", [cliEntry, "doctor", "--json", ...args], {
    cwd: box.work,
    env: { ...box.env, ...extra },
    encoding: "utf8",
  });
  const report = JSON.parse(r.stdout) as DoctorReport & {
    sessionHook?: { action: string; detail: string };
  };
  return { status: r.status, report };
};
const check = (report: DoctorReport, id: string): DoctorCheck =>
  report.checks.find((c) => c.id === id)!;

const git = (box: Sandbox, args: string[], extra: Record<string, string> = {}) => {
  const r = spawnSync("git", args, {
    cwd: box.work,
    env: { ...box.env, ...extra },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitRepo = (box: Sandbox) => {
  git(box, ["init", "-q", "-b", "main"]);
  git(box, ["config", "commit.gpgsign", "false"]);
  git(box, ["commit", "-q", "--allow-empty", "-m", "chore: init"]);
  return path.join(box.work, ".git", "hooks", "prepare-commit-msg");
};
const asWorkspace = (box: Sandbox) =>
  writeFileSync(
    path.join(box.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "scratch",
          glob: `${box.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
        },
      ],
    }),
  );

test("Given a Pi home with an older workit-pi and a newer published version, When `workit doctor` runs, Then pi_extension warns stale against the CLI's own version", () => {
  const box = sandbox();
  const [major, minor] = cliPkg.version.split(".").map(Number);
  const old = minor > 0 ? `${major}.${minor - 1}.0` : `${major - 1}.0.0`;
  const agentDir = path.join(box.home, ".pi", "agent");
  const pkgRoot = path.join(agentDir, "npm", "node_modules", "@brainervirus", "workit-pi");
  mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
  writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:@brainervirus/workit-pi"] }),
  );
  writeFileSync(
    path.join(pkgRoot, "package.json"),
    JSON.stringify({
      name: "@brainervirus/workit-pi",
      version: old,
      pi: { extensions: ["./dist/workit.js"] },
    }),
  );
  writeFileSync(path.join(pkgRoot, "dist", "workit.js"), "export default () => {};\n");

  const { report } = doctor(box, [], { WORKIT_DOCTOR_STALE_REGISTRY_VERSION: cliPkg.version });
  const pi = check(report, "pi_extension");
  expect(pi.status, pi.detail).toBe("warn");
  expect(pi.detail).toContain(`Workit Pi extension stale: @brainervirus/workit-pi ${old}`);
  expect(pi.detail).toContain(`older than workit ${cliPkg.version}`);
  expect(pi.fix).toBe("pi update npm:@brainervirus/workit-pi");
}, 30_000);

test("Given a Workit workspace without the hook, When `workit doctor` runs without --fix, Then it warns with the exact fix and writes nothing", () => {
  const box = sandbox();
  const hook = gitRepo(box);
  asWorkspace(box);
  const { report } = doctor(box);
  const sessionHook = check(report, "session_hook");
  expect(sessionHook).toMatchObject({ status: "warn", fix: "workit doctor --fix" });
  expect(sessionHook.detail).toContain(`no prepare-commit-msg hook at ${hook}`);
  expect(existsSync(hook)).toBe(false);
}, 30_000);

test("Given a Workit workspace with the user's own commit-msg check, When `workit doctor --fix` runs, Then the hook is installed beside it and plain commits carry the session trailer", () => {
  const box = sandbox();
  const hook = gitRepo(box);
  asWorkspace(box);
  const commitMsg = path.join(path.dirname(hook), "commit-msg");
  const userCheck = '#!/bin/sh\ngrep -q "^feat" "$1"\n';
  writeFileSync(commitMsg, userCheck, { mode: 0o755 });

  const fixed = doctor(box, ["--fix"]);
  expect(fixed.report.sessionHook?.action).toBe("installed");
  expect(check(fixed.report, "session_hook").status).toBe("pass");
  expect(readFileSync(hook, "utf8")).toBe(SESSION_HOOK_SCRIPT);
  expect(readFileSync(commitMsg, "utf8")).toBe(userCheck);

  git(box, ["commit", "-q", "--allow-empty", "-m", "feat: raw"], { WORKIT_SESSION_ID: "sub-7" });
  expect(git(box, ["log", "-1", "--format=%B"])).toBe("feat: raw\n\nWorkit-Session: sub-7");
  expect(() => git(box, ["commit", "-q", "--allow-empty", "-m", "nope"])).toThrow();
  expect(doctor(box, ["--fix"]).report.sessionHook?.action).toBe("unchanged");
}, 30_000);

test("Given another tool's prepare-commit-msg hook, When `workit doctor --fix` runs, Then it is left alone and the check gives the manual line", () => {
  const box = sandbox();
  const hook = gitRepo(box);
  asWorkspace(box);
  const theirs = "#!/bin/sh\n# someone else's\nexit 0\n";
  writeFileSync(hook, theirs, { mode: 0o755 });
  const { report } = doctor(box, ["--fix"]);
  expect(report.sessionHook?.action).toBe("skipped");
  const sessionHook = check(report, "session_hook");
  expect(sessionHook.status).toBe("warn");
  // --fix already wrote the helper, so the fix is only the line to add.
  expect(sessionHook.fix).toBe(
    `add this line to ${hook} (a new file needs \`#!/bin/sh\` as its first line and \`chmod +x\`): ${manualTrailerLine()}`,
  );
  expect(existsSync(path.join(box.work, ".git", "workit", "session-trailer.sh"))).toBe(true);
  expect(readFileSync(hook, "utf8")).toBe(theirs);
  // Once the user adds the line, the check passes.
  writeFileSync(hook, `${theirs}${manualTrailerLine()}\n`);
  expect(check(doctor(box).report, "session_hook")).toMatchObject({
    status: "pass",
    detail: `${hook} adds the Workit-Session trailer to plain git commits (via existing hook)`,
  });
  // Commented out, the line only mentions the helper: the check warns again.
  writeFileSync(hook, `${theirs}# ${manualTrailerLine()}\n`);
  expect(check(doctor(box).report, "session_hook").status).toBe("warn");
  // Without --fix in a fresh repo, the check first names --fix for the helper.
  const plain = sandbox();
  const plainHook = gitRepo(plain);
  asWorkspace(plain);
  writeFileSync(plainHook, theirs, { mode: 0o755 });
  expect(check(doctor(plain).report, "session_hook").fix).toStartWith(
    `workit doctor --fix (writes ${path.join(plain.work, ".git", "workit", "session-trailer.sh")}), then add this line to ${plainHook}`,
  );
}, 30_000);

test("Given a git repository that is not a Workit workspace, When `workit doctor --fix` runs, Then nothing is installed", () => {
  const box = sandbox();
  const hook = gitRepo(box);
  const { report } = doctor(box, ["--fix"]);
  expect(report.sessionHook?.action).toBe("skipped");
  expect(report.sessionHook?.detail).toContain("not in a Workit workspace");
  expect(check(report, "session_hook").status).toBe("pass");
  expect(existsSync(hook)).toBe(false);
}, 30_000);
