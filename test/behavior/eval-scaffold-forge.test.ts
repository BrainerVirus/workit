// A bench world with `scaffold.forge: "github"` (#792 item 48): its `gh` is a
// fake that answers the reads `workit pr create` makes and opens one canned
// PR, and refuses every other call having sent nothing, so a case can grade
// the pending-backlink flow with no network, real forge or login.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { childEnv } from "@/scripts/eval/run";
import { FAKE_FORGE_URL, FAKE_YOUTRACK_URL, makeWorld } from "@/scripts/eval/scaffold";

const world = makeWorld({
  id: "forge-fake",
  tier: "full",
  prompt: "x",
  source: "test",
  scaffold: {
    branch: "feature/fix-login",
    forge: "github",
    commits: [{ message: "fix: login", files: { "login.txt": "ok\n" } }],
  },
});
const plain = makeWorld({ id: "forge-none", tier: "smoke", prompt: "x", source: "test" });
afterAll(() => {
  for (const dir of [world.dir, plain.dir]) rmSync(dir, { recursive: true, force: true });
});
const env = childEnv(world, path.join(world.dir, "plugin-bin"));
const gh = (...args: string[]) =>
  spawnSync("gh", args, { cwd: world.repo, env, encoding: "utf8", timeout: 20_000 });
const git = (...args: string[]) =>
  spawnSync("git", args, { cwd: world.repo, encoding: "utf8" }).stdout.trim();
const opened = path.join(world.dir, "forge-pr");

test.skipIf(process.platform === "win32")(
  "Given a case with scaffold.forge github, When the world is made, Then gh api user answers the fake login and an unknown route or a raw comment exits non-zero, sending nothing",
  () => {
    const user = gh("api", "user");
    expect(user.status).toBe(0);
    expect(JSON.parse(user.stdout).login).toBe("eval");
    for (const args of [
      ["api", "repos/eval/demo/issues/1/comments"],
      ["api", "-X", "POST", "repos/eval/demo/issues/1/comments", "-f", "body=Linked"],
      ["pr", "create", "--fill"],
      ["auth", "token"],
    ]) {
      const run = gh(...args);
      expect(run.status, args.join(" ")).not.toBe(0);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("the fake gh refuses this call and sent nothing");
    }
    expect(existsSync(opened)).toBe(false);
  },
);

test.skipIf(process.platform === "win32")(
  "Given the fake forge, When POST pulls opens the PR, Then the search finds it open at the pushed head and a second POST is refused",
  () => {
    const head = git("rev-parse", "HEAD");
    const find = () =>
      JSON.parse(
        gh(
          "api",
          "graphql",
          "-f",
          "query=query { repository { pullRequests(headRefName: $head) { nodes { number } } } }",
          "-f",
          "head=feature/fix-login",
        ).stdout,
      ).data.repository.pullRequests.nodes;
    expect(find()).toEqual([]);
    const post = ["api", "-X", "POST", "repos/eval/demo/pulls", "-f", "head=feature/fix-login"];
    const created = gh(...post);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ number: 1, head: { sha: head } });
    expect(find()).toEqual([
      expect.objectContaining({ number: 1, state: "OPEN", headRefOid: head }),
    ]);
    expect(gh(...post).status).not.toBe(0);
  },
);

test("Given a forge world, Then the branch is on origin, pushes name a .invalid host, and issues link to YouTrack with backlink true", () => {
  expect(git("remote", "get-url", "--push", "origin")).toBe(FAKE_FORGE_URL);
  expect(git("ls-remote", "origin", "refs/heads/feature/fix-login")).toStartWith(
    git("rev-parse", "HEAD"),
  );
  const [entry] = JSON.parse(
    readFileSync(path.join(world.config, "workspaces.json"), "utf8"),
  ).workspaces;
  expect(entry.issues).toEqual({ provider: "youtrack", backlink: true });
  expect(JSON.parse(readFileSync(path.join(world.config, "youtrack.json"), "utf8"))).toEqual({
    baseUrl: FAKE_YOUTRACK_URL,
  });
  expect(new URL(FAKE_FORGE_URL).hostname).toEndWith(".invalid");
  expect(new URL(FAKE_YOUTRACK_URL).hostname).toEndWith(".invalid");
});

test("Given a world with no forge, Then it has no fake gh and no workspace entry", () => {
  expect(existsSync(path.join(plain.bin, "gh"))).toBe(false);
  expect(existsSync(path.join(plain.config, "workspaces.json"))).toBe(false);
});
