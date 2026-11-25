import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { SEAL_FILE } from "@/packages/workit-core/src/core/grant-seal";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type ForgeRepo,
} from "@/test/shared/helpers/forge-replay";

// `externalRepos` counts only while the account's seal is valid (#882): an
// entry that lists the repository but was never sealed still refuses, and the
// unblock adds the seal step. The seal is left to this test (`seal: "manual"`).

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-issue-unsealed-", { seal: "manual" });
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", SEAL_FILE])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

test("Given externalRepos lists the repository but the seal is not valid, When issue create runs, Then it refuses with the workspace set and workspace seal unblock and writes nothing", async () => {
  const repo = makeForgeRepo("github");
  repos.push(repo);
  const runner = replayRunner(
    {
      "GET user": fixture("github/user.json"),
      "GET repos/o/r": fixture("github/repo.json"),
      "POST repos/acme/tool/issues": JSON.stringify({ number: 1, html_url: "u" }),
    },
    repo.subs,
  );
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0, readStdin: () => "x" });
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          externalRepos: ["acme/tool"],
        },
      ],
    }),
  );
  let stdout = "";
  const io: Partial<Io> = {
    cwd: repo.cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await main(
    ["issue", "create", "--repo", "acme/tool", "--title", "t", "--body-file", "-", "--json"],
    io,
  );
  expect(code, stdout).toBe(3);
  const result = JSON.parse(stdout);
  expect(result.error).toContain("outside_owner: acme/tool");
  expect(result.unblock).toEndWith(
    `workit workspace set w externalRepos='["acme/tool"]', then workit workspace seal`,
  );
  expect(runner.calls.filter((call) => call.method === "POST")).toEqual([]);
});
