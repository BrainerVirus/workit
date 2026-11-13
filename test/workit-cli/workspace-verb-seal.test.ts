// `workit workspace seal` and the writers that settle the seal (#819): the
// user's terminal seals after seeing the diff; a terminal write reseals only
// when the seal matched before; any other write reseals only when it lowers
// the sealed values; under a config redirect the account's seal is the only
// one, and a write to the redirected file never touches it.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { run as runYouTrack } from "@/packages/workit-cli/src/verbs/youtrack";
import { runGrant, type GrantDeps } from "@/packages/workit-cli/src/verbs/grant";
import { runWorkspace } from "@/packages/workit-cli/src/verbs/workspace";
import { requireGrant, resolveAutonomy } from "@/packages/workit-core/src/autonomy";
import { checkSeal, SEAL_FILE, sealProjection } from "@/packages/workit-core/src/core/grant-seal";
import type { YouTrackBackend } from "@/packages/workit-core/src/core/youtrack-backend";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";
import { sealConfig, useConfigHome, type ConfigHome } from "../shared/grant-home";

const SAVED = ["WORKIT_CONFIG", "WORKIT_WORKSPACE_NAME", "WORKIT_STATE_DIR"] as const;
const saved = Object.fromEntries(SAVED.map((key) => [key, process.env[key]]));
let configHome: ConfigHome;
let root = "";
let agent = "";
beforeAll(() => {
  delete process.env.WORKIT_WORKSPACE_NAME;
  configHome = useConfigHome("wk-ws-seal-config-", { seal: "manual" });
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-ws-seal-"))).replaceAll("\\", "/");
  agent = path.join(root, "agent-config");
  mkdirSync(path.join(root, "w", "repo"), { recursive: true });
  mkdirSync(agent, { recursive: true });
});
afterAll(() => {
  configHome.restore();
  for (const key of SAVED)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  process.env.WORKIT_CONFIG = configHome.configDir;
  for (const dir of [configHome.configDir, agent])
    for (const name of ["workspaces.json", "workspaces.json.bak", SEAL_FILE])
      rmSync(path.join(dir, name), { force: true });
});

const SEAL = "workit workspace seal";
const GH = { provider: "github", account: "me" };
const cwd = () => `${root}/w/repo`;
const accountFile = () => path.join(configHome.configDir, "workspaces.json");
const sealFile = () => path.join(configHome.configDir, SEAL_FILE);
const seed = (dir: string, workspaces: Record<string, unknown>[]) =>
  writeFileSync(path.join(dir, "workspaces.json"), `${JSON.stringify({ workspaces }, null, 2)}\n`);
const entry = (extra: Record<string, unknown> = {}) => ({
  name: "w",
  glob: `${root}/w/**`,
  vcs: GH,
  ...extra,
});

/** A terminal that answers each y/N in turn (Enter declines once they run out). */
const terminal = (answers: boolean[], asked: string[] = []): GrantDeps => ({
  interactive: () => true,
  ask: async () => "",
  confirm: async (question) => {
    asked.push(question);
    return answers.shift() ?? false;
  },
});
const headless: GrantDeps = { interactive: () => false, ask: async () => "" };

const io = (env: NodeJS.ProcessEnv = {}) => {
  let stdout = "";
  const value: Io = {
    json: false,
    cwd: cwd(),
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stdout += text),
  };
  return { io: value, out: () => stdout };
};
const workspace = async (argv: string[], deps: GrantDeps, env: NodeJS.ProcessEnv = {}) => {
  const { io: value, out } = io(env);
  return { code: await runWorkspace(argv, value, deps), out: out() };
};
const grant = async (argv: string[], deps: GrantDeps, env: NodeJS.ProcessEnv = {}) => {
  const { io: value, out } = io(env);
  return { code: await runGrant(argv, value, deps), out: out() };
};

