import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applySetupPreview } from "@/packages/workit-cli/src/admin/setup";
import { buildSetupPreview } from "@/packages/workit-cli/src/logic";
import { createInitialDraft, reducer } from "@/packages/workit-cli/src/wizard-state";
import type { ToolkitConfig } from "@/packages/workit-core/src/core/config";

// #444: `workit init` merges. Entries the wizard does not edit keep every field
// byte-for-byte, key order included, so a hand-set entry never reads as reset.

/** A hand-written entry with every field set, keys in a non-schema order. */
const FULL = {
  name: "work",
  glob: "/home/u/work/**",
  autonomy: { push: true, pr: true, merge: "verified", release: false, rerun: true },
  defaultEndpoint: "green",
  verification: "independent",
  vcs: { account: "me", provider: "gitlab", defaultTargetBranch: "develop", extra: 1 },
  issues: { relation: "relates", provider: "youtrack", link: true },
  branchPolicy: { preset: "gitflow", developBranch: "develop", integration: "pr" },
  commitPolicy: { preset: "conventional" },
  trailers: false,
  youtrack: { link_issues: true, baseUrl: "https://yt.example" },
  models: { roles: { verifier: "sonnet" } },
  delegation: "lead-orchestrates",
  custom: { x: [1, 2] },
};
const NESTED = {
  name: "ri-web",
  glob: "/home/u/work/ri-web/**",
  commitPolicy: { preset: "conventional" },
  vcs: { provider: "github", account: "me-gh" },
  trailers: true,
};

const config: ToolkitConfig = {
  locale: "en",
  localeOptions: ["en"],
  branchPolicy: { preset: "gitflow", allowed: [], protected: ["main", "develop"] },
  commitPolicy: { preset: "conventional" },
};

let dir = "";
afterEach(() => {
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("init adding an entry keeps every other entry byte-for-byte", () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "workit-init-merge-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
  const file = path.join(dir, "workspaces.json");
  const original = { models: { roles: {} }, workspaces: [FULL, NESTED] };
  writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`);

  let draft = createInitialDraft(config);
  draft = reducer(draft, { type: "workspaceAddCurrent", path: "/home/u/work/libs/kit" });
  const preview = buildSetupPreview(draft.values, { dir, cwd: dir, env: {} });
  expect(preview.ok).toBe(true);
  applySetupPreview(preview, { configDir: dir, cwd: dir, env: {} });

  const written = readFileSync(file, "utf8");
  const parsed = JSON.parse(written) as { workspaces: unknown[]; models: unknown };
  expect(parsed.workspaces).toHaveLength(3);
  expect(parsed.models).toEqual({ roles: {} });
  // Byte-for-byte: the two untouched entries serialize exactly as written.
  const block = (entry: unknown) =>
    JSON.stringify(entry, null, 2)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")
      .trimStart();
  expect(written).toContain(block(FULL));
  expect(written).toContain(block(NESTED));
  expect((parsed.workspaces[2] as { name: string }).name).toBe("kit");
});
