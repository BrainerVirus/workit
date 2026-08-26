import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  LOCALE_RE,
  mergePreset,
  readConfigFromDir,
  type ToolkitConfig,
} from "../../packages/workit-core/src/core/config";
import { readSetupState } from "../../packages/workit-core/src/core/setup-state";
import { planHygieneFiles, ensureHygieneFiles } from "../../packages/workit-core/src/core/hygiene";
import {
  buildSetupPreview,
  TOKEN_PLACEHOLDER,
  collectConfigValues,
  validateTimezone,
  type SetupMutation,
  type SetupPreviewInput,
} from "../../packages/workit-cli/src/logic";
import {
  createInitialDraft,
  reducer,
  resolveBasePath,
} from "../../packages/workit-cli/src/wizard-state";
import { LOCALE_LANGUAGE_MAP, filterOptions } from "../../packages/workit-cli/src/search-select";
import {
  BRANCH_PRESET_DESCRIPTIONS,
  SCREEN_PLACEHOLDERS,
  timezonePickerOptions,
} from "../../packages/workit-cli/src/steps";
import { REPO_ROOT } from "../shared/helpers/packages";
import { assertNoLiveInkInstance } from "../shared/helpers/ink-clean-probe";

// WZ-04-WZ-06, WZ-08, RL-02, RL-06 wizard scope; CA-12, CA-14, CA-22, CA-23.
// readSetupState / mergePreset / buildSetupPreview must be pure readers: preview
// is authoritative, integrations are neutral/optional, malformed state blocks
// Apply, and nothing touches the filesystem before Apply.

const tempDir = (): string => mkdtempSync(path.join(os.tmpdir(), "workit-wizcfg-"));

function clean(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const config = (over: Partial<ToolkitConfig["branchPolicy"]> = {}): ToolkitConfig => ({
  locale: "en",
  localeOptions: ["en", "es-CL"],
  timezone: "UTC",
  branchPolicy: {
    preset: "gitflow",
    allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
    protected: ["main", "develop"],
    ...over,
  },
});

const values = (over: Partial<SetupPreviewInput> = {}): SetupPreviewInput => ({
  locale: "en",
  timezone: "UTC",
  branchPreset: "gitflow",
  branchAllowed: "feature/*, bugfix/*",
  branchProtected: "main, develop",
  baseUrl: "",
  vcsProvider: "skip",
  workspaces: [],
  applyProject: false,
  ...over,
});

const wsEntry = (name: string, glob: string) => ({
  name,
  glob,
  vcs: { provider: "gitlab" as const, defaultTargetBranch: "main" },
});

const snapshot = (dir: string): string[] => {
  const entries: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    entries.push(`${name}|${statSync(p).isDirectory() ? "dir" : "file"}`);
    if (!statSync(p).isDirectory()) entries.push(readFileSync(p, "utf8"));
  }
  return entries;
};

test("wizard defaults contain no organization-specific data (WZ-04/CA-14)", () => {
  const dir = tempDir();
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
    const draft = createInitialDraft(config());
    expect(draft.values.baseUrl).toBe("");
    const serialized = JSON.stringify(draft.values);
    expect(serialized).not.toContain("enghouseamg");
    expect(serialized).not.toContain("IRPT");
    expect(serialized).not.toContain("Alejandra.Flores");
    expect(serialized).not.toContain("youtrack.cloud");
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(dir);
  }
});

test("unselected integrations produce no mutations (WZ-04)", () => {
  const dir = tempDir();
  try {
    const preview = buildSetupPreview(values(), { dir, env: {} });
    expect(preview.ok).toBe(true);
    expect(preview.blocked).toEqual([]);
    for (const p of [
      path.join(dir, "youtrack.json"),
      path.join(dir, "vcs.json"),
      path.join(dir, "youtrack.token"),
      path.join(dir, "gitlab.token"),
      path.join(dir, "github.token"),
    ]) {
      expect(preview.mutations.some((m) => m.path === p)).toBe(false);
    }
  } finally {
    clean(dir);
  }
});

test("existing token bytes are preserved in the preview (WZ-05)", () => {
  const dir = tempDir();
  try {
    const tokenPath = path.join(dir, "youtrack.token");
    writeFileSync(tokenPath, "perm_abc123\n", { mode: 0o600 });
    const preview = buildSetupPreview(values({ baseUrl: "https://yt.example.com" }), {
      dir,
      env: {},
    });
    expect(preview.ok).toBe(true);
    expect(preview.preserved).toContain(tokenPath);
    expect(preview.mutations.some((m) => m.path === tokenPath)).toBe(false);
    expect(readFileSync(tokenPath, "utf8")).toBe("perm_abc123\n");
  } finally {
    clean(dir);
  }
});

test("selected integrations create placeholder tokens only when absent", () => {
  const dir = tempDir();
  try {
    const preview = buildSetupPreview(
      values({ baseUrl: "https://yt.example.com", vcsProvider: "gitlab" }),
      { dir, env: {} },
    );
    const yt = preview.mutations.find((m) => m.path.endsWith("youtrack.token"));
    const gl = preview.mutations.find((m) => m.path.endsWith("gitlab.token"));
    expect(yt).toEqual({
      type: "create-file",
      path: path.join(dir, "youtrack.token"),
      content: TOKEN_PLACEHOLDER + "\n",
      mode: 0o600,
    });
    expect(gl).toBeDefined();
    expect((gl as Extract<SetupMutation, { type: "create-file" }>).mode).toBe(0o600);
  } finally {
    clean(dir);
  }
});

test("malformed config blocks Apply with a path-specific diagnostic (WZ-06)", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "config.json"), "{ not json", "utf8");
    const preview = buildSetupPreview(values(), { dir, env: {} });
    expect(preview.ok).toBe(false);
    expect(preview.mutations).toEqual([]);
    expect(preview.blocked.some((b) => b.includes("config.json"))).toBe(true);
    expect(preview.state.config.status).toBe("malformed");
  } finally {
    clean(dir);
  }
});

