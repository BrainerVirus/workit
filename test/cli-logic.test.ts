import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectConfigValues,
  parseList,
  runProjectSetup,
  scaffoldVcs,
  scaffoldYouTrack,
  TOKEN_PLACEHOLDER,
  validateBaseUrl,
  validateLocale,
  validateTimezone,
} from "../src/cli/logic";
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
