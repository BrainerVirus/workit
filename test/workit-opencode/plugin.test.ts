import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import plugin from "@/packages/workit-opencode/src/plugin";

const packageSkills = path.resolve(import.meta.dir, "../../packages/workit-opencode/assets/skills");
const families = [
  "task",
  "policy",
  "evidence",
  "finding",
  "decision",
  "worker",
  "writer",
  "state",
] as const;

const pluginInput = {
  directory: "/repo",
  worktree: "/repo",
  serverUrl: new URL("http://localhost"),
};

test("the plugin module only exports the default OpenCode plugin", async () => {
  expect(Object.keys(await import("@/packages/workit-opencode/src/plugin"))).toEqual(["default"]);
});

test("registers the eight native operation tools plus init_apply", async () => {
  const hooks = await plugin(pluginInput as never);
  expect(Object.keys(hooks.tool ?? {})).toEqual([
    ...families.map((family) => `workit_${family}`),
    "workit_external_action",
    "workit_init_apply",
  ]);
});

test("config registers only the policy-selected method skills", async () => {
  const hooks = await plugin(pluginInput as never);
  const config: Record<string, any> = {};
  await hooks.config?.(config);
  expect(config.skills.paths).toEqual([packageSkills]);
  expect(readdirSync(packageSkills).sort()).toEqual([
    "workit-babysit",
    "workit-behavioral-tdd",
    "workit-blast-radius",
    "workit-challenge",
    "workit-debug",
    "workit-deslop",
    "workit-diagram",
    "workit-green-run",
    "workit-handoff",
    "workit-implement",
    "workit-mockup",
    "workit-plan",
    "workit-review",
    "workit-steer",
  ]);
  expect(Object.keys(config.command).sort()).toEqual([
    "babysit",
    "challenge",
    "debug",
    "implement",
    "plan",
  ]);
  expect(config.command.challenge.description).toContain("workit-challenge");
  expect(config.command.challenge.template).toContain("$ARGUMENTS");
});

test("skill registration is idempotent and worktree creation is denied", async () => {
  const hooks = await plugin(pluginInput as never);
  const config: Record<string, any> = {
    skills: { paths: [packageSkills] },
    permission: { bash: { "git status *": "allow" } },
  };
  await hooks.config?.(config);
  await hooks.config?.(config);
  expect(config.skills.paths).toEqual([packageSkills]);
  expect(config.permission.bash).toEqual({
    "git status *": "allow",
    "*git *worktree*": "deny",
  });
});

test("each native tool returns a standard contract envelope for invalid input", async () => {
  const hooks = await plugin({
    ...pluginInput,
    client: { session: { get: async () => ({ data: {} }) } },
  } as never);
  for (const family of families) {
    const raw = await hooks.tool?.[`workit_${family}`].execute(
      { schemaVersion: 1, action: "not-a-real-action" },
      { ...pluginInput, sessionID: "plugin-test" } as never,
    );
    expect(JSON.parse(raw as string), family).toMatchObject({ ok: false });
  }
});

test("config preserves user-defined commands of the same name", async () => {
  const hooks = await plugin(pluginInput as never);
  const config: Record<string, any> = { command: { challenge: { description: "mine" } } };
  await hooks.config?.(config);
  expect(config.command.challenge).toEqual({ description: "mine" });
  expect(Object.keys(config.command)).toContain("debug");
});