test("malformed youtrack.json blocks Apply and is never treated as empty (WZ-06)", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "youtrack.json"), "not json{{", "utf8");
    const preview = buildSetupPreview(values({ baseUrl: "https://yt.example.com" }), {
      dir,
      env: {},
    });
    expect(preview.ok).toBe(false);
    expect(preview.mutations).toEqual([]);
    expect(preview.blocked.some((b) => b.includes("youtrack.json"))).toBe(true);
    expect(readFileSync(path.join(dir, "youtrack.json"), "utf8")).toBe("not json{{");
  } finally {
    clean(dir);
  }
});

test("readSetupState classifies missing/valid/malformed files", () => {
  const dir = tempDir();
  try {
    expect(readSetupState(dir).config.status).toBe("missing");
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ locale: "es-CL" }), "utf8");
    expect(readSetupState(dir).config.status).toBe("valid");
    writeFileSync(path.join(dir, "workspaces.json"), "{", "utf8");
    expect(readSetupState(dir).workspaces.status).toBe("malformed");
    expect(readSetupState(dir).workspaces.file).toBe(path.join(dir, "workspaces.json"));
  } finally {
    clean(dir);
  }
});

test("AR-07: readSetupState classifies non-object shapes as malformed on every file", () => {
  const dir = tempDir();
  try {
    for (const [name, key] of [
      ["config.json", "config"],
      ["youtrack.json", "youtrack"],
      ["vcs.json", "vcs"],
      ["workspaces.json", "workspaces"],
    ] as Array<[string, "config" | "youtrack" | "vcs" | "workspaces"]>) {
      for (const content of ["null", '"a string"', "42", "[]"]) {
        writeFileSync(path.join(dir, name), content, "utf8");
        const state = readSetupState(dir);
        expect(state[key].status, `${name} = ${content}`).toBe("malformed");
        expect(state[key].error).toContain(path.join(dir, name));
      }
      rmSync(path.join(dir, name), { force: true });
    }
  } finally {
    clean(dir);
  }
});

test("a non-object config.json blocks Apply instead of defaulting (AR-07)", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "config.json"), "null", "utf8");
    const preview = buildSetupPreview(values(), { dir, env: {} });
    expect(preview.ok).toBe(false);
    expect(preview.mutations).toEqual([]);
    expect(preview.blocked.some((b) => b.includes("config.json"))).toBe(true);
  } finally {
    clean(dir);
  }
});

test("an existing-but-unreadable setup file is blocked, not treated as missing (EACCES)", () => {
  // root bypasses file permissions and win32 chmod is not advisory — skip both.
  if (
    process.platform === "win32" ||
    (typeof process.getuid === "function" && process.getuid() === 0)
  ) {
    return;
  }
  const dir = tempDir();
  const vcsJson = path.join(dir, "vcs.json");
  try {
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ locale: "en" }), "utf8");
    writeFileSync(vcsJson, JSON.stringify({ provider: "gitlab" }), "utf8");
    chmodSync(vcsJson, 0o000);
    const state = readSetupState(dir);
    expect(state.config.status).toBe("valid");
    expect(state.vcs.status).toBe("malformed");
    expect(state.vcs.error).toContain("vcs.json");
    // the preview blocks too — no mutations are generated against the unreadable file
    const preview = buildSetupPreview(values({ vcsProvider: "gitlab" }), { dir, env: {} });
    expect(preview.ok).toBe(false);
    expect(preview.mutations).toEqual([]);
  } finally {
    try {
      chmodSync(vcsJson, 0o644);
    } catch {
      /* file may already be gone */
    }
    clean(dir);
  }
});

