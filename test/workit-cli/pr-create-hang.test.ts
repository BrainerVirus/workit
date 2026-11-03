import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// #644: `pr create` sat silent until the host killed it while its changelog
// check waited on the base fetch. Now its first line comes at once, the
// fetch has a deadline, and a stall blocks naming the call; nothing opens.

setDefaultTimeout(90_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
const sshCommand = process.env.GIT_SSH_COMMAND;
beforeAll(() => {
  configHome = useConfigHome("wk-pr-create-hang-");
});
afterAll(() => configHome.restore());

const cleanup: Array<() => void> = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  if (sshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
  else process.env.GIT_SSH_COMMAND = sshCommand;
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
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, changelog: "update" },
      ],
    }),
  );
  writeFileSync(
    path.join(repo.cwd, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- x\n",
  );
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "docs(changelog): entry");
  repo.git("push", "-q", path.join(repo.root, "remote.git"), "feature/x");
  repo.subs["{{HEAD}}"] = repo.git("rev-parse", "HEAD");
  // Only the fetch can find the base: no local main, no tracking ref.
  repo.git("branch", "-q", "-D", "main");
  // The fetch goes over ssh to a "server" that never answers: it reads stdin forever.
  repo.git("remote", "set-url", "origin", "ssh://git@stall.invalid/o/r.git");
  repo.git("remote", "set-url", "--push", "origin", "https://github.com/o/r.git");
  const stubs = mkdtempSync(path.join(os.tmpdir(), "wk-stall-ssh-"));
  cleanup.push(() => rmSync(stubs, { recursive: true, force: true }));
  const ssh = path.join(stubs, "ssh-stall");
  writeFileSync(ssh, "#!/bin/sh\nexec cat\n");
  chmodSync(ssh, 0o755);
  process.env.GIT_SSH_COMMAND = ssh;
  const runner = replayRunner(
    {
      "GET user": fixture("github/user.json"),
      "GET repos/o/r": fixture("github/repo.json"),
      "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
      "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
      "graphql find": fixture("github/find-none.json"),
    },
    repo.subs,
  );
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return { repo, runner };
};

const opened = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "POST" && call.endpoint.endsWith("pulls"));

test.skipIf(process.platform === "win32")(
  "Given the changelog check's base fetch never returns, When pr create runs, Then it prints progress at once and fails within its deadline naming the stalled call",
  async () => {
    const { repo, runner } = setup();
    const events: string[] = [];
    const io: Partial<Io> = {
      cwd: repo.cwd,
      env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
      stdout: (text) => void events.push(`out:${text}`),
      stderr: (text) => void events.push(`err:${text}`),
    };
    const began = Date.now();
    const code = await main(
      ["pr", "create", "--base", "main", "--title", "feat: x", "--body", "Why: y"],
      io,
    );
    const elapsed = Date.now() - began;
    expect(events[0]).toStartWith("err:workit: pr create: checking");
    expect(code).toBe(3);
    const output = events.join("");
    expect(output).toContain("changelog_base_unknown");
    expect(output).toMatch(/git fetch \S+ timed out after 15000 ms/u);
    expect(elapsed).toBeLessThan(60_000);
    expect(opened(runner.calls)).toEqual([]);
  },
);
