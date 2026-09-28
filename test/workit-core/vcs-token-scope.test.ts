import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergedPrStyle, vcsConfig } from "@/packages/workit-core/src/core/vcs-config";
import { initStatusData } from "@/packages/workit-core/src/core/init";

// Legacy tokenFile entries are tolerated during migration but never read.
const setup = () => {
  const cfgDir = mkdtempSync(path.join(tmpdir(), "wk-vctok-cfg-"));
  const repo = mkdtempSync(path.join(tmpdir(), "wk-vctok-repo-"));
  const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG = cfgDir;
  const writeAll = (wsVcs: Record<string, unknown>, globalTokenFile?: string) => {
    writeFileSync(
      path.join(cfgDir, "vcs.json"),
      JSON.stringify({
        provider: "github",
        github: globalTokenFile
          ? { host: "github.com", tokenFile: globalTokenFile }
          : { host: "github.com" },
      }),
    );
    writeFileSync(
      path.join(cfgDir, "workspaces.json"),
      JSON.stringify({ workspaces: [{ name: "area", glob: `${repo}/**`, vcs: wsVcs }] }),
    );
  };
  return {
    cfgDir,
    repo,
    writeAll,
    cleanup: () => {
      if (prevConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      else process.env.WORKFLOW_TOOLKIT_CONFIG = prevConfig;
      rmSync(cfgDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
};

test("legacy workspace and global token files are ignored", () => {
  const t = setup();
  try {
    t.writeAll(
      { provider: "github", tokenFile: path.join(t.cfgDir, "work.token") },
      path.join(t.cfgDir, "github.token"),
    );
    const loaded = vcsConfig("load", t.repo);
    expect(loaded.ok).toBe(true);
    expect(loaded.tokenPath).toBeUndefined();
    expect(loaded.workspace_name).toBe("area");
  } finally {
    t.cleanup();
  }
});

test("provider resolution does not require a token file", () => {
  const t = setup();
  try {
    t.writeAll({ provider: "github" }, path.join(t.cfgDir, "github.token"));
    expect(vcsConfig("load", t.repo).ok).toBe(true);
    t.writeAll({ provider: "github", tokenFile: "   " }, path.join(t.cfgDir, "github.token"));
    expect(vcsConfig("load", t.repo).tokenPath).toBeUndefined();
    t.writeAll({ provider: "github" });
    expect(vcsConfig("load", t.repo).ok).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("init status reports the effective workspace provider, not a global sibling provider", () => {
  const t = setup();
  const previousRoot = process.env.WORKFLOW_WORKSPACE_ROOT;
  try {
    t.writeAll({ provider: "gitlab" }); // global vcs.json still says github
    process.env.WORKFLOW_WORKSPACE_ROOT = t.repo;
    expect(initStatusData(t.cfgDir).vcs_config.provider).toBe("gitlab");
  } finally {
    if (previousRoot === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = previousRoot;
    t.cleanup();
  }
});

test("unresolvable provider is explicit: resolve reports null, load fails closed", () => {
  const cfgDir = mkdtempSync(path.join(tmpdir(), "wk-vcnoprov-cfg-"));
  const repo = mkdtempSync(path.join(tmpdir(), "wk-vcnoprov-repo-"));
  const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG = cfgDir;
  try {
    writeFileSync(path.join(cfgDir, "vcs.json"), JSON.stringify({ pr: {} }));
    writeFileSync(path.join(cfgDir, "workspaces.json"), JSON.stringify({ workspaces: [] }));
    const resolved = vcsConfig("resolve", repo);
    expect(resolved.ok).toBe(true);
    expect(resolved.provider).toBe(null);
    // Branch policy still resolves from the preset without a provider.
    expect(typeof resolved.defaultTargetBranch).toBe("string");
    const loaded = vcsConfig("load", repo);
    expect(loaded.ok).toBe(false);
    expect(String(loaded.error)).toContain("no vcs provider");
  } finally {
    if (prevConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prevConfig;
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("merged PR style reads the configured push host and full GitLab subgroup path", () => {
  const t = setup();
  const tools = mkdtempSync(path.join(tmpdir(), "wk-vcs-style-tools-"));
  const previousPath = process.env.PATH;
  const previousVcs = process.env.WORKFLOW_VCS_CONFIG;
  const log = path.join(tools, "glab.log");
  try {
    spawnSync("git", ["init", "-q"], { cwd: t.repo });
    spawnSync("git", ["remote", "add", "origin", "https://gitlab.com/old/repo.git"], {
      cwd: t.repo,
    });
    spawnSync(
      "git",
      ["remote", "set-url", "--push", "origin", "https://gitlab.example.test/group/sub/repo.git"],
      { cwd: t.repo },
    );
    writeFileSync(
      path.join(t.cfgDir, "vcs.json"),
      JSON.stringify({ provider: "gitlab", gitlab: { host: "gitlab.example.test" } }),
    );
    writeFileSync(
      path.join(tools, "glab"),
      `#!/bin/sh\nprintf '%s|%s\\n' "$GITLAB_HOST" "$*" >> "${log}"\necho '[{"title":"T","description":"## Notes body","web_url":"https://gitlab.example.test/group/sub/repo/-/merge_requests/2","squash":true}]'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
    process.env.WORKFLOW_VCS_CONFIG = path.join(t.cfgDir, "vcs.json");
    const result = mergedPrStyle(6, t.repo);
    expect(result.ok).toBe(true);
    expect(readFileSync(log, "utf8")).toContain(
      "gitlab.example.test|api projects/group%2Fsub%2Frepo/merge_requests",
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousVcs === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previousVcs;
    t.cleanup();
    rmSync(tools, { recursive: true, force: true });
  }
});

test("GitLab style lookup does not fall back to account-wide merge requests", () => {
  const t = setup();
  const tools = mkdtempSync(path.join(tmpdir(), "wk-vcs-style-scope-tools-"));
  const previousPath = process.env.PATH;
  const previousVcs = process.env.WORKFLOW_VCS_CONFIG;
  const log = path.join(tools, "glab.log");
  try {
    spawnSync("git", ["init", "-q"], { cwd: t.repo });
    spawnSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.example.test/group/sub/repo.git"],
      {
        cwd: t.repo,
      },
    );
    writeFileSync(
      path.join(t.cfgDir, "vcs.json"),
      JSON.stringify({ provider: "gitlab", gitlab: { host: "gitlab.example.test" } }),
    );
    writeFileSync(
      path.join(tools, "glab"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\necho unavailable >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(tools, "glab.cmd"),
      `@echo off\r\n>>"${log}" echo %*\r\necho unavailable 1>&2\r\nexit /b 1\r\n`,
    );
    process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
    process.env.WORKFLOW_VCS_CONFIG = path.join(t.cfgDir, "vcs.json");
    expect(mergedPrStyle(6, t.repo)).toMatchObject({
      ok: false,
      error: "could not list merge requests",
    });
    expect(readFileSync(log, "utf8").trim().split(/\r?\n/u)).toEqual([
      "api projects/group%2Fsub%2Frepo/merge_requests?state=merged&per_page=6&order_by=updated_at&sort=desc",
    ]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousVcs === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previousVcs;
    t.cleanup();
    rmSync(tools, { recursive: true, force: true });
  }
});
