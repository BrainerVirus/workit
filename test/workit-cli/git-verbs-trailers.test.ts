import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { fixSessionHook, runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { invariantBootstrap } from "@/packages/workit-core/src/core/methods";
import {
  SESSION_HOOK_SCRIPT,
  installSessionHook,
  manualTrailerLine,
} from "@/packages/workit-core/src/git/session-hook";
import { CLAUDE_CODE_DESCRIPTOR, handleHook } from "@/packages/workit-core/src/hooks/index";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { getWorkitBootstrap } from "@/packages/workit-opencode/src/bootstrap";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// Per-workspace `trailers` (retro #268 C1/C2): with `trailers: false` a
// commit carries no Workit-Session trailer and authorship lives in the ledger
// only; `--trailer` adds the caller's own trailers in the same commit.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-git-trailers-");
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const setup = (entry: Record<string, unknown> | null): RemoteRepo => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "github-flow" },
      commitPolicy: { preset: "conventional" },
    }),
  );
  const repo = makeRemoteRepo();
  repos.push(repo);
  if (entry)
    writeFileSync(
      path.join(configHome.configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [{ name: "work", glob: `${repo.root.replaceAll("\\", "/")}/**`, ...entry }],
      }),
    );
  repo.git("switch", "-q", "-c", "feature/a");
  return repo;
};

const AUTHOR = { ...process.env, WORKIT_SESSION_ID: "author-1" };

const run = async (argv: string[], cwd: string, env: NodeJS.ProcessEnv = AUTHOR) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const recorded = (cwd: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === "commit.recorded");
};

test("Given a workspace with trailers: false, When workit commits, Then no Workit-Session trailer is written and the ledger still records the author", async () => {
  const repo = setup({ trailers: false });
  repo.write("a.txt", "a\n");
  const result = await run(["git", "commit", "-m", "feat: a", "--json", "--", "a.txt"], repo.cwd);
  expect(result.code, result.stderr).toBe(0);
  expect(result.json().data).toMatchObject({ session: "author-1", sessionTrailer: false });
  expect(repo.git("log", "-1", "--format=%B")).toBe("feat: a");
  expect(recorded(repo.cwd)).toEqual([
    expect.objectContaining({
      head: repo.git("rev-parse", "HEAD"),
      session: "author-1",
      subject: "feat: a",
    }),
  ]);
  const asked = await run(["git", "trailers"], repo.cwd);
  expect(asked.stdout).toBe("off\n");
});

test("Given a workspace without the setting, When workit commits, Then the trailer is kept and git trailers prints on", async () => {
  const repo = setup({});
  repo.write("a.txt", "a\n");
  expect((await run(["git", "commit", "-m", "feat: a", "--", "a.txt"], repo.cwd)).code).toBe(0);
  expect(repo.git("log", "-1", "--format=%B")).toBe("feat: a\n\nWorkit-Session: author-1");
  expect((await run(["git", "trailers"], repo.cwd)).stdout).toBe("on\n");
});

test("Given trailers off, When the author records a verdict, Then it is refused, and a non-author verdict is accepted (author from the ledger only)", async () => {
  const repo = setup({ trailers: false });
  repo.write("a.txt", "a\n");
  expect((await run(["git", "commit", "-m", "feat: a", "--", "a.txt"], repo.cwd)).code).toBe(0);
  expect(repo.git("log", "-1", "--format=%(trailers:key=Workit-Session)")).toBe("");
  const own = await run(["ledger", "verdict", "verified", "--how", "ran it"], repo.cwd);
  expect(own.code).toBe(3);
  expect(own.stderr).toContain("author_verdict");
  const other = await run(
    ["ledger", "verdict", "verified", "--how", "ran the suite", "--json"],
    repo.cwd,
    { ...process.env, WORKIT_SESSION_ID: "author-1:verifier-7" },
  );
  expect(other.code, other.stderr).toBe(0);
  const check = await run(["ledger", "check", "--json"], repo.cwd);
  expect(check.json().data.accepted.accepted).toBe(true);
});

test("Given --trailer (repeatable), When workit commits, Then those trailers land in the same commit beside the session trailer", async () => {
  const repo = setup({});
  repo.write("a.txt", "a\n");
  const result = await run(
    [
      "git",
      "commit",
      "-m",
      "feat: a",
      "--trailer",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "--trailer=Refs: #268",
      "--",
      "a.txt",
    ],
    repo.cwd,
  );
  expect(result.code, result.stderr).toBe(0);
  expect(repo.git("rev-list", "--count", "main..HEAD")).toBe("1");
  expect(repo.git("log", "-1", "--format=%B")).toBe(
    "feat: a\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nRefs: #268\nWorkit-Session: author-1",
  );
});

