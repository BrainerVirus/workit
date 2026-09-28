import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fetchGitHubIssueBody,
  fetchGitLabIssueBody,
  repoPathFromRemote,
} from "@/packages/workit-core/src/core/tracker-issues";

test("GitHub issues use gh CLI and preserve the issue triple", async () => {
  const seen: string[][] = [];
  const cli = async (args: string[]) => {
    seen.push(args);
    return {
      status: 0,
      stdout: JSON.stringify({ number: 42, title: "T", body: "B", state: "open" }),
      stderr: "",
    };
  };
  const result = await fetchGitHubIssueBody("#42", "/root", {
    remote: () => "git@github.com:owner/repo.git",
    cli,
  });
  expect(seen).toEqual([
    ["issue", "view", "42", "--repo", "owner/repo", "--json", "number,title,body,state"],
  ]);
  expect(result).toEqual({ data: { id: "42", title: "T", body: "B", state: "open" } });
});

test("tracker issue reads pin custom GitHub and GitLab hosts", async () => {
  const github: string[][] = [];
  const gitlab: string[][] = [];
  await fetchGitHubIssueBody("42", "/root", {
    host: "github.example.test",
    remote: () => "https://github.example.test/group/repo.git",
    cli: async (args) => {
      github.push(args);
      return {
        status: 0,
        stdout: JSON.stringify({ number: 42, title: "T", body: null, state: "open" }),
        stderr: "",
      };
    },
  });
  await fetchGitLabIssueBody("42", "/root", {
    host: "gitlab.example.test",
    remote: () => "https://gitlab.example.test/group/sub/repo.git",
    cli: async (args) => {
      gitlab.push(args);
      return {
        status: 0,
        stdout: JSON.stringify({ iid: 42, title: "T", description: null, state: "opened" }),
        stderr: "",
      };
    },
  });
  expect(github[0]).toContain("github.example.test/group/repo");
  expect(gitlab[0]).toContain("https://gitlab.example.test/group/sub/repo");
});

test("GitHub issue lookup uses the single configured push destination", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-tracker-push-target-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", "https://origin.example.test/old/repo.git"], {
      cwd: root,
    });
    spawnSync(
      "git",
      ["remote", "set-url", "--push", "origin", "https://github.example.test/group/repo.git"],
      { cwd: root },
    );
    let args: string[] = [];
    const result = await fetchGitHubIssueBody("42", root, {
      host: "github.example.test",
      cli: async (value) => {
        args = value;
        return {
          status: 0,
          stdout: JSON.stringify({ number: 42, title: "T", body: null, state: "open" }),
          stderr: "",
        };
      },
    });
    expect(args).toContain("github.example.test/group/repo");
    expect(result).toMatchObject({ data: { id: "42", title: "T" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitLab issues use glab CLI with the full subgroup path", async () => {
  const seen: string[][] = [];
  const result = await fetchGitLabIssueBody("13", "/root", {
    remote: () => "git@gitlab.com:group/sub/repo.git",
    cli: async (args) => {
      seen.push(args);
      return {
        status: 0,
        stdout: JSON.stringify({ iid: 13, title: "T", description: "B", state: "opened" }),
        stderr: "",
      };
    },
  });
  expect(seen).toEqual([["issue", "view", "13", "-R", "group/sub/repo", "-F", "json"]]);
  expect(result).toEqual({ data: { id: "13", title: "T", body: "B", state: "opened" } });
});

test("tracker reads fail closed without CLI auth or with malformed responses", async () => {
  const remote = () => "git@github.com:owner/repo.git";
  expect(await fetchGitHubIssueBody("bad!", "/root", { remote })).toMatchObject({ kind: "input" });
  expect(await fetchGitHubIssueBody("42", "/root", { remote: () => null })).toMatchObject({
    kind: "input",
  });
  expect(
    await fetchGitHubIssueBody("42", "/root", {
      remote,
      cli: async () => ({ status: 1, stdout: "", stderr: "no auth" }),
    }),
  ).toMatchObject({ kind: "creds" });
  expect(
    await fetchGitLabIssueBody("42", "/root", {
      remote: () => "git@gitlab.com:group/sub/repo.git",
      cli: async () => ({ status: 0, stdout: "{", stderr: "" }),
    }),
  ).toMatchObject({ kind: "request" });
});

test("repoPathFromRemote keeps subgroups and handles scp and HTTPS forms", () => {
  expect(repoPathFromRemote("git@github.com:owner/repo.git")).toBe("owner/repo");
  expect(repoPathFromRemote("https://github.com/owner/repo")).toBe("owner/repo");
  expect(repoPathFromRemote("git@gitlab.com:group/sub/repo.git")).toBe("group/sub/repo");
  expect(repoPathFromRemote("https://gitlab.example.com/group/repo/")).toBe("group/repo");
  expect(repoPathFromRemote("")).toBeNull();
});
