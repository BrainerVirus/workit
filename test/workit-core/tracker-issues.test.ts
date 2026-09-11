import { expect, test } from "bun:test";
import {
  fetchGitHubIssueBody,
  repoPathFromRemote,
} from "@/packages/workit-core/src/core/tracker-issues";

const stubRequest = (payload: unknown, status = 0) => async (url: string) => ({
  status,
  stdout: status === 0 ? JSON.stringify(payload) : "",
  stderr: status === 0 ? "" : "not found",
  url,
});

const deps = {
  creds: () => ({ token: "t", api: "https://api.github.com" }),
  remote: () => "git@github.com:owner/repo.git",
} as const;

test("fetchGitHubIssueBody returns the title/body/state triple on stubbed fetch", async () => {
  const seen: string[] = [];
  const result = await fetchGitHubIssueBody("42", "/root", {
    ...deps,
    request: (async (url: string) => {
      seen.push(url);
      return stubRequest({ number: 42, title: "Fix login", body: "Details", state: "open" })(url);
    }) as never,
  });
  expect(seen[0]).toBe("https://api.github.com/repos/owner/repo/issues/42");
  expect(result).toEqual({ data: { id: "42", title: "Fix login", body: "Details", state: "open" } });
});

test("fetchGitHubIssueBody accepts # and URL refs and tolerates missing body", async () => {
  for (const ref of ["#7", "https://github.com/owner/repo/issues/7"]) {
    const result = await fetchGitHubIssueBody(ref, "/root", {
      ...deps,
      request: stubRequest({ number: 7, title: "T", body: null, state: "closed" }) as never,
    });
    expect(result).toEqual({ data: { id: "7", title: "T", body: null, state: "closed" } });
  }
});

test("fetchGitHubIssueBody fails closed on bad refs, missing remote, creds, and requests", async () => {
  expect(await fetchGitHubIssueBody("not-an-issue!!", "/root", deps)).toMatchObject({
    kind: "input",
  });
  expect(
    await fetchGitHubIssueBody("42", "/root", { ...deps, remote: () => null }),
  ).toMatchObject({ kind: "input" });
  expect(
    await fetchGitHubIssueBody("42", "/root", {
      ...deps,
      creds: () => ({ error: "unconfigured github provider" }),
    }),
  ).toMatchObject({ kind: "creds" });
  expect(
    await fetchGitHubIssueBody("42", "/root", { ...deps, request: stubRequest({}, 404) as never }),
  ).toMatchObject({ kind: "request" });
  expect(
    await fetchGitHubIssueBody("42", "/root", {
      ...deps,
      request: stubRequest({ title: 42 }) as never,
    }),
  ).toMatchObject({ kind: "request" });
});

test("repoPathFromRemote keeps subgroups and handles scp, https, and bare forms", () => {
  expect(repoPathFromRemote("git@github.com:owner/repo.git")).toBe("owner/repo");
  expect(repoPathFromRemote("https://github.com/owner/repo")).toBe("owner/repo");
  expect(repoPathFromRemote("git@gitlab.com:group/sub/repo.git")).toBe("group/sub/repo");
  expect(repoPathFromRemote("https://gitlab.example.com/group/repo/")).toBe("group/repo");
  expect(repoPathFromRemote("")).toBe(null);
  expect(repoPathFromRemote("not a url at all !!!")).toBe(null);
});
