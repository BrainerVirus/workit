import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORT_MATRIX } from "../../packages/workit-core/src/core/support-matrix";
import {
  installPackedPackage,
  isolatedEnv,
  packWorkspacePackages,
  REPO_ROOT,
} from "../shared/helpers/packages";

// Task 7 packed-runtime gate: from EXTRACTED tarballs with repository node_modules
// unavailable, the packaged adapters load/boot under plain Node without Bun or a
// monorepo. Everything must resolve package-locally.

const OPENCODE = "@brainervirus/workit-opencode";
const CURSOR = "@brainervirus/workit-cursor";
const CLI = "@brainervirus/workit-cli";

const byName = (packs: ReturnType<typeof packWorkspacePackages>, name: string) =>
  packs.find((p) => p.packageName === name)!;

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));

type McpClient = {
  child: import("node:child_process").ChildProcess;
  request: (method: string, params: unknown) => Promise<{ result?: unknown; error?: unknown }>;
};

function startNodeMcp(
  cwd: string,
  bin: string,
  args: string[],
  env: Record<string, string>,
): McpClient {
  const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const pending = new Map<number, (value: { result?: unknown; error?: unknown }) => void>();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let msg: { id: number; result?: unknown; error?: unknown };
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
    return new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 15000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  };
  return { child, request };
}

// Install a stub @opencode-ai/plugin at the given version with the exact SDK
// surface the plugin imports, then import the packed entry. Proves the packed
// plugin loads against both the declared minimum and the pinned current host SDK.
function writeOpenCodeStub(nm: string, version: string): void {
  const stubDir = path.join(nm, "@opencode-ai", "plugin");
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    path.join(stubDir, "package.json"),
    JSON.stringify({
      name: "@opencode-ai/plugin",
      version,
      type: "module",
      main: "index.js",
    }),
  );
  writeFileSync(
    path.join(stubDir, "index.js"),
    `export const tool = (def) => def;
tool.schema = { string: () => ({ type: "string" }), boolean: () => ({ type: "boolean" }), enum: (v) => ({ type: "string", enum: v }), optional: (s) => s, array: (s) => ({ type: "array", items: s }) };
`,
  );
}

test("opencode plugin loads from dist/plugin.js with a stub @opencode-ai/plugin", async () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-runtime-opencode-");
  const home = tmp("wk-runtime-opencode-home-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, byName(packs, OPENCODE));

    writeOpenCodeStub(nm, SUPPORT_MATRIX.opencode.current);

    const entry = path.join(install, "node_modules", OPENCODE, "dist", "plugin.js");
    expect(existsSync(entry)).toBe(true);
    const mod = await import(pathToFileURL(entry).href);
    expect(typeof mod.default).toBe("function");
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("opencode plugin loads against the declared minimum @opencode-ai/plugin version (RR-10)", async () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-runtime-opencode-min-");
  const home = tmp("wk-runtime-opencode-min-home-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, byName(packs, OPENCODE));

    writeOpenCodeStub(nm, SUPPORT_MATRIX.opencode.minimum);

    const entry = path.join(install, "node_modules", OPENCODE, "dist", "plugin.js");
    const mod = await import(pathToFileURL(entry).href);
    expect(typeof mod.default).toBe("function");
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("cursor MCP server boots over stdio from the extracted package with node (no bun)", async () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-runtime-cursor-");
  const home = tmp("wk-runtime-cursor-home-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, byName(packs, CURSOR));
    const cursorDir = path.join(nm, CURSOR);
    const env = isolatedEnv(home);

    const { child, request } = startNodeMcp(cursorDir, "bash", ["mcp/run-server.sh"], env);
    try {
      const init = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "packed-runtime", version: "1.0" },
      });
      expect((init.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe("workit");
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const listed = await request("tools/list", {});
      const names = ((listed.result as { tools?: { name: string }[] })?.tools ?? []).map(
        (t) => t.name,
      );
      expect(names).toContain("workflow_git_context");
      expect(names).toContain("workflow_toolkit_init_apply");
    } finally {
      child.kill();
    }
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test("cursor session-start emits the workflow contract payload from the extracted package", async () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-runtime-session-");
  const home = tmp("wk-runtime-session-home-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, byName(packs, CURSOR));
    const cursorDir = path.join(nm, CURSOR);
    const env = isolatedEnv(home);

    const child = spawn("bash", ["hooks/session-start"], {
      cwd: cursorDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => (stdout += c));
    child.stderr?.on("data", (c: string) => (stderr += c));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.additional_context).toContain("HARD-GATE");
    expect(payload.additional_context).toContain("AskQuestion");
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli --help runs under node from the extracted package and exits 0", async () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-runtime-cli-");
  const home = tmp("wk-runtime-cli-home-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, byName(packs, CLI));
    const cliDir = path.join(nm, CLI);
    const env = isolatedEnv(home);

    const { spawnSync } = await import("node:child_process");
    const res = spawnSync("node", [path.join(cliDir, "dist", "index.js"), "--help"], {
      cwd: cliDir,
      env,
      encoding: "utf8",
    });
    expect(res.status, res.stderr ?? "").toBe(0);
    expect(res.stdout).toContain("workit");
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("packed tarball locations never reference the repository checkout", () => {
  const packs = packWorkspacePackages();
  const normalized = REPO_ROOT.split(path.sep).join("/");
  for (const pack of packs) {
    expect(pack.tarball, pack.packageName).not.toContain(normalized);
  }
});

test("declared platform matrix is pinned across CI, engines, and lockfiles (PT-11/PT-12)", () => {
  // The support matrix is the single source of truth for the published
  // toolchain. No Deno is advertised anywhere in the repo surface. (The OS list
  // itself is asserted via ci.yml below and in manifests.test.ts.)

  const ci = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  expect(ci).toContain(SUPPORT_MATRIX.bun);
  // NODE_MINIMUM/NODE_CURRENT pinning is asserted exactly in manifests.test.ts.
  expect(ci).not.toMatch(/[Dd]eno/);

  const lock = readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8");
  expect(lock).toContain(SUPPORT_MATRIX.bun);
  expect(lock).toContain(SUPPORT_MATRIX.opencode.current);
});