test("Given trailers off and --trailer, Then only the caller's trailers are written", async () => {
  const repo = setup({ trailers: false });
  repo.write("a.txt", "a\n");
  const result = await run(
    ["git", "commit", "-m", "feat: a", "--trailer", "Co-Authored-By: A <a@b.c>", "--all"],
    repo.cwd,
  );
  expect(result.code, result.stderr).toBe(0);
  expect(repo.git("log", "-1", "--format=%B")).toBe("feat: a\n\nCo-Authored-By: A <a@b.c>");
});

test("Given a malformed --trailer or one naming Workit-Session, Then the commit is refused (exit 2) and nothing is committed", async () => {
  const repo = setup({});
  repo.write("a.txt", "a\n");
  const head = repo.git("rev-parse", "HEAD");
  for (const [trailer, error] of [
    ["no colon here", 'is not one "Key: value" line'],
    ["Workit-Session: forged", "--trailer cannot set Workit-Session"],
    ["K: v\nWorkit-Session: x", 'is not one "Key: value" line'],
  ]) {
    const result = await run(
      ["git", "commit", "-m", "feat: a", "--trailer", trailer, "--all"],
      repo.cwd,
    );
    expect(result.code, trailer).toBe(2);
    expect(result.stderr).toContain(error);
  }
  const missing = await run(["git", "commit", "-m", "feat: a", "--trailer"], repo.cwd);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("--trailer requires a Key: value trailer");
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
});

test("Given a workspace with trailers: false, When doctor runs, Then it does not suggest the session hook and --fix installs none", async () => {
  const repo = setup({ trailers: false });
  const options = { host: "cli" as const, cwd: repo.cwd, workspaceRoot: repo.cwd };
  const check = runDoctor(options).checks.find((entry) => entry.id === "session_hook");
  expect(check).toMatchObject({ status: "pass" });
  expect(check?.detail).toContain("trailers: false");
  expect(check?.fix).toBeUndefined();
  const fixed = fixSessionHook(options);
  expect(fixed).toMatchObject({ action: "unchanged", workspace: "work" });
  expect(fixed.detail).toContain("trailers: false; no hook installed");
});

test("Given the contract every host loads, Then it tells agents to add trailers with --trailer instead of amending", () => {
  for (const text of [invariantBootstrap(), getWorkitBootstrap() ?? ""]) {
    expect(text).toMatch(
      /Add Co-Authored-By via `workit git commit --trailer "K: v" -- <paths>`, never\s+an amend\./,
    );
    // The contract never tells agents to sweep in unrelated dirt.
    expect(text).not.toContain('--trailer "K: v" --all');
  }
});

// ---------------------------------------------------------------------------
// Review of #287: a hook installed before the switch, amends, forged keys,
// nested workspaces and the isolated-implementer text.

const SESSION_VARS = [
  "WORKIT_SESSION_ID",
  "WORKIT_HOST",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
  "CODEX_THREAD_ID",
  "WORKIT_TRAILERS",
];
/** PATH without any directory that holds a `workit`: the helper cannot ask. */
const noWorkitPath = (): string =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => dir && !existsSync(path.join(dir, "workit")))
    .join(path.delimiter);
const plainEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: noWorkitPath(), ...extra };
  for (const key of SESSION_VARS) if (!(key in extra)) delete env[key];
  return env;
};
const writeWorkspaces = (entries: Record<string, unknown>[]) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({ workspaces: entries }),
  );
const hookSetup = (entry: Record<string, unknown>) => {
  const repo = setup(entry);
  // makeRemoteRepo points core.hooksPath outside the repo; use .git/hooks.
  repo.git("config", "--unset", "core.hooksPath");
  return repo;
};
/** A plain `git commit` from an agent session that cannot run workit. */
const plainCommit = (repo: RemoteRepo, msg: string) => {
  const result = spawnSync("git", ["commit", "-q", "--allow-empty", "-m", msg], {
    cwd: repo.cwd,
    encoding: "utf8",
    env: plainEnv({ WORKIT_SESSION_ID: "sub-7" }),
  });
  expect(result.status, result.stderr).toBe(0);
};