test("Given a terminal, When workspace seal runs, Then it shows the authority fields; n writes nothing, y writes the seal and the raised grants apply", async () => {
  seed(configHome.configDir, [entry({ autonomy: { merge: true }, defaultEndpoint: "merged" })]);
  expect(resolveAutonomy(cwd()).grants.merge).toBe(false);
  const asked: string[] = [];
  const no = await workspace(["seal"], terminal([false], asked));
  expect(no.code).not.toBe(0);
  expect(no.out).toContain('+ w: glob="');
  expect(no.out).toContain('autonomy={"merge":true}');
  expect(no.out).toContain("nothing was written");
  expect(existsSync(sealFile())).toBe(false);
  expect(asked).toHaveLength(1);
  const yes = await workspace(["seal"], terminal([true]));
  expect(yes.code).toBe(0);
  expect(checkSeal(configHome.configDir).state).toBe("valid");
  expect(resolveAutonomy(cwd()).grants.merge).toBe(true);
  expect(resolveAutonomy(cwd()).effectiveEndpoint).toBe("merged");
  // Already sealed: nothing to ask.
  const again = await workspace(["seal"], terminal([], asked));
  expect(again.code).toBe(0);
  expect(again.out).toContain("already sealed");
  expect(asked).toHaveLength(1);
});

test("Given a seal that no longer matches, When workspace seal runs at a terminal, Then it shows only what changed", async () => {
  seed(configHome.configDir, [entry({ autonomy: { merge: false } })]);
  sealConfig(configHome.configDir);
  seed(configHome.configDir, [entry({ autonomy: { merge: "verified" } })]);
  const shown = await workspace(["seal"], terminal([false]));
  expect(shown.out).toContain('~ w.autonomy: {"merge":false} -> {"merge":"verified"}');
  expect(shown.out).not.toContain("+ w:");
});

test("Given an agent marker or no TTY, When workspace seal runs, Then it is refused naming the user's command and nothing is written", async () => {
  seed(configHome.configDir, [entry({ autonomy: { merge: true } })]);
  for (const [label, deps, env] of [
    ["agent", terminal([true]), { CLAUDECODE: "1" }],
    ["headless", headless, {}],
  ] as const) {
    const out = await workspace(["seal"], deps, env);
    expect(out.code, label).not.toBe(0);
    expect(out.out, label).toContain("seal_refused");
    expect(out.out, label).toContain(SEAL);
    expect(existsSync(sealFile()), label).toBe(false);
  }
});

test("Given a matching seal, When grant set raises at a terminal, Then the grant applies with no extra step", async () => {
  seed(configHome.configDir, [entry()]);
  sealConfig(configHome.configDir);
  const asked: string[] = [];
  const out = await grant(["set", "w", "merge=verified"], terminal([true], asked));
  expect(out.code).toBe(0);
  expect(asked).toHaveLength(1);
  expect(out.out).toContain("sealed: the authority fields above apply");
  expect(checkSeal(configHome.configDir).state).toBe("valid");
  const autonomy = resolveAutonomy(cwd());
  expect(autonomy.grants.merge).toBe("verified");
  expect(autonomy.note).toBeUndefined();
});

test("Given a matching seal, When an agent lowers a grant headless, Then it is resealed and the lowered grant applies", async () => {
  seed(configHome.configDir, [entry({ autonomy: { merge: "verified" }, defaultEndpoint: "pr" })]);
  sealConfig(configHome.configDir);
  const out = await grant(["set", "w", "push=false", "defaultEndpoint=commit"], headless, {
    CLAUDECODE: "1",
  });
  expect(out.code).toBe(0);
  expect(checkSeal(configHome.configDir).state).toBe("valid");
  const autonomy = resolveAutonomy(cwd());
  expect(autonomy.grants.push).toBe(false);
  expect(autonomy.grants.merge).toBe("verified");
  expect(autonomy.note).toBeUndefined();
});

