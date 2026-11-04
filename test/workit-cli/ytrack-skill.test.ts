// The ytrack agent skill (youtrack-cli #16): setup and upgrade run
// `ytrack skill install` for each Workit host, doctor compares the installed
// SKILL.md version with `ytrack version`, uninstall removes only what Workit
// recorded. ytrack is a stub on a temp PATH and HOME is a temp dir: never the
// real ytrack or a real host skills directory.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
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
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { applyUninstall, planUninstall } from "@/packages/workit-cli/src/admin/uninstall";
import { runUpgradeCommand, type HostProcess } from "@/packages/workit-cli/src/upgrade";
import { run as setup } from "@/packages/workit-cli/src/verbs/setup";
import {
  hostSkillsRoot,
  parseSkillMeta,
  readYtrackSkillRecord,
  removeYtrackSkill,
  syncYtrackSkill,
} from "@/packages/workit-core/src/core/ytrack-skill";
import { ytrackRunner } from "@/packages/workit-core/src/core/youtrack-ytrack";

setDefaultTimeout(process.platform === "win32" ? 60_000 : 30_000);

const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wk-ytrack-skill-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A ytrack with `ytrack skill`: STUB_VERSION is the version it reports and
// stamps; STUB_OLD=1 is a ytrack without `skill` (0.2.x).
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DIR/calls"
v="\${STUB_VERSION:-0.3.0}"
if [ "$1" = version ]; then printf 'ytrack version %s (2026-11-01)\\n' "$v"; exit 0; fi
if [ "$1" = skill ] && [ "$STUB_OLD" = 1 ]; then
  echo 'Error: unknown command "skill" for "ytrack"' >&2; exit 1
fi
if [ "$1" = skill ] && [ "$2" = print ]; then
  printf -- '---\\nname: ytrack\\nmetadata:\\n  version: "%s"\\n---\\n\\n# ytrack\\n' "$v"; exit 0
fi
if [ "$1" = skill ] && [ "$2" = install ] && [ "$3" = --dir ]; then
  t="$4/ytrack"
  if [ -e "$t" ] && ! grep -q '^name: ytrack' "$t/SKILL.md" 2>/dev/null; then
    echo "$t exists and is not the ytrack skill; left it untouched" >&2; exit 1
  fi
  mkdir -p "$t/references"
  printf -- '---\\nname: ytrack\\nmetadata:\\n  version: "%s"\\n---\\n' "$v" > "$t/SKILL.md"
  echo reference > "$t/references/issues.md"
  printf '{"path":"%s","version":"%s"}\\n' "$t" "$v"; exit 0
fi
exit 1
`;

// The developer's PATH without any directory that holds a real ytrack.
const basePath = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((dir) => dir && !existsSync(path.join(dir, "ytrack")))
  .join(path.delimiter);

let worlds = 0;
/** A temp HOME with Workit's XDG dirs inside, and the stub ytrack on PATH. */
const world = (options: { youtrack?: boolean; pi?: boolean } = {}) => {
  const home = path.join(scratch, `home-${++worlds}`);
  const bin = path.join(home, "ytrack-bin");
  const calls = path.join(home, "ytrack-calls");
  for (const dir of [bin, calls]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(bin, "ytrack"), STUB);
  chmodSync(path.join(bin, "ytrack"), 0o755);
  const configDir = path.join(home, ".config", "workit");
  const stateDir = path.join(home, ".local", "state", "workit");
  mkdirSync(configDir, { recursive: true });
  if (options.youtrack !== false)
    writeFileSync(
      path.join(configDir, "youtrack.json"),
      JSON.stringify({ baseUrl: "https://acme.youtrack.cloud" }),
    );
  if (options.pi) {
    const settings = path.join(home, ".pi", "agent", "settings.json");
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ packages: ["npm:@brainervirus/workit-pi"] }));
  }
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    PATH: [bin, basePath].join(path.delimiter),
    STUB_DIR: calls,
    ...extra,
  });
  return {
    home,
    configDir,
    stateDir,
    env,
    calls: (): string[] => {
      const file = path.join(calls, "calls");
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
    },
    /** A SKILL.md at `dir`, as another installer (or a person) would leave it. */
    skillAt: (dir: string, version: string, name = "ytrack") => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\nmetadata:\n  version: "${version}"\n---\n`,
      );
    },
  };
};