test.skipIf(process.platform === "win32")(
  "Given the hook installed while trailers were on, When the workspace flips to trailers: false, Then doctor warns and --fix removes only Workit's hook and helper",
  () => {
    const repo = hookSetup({});
    const options = { host: "cli" as const, cwd: repo.cwd, workspaceRoot: repo.cwd };
    expect(fixSessionHook(options).action).toBe("installed");
    const hook = path.join(repo.cwd, ".git", "hooks", "prepare-commit-msg");
    const helper = path.join(repo.cwd, ".git", "workit", "session-trailer.sh");
    expect(readFileSync(hook, "utf8")).toBe(SESSION_HOOK_SCRIPT);

    // The same repo: only the setting flips.
    writeWorkspaces([
      { name: "work", glob: `${repo.root.replaceAll("\\", "/")}/**`, trailers: false },
    ]);
    // Without workit on PATH the helper cannot ask and fails open.
    plainCommit(repo, "feat: before fix");
    expect(repo.git("log", "-1", "--format=%B")).toBe("feat: before fix\n\nWorkit-Session: sub-7");
    const check = runDoctor(options).checks.find((entry) => entry.id === "session_hook");
    expect(check).toMatchObject({ status: "warn", fix: "workit doctor --fix" });
    expect(check?.detail).toContain(hook);
    expect(check?.detail).toContain(helper);
    expect(check?.detail).toContain("fails open");

    const fixed = fixSessionHook(options);
    expect(fixed).toMatchObject({ action: "removed", workspace: "work" });
    expect(existsSync(hook)).toBe(false);
    expect(existsSync(helper)).toBe(false);
    expect(runDoctor(options).checks.find((entry) => entry.id === "session_hook")?.status).toBe(
      "pass",
    );
    plainCommit(repo, "feat: after fix");
    expect(repo.git("log", "-1", "--format=%B")).toBe("feat: after fix");
  },
);

test.skipIf(process.platform === "win32")(
  "Given another tool's hook running the helper, When --fix runs with trailers: false, Then that hook is left byte for byte and only the helper goes",
  () => {
    const repo = hookSetup({});
    const hook = path.join(repo.cwd, ".git", "hooks", "prepare-commit-msg");
    const theirs = `#!/bin/sh\n# someone else's\n${manualTrailerLine()}\n`;
    writeFileSync(hook, theirs, { mode: 0o755 });
    installSessionHook(repo.cwd);
    const helper = path.join(repo.cwd, ".git", "workit", "session-trailer.sh");
    expect(existsSync(helper)).toBe(true);
    writeWorkspaces([
      { name: "work", glob: `${repo.root.replaceAll("\\", "/")}/**`, trailers: false },
    ]);
    const options = { host: "cli" as const, cwd: repo.cwd, workspaceRoot: repo.cwd };
    expect(runDoctor(options).checks.find((entry) => entry.id === "session_hook")?.status).toBe(
      "warn",
    );
    expect(fixSessionHook(options)).toMatchObject({ action: "removed", removed: [helper] });
    expect(readFileSync(hook, "utf8")).toBe(theirs);
    plainCommit(repo, "feat: theirs");
    expect(repo.git("log", "-1", "--format=%B")).toBe("feat: theirs");
  },
);