test("hygiene includeOpenSource defaults to auto-detection when omitted (Task 13 advisory)", () => {
  const open = tempDir();
  const closed = tempDir();
  try {
    // open-source by npm default: package.json without `private`
    writeFileSync(path.join(open, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    // closed: explicit `private: true` and no LICENSE
    writeFileSync(
      path.join(closed, "package.json"),
      JSON.stringify({ name: "demo", private: true }),
      "utf8",
    );
    const openPlanned = planHygieneFiles(open);
    expect(openPlanned.some((p) => p.path.endsWith("LICENSE"))).toBe(true);
    const closedPlanned = planHygieneFiles(closed);
    expect(closedPlanned.some((p) => p.path.endsWith("LICENSE"))).toBe(false);
    const applied = ensureHygieneFiles(open, { confirmed: true });
    expect(applied.ok).toBe(true);
    expect((applied as { created: string[] }).created).toContain("LICENSE");
  } finally {
    clean(open);
    clean(closed);
  }
});

test("mergePreset resets all derived policy fields when the preset changes (RL-02)", () => {
  const current = config({ preset: "gitflow", allowed: ["feature/*"], protected: ["main"] });
  expect(mergePreset("github-flow", {}, current)).toEqual({
    preset: "github-flow",
    allowed: ["*"],
    protected: ["main"],
  });
  expect(mergePreset("trunk-based", {}, current)).toEqual({
    preset: "trunk-based",
    allowed: ["*"],
    protected: ["main"],
  });
  expect(
    mergePreset(
      "custom",
      { allowed: ["feature/*", "bugfix/*"], protectedNames: ["main", "develop"] },
      current,
    ),
  ).toEqual({
    preset: "custom",
    allowed: ["feature/*", "bugfix/*"],
    protected: ["main", "develop"],
  });
  expect(mergePreset("custom", {}, current)).toEqual({
    preset: "custom",
    allowed: current.branchPolicy.allowed,
    protected: current.branchPolicy.protected,
  });
});

test("createInitialDraft derives policy from the preset, never divergent values (RL-02/CA-23)", () => {
  const draft = createInitialDraft(
    config({ preset: "github-flow", allowed: ["feature/*"], protected: ["main", "develop"] }),
  );
  expect(draft.values.branchAllowed).toBe("*");
  expect(draft.values.branchProtected).toBe("main");
});

test("buildSetupPreview emits exact typed mutations for every section (WZ-08)", () => {
  const dir = tempDir();
  try {
    const preview = buildSetupPreview(
      values({
        baseUrl: "https://yt.example.com",
        vcsProvider: "gitlab",
        workspaces: [wsEntry("work", "/work/**")],
        applyProject: true,
      }),
      { dir, cwd: dir, env: {} },
    );
    expect(preview.ok).toBe(true);
    const byType = (t: SetupMutation["type"]) => preview.mutations.filter((m) => m.type === t);

    const cfg = byType("merge-json").find((m) => m.path.endsWith("config.json"));
    expect(cfg).toBeDefined();
    expect((cfg as { value: ToolkitConfig }).value.branchPolicy).toEqual({
      preset: "gitflow",
      allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
      protected: ["main", "develop", "master", "prod", "production"],
    });

    const yt = byType("merge-json").find((m) => m.path.endsWith("youtrack.json"));
    expect(yt).toBeDefined();
    const ytValue = JSON.stringify((yt as { value: unknown }).value);
    expect(ytValue).toContain("https://yt.example.com");
    expect(ytValue).not.toContain("IRPT");
    expect(ytValue).not.toContain("defaultMention");
    expect(ytValue).not.toContain("Alejandra.Flores");

    const ws = byType("update-workspaces").find((m) => m.path.endsWith("workspaces.json"));
    expect((ws as { entries: unknown[] }).entries).toEqual([wsEntry("work", "/work/**")]);

    const token = byType("create-file").find((m) => m.path.endsWith("youtrack.token"));
    expect((token as { content: string }).content.trim()).toBe(TOKEN_PLACEHOLDER);

    const gi = byType("append-gitignore").find((m) => m.path.endsWith(".gitignore"));
    expect((gi as { entries: string[] }).entries).toContain("docs/*/sdd/");
  } finally {
    clean(dir);
  }
});

test("active environment overrides are exposed in the preview (RL-06)", () => {
  const dir = tempDir();
  try {
    const preview = buildSetupPreview(values({ baseUrl: "https://wizard.example.com" }), {
      dir,
      env: { WORKFLOW_YT_BASE_URL: "https://env.example.com" },
    });
    const override = preview.overrides.find((o) => o.envKey === "WORKFLOW_YT_BASE_URL");
    expect(override).toBeDefined();
    expect(override!.value).toBe("https://env.example.com");
    expect(override!.affects).toContain("baseUrl");
    // the wizard's own value still wins in the mutation
    const yt = preview.mutations.find((m) => m.path.endsWith("youtrack.json"));
    expect(JSON.stringify((yt as { value: unknown }).value)).toContain(
      "https://wizard.example.com",
    );
  } finally {
    clean(dir);
  }
});

test("buildSetupPreview exposes active VCS overrides alongside YouTrack ones (RL-06)", () => {
  const dir = tempDir();
  try {
    const preview = buildSetupPreview(values({ vcsProvider: "gitlab" }), {
      dir,
      env: { WORKFLOW_VCS_PROVIDER: "github", WORKFLOW_GITLAB_HOST: "gitlab.example.com" },
    });
    const provider = preview.overrides.find((o) => o.envKey === "WORKFLOW_VCS_PROVIDER");
    expect(provider).toBeDefined();
    expect(provider!.value).toBe("github");
    expect(provider!.affects).toContain("provider");
    const host = preview.overrides.find((o) => o.envKey === "WORKFLOW_GITLAB_HOST");
    expect(host).toBeDefined();
    expect(host!.value).toBe("gitlab.example.com");
  } finally {
    clean(dir);
  }
});

test("collectConfigValues routes through mergePreset — no divergent persisted values (RL-02/CA-23)", () => {
  const current = config({ preset: "gitflow", allowed: ["feature/*"], protected: ["main"] });
  const github = collectConfigValues({ preset: "github-flow" }, current);
  expect(github.branchPolicy).toEqual({
    preset: "github-flow",
    allowed: ["*"],
    protected: ["main"],
  });
  const custom = collectConfigValues(
    { preset: "custom", allowed: ["codex/*"], protectedNames: ["main", "develop"] },
    current,
  );
  expect(custom.branchPolicy).toEqual({
    preset: "custom",
    allowed: ["codex/*"],
    protected: ["main", "develop"],
  });
});

test("unsupported workspace glob blocks the preview without a write mutation (RL-08/CA-31)", () => {
  const dir = tempDir();
  try {
    const okPreview = buildSetupPreview(values({ workspaces: [wsEntry("work", "/work/**")] }), {
      dir,
      cwd: dir,
      env: {},
    });
    expect(okPreview.ok).toBe(true);

    const badPreview = buildSetupPreview(
      values({ workspaces: [wsEntry("work", "/work/[abc]/**")] }),
      { dir, cwd: dir, env: {} },
    );
    expect(badPreview.ok).toBe(false);
    expect(badPreview.blocked.some((b) => b.includes("unsupported"))).toBe(true);
    expect(badPreview.mutations.some((m) => m.type === "update-workspaces")).toBe(false);
    expect(existsSync(path.join(dir, "workspaces.json"))).toBe(false);
  } finally {
    clean(dir);
  }
});

test("readSetupState and buildSetupPreview never write (no pre-Apply write, CA-12)", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ locale: "es-CL" }), "utf8");
    const before = snapshot(dir);
    readSetupState(dir);
    buildSetupPreview(
      values({ baseUrl: "https://yt.example.com", vcsProvider: "gitlab", applyProject: true }),
      { dir, cwd: dir, env: {} },
    );
    expect(snapshot(dir)).toEqual(before);
    expect(existsSync(path.join(dir, "youtrack.json"))).toBe(false);
    expect(existsSync(path.join(dir, "youtrack.token"))).toBe(false);
  } finally {
    clean(dir);
  }
});