const skillVersion = (dir: string): string | null =>
  existsSync(path.join(dir, "SKILL.md"))
    ? parseSkillMeta(readFileSync(path.join(dir, "SKILL.md"), "utf8")).version
    : null;

const posix = test.skipIf(process.platform === "win32");

describe("syncYtrackSkill", () => {
  posix(
    "Given a ytrack with `skill`, When it syncs two hosts, Then each skills dir has ytrack/ at that version and both are recorded; a rerun installs nothing",
    () => {
      const w = world();
      const env = w.env();
      const sync = () =>
        syncYtrackSkill({
          hosts: ["claude-code", "pi"],
          home: w.home,
          env,
          stateDir: w.stateDir,
          run: ytrackRunner(env),
        });
      const first = sync();
      const claude = path.join(w.home, ".claude", "skills", "ytrack");
      const pi = path.join(w.home, ".pi", "agent", "skills", "ytrack");
      expect(first).toMatchObject({ state: "synced", version: "0.3.0" });
      expect(skillVersion(claude)).toBe("0.3.0");
      expect(skillVersion(pi)).toBe("0.3.0");
      expect(existsSync(path.join(pi, "references", "issues.md"))).toBe(true);
      expect(readYtrackSkillRecord(w.stateDir)).toEqual([
        { host: "claude-code", path: claude, version: "0.3.0" },
        { host: "pi", path: pi, version: "0.3.0" },
      ]);
      const installs = () => w.calls().filter((call) => call.startsWith("skill install"));
      expect(installs()).toEqual([
        `skill install --dir ${path.dirname(claude)} --json`,
        `skill install --dir ${path.dirname(pi)} --json`,
      ]);
      const again = sync();
      expect(again.state === "synced" && again.results.map((r) => r.status)).toEqual([
        "current",
        "current",
      ]);
      expect(installs()).toHaveLength(2);
    },
  );

  posix("Given an older ytrack without `skill`, Then nothing is installed or recorded", () => {
    const w = world();
    const env = w.env({ STUB_OLD: "1" });
    expect(
      syncYtrackSkill({
        hosts: ["pi"],
        home: w.home,
        env,
        stateDir: w.stateDir,
        run: ytrackRunner(env),
      }),
    ).toEqual({ state: "unsupported", version: "0.3.0" });
    expect(existsSync(path.join(w.home, ".pi", "agent", "skills"))).toBe(false);
    expect(readYtrackSkillRecord(w.stateDir)).toEqual([]);
  });

  posix(
    "Given a ytrack skill someone else installed and another skill named ytrack, Then the first is refreshed but not recorded and the second is left untouched",
    () => {
      const w = world();
      const env = w.env();
      const theirs = path.join(hostSkillsRoot("codex", w.home, env), "ytrack");
      const foreign = path.join(hostSkillsRoot("cursor", w.home, env), "ytrack");
      w.skillAt(theirs, "0.2.9");
      w.skillAt(foreign, "1.0.0", "my-ytrack-notes");
      const sync = syncYtrackSkill({
        hosts: ["codex", "cursor"],
        home: w.home,
        env,
        stateDir: w.stateDir,
        run: ytrackRunner(env),
      });
      expect(sync.state === "synced" && sync.results.map((r) => [r.host, r.status])).toEqual([
        ["codex", "installed"],
        ["cursor", "failed"],
      ]);
      expect(skillVersion(theirs)).toBe("0.3.0");
      expect(parseSkillMeta(readFileSync(path.join(foreign, "SKILL.md"), "utf8")).name).toBe(
        "my-ytrack-notes",
      );
      expect(readYtrackSkillRecord(w.stateDir)).toEqual([]);
    },
  );
});

