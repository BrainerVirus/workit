import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectConfigValues,
  loadWorkspaces,
  parseList,
  runProjectSetup,
  scaffoldVcs,
  scaffoldYouTrack,
  shouldWriteWorkspaces,
  TOKEN_PLACEHOLDER,
  validateBaseUrl,
  validateLocale,
  validateTimezone,
  writeWorkspaces,
} from "../src/cli/logic";
import { resolveWorkspace } from "../src/core/workspaces";
import { PRESETS, type ToolkitConfig } from "../src/core/config";

const current: ToolkitConfig = {
  locale: "en",
  localeOptions: ["en", "es-CL"],
  timezone: "America/Santiago",
  branchPolicy: { preset: "gitflow", allowed: [...PRESETS.gitflow.allowed], protected: [...PRESETS.gitflow.protected] },
};

test("validateLocale accepts BCP-47, rejects bad formats", () => {
  expect(validateLocale("en")).toBeNull();
  expect(validateLocale("es-CL")).toBeNull();
  expect(validateLocale("es-CL1")).not.toBeNull();
  expect(validateLocale("en_US")).not.toBeNull();
  expect(validateLocale("")).not.toBeNull();
});

test("validateTimezone accepts known IANA zones, rejects junk when Intl supports it", () => {
  expect(validateTimezone("America/Santiago")).toBeNull();
  expect(validateTimezone("")).not.toBeNull();
  if (typeof Intl.supportedValuesOf === "function") {
    expect(validateTimezone("Mars/Olympus")).not.toBeNull();
  }
});

test("validateBaseUrl requires https", () => {
  expect(validateBaseUrl("https://enghouseamg.youtrack.cloud")).toBeNull();
  expect(validateBaseUrl("http://example.com")).not.toBeNull();
  expect(validateBaseUrl("not a url")).not.toBeNull();
  expect(validateBaseUrl("")).not.toBeNull();
});

test("parseList splits on commas and trims", () => {
  expect(parseList("feature/*, bugfix/* , hotfix/*")).toEqual(["feature/*", "bugfix/*", "hotfix/*"]);
  expect(parseList("")).toEqual([]);
  expect(parseList("  main  ")).toEqual(["main"]);
});

test("collectConfigValues merges with current config", () => {
  const merged = collectConfigValues({ locale: "es-CL", timezone: "Europe/Madrid" }, current);
  expect(merged.locale).toBe("es-CL");
  expect(merged.timezone).toBe("Europe/Madrid");
  expect(merged.branchPolicy).toEqual(current.branchPolicy);
  expect(merged.localeOptions).toEqual(current.localeOptions);
});

test("collectConfigValues applies preset defaults, keeps current for custom", () => {
  const githubFlow = collectConfigValues({ preset: "github-flow" }, current);
  expect(githubFlow.branchPolicy).toEqual({ preset: "github-flow", allowed: ["*"], protected: ["main"] });

  const custom = collectConfigValues({ preset: "custom", allowed: ["feature/*"], protectedNames: ["main"] }, current);
  expect(custom.branchPolicy).toEqual({ preset: "custom", allowed: ["feature/*"], protected: ["main"] });

  const customKeepsCurrent = collectConfigValues({ preset: "custom" }, current);
  expect(customKeepsCurrent.branchPolicy.allowed).toEqual(current.branchPolicy.allowed);
  expect(customKeepsCurrent.branchPolicy.protected).toEqual(current.branchPolicy.protected);
});