test("Given no seal, When grant set raises at a terminal and the user declines the seal, Then the raise is not honoured and the output names workit workspace seal", async () => {
  seed(configHome.configDir, [entry()]);
  const asked: string[] = [];
  const out = await grant(["set", "w", "merge=verified"], terminal([true, false], asked));
  expect(out.code).toBe(0);
  expect(asked).toHaveLength(2);
  expect(out.out).toContain(
    `not sealed: a raise here applies only after the user runs, in their own terminal: ${SEAL}`,
  );
  expect(existsSync(sealFile())).toBe(false);
  const decision = requireGrant(cwd(), "merge");
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.unblock).toContain(SEAL);
  // Accepting the offer instead seals it, and the raise applies.
  rmSync(accountFile());
  seed(configHome.configDir, [entry()]);
  const sealed = await grant(["set", "w", "merge=verified"], terminal([true, true]));
  expect(sealed.code).toBe(0);
  expect(resolveAutonomy(cwd()).grants.merge).toBe("verified");
});

test("Given a matching seal, When an agent adds a workspace headless, Then the seal is left mismatched, the new entry rises above nothing, and the output names the seal command", async () => {
  seed(configHome.configDir, [entry({ autonomy: { merge: "verified" } })]);
  sealConfig(configHome.configDir);
  const before = readFileSync(sealFile(), "utf8");
  const out = await workspace(["add", "kid", "--glob", `${root}/w/kid/**`], headless, {
    CLAUDECODE: "1",
  });
  expect(out.code).toBe(0);
  expect(out.out).toContain(SEAL);
  expect(readFileSync(sealFile(), "utf8")).toBe(before);
  expect(checkSeal(configHome.configDir).state).toBe("broken");
  // The entry that was sealed keeps its sealed grant.
  expect(resolveAutonomy(cwd()).grants.merge).toBe("verified");
});

test("Given a broken seal, When a terminal write changes authority, Then it shows the diff and asks to seal; n leaves it broken", async () => {
  seed(configHome.configDir, [entry()]);
  sealConfig(configHome.configDir);
  seed(configHome.configDir, [entry({ autonomy: { merge: true } })]);
  const asked: string[] = [];
  const out = await grant(["set", "w", "push=false"], terminal([false], asked));
  expect(out.code).toBe(0);
  expect(asked).toHaveLength(1);
  expect(out.out).toContain('~ w.autonomy: (unset) -> {"merge":true,"push":false}');
  expect(checkSeal(configHome.configDir).state).toBe("broken");
  expect(resolveAutonomy(cwd()).grants.merge).toBe(false);
});

test("Under a config redirect, workspace seal seals the account file, a workspace set on the redirected file leaves the seal byte-identical, and grant set reseals the account file", async () => {
  seed(configHome.configDir, [entry({ autonomy: { merge: "verified" } })]);
  seed(agent, [entry({ autonomy: { merge: true, release: true } })]);
  process.env.WORKIT_CONFIG = agent;
  const sealed = await workspace(["seal"], terminal([true]));
  expect(sealed.code).toBe(0);
  expect(existsSync(path.join(agent, SEAL_FILE))).toBe(false);
  const seal = JSON.parse(readFileSync(sealFile(), "utf8")) as { projection: unknown };
  const account = JSON.parse(readFileSync(accountFile(), "utf8")) as { workspaces: unknown[] };
  expect(seal.projection).toEqual(sealProjection(account.workspaces));
  const bytes = readFileSync(sealFile(), "utf8");
  const set = await workspace(
    ["set", "w", "remotes=https://github.com/acme/w.git"],
    terminal([true]),
  );
  expect(set.code, set.out).toBe(0);
  expect(readFileSync(sealFile(), "utf8")).toBe(bytes);
  expect(existsSync(path.join(agent, SEAL_FILE))).toBe(false);
  const lowered = await grant(["set", "w", "merge=false"], headless, { CLAUDECODE: "1" });
  expect(lowered.code).toBe(0);
  expect(readFileSync(sealFile(), "utf8")).not.toBe(bytes);
  expect(checkSeal(configHome.configDir).state).toBe("valid");
  const lowerAccount = JSON.parse(readFileSync(accountFile(), "utf8")) as {
    workspaces: { autonomy?: unknown }[];
  };
  expect(lowerAccount.workspaces[0]?.autonomy).toEqual({ merge: false });
});

