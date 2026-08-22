import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wf-migrate-cur-"));
const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const legacySpec = (name: string) => `# Spec ${name}\n\n**Branch:** \`feature/${name}\`\n`;
const legacyPlan = (name: string) =>
  `# Plan ${name}\n\n**Spec:** \`docs/superpowers/${name}/spec.md\`\n**Branch:** \`feature/${name}\`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n`;

const putLegacy = (root: string, name: string) => {
  mkdirSync(path.join(root, "docs", "superpowers", name), { recursive: true });
  writeFileSync(path.join(root, "docs", "superpowers", name, "spec.md"), legacySpec(name), "utf8");
  writeFileSync(path.join(root, "docs", "superpowers", name, "plan.md"), legacyPlan(name), "utf8");
};

function startServer() {
  const child = spawn("bun", ["packages/workit-cursor/mcp/server.ts"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
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
  child.stderr.on("data", () => {});
  const nextId = { id: 0 };
  const request = (method: string, params: unknown) => {
    const id = ++nextId.id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    });
  };
  return { child, request };
}

const call = async (request: any, name: string, arguments_: Record<string, unknown>) => {
  const res = await request("tools/call", { name, arguments: arguments_ });
  return JSON.parse((res as any).result.content?.[0]?.text ?? "{}");
};

test("cursor MCP migrate exposes the exact native question choices", async () => {
  const root = tmp();
  const { child, request } = startServer();
  try {
    putLegacy(root, "foo");
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const out = await call(request, "workit_docs_layout", {
      action: "migrate",
      slug: "foo",
      workspace_root: root,
    });
    expect(out.action).toBe("migrate");
    expect(out.stage).toBe("awaiting_confirmation");
    expect(out.question.options).toEqual(["Migrate safely", "Not now"]);
    expect(existsSync(path.join(root, "docs", "foo"))).toBe(false);
  } finally {
    child.kill();
    cleanup(root);
  }
});

test("cursor MCP Not now declines without writes", async () => {
  const root = tmp();
  const { child, request } = startServer();
  try {
    putLegacy(root, "foo");
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const out = await call(request, "workit_docs_layout", {
      action: "migrate",
      slug: "foo",
      confirmed: false,
      workspace_root: root,
    });
    expect(out.stage).toBe("declined");
    expect(out.active_workflow).toBe(true);
    expect(existsSync(path.join(root, "docs", "foo"))).toBe(false);
  } finally {
    child.kill();
    cleanup(root);
  }
});

test("cursor MCP Migrate safely copies the workflow like the opencode adapter", async () => {
  const root = tmp();
  const { child, request } = startServer();
  try {
    putLegacy(root, "foo");
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const out = await call(request, "workit_docs_layout", {
      action: "migrate",
      slug: "foo",
      confirmed: true,
      workspace_root: root,
    });
    expect(out.stage).toBe("migrated");
    expect(out.copied).toContain("docs/foo/spec.md");
    expect(out.rewritten).toContain("docs/foo/plan.md");
    const planText = readFileSync(path.join(root, "docs", "foo", "plan.md"), "utf8");
    expect(planText).toContain("**Spec:** `docs/foo/spec.md`");
    expect(readFileSync(path.join(root, "docs", "superpowers", "foo", "plan.md"), "utf8")).toBe(
      legacyPlan("foo"),
    );
  } finally {
    child.kill();
    cleanup(root);
  }
});
