import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseSpawnModel } from "@/packages/workit-core/src/core/role-models";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// The note on a replaced spawn names the exact model and effort to pass next
// time, so the lead's next spawn needs no rewrite.

let configHome: ConfigHome;
let cwd: string;
beforeAll(() => {
  configHome = useConfigHome("wk-role-models-");
  cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-role-models-cwd-")));
});
afterAll(() => {
  configHome.restore();
  rmSync(cwd, { recursive: true, force: true });
});

const withConfig = (models: unknown, run: () => void): void => {
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify({ models }));
  try {
    run();
  } finally {
    rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
  }
};

const accept = (model: string): string | null => model;

test("G explore set to haiku and a spawn passing sonnet, W the hook rewrites it, T the note names pass model: haiku", () => {
  withConfig({ roles: { explore: { claude_code: "haiku" } } }, () => {
    const choice = chooseSpawnModel(
      cwd,
      { role: "explore" },
      "claude_code",
      { model: "sonnet" },
      accept,
    );
    expect(choice.model).toBe("haiku");
    expect(choice.note).toContain("replaced model sonnet with haiku");
    expect(choice.note).toContain("pass model: haiku on the spawn");
    expect(choice.note).not.toContain("effort:");
  });
});

test("G explore set to haiku with effort low and a spawn passing sonnet, W the hook rewrites it, T the note names model and effort to pass", () => {
  withConfig({ roles: { explore: { claude_code: { model: "haiku", effort: "low" } } } }, () => {
    const choice = chooseSpawnModel(
      cwd,
      { role: "explore" },
      "claude_code",
      { model: "sonnet" },
      accept,
    );
    expect(choice.model).toBe("haiku");
    expect(choice.effort).toBe("low");
    expect(choice.note).toContain("pass model: haiku, effort: low on the spawn");
  });
});

test("G explore set to haiku and a spawn already passing haiku, W the hook runs, T nothing is rewritten and no note is made", () => {
  withConfig({ roles: { explore: { claude_code: "haiku" } } }, () => {
    const choice = chooseSpawnModel(
      cwd,
      { role: "explore" },
      "claude_code",
      { model: "haiku" },
      accept,
    );
    expect(choice.model).toBeNull();
    expect(choice.note).toBeNull();
  });
});