// 9. End to end, in-process: WORKIT_CONFIG pointing at an agent's file raises nothing.
const mainRun = async (argv: string[], at: string) => {
  let stdout = "";
  let stderr = "";
  const value: Partial<Io> = {
    cwd: at,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, value);
  return { code, stdout, stderr };
};

test("9. Given WORKIT_CONFIG=<agent dir> granting everything, When workit git push runs in a push:false folder, Then it exits grant_required", async () => {
  let repo: RemoteRepo | undefined;
  try {
    repo = makeRemoteRepo();
    repo.git("switch", "-q", "-c", "feature/seal");
    const glob = `${repo.root.replaceAll("\\", "/")}/**`;
    seed(configHome.configDir, [{ name: "w", glob, vcs: GH, autonomy: { push: false } }]);
    sealConfig(configHome.configDir);
    seed(agent, [{ name: "w", glob, vcs: GH, autonomy: { push: true, pr: true } }]);
    process.env.WORKIT_CONFIG = agent;
    const out = await mainRun(["git", "push", "--json"], repo.cwd);
    expect(out.code).not.toBe(0);
    expect(out.stdout + out.stderr).toContain("grant_required");
  } finally {
    repo?.cleanup();
  }
});

test("9. Given WORKIT_CONFIG=<agent dir> saying youtrack.writes auto, When workit youtrack note runs, Then it records a pending approval and the backend is never called", async () => {
  const state = path.join(root, "yt-state");
  process.env.WORKIT_STATE_DIR = state;
  const ytConfig = path.join(root, "youtrack.json");
  writeFileSync(ytConfig, JSON.stringify({ baseUrl: "https://yt.example.test", timezone: "UTC" }));
  seed(configHome.configDir, [entry({ youtrack: { writes: "auto" } })]);
  sealConfig(configHome.configDir);
  seed(agent, [entry({ youtrack: { writes: "auto" } })]);
  process.env.WORKIT_CONFIG = agent;
  const called: string[] = [];
  const write = (name: string) => async () => {
    called.push(name);
    return { ok: true as const, data: { id: "1" } };
  };
  const backend = {
    kind: "ytrack",
    supports: () => "ok",
    texts: async () => ({ texts: [], complete: true }),
    ownEntries: async () => [],
    showIssue: write("showIssue"),
    createIssue: write("createIssue"),
    addComment: write("addComment"),
    addWorkItem: write("addWorkItem"),
    attachFiles: write("attachFiles"),
    applyCommand: write("applyCommand"),
  } as unknown as YouTrackBackend;
  let stdout = "";
  const value: Io = {
    json: true,
    cwd: cwd(),
    env: { WORKIT_YT_WRITE: "1", WORKIT_YOUTRACK_CONFIG: ytConfig },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const savedYt = process.env.WORKIT_YOUTRACK_CONFIG;
  process.env.WORKIT_YOUTRACK_CONFIG = ytConfig;
  try {
    const code = await runYouTrack(["note", "ABC-1", "--markdown", "Hi"], value, () => backend);
    expect(code, stdout).toBe(3);
    const body = JSON.parse(stdout) as { data: { reason?: string; approval?: string } };
    expect(body.data.reason).toBe("approval_needed");
    expect(body.data.approval).toBeTruthy();
    expect(called).toEqual([]);
  } finally {
    if (savedYt === undefined) delete process.env.WORKIT_YOUTRACK_CONFIG;
    else process.env.WORKIT_YOUTRACK_CONFIG = savedYt;
    process.env.WORKIT_STATE_DIR = saved.WORKIT_STATE_DIR;
  }
});
