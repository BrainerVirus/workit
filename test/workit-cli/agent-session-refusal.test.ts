// `workit setup` and `workit uninstall --hosts` refuse from inside an agent
// session on one shared marker list, so the two cannot drift: an agent that
// could remove Workit's hooks and permission blocks could remove the guards
// themselves (#423). `grant` refuses on at least the same markers.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_SESSION_VARS } from "@/packages/workit-cli/src/admin/host-permissions";
import type { Io } from "@/packages/workit-cli/src/output";
import { agentMarker } from "@/packages/workit-cli/src/verbs/grant";
import { run as setup } from "@/packages/workit-cli/src/verbs/setup";
import { run as uninstall } from "@/packages/workit-cli/src/verbs/uninstall";

const scratch = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "wk-agent-session-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// One marker per host, as each host sets it in the shells its agent runs.
const MARKERS: Record<string, string> = {
  "claude-code": "CLAUDECODE",
  codex: "CODEX_THREAD_ID",
  cursor: "CURSOR_AGENT",
  opencode: "OPENCODE_SESSION_ID",
  pi: "PI_SESSION_ID",
  workit: "WORKIT_SESSION_ID",
};

const run = async (
  verb: typeof setup,
  argv: string[],
  home: string,
  marker: string,
): Promise<{ code: number; envelope: Record<string, string> }> => {
  const out: string[] = [];
  const io: Io = {
    json: true,
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH, [marker]: "1" },
    stdout: (text) => void out.push(text),
    stderr: () => {},
  };
  const code = await verb(argv, io);
  return { code, envelope: JSON.parse(out.join("").trim().split("\n").at(-1) ?? "") };
};

const cursorHome = (name: string): string => {
  const home = path.join(scratch, name);
  const pluginDir = path.join(home, ".cursor/plugins/local/workit");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, "plugin.json"), "{}\n");
  return home;
};

test("the marker table covers every variable setup refuses on", () => {
  expect(Object.values(MARKERS).toSorted()).toEqual([...AGENT_SESSION_VARS].toSorted());
});

for (const [host, marker] of Object.entries(MARKERS)) {
  test(`Given ${marker} (${host}), When uninstall --hosts=cursor --yes runs, Then it is refused naming the terminal command`, async () => {
    const home = cursorHome(`uninstall-${host}`);
    const { code, envelope } = await run(uninstall, ["--hosts=cursor", "--yes"], home, marker);
    expect(code).toBe(3);
    expect(envelope.code).toBe("blocked");
    expect(envelope.error).toBe(
      `an agent cannot run this (${marker} is set): hand the user \`workit uninstall --hosts=cursor --yes\` to run in their own terminal`,
    );
    expect(envelope.unblock).toBe("workit uninstall --hosts=cursor --yes");
  });

  test(`Given ${marker} (${host}), When setup --hosts=cursor --yes runs, Then it is refused naming the terminal command`, async () => {
    const home = path.join(scratch, `setup-${host}`);
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    const { code, envelope } = await run(
      setup,
      ["--hosts=cursor", "--no-shell", "--yes"],
      home,
      marker,
    );
    expect(code).toBe(3);
    expect(envelope.code).toBe("blocked");
    expect(envelope.error).toContain(`${marker} is set`);
    expect(envelope.error).toContain("workit setup --hosts=cursor");
  });

  test(`Given ${marker} (${host}), When the bare uninstall picker runs, Then it is refused before any terminal check`, async () => {
    const { code, envelope } = await run(uninstall, [], scratch, marker);
    expect(code).toBe(3);
    expect(envelope.error).toBe(
      `an agent cannot run this (${marker} is set): hand the user \`workit uninstall\` to run in their own terminal`,
    );
    expect(envelope.unblock).toBe("workit uninstall");
  });

  test(`Given ${marker} (${host}), Then grant's agent check refuses too`, () => {
    expect(agentMarker({ [marker]: "1" })).toBe(marker);
  });
}