test("runProjectSetup creates gitignore + hygiene files, never overwrites", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-cli-logic-"));
  try {
    writeFileSync(path.join(dir, ".gitignore"), "# existing\n", "utf8");
    const result = runProjectSetup(dir, { includeOpenSource: true });
    expect(result.openSource).toBe(true);
    expect(result.created).toContain("docs/*/sdd/");
    expect(result.created).toContain("CHANGELOG.md");
    expect(result.created).toContain("LICENSE");

    const gi = readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(gi).toContain("# existing");
    expect(gi).toContain("docs/*/sdd/");

    const changelog = readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("# Changelog");

    writeFileSync(path.join(dir, "README.md"), "custom readme", "utf8");
    const again = runProjectSetup(dir, { includeOpenSource: true });
    expect(again.created).toEqual([]);
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("custom readme");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runProjectSetup without includeOpenSource skips LICENSE/CONTRIBUTING", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-cli-logic-"));
  try {
    const result = runProjectSetup(dir, { includeOpenSource: false });
    expect(result.created).toContain("CHANGELOG.md");
    expect(result.created).not.toContain("LICENSE");
    expect(existsSync(path.join(dir, "LICENSE"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffoldYouTrack writes youtrack.json + placeholder token + token URL", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-cli-logic-"));
  try {
    const s = scaffoldYouTrack(dir, "https://youtrack.example.com", { locale: "es-CL", timezone: "America/Santiago" });
    expect(s.tokenCreateUrl).toBe("https://youtrack.example.com/users/me?tab=account-security");
    const cfg = JSON.parse(readFileSync(s.youtrackJson, "utf8"));
    expect(cfg.baseUrl).toBe("https://youtrack.example.com");
    expect(cfg.locale).toBe("es-CL");
    expect(cfg.timezone).toBe("America/Santiago");
    expect(readFileSync(s.tokenPath, "utf8").trim()).toBe(TOKEN_PLACEHOLDER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffoldVcs writes vcs.json for provider + active placeholder token", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-cli-logic-"));
  try {
    const s = scaffoldVcs(dir, "github");
    const cfg = JSON.parse(readFileSync(s.vcsJson, "utf8"));
    expect(cfg.provider).toBe("github");
    expect(s.activeTokenPath).toBe(path.join(dir, "github.token"));
    expect(readFileSync(s.activeTokenPath, "utf8").trim()).toBe(TOKEN_PLACEHOLDER);
    expect(s.tokenCreateUrl).toContain("github.com/settings/personal-access-tokens/new");

    const gitlab = scaffoldVcs(dir, "gitlab");
    expect(gitlab.activeTokenPath).toBe(path.join(dir, "gitlab.token"));
    expect(gitlab.tokenCreateUrl).toContain("gitlab.com/-/user_settings/personal_access_tokens");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const withConfigDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-workspaces-"));
  const prev = process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
  try {
    fn(dir);
  } finally {
    process.env.WORKFLOW_TOOLKIT_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
};

const wsFile = (dir: string) => path.join(dir, "workspaces.json");

const entry = (name: string, glob: string) => ({ name, glob, vcs: { provider: "gitlab" as const, defaultTargetBranch: "main" } });

test("loadWorkspaces: missing file → []", () => {
  withConfigDir(() => {
    expect(loadWorkspaces()).toEqual([]);
  });
});

test("loadWorkspaces: malformed JSON → []", () => {
  withConfigDir((dir) => {
    writeFileSync(wsFile(dir), "{ not json", "utf8");
    expect(loadWorkspaces()).toEqual([]);
  });
});

test("loadWorkspaces: non-object or missing array → []", () => {
  withConfigDir((dir) => {
    writeFileSync(wsFile(dir), "[1,2]", "utf8");
    expect(loadWorkspaces()).toEqual([]);
    writeFileSync(wsFile(dir), '{"foo": "bar"}', "utf8");
    expect(loadWorkspaces()).toEqual([]);
  });
});

test("loadWorkspaces: valid file → parsed entries", () => {
  withConfigDir((dir) => {
    writeFileSync(wsFile(dir), JSON.stringify({ workspaces: [entry("work", "/home/**/work/**")] }), "utf8");
    expect(loadWorkspaces()).toEqual([entry("work", "/home/**/work/**")]);
  });
});

test("shouldWriteWorkspaces: same list → false, different → true", () => {
  const list = [entry("work", "/home/**/work/**")];
  expect(shouldWriteWorkspaces(list, [...list])).toBe(false);
  expect(shouldWriteWorkspaces([], [])).toBe(false);
  expect(shouldWriteWorkspaces([], list)).toBe(true);
  expect(shouldWriteWorkspaces(list, [entry("personal", "/home/**/personal/**")])).toBe(true);
  expect(shouldWriteWorkspaces(list, [entry("work", "/home/**/other/**")])).toBe(true);
  expect(shouldWriteWorkspaces(list, [{ ...list[0], vcs: { provider: "github" as const, defaultTargetBranch: "main" } }])).toBe(true);
});

test("writeWorkspaces replaces the whole list", () => {
  withConfigDir((dir) => {
    const a = writeWorkspaces([entry("work", "/home/**/work/**")]);
    expect(a.ok).toBe(true);
    expect(a.path).toBe(wsFile(dir));
    expect(loadWorkspaces()).toEqual([entry("work", "/home/**/work/**")]);

    writeWorkspaces([entry("personal", "/home/**/personal/**")]);
    expect(loadWorkspaces()).toEqual([entry("personal", "/home/**/personal/**")]);
  });
});

test("writeWorkspaces removes entries when written with fewer", () => {
  withConfigDir((dir) => {
    writeWorkspaces([entry("work", "/home/**/work/**"), entry("personal", "/home/**/personal/**")]);
    writeWorkspaces([entry("work", "/home/**/work/**")]);
    expect(loadWorkspaces()).toEqual([entry("work", "/home/**/work/**")]);
  });
});

test("writeWorkspaces succeeds over a malformed existing file (treated as empty)", () => {
  withConfigDir((dir) => {
    writeFileSync(wsFile(dir), "garbage{{", "utf8");
    const r = writeWorkspaces([entry("work", "/home/**/work/**")]);
    expect(r.ok).toBe(true);
    expect(loadWorkspaces()).toEqual([entry("work", "/home/**/work/**")]);
  });
});

test("written file resolves via resolveWorkspace (parity CA-02)", () => {
  withConfigDir((dir) => {
    const projectDir = path.join(dir, "projects", "work", "repo");
    writeWorkspaces([entry("work", `${path.join(dir, "projects", "work", "**").split(path.sep).join("/")}`)]);
    expect(resolveWorkspace(projectDir)?.name).toBe("work");
  });
});

test("skip = no writeWorkspaces call → file untouched", () => {
  withConfigDir((dir) => {
    const original = JSON.stringify({ workspaces: [entry("work", "/home/**/work/**")] }, null, 2) + "\n";
    writeFileSync(wsFile(dir), original, "utf8");
    expect(loadWorkspaces()).toEqual([entry("work", "/home/**/work/**")]);
    expect(readFileSync(wsFile(dir), "utf8")).toBe(original);
  });
});

test("writeWorkspaces rejects provider/linking cross-combos", () => {
  withConfigDir((dir) => {
    const youtrackOnGithub = writeWorkspaces([{ name: "work", glob: "/w/**", vcs: { provider: "github" }, youtrack: { link_issues: true } }]);
    expect(youtrackOnGithub.ok).toBe(false);
    expect(youtrackOnGithub.error).toContain("youtrack");
    expect(youtrackOnGithub.error).toContain("github");

    const issuesOnGitlab = writeWorkspaces([{ name: "personal", glob: "/p/**", vcs: { provider: "gitlab" }, issues: { provider: "github", link_on_pr: true } }]);
    expect(issuesOnGitlab.ok).toBe(false);
    expect(issuesOnGitlab.error).toContain("issues");
    expect(issuesOnGitlab.error).toContain("gitlab");

    const youtrackNoVcs = writeWorkspaces([{ name: "x", glob: "/x/**", youtrack: { link_issues: true } }]);
    expect(youtrackNoVcs.ok).toBe(false);

    expect(existsSync(wsFile(dir))).toBe(false);
    expect(loadWorkspaces()).toEqual([]);
  });
});

test("writeWorkspaces accepts matching provider/linking combos", () => {
  withConfigDir((dir) => {
    const gitlabYt = writeWorkspaces([{ name: "work", glob: "/w/**", vcs: { provider: "gitlab", defaultTargetBranch: "develop" }, youtrack: { link_issues: true } }]);
    expect(gitlabYt.ok).toBe(true);

    const githubIssues = writeWorkspaces([{ name: "personal", glob: "/p/**", vcs: { provider: "github", defaultTargetBranch: "main" }, issues: { provider: "github", link_on_pr: true } }]);
    expect(githubIssues.ok).toBe(true);
  });
});

test("writeWorkspaces validates entries: no name / no glob / bad provider / null → error, file not written", () => {
  withConfigDir((dir) => {
    const missingName = writeWorkspaces([{ glob: "/x/**" } as { name: string; glob: string }]);
    expect(missingName.ok).toBe(false);
    expect(missingName.error).toContain("name");

    const missingGlob = writeWorkspaces([{ name: "work" } as { name: string; glob: string }]);
    expect(missingGlob.ok).toBe(false);
    expect(missingGlob.error).toContain("glob");

    const badProvider = writeWorkspaces([{ name: "x", glob: "/x/**", vcs: { provider: "bitbucket" as never } }]);
    expect(badProvider.ok).toBe(false);
    expect(badProvider.error).toContain("bitbucket");

    const nullEntry = writeWorkspaces([null as never]);
    expect(nullEntry.ok).toBe(false);
    expect(nullEntry.error).toContain("null");

    expect(existsSync(wsFile(dir))).toBe(false);
    expect(loadWorkspaces()).toEqual([]);
  });
});
