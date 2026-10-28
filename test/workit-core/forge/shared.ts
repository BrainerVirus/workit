import { afterAll, afterEach, beforeAll, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prStatusReport, type PrStatusDoc } from "@/packages/workit-core/src/forge/report";
import { resolveForge, type ResolvedForge } from "@/packages/workit-core/src/forge/resolve";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// Shared by the S10 forge suites: forge adapters behind one interface,
// replayed from recorded gh/glab API fixtures. No test reaches the network.

/**
 * Registers the suite's hooks (temp config dir, repo cleanup) in the calling
 * test file and returns the helpers that depend on them.
 */
export function useForgeHarness(): {
  configDir: () => string;
  repoFor: (kind: "github" | "gitlab") => ForgeRepo;
} {
  // Each test builds git repos and fetches from a local bare remote; Windows
  // runners need well over the 5 s default.
  setDefaultTimeout(60_000);

  let configDir = "";
  const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const previousVcs = process.env.WORKFLOW_VCS_CONFIG;
  beforeAll(() => {
    configDir = mkdtempSync(path.join(os.tmpdir(), "wk-forge-config-"));
    process.env.WORKFLOW_TOOLKIT_CONFIG = configDir;
    delete process.env.WORKFLOW_VCS_CONFIG;
  });
  afterAll(() => {
    if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
    if (previousVcs !== undefined) process.env.WORKFLOW_VCS_CONFIG = previousVcs;
    rmSync(configDir, { recursive: true, force: true });
  });

  const repos: ForgeRepo[] = [];
  afterEach(() => {
    rmSync(path.join(configDir, "workspaces.json"), { force: true });
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  const repoFor = (kind: "github" | "gitlab"): ForgeRepo => {
    const repo = makeForgeRepo(kind);
    repos.push(repo);
    return repo;
  };
  return { configDir: () => configDir, repoFor };
}

export const GH_STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';
export const GL = "projects/group%2Fproject";
export const GL_PIPE = "projects/34675721/pipelines/2909499411";

export const githubRoutes = (pr = "github/pr-failing-thread.json"): Record<string, Reply> => ({
  "GET user": fixture("github/user.json"),
  "GET repos/o/r": fixture("github/repo.json"),
  "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
  "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
  "graphql find": fixture("github/find-pr.json"),
  [GH_STATUS]: fixture(pr),
  "GET repos/o/r/actions/jobs/102/logs": fixture("github/job-log.txt"),
  "POST repos/o/r/actions/runs/1/rerun-failed-jobs": "",
  "POST repos/o/r/actions/jobs/102/rerun": "",
});

export const gitlabMr = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ...JSON.parse(fixture("gitlab/mr-failing-thread.json")),
    ...overrides,
  });

export const gitlabRoutes = (mr: string = gitlabMr()): Record<string, Reply> => ({
  "GET user": fixture("gitlab/user.json"),
  [`GET ${GL}`]: fixture("gitlab/project.json"),
  [`GET ${GL}/repository/branches/main`]: fixture("gitlab/branch-main.json"),
  [`GET ${GL_PIPE}/bridges?per_page=100&page=1`]: fixture("gitlab/bridges.json"),
  [`GET ${GL}/merge_requests?source_branch=feature%2Fx&order_by=created_at&sort=desc&per_page=20`]:
    fixture("gitlab/find-mr.json"),
  [`GET ${GL}/merge_requests/12`]: mr,
  [`GET ${GL_PIPE}/jobs?per_page=100&page=1`]: fixture("gitlab/jobs.json"),
  [`GET ${GL}/merge_requests/12/discussions?per_page=100&page=1`]:
    fixture("gitlab/discussions.json"),
  "GET projects/34675721/jobs/16914440402/trace": fixture("gitlab/job-trace.txt"),
  [`POST ${GL_PIPE}/retry`]: "{}",
  "POST projects/34675721/jobs/16914440402/retry": "{}",
});

export const connect = (
  repo: ForgeRepo,
  routes: Record<string, Reply>,
): {
  resolved: ResolvedForge;
  calls: ReturnType<typeof replayRunner>["calls"];
} => {
  const runner = replayRunner(routes, repo.subs);
  const resolved = resolveForge(repo.cwd, { runner });
  if (!resolved.ok) throw new Error(resolved.error);
  return { resolved: resolved.data, calls: runner.calls };
};

export const statusOf = (
  repo: ForgeRepo,
  routes: Record<string, Reply>,
  pr?: number,
): PrStatusDoc => {
  const { resolved } = connect(repo, routes);
  const report = prStatusReport(repo.cwd, resolved, { pr });
  if (!report.ok) throw new Error(report.error);
  return report.data.doc;
};

/** Value types, recursively; arrays by their first element. */
export const shape = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, shape(item)]),
    );
  return value === null ? "null" : typeof value;
};
