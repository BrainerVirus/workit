import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The external-action descriptor is the hashed approval binding. It must be
// identical no matter which process timezone resolves it, so an action approved
// in one process (TZ=America/Santiago) still matches when it executes in
// another (TZ=UTC). Each phase runs in its own process with TZ set, because
// runtimes cache the default Intl timezone.
const EFFECTS = path.resolve(
  import.meta.dir,
  "../../packages/workit-core/src/core/external-action-effects.ts",
);
const ACTION = path.resolve(
  import.meta.dir,
  "../../packages/workit-core/src/core/external-action.ts",
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "wf-yt-desc-tz-"));
  const tokenPath = path.join(root, "youtrack.token");
  writeFileSync(tokenPath, "test-token\n");
  chmodSync(tokenPath, 0o600);
  // No youtrack.json timezone: the process timezone decides "auto".
  writeFileSync(
    path.join(root, "youtrack.json"),
    JSON.stringify({ baseUrl: "https://yt.example.test", tokenFile: tokenPath }),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const runInTz = (tz: string, script: string, extraEnv: Record<string, string> = {}): any => {
  const out = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: {
      ...process.env,
      TZ: tz,
      WORKFLOW_YOUTRACK_CONFIG: path.join(root, "youtrack.json"),
      WORKFLOW_YT_WRITE: "1",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return JSON.parse(out.stdout.toString().trim().split("\n").at(-1) ?? "null");
};

const resolveScript = (request: unknown): string => `
const { resolveExternalActionRequest } = await import(${JSON.stringify(EFFECTS)});
const { externalActionDescriptor } = await import(${JSON.stringify(ACTION)});
const resolved = resolveExternalActionRequest(${JSON.stringify(root)}, ${JSON.stringify(request)});
if (!resolved.ok) { console.log(JSON.stringify({ error: resolved })); process.exit(0); }
console.log(JSON.stringify({
  resolved: resolved.data,
  descriptor: externalActionDescriptor(resolved.data.request.operation, resolved.data.descriptorPayload),
}));`;

const executeScript = (approved: unknown): string => `
const { executeResolvedExternalAction } = await import(${JSON.stringify(EFFECTS)});
globalThis.fetch = async (input, init) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ id: "item-1", idReadable: "ABC-1" }),
});
const result = await executeResolvedExternalAction(${JSON.stringify(approved)}, ${JSON.stringify(root)});
console.log(JSON.stringify(result));`;

const TIME_REQUEST = {
  operation: "youtrack.time",
  payload: { issueId: "ABC-1", minutes: 30, text: "work", dateMs: Date.UTC(2026, 9, 3) },
};

test("Given the same youtrack.time request, When it is resolved under different process timezones, Then the hashed descriptor is identical and carries no workDate", () => {
  const santiago = runInTz("America/Santiago", resolveScript(TIME_REQUEST));
  const tokyo = runInTz("Asia/Tokyo", resolveScript(TIME_REQUEST));
  const utc = runInTz("UTC", resolveScript(TIME_REQUEST));
  expect(santiago.error).toBeUndefined();
  expect(santiago.descriptor).toBe(tokyo.descriptor);
  expect(santiago.descriptor).toBe(utc.descriptor);
  // Old (pre-workDate) descriptor shape: the hashed payload has no workDate.
  expect(santiago.resolved.descriptorPayload.resolved).not.toHaveProperty("workDate");
  expect(santiago.descriptor).not.toContain("workDate");
  // The effective zone is still surfaced, beside the hashed payload.
  expect(santiago.resolved.workDate).toEqual({
    localDate: "2026-10-03",
    timezone: "America/Santiago",
    timezoneSource: "process",
  });
  expect(utc.resolved.workDate.timezone).toBe("UTC");
});

test("Given a youtrack.time action approved under TZ=America/Santiago, When it executes under TZ=UTC with the same dateMs, Then the approved target still matches", () => {
  const approved = runInTz("America/Santiago", resolveScript(TIME_REQUEST)).resolved;
  const result = runInTz("UTC", executeScript(approved));
  expect(JSON.stringify(result)).not.toContain("target changed");
  expect(result.ok).toBe(true);
});

test("Given an approved youtrack.update in the old descriptor shape (no workDate), When it executes under another timezone, Then it still matches", () => {
  const request = {
    operation: "youtrack.update",
    payload: { issueId: "ABC-1", markdown: "Approved update" },
  };
  const approved = runInTz("America/Santiago", resolveScript(request)).resolved;
  // Strip the display-only field: a descriptor recorded before it existed.
  const { workDate: _display, ...oldShape } = approved;
  expect(oldShape.descriptorPayload.resolved).not.toHaveProperty("workDate");
  const result = runInTz("UTC", executeScript(oldShape));
  expect(JSON.stringify(result)).not.toContain("target changed");
  expect(result.ok).toBe(true);
});
