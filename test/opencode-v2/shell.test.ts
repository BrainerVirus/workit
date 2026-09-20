import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import definition from "@/packages/workit-opencode/src/v2/plugin";

/** The exact 10 registered Workit tool names in registration order. */
const TOOL_NAMES = [
  "workit_task",
  "workit_policy",
  "workit_evidence",
  "workit_finding",
  "workit_decision",
  "workit_worker",
  "workit_writer",
  "workit_state",
  "workit_external_action",
  "workit_init_apply",
];

type Registered = {
  name: string;
  description: string;
  input: Record<string, any>;
  options?: { codemode?: boolean };
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content?: string }>;
};

const repository = (branch = "feature/v2-shell") => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-v2-shell-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q", "-b", branch]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Workit Test"]);
  writeFileSync(path.join(root, "base.txt"), "base\n");
  git(["add", "base.txt"]);
  git(["commit", "-qm", "base"]);
  return root;
};

const harness = async (
  root: string,
  options: { parentID?: string; sessionDirectory?: string } = {},
) => {
  const registered: Registered[] = [];
  const ctx = {
    location: { directory: root },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        ...(options.parentID ? { parentID: options.parentID } : {}),
        location: { directory: options.sessionDirectory ?? root },
      }),
    },
    tool: {
      transform: async (fn: (editor: unknown) => void) => {
        const editor = {
          add: (tool: Registered) => registered.push(tool),
          list: () => registered,
          get: (id: string) => registered.find((tool) => tool.name === id),
          namespace: () => {},
          update: () => {},
          remove: () => {},
        };
        await fn(editor);
        return { dispose: async () => {} };
      },
    },
  };
  const cleanup = await definition.setup(ctx as never);
  const call = async (name: string, input: unknown, sessionID = "ses_v2") => {
    const tool = registered.find((entry) => entry.name === name);
    if (!tool) throw new Error(`tool ${name} is not registered`);
    const result = await tool.execute(input, { sessionID });
    return JSON.parse(result.content ?? "null");
  };
  return { registered, cleanup, call };
};

test("the V2 definition carries the stable workit id and setup", () => {
  expect(definition.id).toBe("workit");
  expect(typeof definition.setup).toBe("function");
});

test("setup registers the exact 10 tools with codemode off and object schemas", async () => {
  const root = repository();
  try {
    const { registered, cleanup } = await harness(root);
    expect(registered.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const tool of registered) {
      expect(tool.options?.codemode, tool.name).toBe(false);
      expect(tool.input.type, tool.name).toBe("object");
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
    }
    const external = registered.find((tool) => tool.name === "workit_external_action");
    expect(external?.input.properties.operation.enum).toEqual([
      "git.branch_setup",
      "git.commit",
      "git.push",
      "hosting.pull_request",
      "hosting.merge",
      "youtrack.update",
      "youtrack.time",
      "youtrack.meeting",
      "changelog.apply",
      "context.read",
    ]);
    expect(external?.input.required).toEqual(["operation", "payload"]);
    const init = registered.find((tool) => tool.name === "workit_init_apply");
    expect(init?.input.required).toEqual(["confirmed", "action"]);
    expect(init?.input.properties.action.enum).toContain("branch_policy");
    expect(cleanup).toBeFunction();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("family tools execute against the session checkout", async () => {
  const root = repository();
  try {
    const { call } = await harness(root);
    const intent = {
      objective: "V2 shell probe",
      scope: { description: "shell", paths: ["docs"], exclusions: [] },
      authorityRefs: [],
    };
    const started = await call("workit_task", { schemaVersion: 1, action: "start", intent });
    expect(started.ok).toBe(true);
    const listed = await call("workit_task", { schemaVersion: 1, action: "list" });
    expect(listed.ok).toBe(true);
    expect(listed.data).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreign session locations and child sessions are denied", async () => {
  const root = repository();
  const other = mkdtempSync(path.join(os.tmpdir(), "workit-v2-other-"));
  try {
    const foreign = await harness(root, { sessionDirectory: other });
    const denied = await foreign.call("workit_task", { schemaVersion: 1, action: "list" });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("session location");

    const child = await harness(root, { parentID: "ses_parent" });
    const blocked = await child.call("workit_task", { schemaVersion: 1, action: "list" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("child sessions");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("workit_external_action runs context.read and refuses unported mutations", async () => {
  const root = repository();
  try {
    const { call } = await harness(root);
    const read = await call("workit_external_action", {
      operation: "context.read",
      payload: { kind: "git" },
    });
    expect(read.ok).toBe(true);
    const mutation = await call("workit_external_action", {
      operation: "git.commit",
      payload: { message: "chore: probe" },
    });
    expect(mutation.ok).toBe(false);
    expect(mutation.code).toBe("capability_unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workit_init_apply runs the shared confirmed executor", async () => {
  const root = repository();
  try {
    const { call } = await harness(root);
    const applied = await call("workit_init_apply", { confirmed: true, action: "gitignore" });
    expect(applied.ok).toBe(true);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
