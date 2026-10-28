// #455: `pr create` ends its human output with the grant/endpoint mismatch
// when the user's grant reaches further than the default endpoint, so a PR
// that stops short is never silent. Only an explicit grant counts.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type ForgeRepo,
} from "@/test/shared/helpers/forge-replay";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-endpoint-note-");
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

/** `workit pr create` in a fresh forge repo whose workspace entry is `entry`. */
const createPr = async (entry: Record<string, unknown>, json = false) => {
  const dir = configHome.configDir;
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  Object.assign(forgeDeps, {
    runner: replayRunner(
      {
        "GET user": fixture("github/user.json"),
        "GET repos/o/r": fixture("github/repo.json"),
        "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
        "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
        "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
        "graphql find": fixture("github/find-none.json"),
        "POST repos/o/r/pulls": JSON.stringify({
          number: 13,
          html_url: "https://github.com/o/r/pull/13",
          state: "open",
          head: { ref: "feature/x", sha: "{{HEAD}}" },
        }),
      },
      repo.subs,
    ),
    sleep: async () => {},
    now: () => 0,
  });
  writeFileSync(
    path.join(dir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          verification: "self",
          vcs: { provider: "github", account: "octo" },
          ...entry,
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
    [
      "pr",
      "create",
      "--base",
      "main",
      "--title",
      "feat: x",
      "--body",
      "Why: y",
      ...(json ? ["--json"] : []),
    ],
    io,
  );
  return { code, stdout, lastLine: stdout.trimEnd().split("\n").at(-1) ?? "" };
};

test("Given merge granted and endpoint pr, When pr create finishes, Then the next line names the stop and the unblock", async () => {
  const result = await createPr({
    autonomy: { merge: true },
    defaultEndpoint: "pr",
  });
  expect(result.code, result.stdout).toBe(0);
  expect(result.lastLine).toContain("next: ");
  expect(result.lastLine).toContain(
    "; merge granted, but endpoint pr stops at the PR; to land on green: workit grant set w defaultEndpoint=merged (your terminal)",
  );
});

test("Given pr granted and endpoint commit, When pr create finishes, Then the next line says how to open PRs", async () => {
  const result = await createPr({
    autonomy: { pr: true },
    defaultEndpoint: "commit",
  });
  expect(result.code, result.stdout).toBe(0);
  expect(result.lastLine).toEndWith(
    "; pr granted, but endpoint commit stops at the local commit; to open PRs: workit grant set w defaultEndpoint=pr (your terminal)",
  );
});

test("Given the grant and the endpoint agree, When pr create finishes, Then the next line carries no note", async () => {
  const result = await createPr({
    autonomy: { merge: true },
    defaultEndpoint: "merged",
  });
  expect(result.code, result.stdout).toBe(0);
  expect(result.lastLine).not.toContain("granted, but endpoint");
});

test("Given a default grant only and endpoint pr, When pr create finishes, Then no note (defaults never trigger it)", async () => {
  const result = await createPr({ defaultEndpoint: "commit" });
  expect(result.code, result.stdout).toBe(0);
  expect(result.lastLine).not.toContain("granted, but endpoint");
});

test("Given a mismatch, When pr create runs with --json, Then the note stays out of the JSON next", async () => {
  const result = await createPr({ autonomy: { merge: true }, defaultEndpoint: "pr" }, true);
  expect(result.code, result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).data.next).not.toContain("granted, but endpoint");
});
