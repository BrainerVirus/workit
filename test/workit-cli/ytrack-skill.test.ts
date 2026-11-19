// The ytrack agent skill (youtrack-cli #16) is ytrack's own: ytrack 0.6.0 and
// newer installs and refreshes it. setup and upgrade write no skill, upgrade
// removes the per-host copies an older Workit recorded once
// ~/.agents/skills/ytrack exists, doctor reads `ytrack skill list --json`,
// uninstall removes only what Workit recorded. ytrack is a stub on a temp PATH
// and HOME is a temp dir: never the real ytrack or a real host skills directory.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { applyUninstall, planUninstall } from "@/packages/workit-cli/src/admin/uninstall";
import { runUpgradeCommand, type HostProcess } from "@/packages/workit-cli/src/upgrade";
import { run as setup } from "@/packages/workit-cli/src/verbs/setup";
import { run as uninstallVerb } from "@/packages/workit-cli/src/verbs/uninstall";
import { hostSkillsRoot } from "@/packages/workit-cli/src/upgrade/skill-roots";
import {
  parseSkillMeta,
  readYtrackSkillRecord,
  removeYtrackSkill,
} from "@/packages/workit-core/src/core/ytrack-skill";

setDefaultTimeout(process.platform === "win32" ? 60_000 : 30_000);

const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wk-ytrack-skill-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A ytrack 0.6 with `ytrack skill list --json`: it prints $STUB_LIST (a JSON
// array, default empty). STUB_OLD=1 is a ytrack before 0.6.0, without
// `skill list`. Any `skill install` or `skill sync` is a write Workit must not make.
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DIR/calls"
v="\${STUB_VERSION:-0.6.1}"
if [ "$1" = version ]; then printf 'ytrack version %s (2026-11-18)\\n' "$v"; exit 0; fi
if [ "$1" = skill ] && [ "$2" = list ] && [ "$STUB_OLD" = 1 ]; then
  echo 'ytrack: unknown command "list" for "ytrack skill"' >&2; exit 1
fi
if [ "$1" = skill ] && [ "$2" = list ] && [ "$3" = --json ]; then
  printf '%s\\n' "\${STUB_LIST:-[]}"; exit 0
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
    writeFileSync(settings, JSON.stringify({ packages: ["npm:@workit-dev/pi"] }));
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

/** Every path under `dir`, relative: what a run wrote shows up as a difference. */
const tree = (dir: string, prefix = ""): string[] =>
  readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(prefix, entry.name);
    return entry.isDirectory() ? [rel, ...tree(dir, rel)] : [rel];
  });

const skillWrites = (w: ReturnType<typeof world>): string[] =>
  w.calls().filter((call) => /^skill (install|sync|uninstall)/u.test(call));

const posix = test.skipIf(process.platform === "win32");

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

test("removeYtrackSkill skips a recorded path that no longer holds the ytrack skill and leaves it", () => {
  const w = world();
  const dir = path.join(w.home, ".pi", "agent", "skills", "ytrack");
  w.skillAt(dir, "1.0.0", "someone-else");
  expect(
    removeYtrackSkill({ host: "pi", path: dir, version: "0.3.0" }, w.stateDir, {
      root: hostSkillsRoot("pi", w.home, w.env()),
      home: w.home,
    }),
  ).toEqual({
    status: "skipped",
    detail: "no longer holds the ytrack skill Workit installed; left untouched",
  });
  expect(existsSync(path.join(dir, "SKILL.md"))).toBe(true);
});

