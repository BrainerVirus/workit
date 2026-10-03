import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  matchWorkspace,
  readWorkspacesResult,
  resolveWorkspace,
  resolveWorkspacePolicy,
  resolveRuntimeWorkspacePolicy,
  resolveRuntimeWorkspaceVcs,
  selectReleaseTrack,
  validateWorkspaceGlob,
  workspacesPath,
  type WorkspaceConfig,
} from "@/packages/workit-core/src/core/workspaces";
import { readConfigFromDir } from "@/packages/workit-core/src/core/config";
import {
  resolveBranchPolicyFor,
  resolveCommitPolicyFor,
} from "@/packages/workit-core/src/core/branch";
import { vcsConfig } from "@/packages/workit-core/src/core/vcs-config";
import { withIsolatedConfig } from "@/test/shared/helpers/env";

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

test("more-specific workspace globs override broad matches", () => {
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
    expect(resolveWorkspace("/home/u/Documents/projects/work/x")?.name).toBe("second");
    expect(resolveWorkspace("/home/u/Documents/projects/work/x", "first")?.name).toBe("first");
    expect(resolveWorkspace("/home/u/Documents/projects/work/x", "second")?.name).toBe("second");
    expect(() => resolveWorkspace("/home/u/Documents/projects/work/x", "missing")).toThrow(
      /matching choices: first, second/,
    );
  });
});

test("equally-specific overlapping workspace globs require an explicit name", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-tie-"));
  writeWorkspaces(
    dir,
    JSON.stringify({
      workspaces: [
        { name: "first", glob: "/home/*/Documents/projects/**" },
        { name: "second", glob: "/home/*/Documents/projects/**" },
      ],
    }),
  );
  withIsolatedConfig(dir, () => {
    expect(() => resolveWorkspace("/home/u/Documents/projects/work/x")).toThrow(
      /ambiguous workspace.*first, second/,
    );
    expect(resolveWorkspace("/home/u/Documents/projects/work/x", "second")?.name).toBe("second");
  });
});

