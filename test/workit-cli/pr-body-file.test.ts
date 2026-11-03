import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type Call,
  type ForgeRepo,
} from "@/test/shared/helpers/forge-replay";

// #643: `pr create --cwd <worktree> --body-file <relative>` read the path
// against the worktree, not the shell the caller typed it in.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-pr-body-file-");
});
afterAll(() => configHome.restore());

const cleanup: Array<() => void> = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const done of cleanup.splice(0)) done();
});

const setup = () => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo: ForgeRepo = makeForgeRepo("github");
  cleanup.push(() => repo.cleanup());
  const runner = replayRunner(
    {
      "GET user": fixture("github/user.json"),
      "GET repos/o/r": fixture("github/repo.json"),
      "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
      "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
      "graphql find": fixture("github/find-none.json"),
      "POST repos/o/r/pulls": (call) =>
        JSON.stringify({
          number: 12,
          html_url: "https://github.com/o/r/pull/12",
          state: "open",
          head: { ref: call.vars.head, sha: "{{HEAD}}" },
        }),
    },
    repo.subs,
  );
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  const shell = mkdtempSync(path.join(os.tmpdir(), "wk-body-shell-"));
  cleanup.push(() => rmSync(shell, { recursive: true, force: true }));
  return { repo, runner, shell };
};

const create = async (cwd: string, shell: string, file: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, PWD: shell, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--body-file", file, "--json"],
    io,
  );
  return { code, stdout, stderr };
};

const bodies = (calls: readonly Call[]) =>
  calls
    .filter((call) => call.method === "POST" && call.endpoint.endsWith("pulls"))
    .map((call) => call.pairs.find(([key]) => key === "body")?.[1]);

test("Given --body-file with a relative path and --cwd elsewhere, When pr create runs, Then the path resolves against the caller's directory", async () => {
  const { repo, runner, shell } = setup();
  writeFileSync(path.join(shell, "body.md"), "Why: from the caller's shell\n");
  const result = await create(repo.cwd, shell, "body.md");
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(bodies(runner.calls)[0]).toContain("Why: from the caller's shell");
});

test("Given a relative --body-file that exists nowhere, When pr create runs, Then it fails at once naming every place it looked", async () => {
  const { repo, runner, shell } = setup();
  const result = await create(repo.cwd, shell, "missing.md");
  expect(result.code).toBe(2);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.error).toContain(path.join(shell, "missing.md"));
  expect(envelope.error).toContain(path.join(repo.cwd, "missing.md"));
  expect(envelope.error).toContain("--body-file -");
  expect(bodies(runner.calls)).toEqual([]);
});
