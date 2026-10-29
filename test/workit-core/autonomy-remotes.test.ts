// #549: grants follow the folder, so a fresh repository whose origin is a
// stricter workspace's remote would push there with the folder's grants. An
// entry's `remotes` caps every checkout whose remote URLs it claims.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { remoteClaims, requireGrant, resolveAutonomy } from "@/packages/workit-core/src/autonomy";
import { remoteKey, remoteMatches } from "@/packages/workit-core/src/core/remotes";
import { readWorkspacesResult } from "@/packages/workit-core/src/core/workspaces";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
let root = "";
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
};
const checkout = (at: string, origin?: string) => {
  mkdirSync(at, { recursive: true });
  git(at, "init", "-q");
  if (origin) git(at, "remote", "add", "origin", origin);
  return at;
};
beforeAll(() => {
  configHome = useConfigHome("wk-remote-cap-config-");
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-remote-cap-"))).replaceAll("\\", "/");
});
afterAll(() => {
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true }));

const workspaces = (strictRemotes: unknown) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "strict",
          glob: `${root}/strict/**`,
          vcs: { provider: "github", account: "me" },
          autonomy: { push: false, pr: false, release: false },
          ...(strictRemotes === undefined ? {} : { remotes: strictRemotes }),
        },
        {
          name: "open",
          glob: `${root}/open/**`,
          vcs: { provider: "github", account: "me" },
          autonomy: { push: true, pr: true, merge: true, release: true },
        },
      ],
    }),
  );

test("Given the ssh, scp-like and https forms of one repository, When they are normalized, Then they compare equal, case-insensitively and without .git", () => {
  const forms = [
    "git@github.com:Acme/Strict.git",
    "ssh://git@GitHub.com/acme/strict.git",
    "ssh://git@github.com:22/acme/strict",
    "https://github.com/acme/strict",
    "https://user@github.com/acme/strict.git/",
    "git+ssh://git@github.com/acme/strict.git",
  ];
  for (const form of forms) expect(remoteKey(form), form).toBe("github.com/acme/strict");
  expect(remoteMatches("github.com/acme/strict", "github.com/acme/strict")).toBe(true);
  expect(remoteMatches("git@github.com:acme/*", "github.com/acme/strict")).toBe(true);
  expect(remoteMatches("https://github.com/acme/*", "github.com/acme/group/strict")).toBe(true);
  expect(remoteMatches("https://github.com/acme/*", "github.com/acmeco/strict")).toBe(false);
  expect(remoteMatches("https://github.com/acme/strict", "github.com/acme/strict2")).toBe(false);
  expect(remoteMatches("https://github.com/acme/strict", "gitlab.com/acme/strict")).toBe(false);
  expect(remoteKey("ext::sh -c evil")).toBeNull();
  expect(remoteKey("/srv/git/strict.git")).toBe("file:/srv/git/strict");
});

test("Given a remotes pattern that is not a remote URL, When workspaces.json is read, Then it is invalid", () => {
  workspaces(["ext::sh -c x"]);
  const read = readWorkspacesResult(configHome.configDir);
  expect(read.status).toBe("invalid");
  expect(read.error).toContain("remotes");
});

test("Given a fresh repository in open whose origin is strict's remote in its ssh form, When grants resolve, Then they are capped at strict and the refusal names strict and the remote", () => {
  workspaces(["https://github.com/acme/strict"]);
  const fresh = checkout(`${root}/open/fresh`, "git@github.com:ACME/strict.git");
  const push = requireGrant(fresh, "push");
  expect(push.allowed).toBe(false);
  if (push.allowed) return;
  expect(push.reason).toBe("grant_required");
  expect(push.error).toContain("capped at workspace strict");
  expect(push.error).toContain("git@github.com:ACME/strict.git");
  expect(push.unblock).toContain("workit grant set strict push=true");
  expect(requireGrant(fresh, "pr").allowed).toBe(false);
  expect(requireGrant(fresh, "release").allowed).toBe(false);
  // merge is not stricter in strict than the defaults' false: also capped.
  expect(requireGrant(fresh, "merge").allowed).toBe(false);
  expect(remoteClaims(fresh)).toEqual([
    {
      remote: "origin",
      url: "git@github.com:ACME/strict.git",
      workspace: "strict",
      pattern: "https://github.com/acme/strict",
    },
  ]);
});

test("Given a strict pattern for a whole owner, When a fresh repository pushes to any repository of that owner, Then it is capped", () => {
  workspaces(["git@github.com:acme/*"]);
  const fresh = checkout(`${root}/open/owner`, "https://github.com/acme/other.git");
  expect(requireGrant(fresh, "push").allowed).toBe(false);
});

test("Given only a push URL claimed by strict, When grants resolve, Then they are capped", () => {
  workspaces(["https://github.com/acme/strict"]);
  const fresh = checkout(`${root}/open/pushurl`, "https://github.com/me/fork");
  git(fresh, "remote", "set-url", "--push", "origin", "git@github.com:acme/strict.git");
  expect(requireGrant(fresh, "push").allowed).toBe(false);
});

test("Given a URL rewritten by insteadOf to strict's remote, When grants resolve, Then they are capped", () => {
  workspaces(["https://github.com/acme/strict"]);
  const fresh = checkout(`${root}/open/insteadof`, "gh:acme/strict");
  git(fresh, "config", "url.https://github.com/.insteadOf", "gh:");
  expect(requireGrant(fresh, "push").allowed).toBe(false);
});

test("Given a remote URL workit cannot read, When grants resolve, Then nothing is granted", () => {
  workspaces(["https://github.com/acme/strict"]);
  const fresh = checkout(`${root}/open/unreadable`, "ext::sh -c x");
  const push = requireGrant(fresh, "push");
  expect(push.allowed).toBe(false);
  if (!push.allowed) expect(push.error).toContain("cannot read");
});

test("Given an unclaimed origin, a folder that is no repository, and no entry with remotes, When grants resolve, Then the folder's grants stand", () => {
  workspaces(["https://github.com/acme/strict"]);
  const own = checkout(`${root}/open/own`, "git@github.com:me/own.git");
  expect(requireGrant(own, "push").allowed).toBe(true);
  expect(resolveAutonomy(own).grants.release).toBe(true);
  const plain = `${root}/open/plain`;
  mkdirSync(plain, { recursive: true });
  expect(requireGrant(plain, "push").allowed).toBe(true);
  workspaces(undefined);
  const fresh = checkout(`${root}/open/unclaimed`, "git@github.com:acme/strict.git");
  expect(requireGrant(fresh, "push").allowed).toBe(true);
});

test("Given strict's own checkout of its claimed remote, When grants resolve, Then strict's grants are unchanged", () => {
  workspaces(["https://github.com/acme/strict"]);
  const own = checkout(`${root}/strict/repo`, "https://github.com/acme/strict.git");
  const autonomy = resolveAutonomy(own);
  expect(autonomy.workspace).toBe("strict");
  expect(autonomy.note).toBeUndefined();
});

test("Given a linked worktree of a fresh repository with strict's remote, When grants resolve there, Then it is capped too", () => {
  workspaces(["https://github.com/acme/strict"]);
  const fresh = checkout(`${root}/open/wt-main`, "git@github.com:acme/strict.git");
  git(
    fresh,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "i",
  );
  git(fresh, "worktree", "add", "-q", "-b", "wt", `${root}/open/wt-linked`);
  expect(requireGrant(`${root}/open/wt-linked`, "push").allowed).toBe(false);
});