test.skipIf(process.platform === "win32")(
  "Given a Workit hook still installed and trailers: false, When workit commits without workit on PATH, Then the hook adds nothing (WORKIT_TRAILERS reaches it)",
  async () => {
    const repo = hookSetup({});
    installSessionHook(repo.cwd);
    writeWorkspaces([
      { name: "work", glob: `${repo.root.replaceAll("\\", "/")}/**`, trailers: false },
    ]);
    repo.write("a.txt", "a\n");
    const result = await run(
      ["git", "commit", "-m", "feat: a", "--", "a.txt"],
      repo.cwd,
      plainEnv({ WORKIT_SESSION_ID: "author-1" }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(repo.git("log", "-1", "--format=%B")).toBe("feat: a");
  },
);

test("Given trailers turned off after a commit, When amending with --no-edit or -m, Then the old Workit-Session trailer is dropped and other trailers stay", async () => {
  const repo = setup({});
  repo.write("a.txt", "a\n");
  await run(
    ["git", "commit", "-m", "feat: a", "--trailer", "Co-Authored-By: A <a@b.c>", "--", "a.txt"],
    repo.cwd,
  );
  expect(repo.git("log", "-1", "--format=%B")).toBe(
    "feat: a\n\nCo-Authored-By: A <a@b.c>\nWorkit-Session: author-1",
  );
  writeWorkspaces([
    { name: "work", glob: `${repo.root.replaceAll("\\", "/")}/**`, trailers: false },
  ]);
  const kept = await run(["git", "commit", "--amend", "--no-edit"], repo.cwd);
  expect(kept.code, kept.stderr).toBe(0);
  expect(repo.git("log", "-1", "--format=%B")).toBe("feat: a\n\nCo-Authored-By: A <a@b.c>");
  // A second session's trailer, then a reword: both Workit-Session lines go.
  writeWorkspaces([{ name: "work", glob: `${repo.root.replaceAll("\\", "/")}/**` }]);
  await run(["git", "commit", "--amend", "--no-edit"], repo.cwd);
  await run(["git", "commit", "--amend", "--no-edit"], repo.cwd, {
    ...process.env,
    WORKIT_SESSION_ID: "author-2",
  });
  expect(repo.git("log", "-1", "--format=%(trailers:key=Workit-Session,valueonly)")).toBe(
    "author-1\nauthor-2",
  );
  writeWorkspaces([
    { name: "work", glob: `${repo.root.replaceAll("\\", "/")}/**`, trailers: false },
  ]);
  const reworded = await run(["git", "commit", "--amend", "-m", "feat: b"], repo.cwd);
  expect(reworded.code, reworded.stderr).toBe(0);
  expect(repo.git("log", "-1", "--format=%B")).toBe("feat: b\n\nCo-Authored-By: A <a@b.c>");
});

test("Given a trailer alias config or a message line naming Workit-Session, When workit commits, Then the forged trailer is refused and nothing is committed", async () => {
  const repo = setup({});
  repo.write("a.txt", "a\n");
  const head = repo.git("rev-parse", "HEAD");
  repo.git("config", "trailer.ws.key", "Workit-Session");
  const alias = await run(
    ["git", "commit", "-m", "feat: a", "--trailer", "ws: someone-else", "--", "a.txt"],
    repo.cwd,
  );
  expect(alias.code).toBe(2);
  expect(alias.stderr).toContain(
    'forged_session_trailer: the message would carry "Workit-Session: someone-else"',
  );
  const inMessage = await run(
    ["git", "commit", "-m", "feat: a\n\nWorkit-Session: someone-else", "--", "a.txt"],
    repo.cwd,
  );
  expect(inMessage.code).toBe(2);
  expect(inMessage.stderr).toContain("forged_session_trailer");
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
  // The acting session's own value is not a forgery.
  const own = await run(
    ["git", "commit", "-m", "feat: a\n\nWorkit-Session: author-1", "--", "a.txt"],
    repo.cwd,
  );
  expect(own.code, own.stderr).toBe(0);
  expect(repo.git("log", "-1", "--format=%B")).toBe("feat: a\n\nWorkit-Session: author-1");
});

test("Given a workspace nested in one with trailers: false, Then it inherits off unless it sets trailers itself", async () => {
  const repo = setup(null);
  const outer = {
    name: "work",
    glob: `${path.dirname(repo.root).replaceAll("\\", "/")}/**`,
    trailers: false,
  };
  const inner = { name: "ri-web", glob: `${repo.root.replaceAll("\\", "/")}/**` };
  writeWorkspaces([outer, inner]);
  expect((await run(["git", "trailers", "--json"], repo.cwd)).json().data).toEqual({
    enabled: false,
    workspace: "ri-web",
    from: "work",
  });
  repo.write("a.txt", "a\n");
  expect((await run(["git", "commit", "-m", "feat: a", "--", "a.txt"], repo.cwd)).code).toBe(0);
  expect(repo.git("log", "-1", "--format=%B")).toBe("feat: a");
  const options = { host: "cli" as const, cwd: repo.cwd, workspaceRoot: repo.cwd };
  expect(runDoctor(options).checks.find((entry) => entry.id === "session_hook")?.detail).toContain(
    "workspace work sets trailers: false",
  );
  writeWorkspaces([outer, { ...inner, trailers: true }]);
  expect((await run(["git", "trailers"], repo.cwd)).stdout).toBe("on\n");
});

test("Given trailers: false, When an isolated implementer starts, Then its git text asks for no Workit-Session trailer; with trailers on it names the trailer", () => {
  const repo = setup({ trailers: false });
  // Claude Code put it in its own worktree: `.claude/worktrees/agent-<id>`.
  const isolated = path.join(repo.cwd, ".claude", "worktrees", "agent-a1");
  repo.git("worktree", "add", "-q", "--detach", isolated);
  const text = () => {
    const decision = handleHook(
      {
        host: "claude_code",
        cwd: isolated,
        session: { id: "lead-1", agentId: null, agentType: null, parentId: null },
        permissionMode: null,
        transcriptPath: null,
        event: {
          kind: "subagent.start",
          agentId: "a1",
          agentType: "workit:implementer",
          task: null,
        },
      },
      { descriptor: CLAUDE_CODE_DESCRIPTOR, addendum: null },
    );
    return decision.kind === "context" ? decision.text : "";
  };
  const off = text();
  expect(off).toContain("this workspace sets trailers: false: add no Workit-Session trailer");
  expect(off).not.toContain('--trailer "Workit-Session=');
  expect(off).toContain(
    "add Co-Authored-By with `git commit --trailer` in the same commit, never by amending",
  );
  writeWorkspaces([{ name: "work", glob: `${repo.root.replaceAll("\\", "/")}/**` }]);
  const on = text();
  expect(on).toContain('`git commit --trailer "Workit-Session=<your session>"`');
  expect(on).not.toContain("trailers: false");
});
