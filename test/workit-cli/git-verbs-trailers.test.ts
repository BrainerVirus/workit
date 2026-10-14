import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { fixSessionHook, runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { invariantBootstrap } from "@/packages/workit-core/src/core/methods";
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
  expect(fixed).toMatchObject({ action: "skipped", workspace: "work" });
  expect(fixed.detail).toContain("trailers: false; no hook installed");
});

test("Given the contract every host loads, Then it tells agents to add trailers with --trailer instead of amending", () => {
  for (const text of [invariantBootstrap(), getWorkitBootstrap() ?? ""]) {
    expect(text).toMatch(
      /Trailers \(Co-Authored-By\): `workit git commit --trailer "K: v" --all`, not\s+an amend\./,
    );
  }
});