test("preview plans host registration and adapter copy mutations (AR-09)", () => {
  const dir = tempDir();
  const home = tempDir();
  try {
    const preview = buildSetupPreview(values({ platforms: ["opencode", "cursor"] }), {
      dir,
      cwd: dir,
      env: {},
      home,
    });
    expect(preview.ok).toBe(true);
    const platformPaths = preview.mutations
      .filter((m) => m.type === "register-platform" || m.type === "install-adapter")
      .map((m) => (m.type === "register-platform" ? `${m.platform}:${m.path}` : `copy:${m.path}`));
    expect(platformPaths).toEqual([
      `opencode:${path.join(home, ".config", "opencode", "opencode.json")}`,
      `copy:${path.join(home, ".cursor", "plugins", "local", "workit")}`,
      `cursor:${path.join(home, ".cursor", "settings.json")}`,
      `cursor:${path.join(home, ".cursor", "mcp.json")}`,
    ]);
  } finally {
    clean(dir);
    clean(home);
  }
});

test("existing custom token paths are reused in the draft; canary bytes preserved (AR-10)", () => {
  const dir = tempDir();
  try {
    const ytJson = path.join(dir, "youtrack.json");
    const customYt = path.join(dir, "secrets", "yt.token");
    const vcsJson = path.join(dir, "vcs.json");
    const customGl = path.join(dir, "secrets", "gl.token");
    const customGh = path.join(dir, "secrets", "gh.token");
    mkdirSync(path.join(dir, "secrets"), { recursive: true });
    writeFileSync(
      ytJson,
      JSON.stringify({ baseUrl: "https://org.example.com", tokenFile: customYt }),
      "utf8",
    );
    writeFileSync(customYt, "canary-yt\n", { mode: 0o600 });
    writeFileSync(
      vcsJson,
      JSON.stringify({
        provider: "gitlab",
        gitlab: { host: "gitlab.example.com", tokenFile: customGl },
        github: { tokenFile: customGh },
      }),
      "utf8",
    );
    writeFileSync(customGl, "canary-gl\n", { mode: 0o600 });
    writeFileSync(customGh, "canary-gh\n", { mode: 0o600 });

    const preview = buildSetupPreview(
      values({ baseUrl: "https://new.example.com", vcsProvider: "gitlab" }),
      { dir, env: {} },
    );
    expect(preview.ok).toBe(true);
    // the custom files are preserved; the default paths are never written
    expect(preview.preserved).toEqual(expect.arrayContaining([customYt, customGl]));
    for (const def of [path.join(dir, "youtrack.token"), path.join(dir, "gitlab.token")]) {
      expect(preview.mutations.some((m) => m.path === def)).toBe(false);
    }
    // reuse means no path replacement mutation anywhere
    expect(preview.mutations.some((m) => m.type === "set-token-path")).toBe(false);
    // the drafts keep the custom paths authoritative
    const yt = preview.mutations.find((m) => m.path === ytJson) as Extract<
      SetupMutation,
      { type: "merge-json" }
    >;
    expect((yt.value as { tokenFile: string }).tokenFile).toBe(customYt);
    const vcs = preview.mutations.find((m) => m.path === vcsJson) as Extract<
      SetupMutation,
      { type: "merge-json" }
    >;
    const v = vcs.value as { gitlab: { tokenFile: string }; github: { tokenFile: string } };
    expect(v.gitlab.tokenFile).toBe(customGl);
    expect(v.github.tokenFile).toBe(customGh);
    // canary bytes untouched by the pure preview
    expect(readFileSync(customYt, "utf8")).toBe("canary-yt\n");
    expect(readFileSync(customGl, "utf8")).toBe("canary-gl\n");
    expect(readFileSync(customGh, "utf8")).toBe("canary-gh\n");
  } finally {
    clean(dir);
  }
});

test("a deliberate token path replacement is its own distinct mutation (AR-10)", () => {
  const dir = tempDir();
  try {
    const ytJson = path.join(dir, "youtrack.json");
    writeFileSync(ytJson, JSON.stringify({ tokenFile: path.join(dir, "old.token") }), "utf8");
    const next = path.join(dir, "new.token");
    const preview = buildSetupPreview(
      values({ baseUrl: "https://yt.example.com", tokenPaths: { youtrack: next } }),
      { dir, env: {} },
    );
    expect(preview.ok).toBe(true);
    const set = preview.mutations.find((m) => m.type === "set-token-path");
    expect(set).toEqual({
      type: "set-token-path",
      path: ytJson,
      key: "tokenFile",
      value: next,
    });
    // the config draft no longer hides the path change inside the generic merge
    const yt = preview.mutations.find((m) => m.path === ytJson) as Extract<
      SetupMutation,
      { type: "merge-json" }
    >;
    expect(JSON.stringify(yt.value)).not.toContain("tokenFile");
    // the new path is created as a separate reviewed mutation; the old file is
    // never written
    expect(
      preview.mutations.some(
        (m) =>
          m.type === "create-file" && m.path === next && m.content.trim() === TOKEN_PLACEHOLDER,
      ),
    ).toBe(true);
    expect(preview.mutations.some((m) => m.path === path.join(dir, "old.token"))).toBe(false);
  } finally {
    clean(dir);
  }
});

// ---------------------------------------------------------------------------
// Locale SearchSelect (Task 3): pure filtering/map behavior + reducer commit.
// The Español block leads LOCALE_LANGUAGE_MAP so the 5-row cap keeps the whole
// language×nationality family visible together for the shared "es" prefix.
// ---------------------------------------------------------------------------

test('filterOptions("es") caps at 5 rows across language+nationality labels', () => {
  // Same adaptation the locale screen applies: Teams rows → picker options.
  const options = [
    ...LOCALE_LANGUAGE_MAP.map((entry) => ({ label: entry.label, value: entry.locale })),
    { label: "Other…", value: "other" },
  ];
  const matches = filterOptions(options, "es");
  expect(matches.length).toBeLessThanOrEqual(5);
  expect(matches.length).toBeGreaterThan(0);
  const labels = matches.map((m) => m.label);
  expect(labels.join(" | ")).toContain("España");
  expect(labels.join(" | ")).toContain("Latinoamérica");
  expect(labels.join(" | ")).toContain("Chile");
  // value-only matches (es-419 has no "es" in its label) are found too
  expect(matches.map((m) => m.value)).toContain("es-419");
  expect(labels.join(" | ")).not.toContain("English (United States)");
  // empty query shows the first window of the full list
  expect(filterOptions(options, "")).toEqual(options.slice(0, 5));
});

