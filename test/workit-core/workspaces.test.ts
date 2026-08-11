import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initStatus } from "../../packages/workit-core/src/core/init";
import {
  matchWorkspace,
  readWorkspacesResult,
  resolveWorkspace,
  validateWorkspaceGlob,
  workspacesPath,
  type WorkspaceConfig,
} from "../../packages/workit-core/src/core/workspaces";
import { withIsolatedConfig } from "../shared/helpers/env";

const WORKSPACES = {
  workspaces: [
    {
      name: "work",
      glob: "/home/*/Documents/projects/work/**",
      vcs: { provider: "gitlab", defaultTargetBranch: "develop" },
      youtrack: { link_issues: true },
    },
    {
      name: "personal",
      glob: "/home/*/Documents/projects/personal/**",
      vcs: { provider: "github" },
      issues: { provider: "github", link_on_pr: true },
    },
  ],
} satisfies { workspaces: WorkspaceConfig[] };

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
    expect(
      resolveWorkspace("/home/u/Documents/projects/work/sixbell/repo/deep/nested/path")?.name,
    ).toBe("work");
  });
});

test("resolveWorkspace returns the first declared match (first-wins)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-first-"));
  writeWorkspaces(
    dir,
    JSON.stringify({
      workspaces: [
        { name: "first", glob: "/home/*/Documents/**" },
        { name: "second", glob: "/home/*/Documents/projects/**" },
      ],
    }),
  );
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
  writeWorkspaces(
    dir,
    JSON.stringify({
      workspaces: [
        { name: "work", glob: "/home/*/Documents/projects/work/**" },
        { name: "catchall", glob: "**" },
      ],
    }),
  );
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
  writeWorkspaces(
    dir,
    JSON.stringify({
      workspaces: [
        { name: "mid", glob: "/home/*/work/**/repo" },
        { name: "lead", glob: "**/repo" },
      ],
    }),
  );
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("/home/u/work/repo")?.name).toBe("mid");
    expect(resolveWorkspace("/home/u/work/a/b/repo")?.name).toBe("mid");
    expect(resolveWorkspace("/repo")?.name).toBe("lead");
  });
});

test("trailing ** matches the bare parent root and deep paths", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-trailing-"));
  writeWorkspaces(
    dir,
    JSON.stringify({
      workspaces: [{ name: "bare", glob: "/x/y/**" }],
    }),
  );
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("/x/y")?.name).toBe("bare");
    expect(resolveWorkspace("/x/y/deep/path")?.name).toBe("bare");
    expect(resolveWorkspace("/x/y/")?.name).toBe("bare");
  });
});

test("catchall ** matches drive-letter and posix paths (Windows CI regression)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-catchall-"));
  writeWorkspaces(
    dir,
    JSON.stringify({
      workspaces: [{ name: "catchall", glob: "**" }],
    }),
  );
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("D:/a/workflow-toolkit/workflow-toolkit")?.name).toBe("catchall");
    expect(resolveWorkspace("D:\\a\\workflow-toolkit\\workflow-toolkit")?.name).toBe("catchall");
    expect(resolveWorkspace("/home/u/anything")?.name).toBe("catchall");
    expect(resolveWorkspace("/home/u/anything/deep/nested")?.name).toBe("catchall");
  });
});

test("native Windows separators in workspace globs match normalized paths", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-windows-glob-"));
  writeWorkspaces(
    dir,
    JSON.stringify({
      workspaces: [{ name: "windows", glob: "D:\\a\\workflow-toolkit\\**" }],
    }),
  );
  withIsolatedConfig(dir, () => {
    expect(resolveWorkspace("D:/a/workflow-toolkit/repo")?.name).toBe("windows");
  });
});

test("resolveWorkspace skips non-object entries in the workspaces array", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-junk-"));
  writeWorkspaces(
    dir,
    JSON.stringify({
      workspaces: ["x", 42, true, null, { name: "ok", glob: "**" }],
    }),
  );
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

test("RL-08: validateWorkspaceGlob enforces the supported matcher grammar", () => {
  for (const good of ["/home/*/work/**", "**", "**/repo", "D:\\a\\repo\\**", "/x/y/**"]) {
    expect(validateWorkspaceGlob(good).ok).toBe(true);
  }
  for (const bad of [
    "[abc]",
    "/home/*/[abc]/**",
    "/home/*/?",
    "/home/*/{a,b}/**",
    "{a,b}/**",
    "**/[x]",
  ]) {
    const r = validateWorkspaceGlob(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unsupported");
  }
  expect(validateWorkspaceGlob("").ok).toBe(false);
  expect(validateWorkspaceGlob("   ").ok).toBe(false);
});

test("RL-08: the unsupported-glob matcher rejects unsupported grammar (write-time parity)", () => {
  // Task 15 advisory: unsupported patterns were accepted and shown as "no
  // match". The matcher grammar and write-time validation must agree.
  for (const bad of ["/home/*/[abc]/**", "/home/*/x?/**", "/home/*/{a,b}/**", "**/[ab]/**"]) {
    expect(matchWorkspace(bad, "/home/u/work/repo")).toBe(false);
  }
});

test("RL-01: readWorkspacesResult distinguishes missing, valid, and malformed with exact paths", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-result-"));
  try {
    withIsolatedConfig(dir, () => {
      expect(readWorkspacesResult().status).toBe("missing");
      expect(readWorkspacesResult().path).toBe(path.join(dir, "workspaces.json"));

      writeWorkspaces(dir, JSON.stringify(WORKSPACES, null, 2));
      const valid = readWorkspacesResult();
      expect(valid.status).toBe("valid");
      expect(valid.entries).toHaveLength(2);
      expect(valid.error).toBeUndefined();

      writeWorkspaces(dir, "{ nope !!");
      const malformed = readWorkspacesResult();
      expect(malformed.status).toBe("malformed");
      expect(malformed.path).toBe(path.join(dir, "workspaces.json"));
      expect(malformed.error).toContain(path.join(dir, "workspaces.json"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
