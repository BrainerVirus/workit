import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";

const FIXTURES = path.resolve(import.meta.dir, "../../fixtures/hooks");

/** A native payload from test/fixtures/hooks/<host>/<name>.json, bound to `cwd`. */
export const fixture = (
  host: "claude-code" | "codex" | "cursor",
  name: string,
  cwd: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...JSON.parse(
    readFileSync(path.join(FIXTURES, host, `${name}.json`), "utf8").replaceAll("__CWD__", cwd),
  ),
  ...overrides,
});

export const tempRoot = (prefix = "workit-hooks-") => mkdtempSync(path.join(tmpdir(), prefix));

/** Protect `main` and allow `feature/*` for the duration of `run`. */
export const withProtectedMain = async (run: (configDir: string) => unknown): Promise<void> => {
  const keys = [
    "WORKFLOW_TOOLKIT_CONFIG",
    "WORKFLOW_TOOLKIT_CONFIG_DIR",
    "WORKFLOW_PROFILE",
    "WORKFLOW_WORKSPACE_NAME",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const configDir = tempRoot("workit-hooks-config-");
  for (const key of keys) delete process.env[key];
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = configDir;
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
  try {
    await run(configDir);
  } finally {
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    rmSync(configDir, { recursive: true, force: true });
  }
};

/** Start one active task in `root` owned by `caller`. */
export const startTask = (
  root: string,
  caller: OperationContext["caller"],
  objective = "hook protocol fixture task",
) => {
  const started = new WorkitCore(new TaskStore(root), {
    root,
    caller,
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  }).task(
    taskStartRequest({
      intent: {
        objective,
        scope: { description: "the checkout", paths: ["."], exclusions: [] },
        authorityRefs: [],
      },
    }),
  );
  if (!started.ok) throw new Error(started.error);
  return (started.data as { id: string }).id;
};