const upgrade = async (w: ReturnType<typeof world>, extra: Record<string, string> = {}) => {
  // Pi at the published version: the upgrade has no host work.
  const piRoot = path.join(w.home, "pi-resolved");
  mkdirSync(piRoot, { recursive: true });
  writeFileSync(
    path.join(piRoot, "package.json"),
    JSON.stringify({ name: "@workit-dev/pi", version: "1.0.0" }),
  );
  const out: string[] = [];
  const code = await runUpgradeCommand(["--hosts=pi", "--yes", "--json"], {
    home: w.home,
    env: { ...w.env(extra), WORKIT_NO_YTRACK: undefined },
    run: (command, args) =>
      command === "npm" && args[0] === "view"
        ? { status: 0, stdout: "1.0.0\n" }
        : command === "pi" && args[0] === "list"
          ? { status: 0, stdout: `npm:@workit-dev/pi\n  ${piRoot}\n` }
          : { status: 0, stdout: "" },
    processes: (): HostProcess[] => [],
    confirm: async () => true,
    doctor: () => ({ checks: [] }),
    out: { write: (text: string) => void out.push(text) },
  });
  const report = JSON.parse(out.join("")) as {
    hosts: { host: string; status: string; reason: string; details?: string[] }[];
  };
  return { code, report, row: report.hosts.find((row) => row.host === "ytrack") };
};

/** A skill copy an older Workit installed for `host`, with its record row. */
const workitCopy = (
  w: ReturnType<typeof world>,
  host: "claude-code" | "codex" | "cursor" | "pi",
) => {
  const dir = path.join(hostSkillsRoot(host, w.home, w.env()), "ytrack");
  w.skillAt(dir, "0.5.4");
  mkdirSync(path.join(dir, "references"), { recursive: true });
  writeFileSync(path.join(dir, "references", "issues.md"), "reference\n");
  const rows = readYtrackSkillRecord(w.stateDir);
  mkdirSync(w.stateDir, { recursive: true });
  writeFileSync(
    path.join(w.stateDir, "ytrack-skill.json"),
    JSON.stringify({
      installs: [
        ...rows,
        { host, path: dir, version: "0.5.4", files: ["SKILL.md", "references/issues.md"] },
      ],
    }),
  );
  return dir;
};

const sharedCopy = (w: ReturnType<typeof world>) =>
  path.join(w.home, ".agents", "skills", "ytrack");
const recordFile = (w: ReturnType<typeof world>) => path.join(w.stateDir, "ytrack-skill.json");

