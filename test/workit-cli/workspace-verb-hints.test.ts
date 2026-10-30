import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grantsDir, grantsOverride } from "@/packages/workit-core/src/autonomy";
import { configFilePath } from "@/packages/workit-core/src/core/config";
import type { Io } from "@/packages/workit-cli/src/output";
import { runWorkspace } from "@/packages/workit-cli/src/verbs/workspace";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-workspace-hints-");
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "work", glob: "/tmp/nowhere/**" }] }),
  );
});
afterAll(() => configHome.restore());

const set = async (spec: string) => {
  let stdout = "";
  const io: Io = {
    json: true,
    cwd: os.tmpdir(),
    env: { CLAUDECODE: "1" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await runWorkspace(["set", "work", spec], io);
  return { code, out: JSON.parse(stdout) as { code: string; error: string } };
};

test("set path=x exits 2 and points at glob, the workspaces.json path and workspace add", async () => {
  const result = await set("path=x");
  expect(result.code).toBe(2);
  expect(result.out.code).toBe("invalid_input");
  expect(result.out.error).toContain("glob");
  expect(result.out.error).toContain(path.join(configHome.configDir, "workspaces.json"));
  expect(result.out.error).toContain("workspace add <name> --glob <g> --from <workspace>");
});

test("set branchpolicy=x suggests branchPolicy", async () => {
  const result = await set("branchpolicy=x");
  expect(result.code).toBe(2);
  expect(result.out.error).toContain("did you mean branchPolicy?");
});

test("a redirected config dir names that dir; the grants note names the account home", () => {
  const saved = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const redirected = mkdtempSync(path.join(os.tmpdir(), "wk-redirect-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG = redirected;
  try {
    expect(configFilePath("vcs.json")).toBe(path.join(redirected, "vcs.json"));
    const note = grantsOverride() ?? "";
    expect(note).toContain(path.join(grantsDir(), "workspaces.json"));
    expect(note).toContain("does not apply to grants");
  } finally {
    process.env.WORKFLOW_TOOLKIT_CONFIG = saved;
    rmSync(redirected, { recursive: true, force: true });
  }
});
