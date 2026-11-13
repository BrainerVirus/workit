// Existing users (#819): with no seal at all, `workit upgrade` and
// `workit setup` at the user's terminal show the authority fields once and
// offer to seal them; y writes the seal, n leaves it. Never on a mismatch,
// never headless, in an agent's shell or under --json.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import type { GrantDeps } from "@/packages/workit-cli/src/verbs/grant";
import { offerFirstSeal } from "@/packages/workit-cli/src/upgrade/seal-offer";
import { resolveAutonomy } from "@/packages/workit-core/src/autonomy";
import { checkSeal, SEAL_FILE } from "@/packages/workit-core/src/core/grant-seal";
import { sealConfig, useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
const root = mkdtempSync(path.join(os.tmpdir(), "wk-seal-offer-")).replaceAll("\\", "/");
beforeAll(() => {
  configHome = useConfigHome("wk-seal-offer-config-", { seal: "manual" });
});
afterAll(() => {
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  for (const name of ["workspaces.json", SEAL_FILE])
    rmSync(path.join(configHome.configDir, name), { force: true });
});

const sealFile = () => path.join(configHome.configDir, SEAL_FILE);
const seed = (autonomy: Record<string, unknown>) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { name: "w", glob: `${root}/**`, vcs: { provider: "github", account: "me" }, autonomy },
      ],
    }),
  );
const deps = (answer: boolean, asked: string[], interactive = true): GrantDeps => ({
  interactive: () => interactive,
  ask: async () => "",
  confirm: async (question) => {
    asked.push(question);
    return answer;
  },
});
const io = (env: NodeJS.ProcessEnv = {}, json = false) => {
  let out = "";
  const value: Io = {
    json,
    cwd: root,
    env,
    stdout: (text) => void (out += text),
    stderr: (text) => void (out += text),
  };
  return { value, out: () => out };
};

test("Given no seal at all, When the user's terminal answers y, Then the fields are shown once and the seal is written", async () => {
  seed({ merge: "verified" });
  expect(resolveAutonomy(root).grants.merge).toBe(false);
  const asked: string[] = [];
  const shown = io();
  expect(await offerFirstSeal(shown.value, deps(true, asked))).toBe("sealed");
  expect(asked).toHaveLength(1);
  expect(shown.out()).toContain('autonomy={"merge":"verified"}');
  expect(checkSeal(configHome.configDir).state).toBe("valid");
  expect(resolveAutonomy(root).grants.merge).toBe("verified");
  // Sealed now: a later upgrade asks nothing.
  expect(await offerFirstSeal(io().value, deps(true, asked))).toBe("skipped");
  expect(asked).toHaveLength(1);
});

test("Given no seal, When the user answers n, Then nothing is written and the command to seal later is named", async () => {
  seed({ merge: "verified" });
  const shown = io();
  expect(await offerFirstSeal(shown.value, deps(false, []))).toBe("declined");
  expect(existsSync(sealFile())).toBe(false);
  expect(shown.out()).toContain("workit workspace seal");
});

test("Given a mismatched seal, a headless run, an agent shell or --json, Then nothing is offered", async () => {
  seed({ merge: false });
  sealConfig(configHome.configDir);
  seed({ merge: true });
  const before = readFileSync(sealFile(), "utf8");
  const asked: string[] = [];
  expect(await offerFirstSeal(io().value, deps(true, asked))).toBe("skipped");
  rmSync(sealFile());
  expect(await offerFirstSeal(io().value, deps(true, asked, false))).toBe("skipped");
  expect(await offerFirstSeal(io({ CLAUDECODE: "1" }).value, deps(true, asked))).toBe("skipped");
  expect(await offerFirstSeal(io({}, true).value, deps(true, asked))).toBe("skipped");
  expect(asked).toEqual([]);
  expect(existsSync(sealFile())).toBe(false);
  expect(before).toContain("sha256");
});