test("filterOptions folds diacritics on both sides (espanol matches Español)", () => {
  const options = LOCALE_LANGUAGE_MAP.map((entry) => ({ label: entry.label, value: entry.locale }));
  const folded = filterOptions(options, "espanol");
  expect(folded.length).toBeGreaterThan(0);
  expect(folded.map((m) => m.label).join(" | ")).toContain("Español");
  // the accented query folds too
  expect(filterOptions(options, "Español").length).toBeGreaterThan(0);
});

test("LOCALE_LANGUAGE_MAP covers every core localeOptions default exactly once", () => {
  const dir = tempDir();
  try {
    const locales = readConfigFromDir(dir).localeOptions;
    expect(locales.length).toBe(5);
    const mapLocales = LOCALE_LANGUAGE_MAP.map((entry) => entry.locale);
    for (const locale of locales) {
      expect(mapLocales, locale).toContain(locale);
    }
    expect(new Set(mapLocales).size).toBe(mapLocales.length);
    expect(LOCALE_LANGUAGE_MAP.length).toBeGreaterThanOrEqual(25);
  } finally {
    clean(dir);
  }
});

test("selecting a mapped row commits its BCP-47 locale through the reducer", () => {
  const row = LOCALE_LANGUAGE_MAP.find((entry) => entry.locale === "es-419");
  expect(row).toBeDefined();
  let d = createInitialDraft(config());
  d = reducer(d, { type: "set", field: "platforms", value: ["opencode"] });
  d = reducer(d, { type: "next" }); // -> locale
  d = reducer(d, { type: "set", field: "locale", value: row!.locale });
  expect(d.errors.locale, LOCALE_RE.test(row!.locale) ? undefined : row!.locale).toBeUndefined();
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("timezone");
  expect(d.values.locale).toBe("es-419");
});

// ---------------------------------------------------------------------------
// Timezone SearchSelect (Task 4): full IANA catalog through filterOptions,
// catalog consistency with the KNOWN_TIMEZONES guard in logic.ts, and reducer
// commit. Other… keeps validateTimezone (CA-04) untouched.
// ---------------------------------------------------------------------------

test('filterOptions("Santiago") caps at 5 rows including America/Santiago', () => {
  const matches = filterOptions(timezonePickerOptions(), "Santiago");
  expect(matches.length).toBeGreaterThan(0);
  expect(matches.length).toBeLessThanOrEqual(5);
  expect(matches.map((m) => m.value)).toContain("America/Santiago");
});

test("timezone catalog matches the KNOWN_TIMEZONES guard and contains the detected zone", () => {
  const options = timezonePickerOptions();
  expect(options[options.length - 1].value).toBe("other");
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  // The detected zone heads the list so its preselection is visible without
  // typing; the remainder is the runtime's IANA set when supportedValuesOf
  // exists (validateTimezone enforces membership exactly then — the same
  // guard shape as logic.ts KNOWN_TIMEZONES), else the static fallback while
  // validation stays open.
  expect(options[0].value).toBe(detected);
  const rest = options.slice(1, -1).map((option) => option.value);
  if (typeof Intl.supportedValuesOf === "function") {
    expect([...rest].sort()).toEqual(
      Intl.supportedValuesOf("timeZone")
        .filter((tz) => tz !== detected)
        .sort(),
    );
  } else {
    expect(validateTimezone("Not/AZone")).toBeNull();
  }
});

test("committing a searched zone updates the draft through the reducer", () => {
  let d = createInitialDraft(config());
  d = reducer(d, { type: "set", field: "platforms", value: ["opencode"] });
  d = reducer(d, { type: "next" }); // -> locale
  d = reducer(d, { type: "next" }); // -> timezone
  d = reducer(d, { type: "set", field: "timezone", value: "America/Santiago" });
  expect(validateTimezone("America/Santiago")).toBeNull();
  expect(d.errors.timezone).toBeUndefined();
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("branchPreset");
  expect(d.values.timezone).toBe("America/Santiago");
});

// ---------------------------------------------------------------------------
// Issue tracker selection (Task 5): SetupValues.issueTracker gates the YouTrack
// screen exactly like skipsCustomBranch gates the custom-branch screens, and
// the github/none choices rewire workspace defaults without core edits.
// ---------------------------------------------------------------------------

// Custom preset so every branch screen is visited on the way to issueTracker.
const startCustom = (): ReturnType<typeof createInitialDraft> => {
  let d = createInitialDraft(
    config({ preset: "custom", allowed: ["feature/*"], protected: ["main"] }),
  );
  d = reducer(d, { type: "set", field: "platforms", value: ["opencode"] });
  d = reducer(d, { type: "next" }); // -> locale
  d = reducer(d, { type: "next" }); // -> timezone
  d = reducer(d, { type: "next" }); // -> branchPreset
  d = reducer(d, { type: "set", field: "branchPreset", value: "custom" });
  d = reducer(d, { type: "next" }); // -> branchAllowed
  d = reducer(d, { type: "set", field: "branchAllowed", value: "feature/*" });
  d = reducer(d, { type: "next" }); // -> branchProtected
  d = reducer(d, { type: "set", field: "branchProtected", value: "main" });
  return d;
};

test("issueTracker defaults to youtrack and sits between branchProtected and youtrack", () => {
  expect(createInitialDraft(config()).values.issueTracker).toBe("youtrack");

  let d = startCustom();
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("issueTracker");
  expect(reducer(d, { type: "back" }).screen).toBe("branchProtected");

  // Default selection YouTrack keeps the base-url screen in the flow.
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("youtrack");
  expect(reducer(d, { type: "back" }).screen).toBe("issueTracker");
  d = reducer(d, { type: "next" });
  expect(d.screen).toBe("vcs");
  expect(reducer(d, { type: "back" }).screen).toBe("youtrack");
});