test("parseSkillMeta reads name and metadata.version from a CRLF checkout, and nothing without frontmatter", () => {
  expect(
    parseSkillMeta(
      '---\r\nname: ytrack\r\ndescription: x\r\nmetadata:\r\n  version: "0.3.0"\r\n---\r\n# ytrack\r\n',
    ),
  ).toEqual({ name: "ytrack", version: "0.3.0" });
  expect(parseSkillMeta("---\nname: ytrack\nversion: 9\n---\n")).toEqual({
    name: "ytrack",
    version: null,
  });
  expect(parseSkillMeta("# ytrack\n")).toEqual({ name: null, version: null });
});

test("removeYtrackSkill leaves a recorded path that no longer holds the ytrack skill", () => {
  const w = world();
  const dir = path.join(w.home, ".pi", "agent", "skills", "ytrack");
  w.skillAt(dir, "1.0.0", "someone-else");
  expect(removeYtrackSkill({ host: "pi", path: dir, version: "0.3.0" }, w.stateDir)).toMatchObject({
    status: "failed",
  });
  expect(existsSync(path.join(dir, "SKILL.md"))).toBe(true);
});

const upgrade = async (w: ReturnType<typeof world>, extra: Record<string, string> = {}) => {
  // Pi at the published version: the upgrade has no host work, only the skill.
  const piRoot = path.join(w.home, "pi-resolved");
  mkdirSync(piRoot, { recursive: true });
  writeFileSync(
    path.join(piRoot, "package.json"),
    JSON.stringify({ name: "@brainervirus/workit-pi", version: "1.0.0" }),
  );
  const out: string[] = [];
  const code = await runUpgradeCommand(["--hosts=pi", "--yes", "--json"], {
    home: w.home,
    env: { ...w.env(extra), WORKIT_NO_YTRACK: undefined },
    run: (command, args) =>
      command === "npm" && args[0] === "view"
        ? { status: 0, stdout: "1.0.0\n" }
        : command === "pi" && args[0] === "list"
          ? { status: 0, stdout: `npm:@brainervirus/workit-pi\n  ${piRoot}\n` }
          : { status: 0, stdout: "" },
    processes: (): HostProcess[] => [],
    confirm: async () => true,
    doctor: () => ({ checks: [] }),
    out: { write: (text: string) => void out.push(text) },
  });
  const report = JSON.parse(out.join("")) as { hosts: { host: string; status: string }[] };
  return { code, report, row: report.hosts.find((row) => row.host === "ytrack") };
};

describe("workit upgrade", () => {
  posix(
    "Given YouTrack in use and Pi installed, When upgrade runs, Then Pi's skills dir has the ytrack skill and the install is recorded",
    async () => {
      const w = world({ pi: true });
      const { code, row } = await upgrade(w);
      expect(code).toBe(0);
      expect(row).toMatchObject({ status: "updated", reason: "skill 0.3.0 installed for pi" });
      const dir = path.join(w.home, ".pi", "agent", "skills", "ytrack");
      expect(skillVersion(dir)).toBe("0.3.0");
      expect(readYtrackSkillRecord(w.stateDir)).toEqual([
        { host: "pi", path: dir, version: "0.3.0" },
      ]);
    },
  );

  posix(
    "Given an older ytrack without `skill`, Then nothing is installed and the row says `ytrack upgrade`",
    async () => {
      const w = world({ pi: true });
      const { code, row } = await upgrade(w, { STUB_OLD: "1" });
      expect(code).toBe(0);
      expect(row).toMatchObject({ status: "skipped", fix: "ytrack upgrade" });
      expect(existsSync(path.join(w.home, ".pi", "agent", "skills"))).toBe(false);
    },
  );

  posix(
    "Given YouTrack unused, Then upgrade never runs ytrack and shows no ytrack row",
    async () => {
      const w = world({ pi: true, youtrack: false });
      const { row } = await upgrade(w);
      expect(row).toBeUndefined();
      expect(w.calls()).toEqual([]);
    },
  );
});

