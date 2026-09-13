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
} from "@/packages/workit-core/src/core/setup";
import { OPENCODE_NPM_PIN } from "@/packages/workit-core/src/core/registration";
import { isolatedEnv } from "@/test/shared/helpers/packages";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempDir = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const clean = (dir: string) => rmSync(dir, { recursive: true, force: true });

const values = (): SetupPreviewInput => ({
  platforms: ["opencode"],
  locale: "en",
  timezone: "UTC",
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
    ) as { plugin: string[] };
    expect(cfg.plugin[0]).toMatch(/^file:\/\//);
    expect(isCheckoutOpenCodePin(cfg.plugin[0])).toBe(true);
  } finally {
    clean(home);
    clean(dir);
  }
});
