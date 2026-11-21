// youtrack.autoHosts for `workit youtrack` writes: `auto` only when the
// instance the verb reaches is an allowed host. The verb reaches the
// workspace's youtrack.baseUrl, else youtrack.json's, and names it in
// YTRACK_HOST over an inherited one. ytrack is a recorded stub on a temp
// PATH; the account home and its seal are temp ones; no real YouTrack.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run } from "@/packages/workit-cli/src/verbs/youtrack";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

const SANDBOX = "sandbox.youtrack.cloud";
const WORK = "https://acme.youtrack.cloud";

/** Logs YTRACK_HOST and argv; answers the read-backs with empty lists. */
const STUB = `#!/bin/sh
printf '%s %s\\n' "$YTRACK_HOST" "$*" >> "$STUB_DIR/calls"
case "$1 $2" in
  "issue view") echo '{"comments":[]}' ;;
  "work-item list") echo '[]' ;;
  "api /users/me") echo '{"login":"me"}' ;;
  "issue comment") echo '{"id":"4-1"}' ;;
  *) echo '{}' ;;
esac
`;

let dir = "";
let home: ConfigHome;
let stateRun = 0;
const saved = {
  WORKIT_YOUTRACK_CONFIG: process.env.WORKIT_YOUTRACK_CONFIG,
  WORKIT_STATE_DIR: process.env.WORKIT_STATE_DIR,
  WORKIT_WORKSPACE_NAME: process.env.WORKIT_WORKSPACE_NAME,
};
beforeAll(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-yt-autohosts-")));
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "bin", "ytrack"), STUB);
  chmodSync(path.join(dir, "bin", "ytrack"), 0o755);
  mkdirSync(path.join(dir, "repo"));
  // youtrack.json names the work instance.
  writeFileSync(
    path.join(dir, "youtrack.json"),
    JSON.stringify({ baseUrl: WORK, timezone: "UTC" }),
  );
  process.env.WORKIT_YOUTRACK_CONFIG = path.join(dir, "youtrack.json");
  delete process.env.WORKIT_WORKSPACE_NAME;
  // A self-sealing temp account home: the entry is sealed as the user's terminal would.
  home = useConfigHome("wk-yt-autohosts-home-");
});
beforeEach(() => {
  stateRun += 1;
  process.env.WORKIT_STATE_DIR = path.join(dir, `state-${stateRun}`);
  rmSync(path.join(dir, "calls"), { force: true });
});
afterAll(() => {
  home.restore();
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});

const workspace = (youtrack: Record<string, unknown>) =>
  writeFileSync(
    path.join(home.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "personal", glob: `${dir.replaceAll("\\", "/")}/**`, youtrack }],
    }),
  );

const note = async (env: NodeJS.ProcessEnv = {}) => {
  let stdout = "";
  const io: Io = {
    json: true,
    cwd: path.join(dir, "repo"),
    env: { PATH: path.join(dir, "bin"), STUB_DIR: dir, WORKIT_YT_WRITE: "1", ...env },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await run(["note", "DEMO-1", "--markdown", "y"], io);
  let calls: string[] = [];
  try {
    calls = readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");
  } catch {
    // ytrack never ran.
  }
  return {
    code,
    json: JSON.parse(stdout),
    posts: calls.filter((line) => / issue comment /.test(line)),
  };
};

test.skipIf(process.platform === "win32")(
  "G auto with autoHosts [sandbox] and a verb backend that resolves to the work instance (youtrack.json), W WORKIT_YT_WRITE=1 workit youtrack note runs, T it needs the user's yes and posts nothing",
  async () => {
    workspace({ writes: "auto", autoHosts: [SANDBOX] });
    const out = await note();
    expect(out.code).toBe(3);
    expect(out.json.data).toMatchObject({ reason: "approval_needed", posted: false });
    expect(out.posts).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "G auto with autoHosts [sandbox] and the workspace's youtrack.baseUrl on the sandbox, W the note runs with an inherited YTRACK_HOST on the work instance, T it posts unasked to the sandbox only",
  async () => {
    workspace({ writes: "auto", autoHosts: [SANDBOX], baseUrl: `https://${SANDBOX}` });
    const out = await note({ YTRACK_HOST: WORK });
    expect(out.code).toBe(0);
    expect(out.posts).toHaveLength(1);
    expect(out.posts[0]).toStartWith(`https://${SANDBOX} issue comment DEMO-1`);
  },
);

test.skipIf(process.platform === "win32")(
  "G plain auto without autoHosts, W the note runs against youtrack.json's work instance, T it posts as before",
  async () => {
    workspace({ writes: "auto" });
    const out = await note();
    expect(out.code).toBe(0);
    expect(out.posts).toHaveLength(1);
    expect(out.posts[0]).toStartWith(`${WORK} issue comment DEMO-1`);
  },
);
