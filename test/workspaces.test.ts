import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initStatus } from "../packages/workit-core/src/core/init";
import { resolveWorkspace, workspacesPath, type WorkspaceConfig } from "../packages/workit-core/src/core/workspaces";

const WORKSPACES = {
  workspaces: [
    { name: "work", glob: "/home/*/Documents/projects/work/**", vcs: { provider: "gitlab", defaultTargetBranch: "develop" }, youtrack: { link_issues: true } },
    { name: "personal", glob: "/home/*/Documents/projects/personal/**", vcs: { provider: "github" }, issues: { provider: "github", link_on_pr: true } },
  ],
} satisfies { workspaces: WorkspaceConfig[] };

const withIsolatedConfig = (dir: string, fn: () => void) => {
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};

const writeWorkspaces = (dir: string, content: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "workspaces.json"), content, "utf8");
};

test("resolveWorkspace matches work and personal globs, deep paths included", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-basic-"));
  writeWorkspaces(dir, JSON.stringify(WORKSPACES, null, 2));
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("/home/u/Documents/projects/work/sixbell/repo")?.name).toBe("work");
    expect(resolveWorkspace("/home/u/Documents/projects/personal/some-app")?.name).toBe("personal");
    expect(resolveWorkspace("/home/u/Documents/projects/work/sixbell/repo/deep/nested/path")?.name).toBe("work");
  });
});

test("resolveWorkspace returns the first declared match (first-wins)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-first-"));
  writeWorkspaces(dir, JSON.stringify({
    workspaces: [
      { name: "first", glob: "/home/*/Documents/**" },
      { name: "second", glob: "/home/*/Documents/projects/**" },
    ],
  }));
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("/home/u/Documents/projects/work/x")?.name).toBe("first");
  });
});

test("resolveWorkspace returns null with no matching workspace", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-nomatch-"));
  writeWorkspaces(dir, JSON.stringify(WORKSPACES, null, 2));
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("/home/u/elsewhere")).toBeNull();
  });
});

test("resolveWorkspace returns null without throwing when workspaces.json is missing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-missing-"));
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("/home/u/Documents/projects/work/x")).toBeNull();
  });
});

test("resolveWorkspace returns null without throwing on malformed JSON", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-malformed-"));
  writeWorkspaces(dir, "{ not json !!");
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("/home/u/Documents/projects/work/x")).toBeNull();
  });
});

test("matched workspace carries vcs.provider, vcs.defaultTargetBranch, youtrack.link_issues", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-fields-"));
  writeWorkspaces(dir, JSON.stringify(WORKSPACES, null, 2));
  withIsolatedConfig(dir, () => {
    const ws = resolveWorkspace("/home/u/Documents/projects/work/sixbell/repo");
    expect(ws).not.toBeNull();
    expect(ws?.vcs?.provider).toBe("gitlab");
    expect(ws?.vcs?.defaultTargetBranch).toBe("develop");
    expect(ws?.youtrack?.link_issues).toBe(true);
    const personal = resolveWorkspace("/home/u/Documents/projects/personal/app");
    expect(personal?.vcs?.provider).toBe("github");
    expect(personal?.vcs?.defaultTargetBranch).toBeUndefined();
    expect(personal?.issues?.provider).toBe("github");
    expect(personal?.issues?.link_on_pr).toBe(true);
  });
});

test("initStatus reports workspaces.resolved and path for the temp config", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-status-"));
  writeWorkspaces(dir, JSON.stringify({
    workspaces: [
      { name: "work", glob: "/home/*/Documents/projects/work/**" },
      { name: "catchall", glob: "**" },
    ],
  }));
  withIsolatedConfig(dir, () => {
    const status = initStatus();
    expect(status.error).toBeUndefined();
    expect(status.workspaces.path).toBe(path.join(dir, "workspaces.json"));
    expect(status.workspaces.resolved?.name).toBe("catchall");
  });
});

test("resolveWorkspace returns null without throwing when workspaces.json is literal null", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-null-"));
  writeWorkspaces(dir, "null");
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("/home/u/Documents/projects/work/x")).toBeNull();
  });
});

test("initStatus survives a literal null workspaces.json", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-status-null-"));
  writeWorkspaces(dir, "null");
  withIsolatedConfig(dir, () => {
    const status = initStatus();
    expect(status.error).toBeUndefined();
    expect(status.workspaces.resolved).toBeNull();
  });
});

test("globstar **/ matches zero or more segments mid-pattern and leading", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-globstar-"));
  writeWorkspaces(dir, JSON.stringify({
    workspaces: [
      { name: "mid", glob: "/home/*/work/**/repo" },
      { name: "lead", glob: "**/repo" },
    ],
  }));
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("/home/u/work/repo")?.name).toBe("mid");
    expect(resolveWorkspace("/home/u/work/a/b/repo")?.name).toBe("mid");
    expect(resolveWorkspace("/repo")?.name).toBe("lead");
  });
});

test("trailing ** matches the bare parent root and deep paths", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-trailing-"));
  writeWorkspaces(dir, JSON.stringify({
    workspaces: [
      { name: "bare", glob: "/x/y/**" },
    ],
  }));
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("/x/y")?.name).toBe("bare");
    expect(resolveWorkspace("/x/y/deep/path")?.name).toBe("bare");
    expect(resolveWorkspace("/x/y/")?.name).toBe("bare");
  });
});

test("catchall ** matches drive-letter and posix paths (Windows CI regression)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-catchall-"));
  writeWorkspaces(dir, JSON.stringify({
    workspaces: [
      { name: "catchall", glob: "**" },
    ],
  }));
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("D:/a/workflow-toolkit/workflow-toolkit")?.name).toBe("catchall");
    expect(resolveWorkspace("D:\\a\\workflow-toolkit\\workflow-toolkit")?.name).toBe("catchall");
    expect(resolveWorkspace("/home/u/anything")?.name).toBe("catchall");
    expect(resolveWorkspace("/home/u/anything/deep/nested")?.name).toBe("catchall");
  });
});

test("resolveWorkspace skips non-object entries in the workspaces array", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-junk-"));
  writeWorkspaces(dir, JSON.stringify({
    workspaces: ["x", 42, true, null, { name: "ok", glob: "**" }],
  }));
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("/home/u/anything")?.name).toBe("ok");
  });
});

test("workspacesPath follows the configDir env chain", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-path-"));
  withIsolatedConfig(dir, () => {
    expect(workspacesPath()).toBe(path.join(dir, "workspaces.json"));
  });
});
