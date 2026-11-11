// #769 `workit git hold`: the user's "not yet" for a branch, recorded by the
// CLI; it grants nothing, and the first push that moves the branch ends it.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { branchHold, readLedger } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-hold-config-");
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const setup = (): RemoteRepo => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "github-flow" },
      commitPolicy: { preset: "conventional" },
    }),
  );
  const repo = makeRemoteRepo();
  repos.push(repo);
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
          autonomy: { push: true, pr: true },
          defaultEndpoint: "pr",
        },
      ],
    }),
  );
  return repo;
};

const ENV = { ...process.env, WORKIT_SESSION_ID: "author-1" };

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: ENV,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const hold = (cwd: string, branch: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return branchHold(ledger.value.rows, branch);
};

const feature = async (repo: RemoteRepo, file: string) => {
  if (repo.git("branch", "--show-current") !== "feature/a")
    repo.git("switch", "-q", "-c", "feature/a");
  repo.write(file, `${file}\n`);
  expect((await run(["git", "commit", "-m", `feat: ${file}`, "--", file], repo.cwd)).code).toBe(0);
};

test("Given the user said not yet, When git hold --why runs, Then a CLI-observed hold names their words and grant show is unchanged", async () => {
  const repo = setup();
  await feature(repo, "a.txt");
  const before = await run(["grant", "show", "--json"], repo.cwd);
  expect(before.code).toBe(0);
  expect(before.json().data).toMatchObject({ effectiveEndpoint: "pr" });
  const held = await run(["git", "hold", "--why", "no PR yet", "--json"], repo.cwd);
  expect(held.code).toBe(0);
  expect(held.json().data).toEqual({
    branch: "feature/a",
    held: true,
    why: "no PR yet",
  });
  expect(hold(repo.cwd, "feature/a")).toMatchObject({
    type: "branch.hold",
    observer: "workit_cli",
    why: "no PR yet",
  });
  const after = await run(["grant", "show", "--json"], repo.cwd);
  expect(after.code).toBe(before.code);
  expect(after.stdout).toBe(before.stdout);
});

test("Given a hold, When workit git push moves the branch, Then the hold is cleared and the push says so", async () => {
  const repo = setup();
  await feature(repo, "a.txt");
  expect((await run(["git", "hold", "--why", "not yet"], repo.cwd)).code).toBe(0);
  const pushed = await run(["git", "push", "--set-upstream", "--json"], repo.cwd);
  expect(pushed.code).toBe(0);
  expect(pushed.json().data).toMatchObject({ pushed: true, holdCleared: true });
  expect(hold(repo.cwd, "feature/a")).toBeNull();
  // No hold, no claim of clearing one.
  await feature(repo, "b.txt");
  const again = await run(["git", "push", "--json"], repo.cwd);
  expect(again.json().data).toMatchObject({ pushed: true, holdCleared: false });
});

test("Given a hold, When git hold --clear runs, Then it ends; a second clear finds none", async () => {
  const repo = setup();
  await feature(repo, "a.txt");
  await run(["git", "hold", "--why", "later"], repo.cwd);
  const cleared = await run(["git", "hold", "--clear", "--json"], repo.cwd);
  expect(cleared.json().data).toEqual({
    branch: "feature/a",
    held: false,
    cleared: true,
  });
  expect(hold(repo.cwd, "feature/a")).toBeNull();
  const none = await run(["git", "hold", "--clear"], repo.cwd);
  expect(none.code).toBe(0);
  expect(none.stdout).toContain("no hold on feature/a");
});

test("git hold: needs exactly one of --why and --clear (exit 2 with the usage)", async () => {
  const repo = setup();
  await feature(repo, "a.txt");
  for (const argv of [[], ["--why", "x", "--clear"], ["--why", "  "], ["later"]]) {
    const result = await run(["git", "hold", ...argv, "--json"], repo.cwd);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.json().unblock).toContain("workit git hold --why");
  }
  expect(hold(repo.cwd, "feature/a")).toBeNull();
});
