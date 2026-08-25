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
  type SetupMutation,
  type SetupPreviewInput,
} from "../../packages/workit-cli/src/logic";
import { createInitialDraft, reducer } from "../../packages/workit-cli/src/wizard-state";
import { LOCALE_LANGUAGE_MAP, filterOptions } from "../../packages/workit-cli/src/search-select";

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
