import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vcsConfig } from "@/packages/workit-core/src/core/vcs-config";

// Workspace-tight tokens: a workspace vcs.tokenFile wins over the global
// provider tokenFile so per-area accounts never collide; empty falls back.
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

test("workspace vcs.tokenFile wins over the global provider tokenFile", () => {
  const t = setup();
  try {
    t.writeAll(
      { provider: "github", tokenFile: path.join(t.cfgDir, "work.token") },
      path.join(t.cfgDir, "github.token"),
    );
    const loaded = vcsConfig("load", t.repo);
    expect(loaded.ok).toBe(true);
    expect(loaded.tokenPath).toBe(path.join(t.cfgDir, "work.token"));
    expect(loaded.workspace_name).toBe("area");
  } finally {
    t.cleanup();
  }
});

test("missing or empty workspace tokenFile falls back to global then default", () => {
  const t = setup();
  try {
    t.writeAll({ provider: "github" }, path.join(t.cfgDir, "github.token"));
    expect(vcsConfig("load", t.repo).tokenPath).toBe(path.join(t.cfgDir, "github.token"));
    t.writeAll({ provider: "github", tokenFile: "   " }, path.join(t.cfgDir, "github.token"));
    expect(vcsConfig("load", t.repo).tokenPath).toBe(path.join(t.cfgDir, "github.token"));
    t.writeAll({ provider: "github" });
    expect(vcsConfig("load", t.repo).tokenPath).toBe(path.join(t.cfgDir, "github.token"));
  } finally {
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
