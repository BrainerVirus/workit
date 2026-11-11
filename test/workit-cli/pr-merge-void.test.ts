import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { ledgerDeps } from "@/packages/workit-cli/src/verbs/ledger";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// #759: `pr merge --unverified` over a failed verdict names the void path, and
// once the user voids a stray failed verdict the bypass is no longer refused.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
const interactive = ledgerDeps.interactive;
beforeAll(() => {
  configHome = useConfigHome("wk-merge-void-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  ledgerDeps.interactive = interactive;
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const AGENT_ENV = new Set([
  "CLAUDECODE",
  "OPENCODE",
  "CURSOR_AGENT",
  "PI_CODING_AGENT",
  "AI_AGENT",
  "AGENT",
]);

/** A user's own terminal: no agent marker, no host session. */
const userEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("CODEX_") && !name.startsWith("WORKIT_SESSION") && !AGENT_ENV.has(name),
    ),
  );

const run = async (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => {
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
const as = (session: string) => ({ ...process.env, WORKIT_SESSION_ID: session });

const GH_STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';

const setup = (): ForgeRepo => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  let merged = false;
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    [GH_STATUS]: () => fixture(merged ? "github/pr-merged.json" : "github/pr-passing.json"),
    "PUT repos/o/r/pulls/12/merge": () => {
      merged = true;
      return JSON.stringify({ sha: "{{BASE}}", merged: true, message: "merged" });
    },
  };
  Object.assign(forgeDeps, {
    runner: replayRunner(routes, repo.subs),
    sleep: async () => {},
    now: () => 0,
  });
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          verification: "self",
          deleteBranch: false,
          vcs: { provider: "github", account: "octo" },
          autonomy: { merge: true },
        },
      ],
    }),
  );
  return repo;
};

test("pr merge --unverified over a failed verdict names the void path; once the user voids it, failed_verdict is gone", async () => {
  const repo = setup();
  const failed = await run(
    ["ledger", "verdict", "failed", "--how", "judged another repo's PR", "--json"],
    repo.cwd,
    as("reviewer-2"),
  );
  expect(failed.code).toBe(0);
  const stray = failed.json().data.id as string;

  const refused = await run(
    ["pr", "merge", "--unverified", "--reason", "user asked", "--json"],
    repo.cwd,
    as("author-1"),
  );
  expect(refused.json()).toMatchObject({ data: { reason: "failed_verdict" } });
  expect(refused.json().error).toContain(stray);
  expect(refused.json().unblock).toContain(`workit ledger void ${stray} --reason`);

  // An agent shell is refused even at a terminal.
  ledgerDeps.interactive = () => true;
  const agent = await run(["ledger", "void", stray, "--reason", "wrong repo", "--json"], repo.cwd, {
    ...userEnv(),
    CLAUDECODE: "1",
  });
  expect(agent.json().error).toContain("void_refused");

  const voided = await run(
    ["ledger", "void", stray, "--reason", "wrong repo", "--json"],
    repo.cwd,
    userEnv(),
  );
  expect(voided.code).toBe(0);
  const after = await run(
    ["pr", "merge", "--unverified", "--reason", "user asked", "--json"],
    repo.cwd,
    as("author-1"),
  );
  // The user's bypass now merges: the stray failure no longer blocks it.
  expect(after.code, after.stdout).toBe(0);
});