test("none/github skip the youtrack screen in both directions; non-custom presets reach issueTracker", () => {
  // gitflow preset: branch screens skip straight to the new select screen
  let g = createInitialDraft(config());
  g = reducer(g, { type: "set", field: "platforms", value: ["opencode"] });
  g = reducer(g, { type: "next" }); // -> locale
  g = reducer(g, { type: "next" }); // -> timezone
  g = reducer(g, { type: "next" }); // -> branchPreset
  g = reducer(g, { type: "next" }); // skips branchAllowed/branchProtected
  expect(g.screen).toBe("issueTracker");

  const atIssueTracker = reducer(startCustom(), { type: "next" });
  for (const tracker of ["none", "github"] as const) {
    let t = reducer(atIssueTracker, { type: "set", field: "issueTracker", value: tracker });
    t = reducer(t, { type: "next" });
    expect(t.screen, tracker).toBe("vcs"); // skipped forward
    t = reducer(t, { type: "back" });
    expect(t.screen, tracker).toBe("issueTracker"); // skipped backward too
  }
});

test("choosing None drops a typed base URL: preview carries zero youtrack mutations", () => {
  const dir = tempDir();
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
    let d = createInitialDraft(config());
    d = reducer(d, { type: "set", field: "baseUrl", value: "https://yt.example.com" });
    d = reducer(d, { type: "set", field: "vcsProvider", value: "gitlab" });
    d = reducer(d, { type: "set", field: "issueTracker", value: "none" });
    expect(d.values.baseUrl).toBe("");
    expect(d.errors.baseUrl).toBeUndefined();
    const preview = buildSetupPreview(d.values, { dir, env: {} });
    expect(preview.ok).toBe(true);
    expect(preview.mutations.some((m) => m.path.endsWith("youtrack.json"))).toBe(false);
    expect(preview.mutations.some((m) => m.path.endsWith("youtrack.token"))).toBe(false);
    // switching back keeps the cleared value — the user retypes it deliberately
    d = reducer(d, { type: "set", field: "issueTracker", value: "youtrack" });
    expect(d.values.baseUrl).toBe("");
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(dir);
  }
});

test("github mode: new workspaces default provider github with issues linked", () => {
  const dir = tempDir();
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
    let d = createInitialDraft(config());
    d = reducer(d, { type: "set", field: "issueTracker", value: "github" });
    // the tracker wins over an unrelated gitlab VCS selection (writeWorkspaces
    // validation requires the github provider for linked issues)
    d = reducer(d, { type: "set", field: "vcsProvider", value: "gitlab" });

    d = reducer(d, { type: "workspaceAddCurrent", path: "/home/u/proj" });
    expect(d.values.workspaces[0].vcs?.provider).toBe("github");
    expect(d.values.workspaces[0].issues).toEqual({ provider: "github", link_on_pr: true });

    d = reducer(d, { type: "workspaceAdd" });
    expect(d.workspaceDraft?.vcs?.provider).toBe("github");
    expect(d.workspaceDraft?.issues).toEqual({ provider: "github", link_on_pr: true });

    const preview = buildSetupPreview(d.values, { dir, cwd: dir, env: {} });
    const ws = preview.mutations.find((m) => m.type === "update-workspaces") as Extract<
      SetupMutation,
      { type: "update-workspaces" }
    >;
    expect(ws.entries[0].issues).toEqual({ provider: "github", link_on_pr: true });
    expect(ws.entries[0].vcs?.provider).toBe("github");
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(dir);
  }
});

test("walking the tracker back from github strips issues linking from added workspaces", () => {
  const dir = tempDir();
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
    let d = createInitialDraft(config());
    d = reducer(d, { type: "set", field: "issueTracker", value: "github" });
    d = reducer(d, { type: "workspaceAddCurrent", path: "/home/u/proj" });
    expect(d.values.workspaces[0].issues).toEqual({ provider: "github", link_on_pr: true });
    for (const tracker of ["none", "youtrack"] as const) {
      let t = reducer(d, { type: "set", field: "issueTracker", value: tracker });
      expect(t.values.workspaces[0].issues, tracker).toBeUndefined();
      expect(t.values.workspaces[0].name).toBe("proj"); // everything else intact
    }
    // switching back to github re-links new workspaces but stays honest about
    // existing ones (they were stripped; nothing silently re-links)
    const back = reducer(reducer(d, { type: "set", field: "issueTracker", value: "none" }), {
      type: "set",
      field: "issueTracker",
      value: "github",
    });
    expect(back.values.workspaces[0].issues).toBeUndefined();
    // no-op guard: an unchanged tracker dispatch returns the same draft object
    expect(reducer(d, { type: "set", field: "issueTracker", value: "github" })).toBe(d);
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(dir);
  }
});

test("youtrack mode stays byte-identical: preview equals the legacy literal input", () => {
  const dir = tempDir();
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
    let d = createInitialDraft(config());
    d = reducer(d, { type: "set", field: "baseUrl", value: "https://yt.example.com" });
    d = reducer(d, { type: "set", field: "vcsProvider", value: "gitlab" });
    d = reducer(d, { type: "workspaceAddCurrent", path: "/home/u/proj" });
    const legacy = values({
      baseUrl: "https://yt.example.com",
      vcsProvider: "gitlab",
      workspaces: [{ name: "proj", glob: "/home/u/proj/**", vcs: { provider: "gitlab" } }],
    });
    const fromWizard = buildSetupPreview(d.values, { dir, cwd: dir, env: {} });
    const literal = buildSetupPreview(legacy, { dir, cwd: dir, env: {} });
    expect(JSON.stringify(fromWizard.mutations)).toBe(JSON.stringify(literal.mutations));
    // no issues linking leaks into youtrack-mode workspaces
    expect(
      JSON.stringify(fromWizard.mutations.filter((m) => m.type === "update-workspaces")),
    ).not.toContain('"issues"');
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    clean(dir);
  }
});

// ---------------------------------------------------------------------------
// Base-path resolution (Task 6, D-06/CA-06/CA-07): WORKFLOW_WORKSPACE_ROOT env
// wins over the prompted path; without env the basePath screen gates the
// wizard with existsSync validation; process.cwd() is gone from every
// workspace-preview and hygiene-target code path.
// ---------------------------------------------------------------------------

