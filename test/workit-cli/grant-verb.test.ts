import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { runGrant, type GrantDeps } from "@/packages/workit-cli/src/verbs/grant";

// `workit grant` (S16; D4, D15): agents may lower their own ceiling, but a
// raise needs the user at an interactive terminal typing the workspace name.

let configDir = "";
let checkout = "";
let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-grant-config-");
  configDir = configHome.configDir;
});
afterAll(() => {
  configHome.restore();
});

const file = () => path.join(configDir, "workspaces.json");
const backup = () => `${file()}.bak`;

const writeWorkspace = (extra: Record<string, unknown> = {}) =>
  writeFileSync(
    file(),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${checkout.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
          ...extra,
        },
      ],
    }),
  );
const entry = () => JSON.parse(readFileSync(file(), "utf8")).workspaces[0];

beforeEach(() => {
  checkout = mkdtempSync(path.join(os.tmpdir(), "wk-grant-checkout-"));
  mkdirSync(path.join(checkout, "repo"), { recursive: true });
  writeWorkspace();
});
afterEach(() => {
  for (const name of [file(), backup()]) rmSync(name, { force: true });
  rmSync(checkout, { recursive: true, force: true });
});

const headless: GrantDeps = {
  interactive: () => false,
  ask: async () => {
    throw new Error("a headless call must never prompt");
  },
};
const interactive = (answer: string, asked: string[] = []): GrantDeps => ({
  interactive: () => true,
  ask: async (question) => {
    asked.push(question);
    return answer;
  },
});

const run = async (argv: string[], deps: GrantDeps, env: NodeJS.ProcessEnv = {}) => {
  let stdout = "";
  const io: Io = {
    json: true,
    cwd: path.join(checkout, "repo"),
    // Never inherit the runner's env: it may carry an agent marker such as CLAUDECODE.
    env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await runGrant(argv, io, deps);
  return { code, json: () => JSON.parse(stdout) };
};

test("grant show: a workspace without grants reports the D4 defaults", async () => {
  const result = await run(["show"], headless);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    workspace: "w",
    grants: { push: true, pr: true, merge: false, release: false, rerun: true },
    configured: [],
    source: "default",
    defaultEndpoint: "commit",
  });
  const named = await run(["show", "w"], headless);
  expect(named.json().data.workspaces).toEqual([
    expect.objectContaining({ name: "w", configured: [], grants: expect.any(Object) }),
  ]);
});

test("grant set: raising merge=verified headless is refused and nothing is written", async () => {
  const before = readFileSync(file(), "utf8");
  const result = await run(["set", "w", "merge=verified"], headless);
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ ok: false, code: "blocked" });
  expect(result.json().error).toContain("grant_raise_refused");
  expect(result.json().unblock).toContain("workit grant set w merge=verified");
  expect(readFileSync(file(), "utf8")).toBe(before);
  expect(existsSync(backup())).toBe(false);
});

test("grant set: an agent shell (CLAUDECODE=1) is refused even when interactive", async () => {
  const before = readFileSync(file(), "utf8");
  const asked: string[] = [];
  const result = await run(["set", "w", "merge=verified"], interactive("w", asked), {
    CLAUDECODE: "1",
  });
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ ok: false, code: "blocked" });
  expect(result.json().error).toContain("CLAUDECODE");
  expect(result.json().unblock).toContain("workit grant set w merge=verified");
  expect(asked).toEqual([]);
  expect(readFileSync(file(), "utf8")).toBe(before);
});

test("grant set: interactive and confirmed by the workspace name writes the raise with a backup", async () => {
  const before = readFileSync(file(), "utf8");
  const asked: string[] = [];
  const result = await run(["set", "w", "merge=verified"], interactive("w\n", asked));
  expect(result.code).toBe(0);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('workspace "w"');
  expect(result.json().data).toMatchObject({
    workspace: "w",
    grants: { merge: "verified" },
    configured: ["merge"],
    backup: backup(),
  });
  expect(entry().autonomy).toEqual({ merge: "verified" });
  expect(readFileSync(backup(), "utf8")).toBe(before);
});

test("grant set: interactive with the wrong confirmation writes nothing", async () => {
  const before = readFileSync(file(), "utf8");
  const result = await run(["set", "w", "merge=verified"], interactive("yes"));
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ ok: false, code: "blocked" });
  expect(result.json().error).toContain("not confirmed");
  expect(readFileSync(file(), "utf8")).toBe(before);
  expect(existsSync(backup())).toBe(false);
});

test("grant set: lowering (push=false) succeeds headless", async () => {
  const result = await run(["set", "w", "push=false"], headless);
  expect(result.code).toBe(0);
  expect(result.json().data.grants).toMatchObject({ push: false });
  expect(entry().autonomy).toEqual({ push: false });
});

test("grant unset: removing a grant returns the kind to its default", async () => {
  writeWorkspace({ autonomy: { push: false, merge: "verified" } });
  const result = await run(["unset", "w", "merge"], headless);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({ grants: { merge: false }, configured: ["push"] });
  expect(entry().autonomy).toEqual({ push: false });
  // Unsetting the last grant drops the autonomy block; unsetting push=false raises it back
  // to the default, which is refused headless.
  const raise = await run(["unset", "w", "push"], headless);
  expect(raise.code).toBe(3);
  expect(entry().autonomy).toEqual({ push: false });
});

test("grant set: defaultEndpoint=pr is a raise; commit and unset are allowed headless", async () => {
  const before = readFileSync(file(), "utf8");
  const raise = await run(["set", "w", "defaultEndpoint=pr"], headless);
  expect(raise.code).toBe(3);
  expect(raise.json().error).toContain("defaultEndpoint");
  expect(readFileSync(file(), "utf8")).toBe(before);

  writeWorkspace({ defaultEndpoint: "pr" });
  const lower = await run(["set", "w", "defaultEndpoint=commit"], headless);
  expect(lower.code).toBe(0);
  expect(lower.json().data.defaultEndpoint).toBe("commit");
  expect(entry().defaultEndpoint).toBeUndefined();

  writeWorkspace({ defaultEndpoint: "pr" });
  const unset = await run(["unset", "w", "defaultEndpoint"], headless);
  expect(unset.code).toBe(0);
  expect(entry().defaultEndpoint).toBeUndefined();
});

test("grant set: a legacy autoApprove is folded into autonomy on write", async () => {
  writeWorkspace({ autoApprove: ["push", "merge"] });
  const shown = await run(["show"], headless);
  expect(shown.json().data).toMatchObject({
    source: "autoApprove",
    // A standing merge approval keeps the verdict gate (review L1).
    grants: { push: true, merge: "verified" },
  });
  const result = await run(["set", "w", "pr=false"], headless);
  expect(result.code).toBe(0);
  expect(entry().autoApprove).toBeUndefined();
  expect(entry().autonomy).toEqual({ push: true, pr: false, merge: "verified" });
});

test("grant set: autonomy keys this version does not know are preserved", async () => {
  writeWorkspace({ autonomy: { push: true, deploy: "staging" } });
  const result = await run(["set", "w", "pr=false"], headless);
  expect(result.code).toBe(0);
  expect(entry().autonomy).toEqual({ deploy: "staging", push: true, pr: false });
});

test("grant show --json carries defaultEndpoint", async () => {
  writeWorkspace({ defaultEndpoint: "pr" });
  const shown = await run(["show"], headless);
  expect(shown.json().data.defaultEndpoint).toBe("pr");
});