posix(
  "Given workit setup with YouTrack in use, When it runs, Then each selected Workit host gets the skill; uninstall then removes only the recorded dir",
  async () => {
    const w = world({ pi: true });
    const out: string[] = [];
    const io = {
      json: false,
      cwd: w.home,
      env: w.env(),
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void out.push(text),
    };
    expect(await setup(["--hosts=pi,claude-code", "--no-shell", "--yes"], io)).toBe(0);
    const pi = path.join(w.home, ".pi", "agent", "skills", "ytrack");
    // Claude Code has no Workit install here: it gets no skill.
    expect(existsSync(path.join(w.home, ".claude", "skills"))).toBe(false);
    expect(skillVersion(pi)).toBe("0.3.0");
    expect(out.join("")).toContain("ytrack skill 0.3.0 installed for pi");

    // A ytrack skill Workit did not install stays through uninstall.
    const theirs = path.join(w.home, ".claude", "skills", "ytrack");
    w.skillAt(theirs, "0.3.0");
    const paths = { home: w.home, env: w.env(), stateDir: w.stateDir };
    const plan = planUninstall(paths);
    const skillActions = plan.hosts.flatMap((host) =>
      host.actions.filter((action) => action.kind === "remove-ytrack-skill"),
    );
    expect(skillActions.map((action) => action.path)).toEqual([pi]);
    const result = applyUninstall(
      {
        hosts: plan.hosts.map((host) => ({
          ...host,
          actions: host.actions.filter((action) => action.kind === "remove-ytrack-skill"),
        })),
      },
      paths,
    );
    expect(result.entries).toEqual([
      { host: "pi", path: pi, status: "removed", detail: undefined },
    ]);
    expect(existsSync(pi)).toBe(false);
    expect(existsSync(path.join(theirs, "SKILL.md"))).toBe(true);
    expect(readYtrackSkillRecord(w.stateDir)).toEqual([]);
  },
);

describe("doctor ytrack_skill", () => {
  const doctorRow = (w: ReturnType<typeof world>, extra: Record<string, string> = {}) =>
    runDoctor({
      host: "cli",
      home: w.home,
      configDir: w.configDir,
      stateDir: w.stateDir,
      cwd: w.home,
      env: w.env(extra),
    }).checks.find((check) => check.id === "ytrack_skill");
  const recordPi = (w: ReturnType<typeof world>, version: string) => {
    const dir = path.join(w.home, ".pi", "agent", "skills", "ytrack");
    w.skillAt(dir, version);
    mkdirSync(w.stateDir, { recursive: true });
    writeFileSync(
      path.join(w.stateDir, "ytrack-skill.json"),
      JSON.stringify({ installs: [{ host: "pi", path: dir, version }] }),
    );
  };

  posix("Given the installed skill matches `ytrack version`, Then the row passes", () => {
    const w = world();
    recordPi(w, "0.3.0");
    expect(doctorRow(w)).toMatchObject({ status: "pass", detail: "ytrack skill 0.3.0 in pi" });
  });

  posix(
    "Given a host's skill older than `ytrack version`, Then the row warns with the upgrade fix",
    () => {
      const w = world();
      recordPi(w, "0.3.0");
      expect(doctorRow(w, { STUB_VERSION: "0.4.0" })).toMatchObject({
        status: "warn",
        detail: "ytrack 0.4.0: pi has skill 0.3.0",
        fix: "workit upgrade --hosts=pi",
      });
    },
  );

  posix("Given a Workit host without the skill, Then the row warns that it is missing", () => {
    const w = world({ pi: true });
    expect(doctorRow(w)).toMatchObject({
      status: "warn",
      detail: "ytrack 0.3.0: no ytrack skill for pi",
      fix: "workit upgrade --hosts=pi",
    });
  });

  posix("Given an older ytrack without `skill`, Then the row hints `ytrack upgrade`", () => {
    const w = world({ pi: true });
    expect(doctorRow(w, { STUB_OLD: "1" })).toMatchObject({
      status: "warn",
      fix: "ytrack upgrade",
    });
  });

  posix("Given YouTrack unused, Then there is no row", () => {
    const w = world({ pi: true, youtrack: false });
    expect(doctorRow(w)).toBeUndefined();
  });
});