describe("Workit writes no ytrack skill", () => {
  posix(
    "Given ytrack 0.6 and YouTrack in use, When workit setup runs for Pi and Claude Code, Then no skill dir is written and ytrack is never asked to install one",
    async () => {
      const w = world({ pi: true });
      const before = tree(w.home);
      const io = {
        json: false,
        cwd: w.home,
        env: w.env(),
        stdout: () => {},
        stderr: () => {},
      };
      expect(await setup(["--hosts=pi,claude-code", "--no-shell", "--yes"], io)).toBe(0);
      const added = tree(w.home).filter((entry) => !before.includes(entry));
      expect(added.filter((entry) => entry.split(path.sep).includes("skills"))).toEqual([]);
      expect(skillWrites(w)).toEqual([]);
      expect(existsSync(recordFile(w))).toBe(false);
    },
  );

  posix(
    "Given ytrack 0.6 and YouTrack in use, When workit upgrade runs, Then no skill file is written and there is no ytrack row",
    async () => {
      const w = world({ pi: true });
      const { code, row } = await upgrade(w);
      expect(code).toBe(0);
      expect(row).toBeUndefined();
      expect(existsSync(path.join(w.home, ".pi", "agent", "skills"))).toBe(false);
      expect(existsSync(path.join(w.home, ".agents"))).toBe(false);
      expect(skillWrites(w)).toEqual([]);
    },
  );

  test("Given Workit's sources, Then none runs `ytrack skill install|sync|uninstall` or `ytrack upgrade`", () => {
    const root = path.resolve(import.meta.dir, "..", "..", "packages");
    const writes = /\[\s*"(?:skill",\s*"(?:install|sync|uninstall)|upgrade)"/u;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "dist") walk(file);
        } else if (
          /\.(?:ts|tsx|mts|mjs)$/u.test(entry.name) &&
          file.includes(`${path.sep}src${path.sep}`) &&
          /ytrack/u.test(readFileSync(file, "utf8")) &&
          writes.test(readFileSync(file, "utf8"))
        )
          hits.push(path.relative(root, file));
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

describe("workit upgrade retires Workit's per-host copies", () => {
  posix(
    "Given ~/.agents/skills/ytrack, a Workit-made Pi copy and a user-made Codex copy, When upgrade runs, Then the Pi copy goes, the Codex and Claude Code copies stay and the record is gone",
    async () => {
      const w = world({ pi: true });
      w.skillAt(sharedCopy(w), "0.6.1");
      const pi = workitCopy(w, "pi");
      const claude = workitCopy(w, "claude-code");
      // Made by hand: no row in Workit's record.
      const codex = path.join(hostSkillsRoot("codex", w.home, w.env()), "ytrack");
      w.skillAt(codex, "0.5.4");
      const { code, row } = await upgrade(w);
      expect(code).toBe(0);
      expect(row).toEqual({
        host: "ytrack",
        status: "updated",
        reason: `retired Workit's copies of the ytrack skill: ytrack keeps ${sharedCopy(w)}; ytrack still lists them as missing until \`ytrack skill sync\` (optional)`,
        details: [pi],
      });
      expect(existsSync(pi)).toBe(false);
      expect(existsSync(path.join(codex, "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(claude, "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(sharedCopy(w), "SKILL.md"))).toBe(true);
      expect(existsSync(recordFile(w))).toBe(false);
      expect(skillWrites(w)).toEqual([]);
    },
  );

  posix(
    "Given ~/.agents/skills is a symlink to ~/.codex/skills, When upgrade runs, Then the Codex copy (the shared one) stays",
    async () => {
      const w = world({ pi: true });
      const codex = workitCopy(w, "codex");
      const pi = workitCopy(w, "pi");
      mkdirSync(path.join(w.home, ".agents"), { recursive: true });
      symlinkSync(path.dirname(codex), path.join(w.home, ".agents", "skills"));
      const { row } = await upgrade(w);
      expect(row?.details).toEqual([pi]);
      expect(existsSync(path.join(codex, "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(sharedCopy(w), "SKILL.md"))).toBe(true);
    },
  );

  posix(
    "Given ~/.agents/skills/ytrack is a symlink to ~/.cursor/skills/ytrack, When upgrade runs, Then the Cursor copy (the shared one) stays",
    async () => {
      const w = world({ pi: true });
      const cursor = workitCopy(w, "cursor");
      const pi = workitCopy(w, "pi");
      mkdirSync(path.join(w.home, ".agents", "skills"), { recursive: true });
      symlinkSync(cursor, sharedCopy(w));
      const { row } = await upgrade(w);
      expect(row?.details).toEqual([pi]);
      expect(existsSync(path.join(cursor, "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(sharedCopy(w), "SKILL.md"))).toBe(true);
    },
  );

  for (const [name, make] of [
    [
      "a dangling symlink",
      (w: ReturnType<typeof world>) => {
        mkdirSync(path.join(w.home, ".agents", "skills"), { recursive: true });
        symlinkSync(path.join(w.home, "nowhere"), sharedCopy(w));
      },
    ],
    [
      "another skill named ytrack",
      (w: ReturnType<typeof world>) => w.skillAt(sharedCopy(w), "1.0.0", "my-ytrack-notes"),
    ],
  ] as const)
    posix(
      `Given ~/.agents/skills/ytrack is ${name}, When upgrade runs, Then every Workit copy and the record stay`,
      async () => {
        const w = world({ pi: true });
        make(w);
        const pi = workitCopy(w, "pi");
        const { row } = await upgrade(w);
        expect(row).toBeUndefined();
        expect(existsSync(path.join(pi, "SKILL.md"))).toBe(true);
        expect(existsSync(recordFile(w))).toBe(true);
      },
    );

  posix(
    "Given a Workit-made Pi copy but no ~/.agents/skills/ytrack, When upgrade runs, Then the copy and its record stay",
    async () => {
      const w = world({ pi: true });
      const pi = workitCopy(w, "pi");
      const { row } = await upgrade(w);
      expect(row).toBeUndefined();
      expect(existsSync(path.join(pi, "SKILL.md"))).toBe(true);
      expect(readYtrackSkillRecord(w.stateDir).map((install) => install.path)).toEqual([pi]);
    },
  );

  posix(
    "Given ~/.agents/skills/ytrack and Workit's record of Claude Code's copy, When uninstall runs, Then that copy is ytrack's and stays",
    () => {
      const w = world();
      w.skillAt(sharedCopy(w), "0.6.1");
      const claude = workitCopy(w, "claude-code");
      const paths = { home: w.home, env: w.env(), stateDir: w.stateDir };
      const plan = planUninstall(paths);
      const ours = (action: { path: string }) => action.path === claude;
      expect(plan.hosts.flatMap((host) => host.actions.filter(ours))).toEqual([
        {
          kind: "keep-foreign",
          path: claude,
          detail:
            "ytrack keeps this copy of its skill (~/.agents/skills/ytrack is there); left untouched",
        },
      ]);
      applyUninstall(
        { hosts: plan.hosts.map((host) => ({ ...host, actions: host.actions.filter(ours) })) },
        paths,
      );
      expect(existsSync(path.join(claude, "SKILL.md"))).toBe(true);
    },
  );
});

describe("doctor ytrack_skill reads `ytrack skill list --json`", () => {
  const doctorRow = (w: ReturnType<typeof world>, extra: Record<string, string> = {}) =>
    runDoctor({
      host: "cli",
      home: w.home,
      configDir: w.configDir,
      stateDir: w.stateDir,
      cwd: w.home,
      env: w.env(extra),
    }).checks.find((check) => check.id === "ytrack_skill");
  const copy = (
    dir: string,
    state: "current" | "stale" | "missing",
    options: { managed?: boolean } = {},
  ) => ({
    dir,
    path: path.join(dir, "ytrack"),
    version: state === "missing" ? "" : state === "current" ? "0.6.1" : "0.5.4",
    state,
    managed: options.managed ?? true,
  });
  const list = (...rows: ReturnType<typeof copy>[]) => ({ STUB_LIST: JSON.stringify(rows) });

  posix("Given every copy current, Then the row passes and names the dirs", () => {
    const w = world();
    expect(
      doctorRow(
        w,
        list(copy("/h/.agents/skills", "current"), copy("/h/.claude/skills", "current")),
      ),
    ).toEqual({
      id: "ytrack_skill",
      status: "pass",
      detail: "ytrack skill 0.6.1 in /h/.agents/skills, /h/.claude/skills",
    });
  });

  posix("Given a stale managed copy, Then the row names `ytrack skill sync`", () => {
    const w = world();
    expect(
      doctorRow(w, list(copy("/h/.agents/skills", "current"), copy("/h/.claude/skills", "stale"))),
    ).toMatchObject({
      status: "warn",
      detail: `${path.join("/h/.claude/skills", "ytrack")} holds skill 0.5.4`,
      fix: "ytrack skill sync",
    });
  });

  posix("Given a missing copy and a stale one in a repository, Then each gets its fix", () => {
    const w = world();
    expect(
      doctorRow(
        w,
        list(
          copy("/h/.agents/skills", "current"),
          copy("/h/.codex/skills", "missing"),
          copy("/repo/.agents/skills", "stale", { managed: false }),
        ),
      ),
    ).toMatchObject({
      status: "warn",
      fix: "ytrack skill sync; ytrack skill install --dir /repo/.agents/skills",
    });
  });

  posix(
    "Given copies Workit's upgrade retired (missing, managed) and a current home copy, Then the row passes with a note",
    () => {
      const w = world();
      const home = (dir: string) => path.join(w.home, dir, "skills");
      expect(
        doctorRow(
          w,
          list(
            copy(home(".agents"), "current"),
            copy(home(".codex"), "missing"),
            copy(home(".cursor"), "missing"),
          ),
        ),
      ).toEqual({
        id: "ytrack_skill",
        status: "pass",
        detail: `ytrack skill 0.6.1 in ${home(".agents")}; ytrack still lists 2 removed copies (\`ytrack skill sync\` forgets them)`,
      });
    },
  );

  posix("Given a stale repository copy in a dir with spaces, Then the fix quotes it", () => {
    const w = world();
    expect(
      doctorRow(
        w,
        list(
          copy("/h/.agents/skills", "current"),
          copy("/my repo/skills", "stale", { managed: false }),
        ),
      ),
    ).toMatchObject({ fix: 'ytrack skill install --dir "/my repo/skills"' });
  });

  posix("Given no copy of the skill, Then the row names `ytrack skill install`", () => {
    const w = world();
    expect(doctorRow(w)).toMatchObject({ status: "warn", fix: "ytrack skill install" });
  });

  posix(
    "Given an older ytrack without `skill list`, Then the row names `ytrack upgrade` to 0.6.0 and nothing changes",
    () => {
      const w = world({ pi: true });
      const pi = workitCopy(w, "pi");
      // Other doctor rows may write logs; the skill dirs and Workit's record stay as they were.
      const unchanged = () => [
        ...tree(w.home).filter((entry) => entry.split(path.sep).includes("skills")),
        readFileSync(recordFile(w), "utf8"),
      ];
      const before = unchanged();
      expect(doctorRow(w, { STUB_OLD: "1", STUB_VERSION: "0.5.4" })).toEqual({
        id: "ytrack_skill",
        status: "warn",
        detail:
          "ytrack 0.5.4 has no `ytrack skill list`: ytrack 0.6.0 or newer installs and keeps its agent skill current",
        fix: "ytrack upgrade (to 0.6.0 or newer)",
      });
      expect(unchanged()).toEqual(before);
      expect(existsSync(path.join(pi, "SKILL.md"))).toBe(true);
      expect(skillWrites(w)).toEqual([]);
      expect(w.calls().filter((call) => call.startsWith("upgrade"))).toEqual([]);
    },
  );

  posix("Given YouTrack unused, Then there is no row", () => {
    const w = world({ youtrack: false });
    expect(doctorRow(w)).toBeUndefined();
  });
});

describe("uninstall refuses a recorded path that is not the host's <skills root>/ytrack", () => {
  /** A ytrack skill dir the record points at, with a file that must survive. */
  const target = (w: ReturnType<typeof world>, dir: string) => {
    w.skillAt(dir, "0.3.0");
    writeFileSync(path.join(dir, "keep.txt"), "important");
    return dir;
  };
  const record = (w: ReturnType<typeof world>, rows: { host: string; path: string }[]) => {
    mkdirSync(w.stateDir, { recursive: true });
    writeFileSync(
      path.join(w.stateDir, "ytrack-skill.json"),
      JSON.stringify({ installs: rows.map((row) => ({ ...row, version: "0.3.0" })) }),
    );
  };
  const uninstall = (w: ReturnType<typeof world>) => {
    const paths = { home: w.home, env: w.env(), stateDir: w.stateDir };
    const plan = planUninstall(paths);
    const skill = (action: { kind: string; path: string }) =>
      action.kind === "remove-ytrack-skill" ||
      (action.kind === "keep-foreign" && action.path.endsWith("ytrack"));
    const actions = plan.hosts.flatMap((host) => host.actions.filter(skill));
    const result = applyUninstall(
      { hosts: plan.hosts.map((host) => ({ ...host, actions: host.actions.filter(skill) })) },
      paths,
    );
    return { actions, entries: result.entries };
  };
  const cases: [string, (w: ReturnType<typeof world>) => { host: string; path: string }][] = [
    [
      "a path outside every skills root",
      (w) => ({
        host: "pi",
        path: target(w, path.join(w.home, "projects", "important", "ytrack")),
      }),
    ],
    [
      "a `..` path that leaves the host's root",
      (w) => {
        target(w, path.join(w.home, "other", "ytrack"));
        return {
          host: "claude-code",
          path: [w.home, ".claude", "skills", "..", "..", "other", "ytrack"].join(path.sep),
        };
      },
    ],
    [
      "another host's root under a valid host",
      (w) => ({ host: "pi", path: target(w, path.join(w.home, ".claude", "skills", "ytrack")) }),
    ],
  ];
  for (const [name, row] of cases)
    test(`Given ${name}, Then the plan keeps it, apply skips it and the dir survives`, () => {
      const w = world();
      const recorded = row(w);
      record(w, [recorded]);
      const kept = path.resolve(recorded.path);
      const { actions, entries } = uninstall(w);
      expect(actions.map((action) => action.kind)).toEqual(["keep-foreign"]);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ status: "skipped" });
      expect(entries[0].detail).toContain("left untouched");
      expect(readFileSync(path.join(kept, "keep.txt"), "utf8")).toBe("important");
      // The apply-time guard refuses the same row on its own.
      expect(
        removeYtrackSkill(
          { host: recorded.host as "pi", path: recorded.path, version: "0.3.0" },
          w.stateDir,
          {
            root: hostSkillsRoot(recorded.host as "pi", w.home, w.env()),
            home: w.home,
          },
        ),
      ).toMatchObject({ status: "skipped" });
      expect(readFileSync(path.join(kept, "keep.txt"), "utf8")).toBe("important");
    });

  posix("Given a symlinked parent of the skills root, Then the dir behind it survives", () => {
    const w = world();
    const elsewhere = path.join(w.home, "elsewhere", "skills");
    target(w, path.join(elsewhere, "ytrack"));
    mkdirSync(path.join(w.home, ".pi"), { recursive: true });
    symlinkSync(path.join(w.home, "elsewhere"), path.join(w.home, ".pi", "agent"));
    const recorded = path.join(w.home, ".pi", "agent", "skills", "ytrack");
    record(w, [{ host: "pi", path: recorded }]);
    const { actions, entries } = uninstall(w);
    expect(actions.map((action) => action.kind)).toEqual(["keep-foreign"]);
    expect(entries[0]).toMatchObject({ status: "skipped" });
    expect(
      removeYtrackSkill({ host: "pi", path: recorded, version: "0.3.0" }, w.stateDir, {
        root: hostSkillsRoot("pi", w.home, w.env()),
        home: w.home,
      }),
    ).toMatchObject({ status: "skipped" });
    expect(readFileSync(path.join(elsewhere, "ytrack", "keep.txt"), "utf8")).toBe("important");
  });

  /** `workit uninstall --hosts=pi` as --preview then --yes (JSON): the ytrack rows each printed. */
  const previewThenYes = async (w: ReturnType<typeof world>) => {
    const runVerb = async (flag: string) => {
      const out: string[] = [];
      const io = {
        json: true,
        cwd: w.home,
        env: w.env(),
        stdout: (text: string) => void out.push(text),
        stderr: () => {},
      };
      const code = await uninstallVerb(["--hosts=pi", flag], io);
      const envelope = JSON.parse(out.join("").trim().split("\n").at(-1) ?? "{}");
      return { code, data: envelope.data ?? {} };
    };
    const preview = await runVerb("--preview");
    const apply = await runVerb("--yes");
    const skill = (row: { path: string }) => row.path.endsWith(`${path.sep}ytrack`);
    return {
      rows: (
        preview.data.actions as {
          kind: string;
          path: string;
          detail: string;
          keys: string[];
          host: string;
        }[]
      ).filter(skill),
      code: apply.code,
      entries: (
        apply.data.removed as {
          host: string;
          path: string;
          status: string;
          detail?: string;
        }[]
      ).filter(skill),
    };
  };

  posix(
    "Given a recorded skill dir that no longer holds the skill, When preview and then --yes run twice, Then each shows the same kept row and neither run fails",
    async () => {
      const w = world();
      const dir = path.join(w.home, ".pi", "agent", "skills", "ytrack");
      w.skillAt(dir, "1.0.0", "my-ytrack-notes");
      record(w, [{ host: "pi", path: dir }]);
      for (const _ of [1, 2]) {
        const run = await previewThenYes(w);
        expect(run.code).toBe(0);
        expect(run.rows).toEqual([
          {
            kind: "keep-foreign",
            path: dir,
            detail: "no longer holds the ytrack skill Workit installed; left untouched",
            keys: [],
            host: "pi",
          },
        ]);
        expect(run.entries).toEqual([
          {
            host: "pi",
            path: dir,
            status: "skipped",
            detail: run.rows[0].detail,
          },
        ]);
      }
      expect(parseSkillMeta(readFileSync(path.join(dir, "SKILL.md"), "utf8")).name).toBe(
        "my-ytrack-notes",
      );
    },
  );

  posix(
    "Given the recorded skill dir also holds a user's file, When preview and then --yes run, Then only the skill's files go, the dir and the file stay, and both say so in one wording",
    async () => {
      const w = world();
      const dir = path.join(w.home, ".pi", "agent", "skills", "ytrack");
      w.skillAt(dir, "0.3.0");
      mkdirSync(path.join(dir, "references"), { recursive: true });
      writeFileSync(path.join(dir, "references", "issues.md"), "reference\n");
      writeFileSync(path.join(dir, "mynotes.md"), "mine\n");
      mkdirSync(w.stateDir, { recursive: true });
      writeFileSync(
        path.join(w.stateDir, "ytrack-skill.json"),
        JSON.stringify({
          installs: [
            {
              host: "pi",
              path: dir,
              version: "0.3.0",
              files: ["SKILL.md", "references/issues.md"],
            },
          ],
        }),
      );
      const run = await previewThenYes(w);
      expect(run.code).toBe(0);
      const detail = `remove the ytrack skill's files; ${dir} kept (holds mynotes.md)`;
      expect(run.rows.map((row) => [row.kind, row.detail])).toEqual([
        ["remove-ytrack-skill", detail],
      ]);
      expect(run.entries).toEqual([{ host: "pi", path: dir, status: "removed", detail }]);
      expect(readFileSync(path.join(dir, "mynotes.md"), "utf8")).toBe("mine\n");
      expect(existsSync(path.join(dir, "SKILL.md"))).toBe(false);
      expect(existsSync(path.join(dir, "references"))).toBe(false);
      expect(readYtrackSkillRecord(w.stateDir)).toEqual([]);
    },
  );

  posix(
    "Given a record from before Workit listed the files, Then uninstall removes only ytrack's documented layout and keeps a user's file",
    async () => {
      const w = world();
      const dir = path.join(w.home, ".pi", "agent", "skills", "ytrack");
      w.skillAt(dir, "0.3.0");
      mkdirSync(path.join(dir, "references"), { recursive: true });
      writeFileSync(path.join(dir, "references", "api.md"), "reference\n");
      writeFileSync(path.join(dir, "mynotes.md"), "mine\n");
      record(w, [{ host: "pi", path: dir }]);
      const run = await previewThenYes(w);
      expect(run.entries[0]).toMatchObject({ status: "removed", detail: run.rows[0].detail });
      expect(run.rows[0].detail).toEndWith(`${dir} kept (holds mynotes.md)`);
      expect(readFileSync(path.join(dir, "mynotes.md"), "utf8")).toBe("mine\n");
      expect(existsSync(path.join(dir, "references"))).toBe(false);
    },
  );

  posix(
    "Given a recorded skill already gone, When preview and then --yes run, Then both use the same wording and the record goes",
    async () => {
      const w = world();
      const dir = path.join(w.home, ".pi", "agent", "skills", "ytrack");
      record(w, [{ host: "pi", path: dir }]);
      const run = await previewThenYes(w);
      expect(run.code).toBe(0);
      expect(run.rows.map((row) => [row.kind, row.detail])).toEqual([
        ["remove-ytrack-skill", "ytrack skill already absent; Workit forgets its record of it"],
      ]);
      expect(run.entries).toEqual([
        {
          host: "pi",
          path: dir,
          status: "skipped",
          detail: run.rows[0].detail,
        },
      ]);
      expect(readYtrackSkillRecord(w.stateDir)).toEqual([]);
    },
  );
});
