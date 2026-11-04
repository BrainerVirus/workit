import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { actorFromEnv, appendObserved } from "@/packages/workit-core/src/ledger";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type ForgeRepo,
} from "@/test/shared/helpers/forge-replay";

// #651: `verify-delivery merge` run on main after `pr merge` looked up a PR
// whose head is main and suggested pushing main and opening a PR from it.
// On a protected branch it checks the PR this session merged onto it, or
// asks for --pr, and never suggests a PR from the protected branch.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-verify-protected-");
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  rmSync(path.join(configHome.configDir, "config.json"), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const SESSION = "author-1";

const onMain = () => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  const runner = replayRunner(
    {
      "GET user": fixture("github/user.json"),
      "GET repos/o/r": fixture("github/repo.json"),
      "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
      "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
      "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
      'graphql status {"owner":"o","name":"r","number":"12"}': fixture("github/pr-merged.json"),
    },
    repo.subs,
  );
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  repo.git("switch", "-q", "main");
  return { repo, runner };
};

const run = async (argv: string[], cwd: string, session: string | null = SESSION) => {
  let stdout = "";
  let stderr = "";
  const env = { ...process.env };
  delete env.WORKIT_SESSION_ID;
  const io: Partial<Io> = {
    cwd,
    env: session ? { ...env, WORKIT_SESSION_ID: session } : env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
};

test("Given main and no merge this session recorded, When verify-delivery merge runs, Then it asks for --pr and never suggests a PR from main", async () => {
  const { repo, runner } = onMain();
  for (const session of [SESSION, null]) {
    const result = await run(["verify-delivery", "merge"], repo.cwd, session);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("main is a protected branch, not a PR head");
    expect(result.stderr).toContain("workit verify-delivery merge --pr <n>");
    expect(result.stderr).not.toContain("pr create");
    expect(result.stderr).not.toContain("git push");
  }
  // Refused before any forge call.
  expect(runner.calls).toEqual([]);
});

test("Given main and verify-delivery pr, When it runs without --pr, Then it asks for --pr or --branch", async () => {
  const { repo } = onMain();
  const result = await run(["verify-delivery", "pr"], repo.cwd);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(
    "workit verify-delivery pr --pr <n>  # or --branch <its head branch>",
  );
  expect(result.stderr).not.toContain("pr create");
});

test("Given main and a merge this session recorded onto it, When verify-delivery merge runs, Then it checks that PR", async () => {
  const { repo, runner } = onMain();
  const recorded = appendObserved(repo.cwd, {
    type: "pr.merged",
    actor: actorFromEnv({ WORKIT_SESSION_ID: SESSION }),
    branch: "feature/x",
    head: repo.head,
    pr: 12,
    base: "main",
  });
  expect(recorded.ok).toBe(true);
  const result = await run(["verify-delivery", "merge"], repo.cwd);
  expect(result.stderr).toContain("checking PR #12, the last one this session merged onto it");
  expect(result.stderr).not.toContain("no pull request for branch main");
  expect(runner.calls.some((call) => call.op === "status")).toBe(true);
  // Another session's merge is not picked up.
  const other = await run(["verify-delivery", "merge"], repo.cwd, "someone-else");
  expect(other.code).toBe(2);
  expect(other.stderr).toContain("protected branch");
});
