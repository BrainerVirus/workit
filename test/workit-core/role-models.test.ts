import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chooseSpawnModel,
  claudeSpawnTable,
  roleEnforcement,
  roleForAgentType,
  roleModelIssues,
} from "@/packages/workit-core/src/core/role-models";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// D1: a model the spawn names wins unless models.enforce is strict. Under
// strict, the note on a replaced spawn names the exact model and effort to
// pass next time, so the lead's next spawn needs no rewrite.

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

test("G explore set to haiku and no enforce mode, W a spawn passes sonnet, T sonnet stays and nothing is noted", () => {
  withConfig({ roles: { explore: { claude_code: "haiku" } } }, () => {
    const choice = chooseSpawnModel(
      cwd,
      { role: "explore" },
      "claude_code",
      { model: "sonnet" },
      accept,
    );
    expect(choice).toEqual({ model: null, effort: null, note: null, basis: null });
  });
});

test("G explore set to haiku under enforce strict and a spawn passing sonnet, W the hook rewrites it, T the note names pass model: haiku", () => {
  withConfig({ enforce: "strict", roles: { explore: { claude_code: "haiku" } } }, () => {
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

test("G explore set to haiku with effort low under enforce strict and a spawn passing sonnet, W the hook rewrites it, T the note names model and effort to pass", () => {
  withConfig(
    { enforce: "strict", roles: { explore: { claude_code: { model: "haiku", effort: "low" } } } },
    () => {
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
    },
  );
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

test("G Workit agent names on any host, W roleForAgentType reads them, T workit:babysitter and workit-decider map to their roles", () => {
  expect(roleForAgentType("workit:babysitter")).toEqual({ role: "babysit" });
  expect(roleForAgentType("workit-babysitter")).toEqual({ role: "babysit" });
  expect(roleForAgentType("workit:decider")).toEqual({ role: "decider" });
  expect(roleForAgentType("workit:verifierter")).toBeNull();
});

test("G no models config, W the SessionStart spawn line renders, T it says spawn by name and pass no model, listing no role", () => {
  const line = claudeSpawnTable(cwd);
  expect(line).toContain("Spawn Workit roles by name (workit:implementer, workit:verifier");
  expect(line).toContain("workit:decider, workit:babysitter; search: Explore");
  expect(line).toContain("pass no model or effort unless the user named one.");
  expect(line).not.toContain("configured here");
});

test("G roles configured to differ from their agent files, W the SessionStart spawn line renders, T only those roles are listed", () => {
  withConfig(
    {
      roles: {
        verifier: "opus",
        reviewer: "opus",
        explore: "haiku",
        decider: { model: "fable", effort: "high" },
      },
    },
    () => {
      const line = claudeSpawnTable(cwd);
      expect(line).toContain("configured here (pass them): workit:verifier opus, Explore haiku.");
      expect(line).not.toContain("workit:reviewer opus");
      expect(line).not.toContain("workit:decider fable");
    },
  );
});

test("G each host, W roleEnforcement reads a role, T it names agent file, spawn fill or advisory", () => {
  const of = (role: "verifier" | "explore" | "default" | "decider", host: string) =>
    roleEnforcement(cwd, { role }, host);
  expect(of("verifier", "claude_code")).toBe("agent file");
  expect(of("decider", "opencode")).toBe("agent file");
  expect(of("decider", "codex")).toBe("agent file");
  expect(of("verifier", "cursor")).toBe("agent file");
  expect(of("default", "opencode")).toBe("spawn fill");
  expect(of("explore", "pi")).toBe("spawn fill");
  expect(of("default", "codex")).toBe("advisory");
  expect(roleEnforcement(cwd, "lead", "claude_code")).toBe("advisory");
  withConfig({ roles: { verifier: "opus", explore: "haiku" } }, () => {
    expect(of("verifier", "claude_code")).toBe("spawn fill");
    expect(of("explore", "claude_code")).toBe("spawn fill");
  });
});

test("G models.enforce set to an unknown mode, W roleModelIssues runs, T it is reported and read as advise", () => {
  withConfig({ enforce: "always" }, () => {
    expect(roleModelIssues(cwd)).toContain(
      'global default models.enforce: not "advise" or "strict"; read as advise',
    );
  });
});
