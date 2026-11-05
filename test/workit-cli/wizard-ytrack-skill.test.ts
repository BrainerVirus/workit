// `workit init` installs the ytrack agent skill when the wizard chose YouTrack,
// like `workit setup` and `workit upgrade`, and its finish screen shows the
// result. ytrack is a POSIX-sh stub on a temp PATH and HOME is a temp dir:
// never the real ytrack or a real host skills directory.
import { afterAll, describe, expect, test } from "bun:test";
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
import { hostSkillsRoot } from "@/packages/workit-cli/src/upgrade/skill-roots";
import { initYtrackSkill, ytrackSkillLines } from "@/packages/workit-cli/src/upgrade/ytrack-skill";

const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wk-init-ytrack-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A ytrack with `ytrack skill` 0.3.0; STUB_OLD=1 is one without it (0.2.x).
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DIR/calls"
v="\${STUB_VERSION:-0.3.0}"
if [ "$1" = version ]; then printf 'ytrack version %s (2026-11-01)\\n' "$v"; exit 0; fi
if [ "$1" = skill ] && [ "$STUB_OLD" = 1 ]; then
  echo 'Error: unknown command "skill" for "ytrack"' >&2; exit 1
fi
if [ "$1" = skill ] && [ "$2" = print ]; then
  printf -- '---\\nname: ytrack\\nmetadata:\\n  version: "%s"\\n---\\n' "$v"; exit 0
fi
if [ "$1" = skill ] && [ "$2" = install ] && [ "$3" = --dir ]; then
  t="$4/ytrack"
  mkdir -p "$t"
  printf -- '---\\nname: ytrack\\nmetadata:\\n  version: "%s"\\n---\\n' "$v" > "$t/SKILL.md"
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
/** A temp HOME where the wizard just wrote youtrack.json and installed Workit for Pi. */
const world = (extra: Record<string, string> = {}) => {
  const home = path.join(scratch, `home-${++worlds}`);
  const bin = path.join(home, "ytrack-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "ytrack"), STUB);
  chmodSync(path.join(bin, "ytrack"), 0o755);
  const configDir = path.join(home, ".config", "workit");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "youtrack.json"),
    JSON.stringify({ baseUrl: "https://acme.youtrack.cloud" }),
  );
  const settings = path.join(home, ".pi", "agent", "settings.json");
  mkdirSync(path.dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ packages: ["npm:@brainervirus/workit-pi"] }));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    PATH: [bin, basePath].join(path.delimiter),
    STUB_DIR: home,
    ...extra,
  };
  const calls = (): string[] => {
    const file = path.join(home, "calls");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
  };
  return { home, env, calls };
};

const plain = { path: (text: string) => text, command: (text: string) => text };

describe.skipIf(process.platform === "win32")("workit init: the ytrack skill", () => {
  test("Given the wizard chose YouTrack and Pi, When it finishes with a ytrack that has `skill`, Then the skill is installed for Pi and the finish lines name it", () => {
    const { home, env, calls } = world();
    // Codex was selected but has no Workit: it gets no skill.
    const row = initYtrackSkill(
      { issueTracker: "youtrack", platforms: ["pi", "codex"] },
      home,
      env,
    );
    const skill = path.join(hostSkillsRoot("pi", home, env), "ytrack");
    expect(readFileSync(path.join(skill, "SKILL.md"), "utf8")).toContain('version: "0.3.0"');
    expect(row).toMatchObject({ host: "ytrack", status: "updated" });
    expect(ytrackSkillLines(row, plain)).toEqual([
      "ytrack skill 0.3.0 installed for pi",
      `  ${skill}`,
    ]);
    expect(calls().filter((call) => call.startsWith("skill install"))).toHaveLength(1);
  });

  test("Given a ytrack without `skill`, When the wizard finishes with YouTrack, Then nothing is installed and the finish lines name `ytrack upgrade`", () => {
    const { home, env } = world({ STUB_OLD: "1" });
    const row = initYtrackSkill({ issueTracker: "youtrack", platforms: ["pi"] }, home, env);
    expect(existsSync(path.join(hostSkillsRoot("pi", home, env), "ytrack"))).toBe(false);
    const lines = ytrackSkillLines(row, plain);
    expect(lines[0]).toBe(
      "ytrack 0.3.0 has no `ytrack skill`: the agent skill needs a newer ytrack",
    );
    expect(lines.at(-1)).toBe("  fix: ytrack upgrade");
  });

  test("Given the wizard chose another tracker, Then ytrack is never run and no line is shown", () => {
    const { home, env, calls } = world();
    const row = initYtrackSkill({ issueTracker: "github", platforms: ["pi"] }, home, env);
    expect(row).toBeNull();
    expect(ytrackSkillLines(row, plain)).toEqual([]);
    expect(calls()).toEqual([]);
  });
});
