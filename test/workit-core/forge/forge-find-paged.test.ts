import { expect, test } from "bun:test";
import { createGitHubForge } from "@/packages/workit-core/src/forge/github";
import { createGitLabForge } from "@/packages/workit-core/src/forge/gitlab";
import { replayRunner } from "@/test/shared/helpers/forge-replay";

// #284 N5: PR lookup by head reads every page, so an open PR past the first
// 20 results is found and `pr create` never opens a duplicate.

const HEAD = "feature/x";
const OWNER_SHA = "a".repeat(40);

/** 25 PRs for one head, newest first; only the 21st is open. */
const prs = Array.from({ length: 25 }, (_, index) => ({
  number: 100 - index,
  open: index === 20,
}));

test("Given 25 GitHub PRs for a head where the open one is the 21st, When findPr runs, Then it pages and finds it", () => {
  const runner = replayRunner({
    "graphql find": (call) => {
      const start = call.vars.after ? Number(call.vars.after) : 0;
      const page = prs.slice(start, start + 20);
      const end = start + page.length;
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: end < prs.length, endCursor: String(end) },
              nodes: page.map((pr) => ({
                number: pr.number,
                url: `https://github.com/o/r/pull/${pr.number}`,
                state: pr.open ? "OPEN" : "CLOSED",
                baseRefName: "main",
                headRefName: HEAD,
                headRefOid: OWNER_SHA,
                headRepositoryOwner: { login: "o" },
              })),
            },
          },
        },
      });
    },
  });
  const forge = createGitHubForge({ apiHost: "github.com", repo: "o/r", runner });
  const found = forge.findPr(HEAD, { owner: "o", projectId: null, sha: null });
  expect(found).toMatchObject({ ok: true, data: { number: 80, state: "open" } });
  expect(runner.calls.map((call) => call.vars.after ?? null)).toEqual([null, "20"]);
});

test("Given 25 GitLab MRs for a head where the open one is the 21st, When findPr runs, Then it pages and finds it", () => {
  const endpoint = `projects/g%2Fr/merge_requests?source_branch=feature%2Fx&order_by=created_at&sort=desc&per_page=20`;
  const mr = (pr: (typeof prs)[number]) => ({
    iid: pr.number,
    web_url: `https://gitlab.com/g/r/-/merge_requests/${pr.number}`,
    state: pr.open ? "opened" : "closed",
    target_branch: "main",
    source_branch: HEAD,
    source_project_id: 7,
    sha: OWNER_SHA,
  });
  const runner = replayRunner({
    [`GET ${endpoint}`]: JSON.stringify(prs.slice(0, 20).map(mr)),
    [`GET ${endpoint}&page=2`]: JSON.stringify(prs.slice(20).map(mr)),
  });
  const forge = createGitLabForge({ apiHost: "gitlab.com", repo: "g/r", runner });
  const found = forge.findPr(HEAD, { owner: null, projectId: 7, sha: null });
  expect(found).toMatchObject({ ok: true, data: { number: 80, state: "open" } });
  expect(runner.calls).toHaveLength(2);
});

test("Given a GitLab head with fewer MRs than a page, When findPr runs, Then it reads one page only", () => {
  const endpoint = `projects/g%2Fr/merge_requests?source_branch=feature%2Fx&order_by=created_at&sort=desc&per_page=20`;
  const runner = replayRunner({ [`GET ${endpoint}`]: "[]" });
  const forge = createGitLabForge({ apiHost: "gitlab.com", repo: "g/r", runner });
  expect(forge.findPr(HEAD, { owner: null, projectId: 7, sha: null })).toEqual({
    ok: true,
    data: null,
  });
  expect(runner.calls).toHaveLength(1);
});