// gitflow preset walk to the vcs screen: platforms → locale → timezone →
// branchPreset → issueTracker → youtrack → vcs (six `next`s after platforms).
const walkToVcs = (): ReturnType<typeof createInitialDraft> => {
  let d = createInitialDraft(config());
  d = reducer(d, { type: "set", field: "platforms", value: ["opencode"] });
  for (let i = 0; i < 6; i++) d = reducer(d, { type: "next" });
  return d;
};

test("D-06: WORKFLOW_WORKSPACE_ROOT beats the prompted path and seeds the initial draft", () => {
  const prev = process.env.WORKFLOW_WORKSPACE_ROOT;
  try {
    process.env.WORKFLOW_WORKSPACE_ROOT = "/tmp/wk-t6-env-root";
    const d = createInitialDraft(config());
    expect(d.values.basePath).toBe("/tmp/wk-t6-env-root");
    expect(resolveBasePath(d.values)).toBe("/tmp/wk-t6-env-root");
    // a prompted value never overrides the env…
    const edited = reducer(d, { type: "set", field: "basePath", value: "/tmp/wk-t6-prompted" });
    expect(resolveBasePath(edited.values)).toBe("/tmp/wk-t6-env-root");
    // …but an explicit env argument wins over the ambient one (pure seam)
    expect(resolveBasePath(edited.values, {})).toBe("/tmp/wk-t6-prompted");
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = prev;
  }
});

