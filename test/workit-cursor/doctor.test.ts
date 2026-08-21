import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDoctor, type DoctorReport } from "../../packages/workit-core/src/core/doctor";
import { makeDoctorFixture } from "../shared/helpers/doctor-fixture";

// workit_doctor on the Cursor host (DG-07): same report shape, consistent
// nonzero on broken fixtures, host stays usable, no canary reaches stderr logs.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

const fixture = makeDoctorFixture();
afterAll(() => fixture.cleanup());

type ServerProcess = {
  child: ChildProcess;
  request: (method: string, params: unknown) => Promise<any>;
  stderr: string[];
};

function startServer(extra: Record<string, string> = {}): ServerProcess {
  const child = spawn("bun", ["packages/workit-cursor/mcp/server.ts"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: fixture.home,
      WORKFLOW_TOOLKIT_CONFIG: fixture.configDir,
      WORKFLOW_TOOLKIT_STATE: fixture.stateDir,
      WORKFLOW_TOOLKIT_DEV: fixture.dev,
      ...extra,
    },
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.trim()) stderr.push(line.trim());
  });
  let buffer = "";
  const pending = new Map<number, (value: unknown) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
      newline = buffer.indexOf("\n");
    }
  });
  const nextId = { id: 0 };
  const request = (method: string, params: unknown) => {
    const id = ++nextId.id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    });
  };
  return { child, request, stderr };
}

async function initialize(server: ServerProcess) {
  await server.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
  server.child.stdin!.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
}

const direct = () =>
  runDoctor({
    host: "cursor",
    cwd: fixture.cwd,
    home: fixture.home,
    configDir: fixture.configDir,
    stateDir: fixture.stateDir,
    dev: fixture.dev,
  });

test("workit_doctor returns the same report shape and reflects health", async () => {
  const server = startServer();
  try {
    await initialize(server);
    const response = await server.request("tools/call", {
      name: "workit_doctor",
      arguments: { workspace_root: fixture.cwd },
    });
    const result = (response as any).result;
    expect(result.isError).not.toBe(true);
    const report = JSON.parse(result.content?.[0]?.text ?? "{}") as DoctorReport;
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.offline).toBe(true);
    expect(report.host).toBe("cursor");
    expect(report.checks.map((c) => [c.id, c.status])).toEqual(
      direct().checks.map((c) => [c.id, c.status]),
    );
    expect(report.summary).toEqual(direct().summary);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      exitCode: 0,
      offline: true,
      host: "cursor",
    });
  } finally {
    server.child.kill();
  }
});

test("forced broken fixture yields consistent nonzero and the host stays usable", async () => {
  writeFileSync(
    fixture.cursorSettings,
    JSON.stringify({
      enabled_plugins: { workit: true, "workflow-toolkit": true },
      plugin_dirs: [fixture.pluginDir],
    }),
  );
  const server = startServer();
  try {
    await initialize(server);
    const response = await server.request("tools/call", {
      name: "workit_doctor",
      arguments: { workspace_root: fixture.cwd },
    });
    const result = (response as any).result;
    const report = JSON.parse(result.content?.[0]?.text ?? "{}") as DoctorReport;
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(
      report.checks.some((c) => c.id === "duplicate_registration" && c.status === "fail"),
    ).toBe(true);
    expect(report.checks.map((c) => [c.id, c.status])).toEqual(
      direct().checks.map((c) => [c.id, c.status]),
    );

    // host remains usable: a sibling tool still executes
    const git = await server.request("tools/call", {
      name: "workit_git_context",
      arguments: { workspace_root: fixture.cwd },
    });
    expect((git as any).result.isError).not.toBe(true);
    expect((git as any).result.content?.[0]?.text).toBeDefined();
  } finally {
    writeFileSync(
      fixture.cursorSettings,
      JSON.stringify({
        enabled_plugins: { workit: true },
        plugin_dirs: [fixture.pluginDir],
      }),
    );
    server.child.kill();
  }
});

test("no canary reaches stderr logs or the report", async () => {
  const tokenFile = path.join(fixture.configDir, "youtrack.token");
  const youtrackJson = path.join(fixture.configDir, "youtrack.json");
  mkdirSync(fixture.configDir, { recursive: true });
  writeFileSync(youtrackJson, JSON.stringify({ tokenFile }));
  writeFileSync(tokenFile, "sk-live-88\n", { mode: 0o600 });

  const server = startServer();
  try {
    await initialize(server);
    const response = await server.request("tools/call", {
      name: "workit_doctor",
      arguments: { workspace_root: fixture.cwd },
    });
    const raw = JSON.stringify((response as any).result);
    expect(raw).not.toContain("sk-live-88");
    const rawStderr = server.stderr.join("\n");
    expect(rawStderr).not.toContain("sk-live-88");
  } finally {
    server.child.kill();
  }
});