test("runtime VCS and branch policy resolution use the most-specific workspace", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-specific-"));
  const cwd = "/home/u/Documents/projects/work/sixbell/productos/ri/web";
  writeWorkspaces(
    dir,
    JSON.stringify({
      workspaces: [
        {
          name: "work",
          glob: "/home/*/Documents/projects/work/**",
          vcs: { provider: "gitlab", defaultTargetBranch: "develop" },
          branchPolicy: { preset: "gitflow" },
        },
        {
          name: "github-web",
          glob: "/home/*/Documents/projects/work/sixbell/productos/ri/web/**",
          vcs: { provider: "github", defaultTargetBranch: "nun-develop" },
          branchPolicy: { preset: "github-flow" },
        },
      ],
    }),
  );
  withIsolatedConfig(dir, () => {
    expect(resolveRuntimeWorkspaceVcs(cwd)).toMatchObject({
      name: "github-web",
      vcs: { provider: "github", defaultTargetBranch: "nun-develop" },
    });
    expect(resolveRuntimeWorkspacePolicy(cwd, "branch")).toMatchObject({
      source: "workspace:github-web",
      policy: { preset: "github-flow" },
    });
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

test("resolveWorkspace fails with the config path on malformed JSON", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-malformed-"));
  writeWorkspaces(dir, "{ not json !!");
  withIsolatedConfig(dir, () => {
    expect(() => resolveWorkspace("/home/u/Documents/projects/work/x")).toThrow(
      /workspaces\.json is not valid JSON/,
    );
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

test("YouTrack settings are valid with either hosting provider while GitHub Issues stay host-bound", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-tracker-hosts-"));
  try {
    writeWorkspaces(
      dir,
      JSON.stringify({
        workspaces: [
          {
            name: "github-youtrack",
            glob: "/home/*/github/**",
            vcs: { provider: "github" },
            youtrack: { link_issues: true, baseUrl: "https://yt.example.test" },
          },
          {
            name: "gitlab-youtrack",
            glob: "/home/*/gitlab/**",
            vcs: { provider: "gitlab" },
            youtrack: { link_issues: true, baseUrl: "https://yt.example.test" },
          },
        ],
      }),
    );
    withIsolatedConfig(dir, () => expect(readWorkspacesResult().status).toBe("valid"));

    writeWorkspaces(
      dir,
      JSON.stringify({
        workspaces: [
          {
            name: "gitlab-github-issues",
            glob: "/home/*/gitlab/**",
            vcs: { provider: "gitlab" },
            issues: { provider: "github", link_on_pr: true },
          },
        ],
      }),
    );
    withIsolatedConfig(dir, () => {
      expect(readWorkspacesResult().status).toBe("invalid");
      expect(readWorkspacesResult().error).toContain(
        "GitHub issue linking requires the github provider",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CA-01: resolveWorkspace maps work/personal globs to vcs + branchPolicy presets", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-ca01-"));
  const cfg = {
    workspaces: [
      {
        name: "work",
        glob: "/home/*/Documents/projects/work/**",
        vcs: { provider: "gitlab", defaultTargetBranch: "develop" },
        youtrack: { link_issues: true },
        branchPolicy: { preset: "gitflow" },
      },
      {
        name: "personal",
        glob: "/home/*/Documents/projects/personal/**",
        vcs: { provider: "github", defaultTargetBranch: "main" },
        issues: { provider: "github", link_on_pr: true },
        branchPolicy: { preset: "github-flow" },
      },
    ],
  };
  writeWorkspaces(dir, JSON.stringify(cfg, null, 2));
  withIsolatedConfig(dir, () => {
    const work = resolveWorkspace("/home/u/Documents/projects/work/sixbell/repo");
    expect(work?.name).toBe("work");
    expect(work?.vcs?.provider).toBe("gitlab");
    expect(work?.vcs?.defaultTargetBranch).toBe("develop");
    expect(work?.branchPolicy?.preset).toBe("gitflow");
    const personal = resolveWorkspace("/home/u/Documents/projects/personal/some-app");
    expect(personal?.name).toBe("personal");
    expect(personal?.vcs?.provider).toBe("github");
    expect(personal?.vcs?.defaultTargetBranch).toBe("main");
    expect(personal?.branchPolicy?.preset).toBe("github-flow");
    expect(personal?.issues?.link_on_pr).toBe(true);
  });
});

test("resolveWorkspace reports equal-specificity ambiguity without choosing by file order", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-status-"));
  writeWorkspaces(
    dir,
    JSON.stringify({
      workspaces: [
        { name: "personal", glob: path.join(process.cwd(), "**") },
        { name: "catchall", glob: path.join(process.cwd(), "**") },
      ],
    }),
  );
  withIsolatedConfig(dir, () => {
    expect(() => resolveWorkspace(process.cwd())).toThrow(/ambiguous workspace/);
  });
});

test("resolveWorkspace fails closed when workspaces.json is literal null", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-null-"));
  writeWorkspaces(dir, "null");
  withIsolatedConfig(dir, () => {
    expect(() => resolveWorkspace("/home/u/Documents/projects/work/x")).toThrow(
      /workspaces\.json is not a JSON object/,
    );
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
    expect(resolveWorkspace("/home/u/work/repo", "mid")?.name).toBe("mid");
    expect(resolveWorkspace("/home/u/work/a/b/repo", "mid")?.name).toBe("mid");
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

test("resolveWorkspace rejects non-object entries in the workspaces array", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-junk-"));
  writeWorkspaces(
    dir,
    JSON.stringify({
      workspaces: ["x", 42, true, null, { name: "ok", glob: "**" }],
    }),
  );
  withIsolatedConfig(dir, () => {
    expect(readWorkspacesResult().status).toBe("invalid");
    expect(() => resolveWorkspace("/home/u/anything")).toThrow(/invalid workspace configuration/);
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
    "!**",
    "!/home/*/work/**",
    "/home/*/@(a|b)/**",
    "/home/*/+(a|b)/**",
    "/home/*/foo*(bar)/**",
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

test("readWorkspacesResult validates typed entries and keeps unrelated JSON metadata", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-result-"));
  try {
    withIsolatedConfig(dir, () => {
      expect(readWorkspacesResult().status).toBe("missing");
      expect(readWorkspacesResult().path).toBe(path.join(dir, "workspaces.json"));

      writeWorkspaces(dir, JSON.stringify({ ...WORKSPACES, unrelated: { keep: true } }, null, 2));
      const valid = readWorkspacesResult();
      expect(valid.status).toBe("valid");
      expect(valid.entries).toHaveLength(2);
      expect(valid.error).toBeUndefined();
      expect(valid.document?.unrelated).toEqual({ keep: true });

      writeWorkspaces(
        dir,
        JSON.stringify({ workspaces: [{ name: "bad", glob: "**", vcs: { provider: "unknown" } }] }),
      );
      const invalid = readWorkspacesResult();
      expect(invalid.status).toBe("invalid");
      expect(invalid.error).toContain("vcs.provider");

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

test("workspace policy layers user defaults, matched workspace, and selected profile", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-policy-"));
  try {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        branchPolicy: { preset: "trunk-based" },
        commitPolicy: { preset: "freeform" },
      }),
    );
    writeWorkspaces(
      dir,
      JSON.stringify({
        workspaces: [
          {
            name: "personal",
            glob: "/home/*/personal/**",
            branchPolicy: { preset: "gitflow", integration: "merge" },
            commitPolicy: { preset: "conventional" },
            defaultProfile: "modern",
            profiles: {
              modern: {
                branchPolicy: { preset: "github-flow", integration: "pr" },
              },
            },
          },
        ],
      }),
    );
    withIsolatedConfig(dir, () => {
      const config = readConfigFromDir(dir);
      const workspace = resolveWorkspace("/home/u/personal/app");
      const policy = resolveWorkspacePolicy(config, workspace);
      expect(policy.status).toBe("resolved");
      if (policy.status !== "resolved") return;
      expect(policy.profileName).toBe("modern");
      expect(policy.branchPolicy.preset).toBe("github-flow");
      expect(policy.branchPolicy.integration).toBe("pr");
      expect(policy.commitPolicy.preset).toBe("conventional");
      expect(policy.provenance).toEqual({
        branchPolicy: "profile:modern",
        commitPolicy: "workspace:personal",
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default workspace profile drives the shared branch and commit resolvers", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-runtime-profile-"));
  try {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        branchPolicy: { preset: "trunk-based" },
        commitPolicy: { preset: "freeform" },
      }),
    );
    writeWorkspaces(
      dir,
      JSON.stringify({
        workspaces: [
          {
            name: "personal",
            glob: "/home/*/personal/**",
            branchPolicy: { preset: "gitflow" },
            commitPolicy: { preset: "freeform" },
            defaultProfile: "modern",
            profiles: {
              modern: {
                branchPolicy: { preset: "github-flow" },
                commitPolicy: { preset: "conventional" },
              },
              legacy: { branchPolicy: { preset: "gitflow" } },
            },
          },
        ],
      }),
    );
    withIsolatedConfig(dir, () => {
      expect(resolveBranchPolicyFor("/home/u/personal/app").preset).toBe("github-flow");
      expect(resolveCommitPolicyFor("/home/u/personal/app").preset).toBe("conventional");
      expect(resolveBranchPolicyFor("/home/u/personal/app", "legacy").preset).toBe("gitflow");
      expect(() => resolveBranchPolicyFor("/home/u/personal/app", "missing")).toThrow(
        /has no profile "missing"/,
      );
      const changed = JSON.parse(readFileSync(path.join(dir, "workspaces.json"), "utf8"));
      changed.workspaces[0].defaultProfile = "legacy";
      writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify(changed));
      expect(resolveBranchPolicyFor("/home/u/personal/app").preset).toBe("gitflow");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime policy resolution isolates unrelated invalid workspace settings", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-policy-scope-"));
  const file = path.join(dir, "workspaces.json");
  try {
    const document = {
      workspaces: [
        {
          name: "personal",
          glob: "/home/*/personal/**",
          vcs: { provider: "github" },
          youtrack: { link_issues: true },
          branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
          commitPolicy: { preset: "conventional" },
        },
        {
          name: "unmatched-invalid-policy",
          glob: "/srv/other/**",
          branchPolicy: { preset: "not-a-preset" },
        },
      ],
    };
    writeWorkspaces(dir, JSON.stringify(document));
    withIsolatedConfig(dir, () => {
      expect(readWorkspacesResult().status).toBe("invalid");
      expect(resolveBranchPolicyFor("/home/u/personal/app").preset).toBe("custom");
      expect(resolveCommitPolicyFor("/home/u/personal/app").preset).toBe("conventional");

      const workspace = document.workspaces[0];
      if (!workspace) throw new Error("workspace fixture is missing");
      writeFileSync(
        file,
        JSON.stringify({
          workspaces: [{ ...workspace, commitPolicy: { preset: "not-a-preset" } }],
        }),
      );
      expect(resolveBranchPolicyFor("/home/u/personal/app").preset).toBe("custom");
      expect(() => resolveCommitPolicyFor("/home/u/personal/app")).toThrow(
        /invalid commit policy configuration/,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime VCS resolution ignores invalid unrelated workspace settings", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-vcs-scope-"));
  try {
    writeWorkspaces(
      dir,
      JSON.stringify({
        workspaces: [
          {
            name: "personal",
            glob: "/home/*/personal/**",
            vcs: { provider: "github" },
            youtrack: { link_issues: true, baseUrl: "https://yt.example.test" },
          },
          {
            name: "unmatched-invalid",
            glob: "/srv/other/**",
            vcs: { provider: "github" },
            youtrack: { link_issues: true, baseUrl: "https://yt.example.test" },
            branchPolicy: { preset: "not-a-preset" },
          },
        ],
      }),
    );
    withIsolatedConfig(dir, () => {
      expect(readWorkspacesResult().status).toBe("invalid");
      expect(vcsConfig("resolve", "/home/u/personal/app")).toMatchObject({
        ok: true,
        provider: "github",
        workspace_name: "personal",
        link_issues: true,
        youtrack_base_url: "https://yt.example.test",
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple release tracks require an explicit selection and preserve each track", () => {
  const makeTrack = (
    productionBranch: string,
    integrationBranch: string,
    tagNamespace: string,
  ) => ({
    strategy: "gitflow",
    productionBranch,
    integrationBranch,
    naming: { feature: "feature/", release: "release/", hotfix: "hotfix/" },
    baseBranch: integrationBranch,
    mergeBackBranches: [integrationBranch],
    pullRequestTarget: productionBranch,
    tagNamespace,
    versionSource: { kind: "package-json", path: "package.json", field: "version" },
    requiredChecks: ["build", "test"],
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-tracks-"));
  try {
    writeWorkspaces(
      dir,
      JSON.stringify({
        workspaces: [
          {
            name: "dual-track",
            glob: "/home/*/dual/**",
            releaseTracks: {
              standard: makeTrack("main", "develop", ""),
              nun: makeTrack("nun-main", "nun-develop", "nun/"),
            },
          },
        ],
      }),
    );
    withIsolatedConfig(dir, () => {
      const workspace = resolveWorkspace("/home/u/dual/repo");
      expect(workspace).not.toBeNull();
      const ambiguous = selectReleaseTrack(workspace!);
      expect(ambiguous).toEqual({ status: "choice_required", choices: ["nun", "standard"] });
      const selected = selectReleaseTrack(workspace!, "nun");
      expect(selected.status).toBe("selected");
      if (selected.status !== "selected") return;
      expect(selected.track.productionBranch).toBe("nun-main");
      expect(selected.track.integrationBranch).toBe("nun-develop");
      expect(selected.track.tagNamespace).toBe("nun/");
      expect(selectReleaseTrack(workspace!, "missing").status).toBe("invalid");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