test("D-06: without env the basePath prompt gates advancement with field errors", () => {
  const prev = process.env.WORKFLOW_WORKSPACE_ROOT;
  delete process.env.WORKFLOW_WORKSPACE_ROOT;
  try {
    let d = walkToVcs();
    d = reducer(d, { type: "next" }); // vcs -> basePath prompt (no env)
    expect(d.screen).toBe("basePath");
    d = reducer(d, { type: "next" }); // empty input refuses to advance
    expect(d.screen).toBe("basePath");
    expect(d.errors.basePath).toContain("required");
    d = reducer(d, { type: "set", field: "basePath", value: "relative/path" });
    d = reducer(d, { type: "next" });
    expect(d.screen).toBe("basePath");
    expect(d.errors.basePath).toContain("existing absolute directory");
    const missing = path.join(os.tmpdir(), `wk-t6-missing-${process.pid}`);
    d = reducer(d, { type: "set", field: "basePath", value: missing });
    d = reducer(d, { type: "next" });
    expect(d.screen).toBe("basePath");
    expect(d.errors.basePath).toContain("existing absolute directory");
    const real = mkdtempSync(path.join(os.tmpdir(), "wk-t6-real-"));
    try {
      d = reducer(d, { type: "set", field: "basePath", value: real });
      d = reducer(d, { type: "next" });
      expect(d.screen).toBe("workspaces");
      // answered once — walking back skips the prompt (mirrors youtrack gating)
      expect(reducer(d, { type: "back" }).screen).toBe("vcs");
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = prev;
  }
});

test("D-06: with env set the basePath screen is skipped in both directions", () => {
  const prev = process.env.WORKFLOW_WORKSPACE_ROOT;
  try {
    process.env.WORKFLOW_WORKSPACE_ROOT = os.tmpdir();
    const d = walkToVcs();
    const fwd = reducer(d, { type: "next" });
    expect(fwd.screen).toBe("workspaces");
    expect(reducer(fwd, { type: "back" }).screen).toBe("vcs");
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = prev;
  }
});

test("basePath gate rejects an existing FILE (directory required)", () => {
  const prev = process.env.WORKFLOW_WORKSPACE_ROOT;
  delete process.env.WORKFLOW_WORKSPACE_ROOT;
  const dir = tempDir();
  try {
    const file = path.join(dir, "passwd");
    writeFileSync(file, "root:x:0:0\n", "utf8");
    let d = walkToVcs();
    d = reducer(d, { type: "next" }); // -> basePath prompt
    d = reducer(d, { type: "set", field: "basePath", value: file });
    expect(d.errors.basePath).toContain("existing absolute directory");
    expect(reducer(d, { type: "next" }).screen).toBe("basePath"); // gated
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = prev;
    clean(dir);
  }
});

test("a whitespace-only WORKFLOW_WORKSPACE_ROOT seed is treated as unset", () => {
  const prev = process.env.WORKFLOW_WORKSPACE_ROOT;
  try {
    process.env.WORKFLOW_WORKSPACE_ROOT = "   ";
    let d = walkToVcs();
    d = reducer(d, { type: "next" });
    expect(d.screen).toBe("basePath"); // prompt appears, never silently skipped
    expect(resolveBasePath(d.values)).toBe("");
    const real = mkdtempSync(path.join(os.tmpdir(), "wk-t6-ws-"));
    try {
      d = reducer(d, { type: "set", field: "basePath", value: real });
      expect(resolveBasePath(d.values, {})).toBe(real);
      d = reducer(d, { type: "next" });
      expect(d.screen).toBe("workspaces");
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = prev;
  }
});

// ---------------------------------------------------------------------------
// Display-only polish (Task 7, CA-08/CA-09): static preset descriptions on the
// branchPreset screen and an example placeholder on every TextInput screen.
// Placeholders must never reach draft values or submitted input.
// ---------------------------------------------------------------------------

test("branchPreset descriptions: gitflow hints develop + pr/merge; others are main-only (CA-08)", () => {
  const gitflow = BRANCH_PRESET_DESCRIPTIONS.gitflow;
  for (const pattern of ["feature/*", "bugfix/*", "hotfix/*", "release/*"]) {
    expect(gitflow, pattern).toContain(pattern);
  }
  expect(gitflow).toContain("develop");
  expect(/pr|merge/i.test(gitflow)).toBe(true);

  for (const preset of ["github-flow", "trunk-based"] as const) {
    expect(BRANCH_PRESET_DESCRIPTIONS[preset]).toContain("main");
    expect(BRANCH_PRESET_DESCRIPTIONS[preset]).not.toContain("develop");
  }
  expect(BRANCH_PRESET_DESCRIPTIONS.custom.length).toBeGreaterThan(0);
});

// Map-level sanity only; the rendered JSX wiring of every placeholder is
// pinned by the TTY tests in wizard-tty.test.tsx (placeholder assertions on
// each screen's frame), so deleting a placeholder prop cannot pass silently.
test("every wizard TextInput screen carries a non-empty example placeholder (CA-09)", () => {
  for (const screen of [
    "youtrack",
    "localeOther",
    "timezoneOther",
    "branchAllowed",
    "branchProtected",
    "workspaceName",
    "workspaceGlob",
    "branchPolicyDevelop",
  ] as const) {
    expect(SCREEN_PLACEHOLDERS[screen].trim().length, screen).toBeGreaterThan(0);
    expect(SCREEN_PLACEHOLDERS[screen], screen).toContain("e.g.");
  }
});

test("placeholders are display-only: no example text reaches draft or submitted values", () => {
  const initial = createInitialDraft(config());
  // Real branch patterns may legitimately appear in values; the "e.g. …"
  // placeholder bytes themselves may never leak into the draft.
  for (const placeholder of Object.values(SCREEN_PLACEHOLDERS)) {
    expect(JSON.stringify(initial.values)).not.toContain(placeholder);
  }
  // submitting an untouched branchPolicyDevelop keeps the develop branch unset
  let d = createInitialDraft(config());
  d = reducer(d, { type: "set", field: "branchPolicyDevelop", value: "" });
  expect(d.values.branchPolicy?.developBranch ?? "").toBe("");
});

class ExitSentinel extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

// CA-07 end-to-end: runInit resolves Apply's cwd from the base path. Zero
// platforms keeps host registrations out of the run; applyProject hygiene is
// the observable cwd seam — the gitignore must land in the resolved basePath,
// never in the process cwd the wizard used to silently inherit.
test("runInit apply resolves its cwd from the base path, never the process cwd", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "wk-t6-drive-"));
  const root = path.join(base, "root");
  const cwdDir = path.join(base, "cwd");
  const configDir = path.join(base, "config");
  const home = path.join(base, "home");
  for (const dir of [root, cwdDir, configDir, home]) mkdirSync(dir, { recursive: true });
  const prevRoot = process.env.WORKFLOW_WORKSPACE_ROOT;
  const prevCfg = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const prevDev = process.env.WORKFLOW_TOOLKIT_DEV;
  // Isolated HOME: the OpenCode registration must never touch the real
  // ~/.config/opencode on any machine (dev pointer keeps adapter resolution
  // inside the repository, so the install succeeds hermetically).
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  const prevExit = process.exit;
  const prevLog = console.log;
  const prevStdin = process.stdin;
  // Private stdout object per drive: ink keys live instances BY STDOUT, so an
  // interrupted drive abandons its instance here instead of poisoning every
  // later render() on the shared real stdout (instance reuse + dead stdin).
  const prevStdout = process.stdout;
  const chunks: string[] = [];
  let exitCode: number | undefined;
  const recordedStdout = {
    write(chunk: unknown, cb?: (() => void) | undefined): boolean {
      chunks.push(String(chunk));
      cb?.();
      return true;
    },
    isTTY: true,
    columns: 120,
    rows: 40,
    on(): void {},
    off(): void {},
  } as unknown as typeof process.stdout;
  try {
    process.env.WORKFLOW_WORKSPACE_ROOT = root;
    process.env.WORKFLOW_TOOLKIT_CONFIG = configDir;
    process.env.WORKFLOW_TOOLKIT_DEV = REPO_ROOT;
    process.env.HOME = home;
    writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config()), "utf8");
    process.chdir(cwdDir);

    const fakeStdin = new PassThrough() as PassThrough & {
      isTTY: boolean;
      ref(): void;
      unref(): void;
      setRawMode(enabled: boolean): void;
    };
    fakeStdin.isTTY = true;
    fakeStdin.ref = () => {};
    fakeStdin.unref = () => {};
    fakeStdin.setRawMode = () => {};

    process.stdin = fakeStdin as unknown as typeof process.stdin;
    process.stdout = recordedStdout;
    console.log = (...args: unknown[]) => {
      chunks.push(`${args.map(String).join(" ")}\n`);
    };
    process.exit = ((code?: number) => {
      throw new ExitSentinel(code);
    }) as typeof process.exit;

    const ENTER = "\r";
    const SPACE = " ";
    const { runInit } = await import("../../packages/workit-cli/src/index");
    const flush = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setImmediate(resolve));
    };
    const running = runInit();
    running.catch(() => {});
    await flush();
    // empty platforms submit is blocked; select OpenCode, then straight through
    // to Apply with the env root set (no basePath prompt appears): platforms
    // submit, locale, timezone, preset->tracker, tracker->youtrack,
    // youtrack->vcs, vcs->workspaces (env skips the prompt), Done->project
    for (const key of [ENTER, SPACE, ENTER, ...Array(7).fill(ENTER), "y", "y"] as string[]) {
      process.stdin.push(key);
      await flush();
    }
    try {
      await running;
    } catch (err) {
      if (!(err instanceof ExitSentinel)) throw err;
      exitCode = err.code;
    }
    // Drive determinism gate: the product must have fully torn down its Ink
    // instance before this drive hands the (still swapped) stdout back.
    await assertNoLiveInkInstance();

    expect(exitCode, chunks.join("")).toBe(0);
    const joined = chunks.join("");
    expect(joined).toContain(path.join(root, ".gitignore"));
    expect(existsSync(path.join(root, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(cwdDir, ".gitignore"))).toBe(false);
  } finally {
    if (prevRoot === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = prevRoot;
    if (prevCfg === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prevCfg;
    if (prevDev === undefined) delete process.env.WORKFLOW_TOOLKIT_DEV;
    else process.env.WORKFLOW_TOOLKIT_DEV = prevDev;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    process.chdir(prevCwd);
    process.exit = prevExit;
    console.log = prevLog;
    process.stdin = prevStdin;
    process.stdout = prevStdout;
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);
