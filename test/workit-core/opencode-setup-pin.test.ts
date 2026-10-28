import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySetupPreview,
  buildSetupPreview,
  resolveOpenCodePin,
  type SetupPreviewInput,
} from "@/packages/workit-cli/src/admin/setup";
import { OPENCODE_NPM_PIN } from "@/packages/workit-cli/src/admin/registration";
import { isolatedEnv } from "@/test/shared/helpers/packages";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempDir = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const clean = (dir: string) => rmSync(dir, { recursive: true, force: true });

const values = (): SetupPreviewInput => ({
  platforms: ["opencode"],
  locale: "en",
  branchPreset: "gitflow",
  branchAllowed: "feature/*, bugfix/*",
  branchProtected: "main, develop",
  baseUrl: "",
  vcsProvider: "skip",
  workspaces: [],
  applyProject: false,
});

test("published node_modules adapter roots resolve to the npm OpenCode pin", () => {
  const root = path.join(tempDir("wk-oc-nm-"), "node_modules", "@brainervirus", "workit-opencode");
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "dist", "plugin.js"), "export default {};\n");
  try {
    expect(resolveOpenCodePin(root)).toBe(OPENCODE_NPM_PIN);
    expect(resolveOpenCodePin(root, { dev: null })).toBe(OPENCODE_NPM_PIN);
  } finally {
    clean(path.dirname(path.dirname(path.dirname(root))));
  }
});

const isCheckoutOpenCodePin = (pin: string | undefined): boolean =>
  Boolean(pin?.startsWith("file://") && /[/\\]packages[/\\]workit-opencode[/\\]/.test(pin));

test("monorepo adapter roots keep a file:// OpenCode pin", () => {
  const pin = resolveOpenCodePin(path.join(repoRoot, "packages", "workit-opencode"), {
    dev: repoRoot,
  });
  expect(pin).toMatch(/^file:\/\//);
  expect(isCheckoutOpenCodePin(pin ?? undefined)).toBe(true);
});

test("dev checkout Apply writes a file:// OpenCode pin", () => {
  const home = tempDir("wk-oc-dev-home-");
  const dir = tempDir("wk-oc-dev-cfg-");
  try {
    const result = applySetupPreview(
      buildSetupPreview(values(), { dir, cwd: dir, env: {}, home }),
      {
        home,
        configDir: dir,
        dev: repoRoot,
        cwd: dir,
        env: isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: dir }),
      },
    );
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    const cfg = JSON.parse(
      readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8"),
    ) as { plugins: string[] };
    expect(cfg.plugins[0]).toMatch(/^file:\/\//);
    expect(isCheckoutOpenCodePin(cfg.plugins[0])).toBe(true);
  } finally {
    clean(home);
    clean(dir);
  }
});

test("setup preserves an existing explicit OpenCode package version pin", () => {
  const home = tempDir("wk-oc-pinned-home-");
  const dir = tempDir("wk-oc-pinned-cfg-");
  const file = path.join(home, ".config", "opencode", "opencode.json");
  const original = JSON.stringify({
    plugins: ["@brainervirus/workit-opencode@2.0.1", "other-plugin"],
  });
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, original);
    const result = applySetupPreview(
      buildSetupPreview(values(), { dir, cwd: dir, env: {}, home }),
      {
        home,
        configDir: dir,
        dev: repoRoot,
        cwd: dir,
        env: isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: dir }),
      },
    );
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally {
    clean(home);
    clean(dir);
  }
});

test("setup preserves an existing OpenCode v2 plugins array pin byte-for-byte", () => {
  const home = tempDir("wk-oc-v2-pinned-home-");
  const dir = tempDir("wk-oc-v2-pinned-cfg-");
  const file = path.join(home, ".config", "opencode", "opencode.json");
  const original = JSON.stringify({
    plugins: ["@brainervirus/workit-opencode@2.0.1", "other-plugin"],
    model: "provider/model",
  });
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, original);
    const result = applySetupPreview(
      buildSetupPreview(values(), { dir, cwd: dir, env: {}, home }),
      {
        home,
        configDir: dir,
        dev: repoRoot,
        cwd: dir,
        env: isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: dir }),
      },
    );
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally {
    clean(home);
    clean(dir);
  }
});

test("setup moves a Workit entry from the deprecated plugin key to plugins", () => {
  const home = tempDir("wk-oc-legacy-home-");
  const dir = tempDir("wk-oc-legacy-cfg-");
  const file = path.join(home, ".config", "opencode", "opencode.json");
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ plugin: ["@brainervirus/workit-opencode", "other-plugin"] }),
    );
    const result = applySetupPreview(
      buildSetupPreview(values(), { dir, cwd: dir, env: {}, home }),
      {
        home,
        configDir: dir,
        dev: repoRoot,
        cwd: dir,
        env: isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: dir }),
      },
    );
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.plugins).toEqual(["@brainervirus/workit-opencode"]);
    expect(cfg.plugin).toEqual(["other-plugin"]);
    const entry = result.entries.find((e) => e.platform === "opencode");
    expect(entry?.detail).toContain('deprecated "plugin" key');
  } finally {
    clean(home);
    clean(dir);
  }
});

test("setup writes plugins and no plugin key into an empty opencode.json", () => {
  const home = tempDir("wk-oc-empty-home-");
  const dir = tempDir("wk-oc-empty-cfg-");
  const file = path.join(home, ".config", "opencode", "opencode.json");
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{}");
    applySetupPreview(buildSetupPreview(values(), { dir, cwd: dir, env: {}, home }), {
      home,
      configDir: dir,
      dev: repoRoot,
      cwd: dir,
      env: isolatedEnv(home, { WORKFLOW_TOOLKIT_CONFIG: dir }),
    });
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(Array.isArray(cfg.plugins)).toBe(true);
    expect(cfg.plugin).toBeUndefined();
  } finally {
    clean(home);
    clean(dir);
  }
});
