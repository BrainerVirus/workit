import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Runtime parity for the Cursor launcher + session hook: both execute
// Node-compatible TS entries, and session start performs NO network sync
// (RL-09/CA-25) — a network-unavailable environment must not change behavior.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CURSOR_ROOT = path.join(REPO_ROOT, "packages", "workit-cursor");

const contractText = `# Superpowers doc contract

- Deliver docs as clickable markdown links.
- [spec.md](docs/<slug>/spec.md) + 3-5 bullet summary.
`;

function runEntry(args: string[], env: Record<string, string>): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

test("hooks/session-start executes a Node-compatible TS entry with the contract injected", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-hook-root-"));
  mkdirSync(path.join(root, "templates"), { recursive: true });
  writeFileSync(path.join(root, "templates", "superpowers-doc-contract.md"), contractText);
  try {
    const env = {
      ...process.env,
      WORKFLOW_TOOLKIT_ROOT: root,
      BUN: process.execPath,
    } as Record<string, string>;
    const direct = runEntry([path.join(CURSOR_ROOT, "hooks", "session-start.ts")], env);
    expect(direct.status, direct.stdout).toBe(0);
    const parsed = JSON.parse(direct.stdout);
    expect(parsed.additional_context).toContain("HARD-GATE");
    expect(parsed.additional_context).toContain("never A/B/C or 1/2/3 lists in prose");
    expect(parsed.additional_context).toContain(contractText.trim());

    // the manifest-facing shim produces the same JSON
    const shim = spawnSync("bash", [path.join(CURSOR_ROOT, "hooks", "session-start")], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
    expect(shim.status, shim.stderr ?? "").toBe(0);
    expect((shim.stdout ?? "").trim()).toBe(direct.stdout.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session start performs no network sync — network-unavailable behavior is identical", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-hook-offline-"));
  mkdirSync(path.join(root, "templates"), { recursive: true });
  writeFileSync(path.join(root, "templates", "superpowers-doc-contract.md"), contractText);
  const emptyBin = mkdtempSync(path.join(os.tmpdir(), "wf-hook-bin-"));
  try {
    const normal = runEntry([path.join(CURSOR_ROOT, "hooks", "session-start.ts")], {
      ...process.env,
      WORKFLOW_TOOLKIT_ROOT: root,
    });
    // PATH holds no git/rsync/flock/npm/curl: the hook cannot reach the network
    // even if it tried. It must produce the exact same JSON.
    const offline = runEntry([path.join(CURSOR_ROOT, "hooks", "session-start.ts")], {
      ...process.env,
      WORKFLOW_TOOLKIT_ROOT: root,
      PATH: emptyBin,
      BUN: process.execPath,
    });
    expect(offline.status, offline.stdout).toBe(0);
    expect(offline.stdout).toBe(normal.stdout);
    expect(JSON.parse(offline.stdout).additional_context).toContain("HARD-GATE");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("session start with a missing contract reports it without pretending success", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-hook-empty-"));
  try {
    // WORKFLOW_TOOLKIT_ROOT points at a root whose templates dir exists but the
    // contract file is absent: the hook must output {} (fail-open), not error.
    mkdirSync(path.join(root, "templates"), { recursive: true });
    const r = runEntry([path.join(CURSOR_ROOT, "hooks", "session-start.ts")], {
      ...process.env,
      WORKFLOW_TOOLKIT_ROOT: root,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the TS hook and launcher sources perform no network I/O", () => {
  for (const file of [
    path.join(CURSOR_ROOT, "hooks", "session-start.ts"),
    path.join(CURSOR_ROOT, "mcp", "run-server.ts"),
  ]) {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(/fetch\s*\(/);
    expect(src).not.toContain("child_process");
    expect(src).not.toContain("sync-runtime");
    expect(src).not.toMatch(/git\s+(fetch|pull|clone)/);
    expect(src).not.toMatch(/\b(?:rsync|flock|npm install|curl)\b/);
  }
  const shim = readFileSync(path.join(CURSOR_ROOT, "hooks", "session-start"), "utf8");
  expect(shim).not.toContain("sync-runtime");
  expect(shim).not.toMatch(/git fetch|git pull|rsync|npm install/);
  const launcher = readFileSync(path.join(CURSOR_ROOT, "mcp", "run-server.sh"), "utf8");
  expect(launcher).toContain("run-server.ts");
  expect(launcher).not.toContain("sync-runtime");
});

test("mcp/run-server.sh launches the MCP server through the TS entry (initialize + tools/list)", async () => {
  const child = spawn("bash", [path.join(CURSOR_ROOT, "mcp", "run-server.sh")], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BUN: process.execPath },
  });
  let buffer = "";
  const pending = new Map<number, (value: unknown) => void>();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
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
        newline = buffer.indexOf("\n");
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
  child.stderr?.on("data", () => {});
  const nextId = { id: 0 };
  const request = (method: string, params: unknown) => {
    const id = ++nextId.id;
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    });
  };
  try {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "runtime-parity", version: "1.0" },
    });
    expect((init as any).result.serverInfo.name).toBe("workit");
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await request("tools/list", {});
    const names = ((listed as any).result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("workflow_verify");
    expect(names).toContain("workflow_pr_context");
    expect(names).toContain("workflow_changelog_context");
  } finally {
    child.kill();
  }
});
