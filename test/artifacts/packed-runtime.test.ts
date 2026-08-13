import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORT_MATRIX } from "../../packages/workit-core/src/core/support-matrix";
import {
  installPackedPackage,
  isolatedEnv,
  npmRegistryReachable,
  packReleaseCandidate,
  packWorkspacePackages,
  REPO_ROOT,
} from "../shared/helpers/packages";

// Task 7 packed-runtime gate: from EXTRACTED tarballs with repository node_modules
// unavailable, the packaged adapters load/boot under plain Node without Bun or a
// monorepo. Everything must resolve package-locally.

const CORE = "@brainervirus/workit-core";
const OPENCODE = "@brainervirus/workit-opencode";
const CURSOR = "@brainervirus/workit-cursor";
const CLI = "@brainervirus/workit-cli";

// The isolated npm-install gate fetches third-party runtime deps (zod/
// @modelcontextprotocol/sdk) from the public registry, so an offline/
// registry-outage CI run skips it cleanly instead of failing. Reachability is
// probed once; the online path keeps every assertion intact.
const npmRegistryOk = npmRegistryReachable();
if (!npmRegistryOk) {
  console.error("skipping npm-registry install gate: `npm ping` failed — registry unreachable");
}

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
  options: { shell?: boolean } = {},
): McpClient {
  const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], ...options });
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

// CA-07: the SDK helper/schema runtime is bundled into dist/plugin.js, so the
// packed plugin loads standalone — no stub @opencode-ai/plugin is written and
// no runtime import of it may remain in the bundle.
test("opencode plugin loads from dist/plugin.js with no runtime @opencode-ai/plugin dependency", async () => {
  const packs = packWorkspacePackages();
  const install = tmp("wk-runtime-opencode-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, byName(packs, OPENCODE));

    const entry = path.join(install, "node_modules", OPENCODE, "dist", "plugin.js");
    expect(existsSync(entry)).toBe(true);
    const bundle = readFileSync(entry, "utf8");
    expect(bundle, "dist/plugin.js").not.toMatch(
      /(?:from\s+|import\s*\(\s*)\s*["']@opencode-ai\/plugin["']/,
    );

    const mod = await import(pathToFileURL(entry).href);
    expect(typeof mod.default).toBe("function");
  } finally {
    rmSync(install, { recursive: true, force: true });
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

    const { child, request } = startNodeMcp(cursorDir, "node", ["dist/mcp-server.js"], env);
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
      // win32 keeps deleted files/dirs locked until the child fully exits, so
      // wait for the kill to land before the outer finally rmSync's the tree.
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
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

    const child = spawn("node", ["dist/cursor-session-start.js"], {
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

test.skipIf(!npmRegistryOk)(
  "cursor npm executables run through npm's package runner from the packed install (CA-16)",
  async () => {
    const packs = packWorkspacePackages();
    const install = tmp("wk-cursor-bin-install-");
    const home = tmp("wk-cursor-bin-home-");
    try {
      // npm resolves the @brainervirus/* workspace deps from the sibling tarballs
      // (file:), so the candidate installs without a published core. The MCP SDK
      // and zod resolve from the registry, exactly as a real install would.
      writeFileSync(
        path.join(install, "package.json"),
        JSON.stringify(
          {
            name: "wk-cursor-bin-test",
            private: true,
            version: "1.0.0",
            dependencies: {
              "@brainervirus/workit-cursor": pathToFileURL(byName(packs, CURSOR).tarball).href,
            },
            overrides: {
              "@brainervirus/workit-core": pathToFileURL(byName(packs, CORE).tarball).href,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const env = isolatedEnv(home);
      const installRes = spawnSync(
        "npm",
        ["install", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts"],
        {
          cwd: install,
          env,
          encoding: "utf8",
          timeout: 120_000,
          shell: process.platform === "win32",
        },
      );
      expect(installRes.status, installRes.stdout + installRes.stderr).toBe(0);

      // Both executables are wired into the installed .bin directory.
      const binDir = path.join(install, "node_modules", ".bin");
      const shim = (name: string) => (process.platform === "win32" ? `${name}.cmd` : name);
      expect(existsSync(path.join(binDir, shim("workit-cursor-mcp")))).toBe(true);
      expect(existsSync(path.join(binDir, shim("workit-cursor-session-start")))).toBe(true);

      // MCP executable: drive tools/list over the package runner's stdio.
      const { child, request } = startNodeMcp(
        install,
        "npm",
        ["exec", "--", "workit-cursor-mcp"],
        env,
        { shell: process.platform === "win32" },
      );
      try {
        const init = await request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "packed-bin", version: "1.0" },
        });
        expect((init.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe(
          "workit",
        );
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
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      }

      // Session-start executable: emits the protocol JSON contract on stdout.
      const session = spawnSync("npm", ["exec", "--", "workit-cursor-session-start"], {
        cwd: install,
        env,
        encoding: "utf8",
        timeout: 60_000,
        shell: process.platform === "win32",
      });
      expect(session.status, session.stderr ?? "").toBe(0);
      const payload = JSON.parse(session.stdout);
      expect(payload.additional_context).toContain("HARD-GATE");
      expect(payload.additional_context).toContain("AskQuestion");
    } finally {
      rmSync(install, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
  180_000,
);

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

test("the runtime gate exercises the same final candidate artifacts (CA-30)", () => {
  // Both calls resolve to the same cached pack, so this asserts the gate uses
  // the final candidate, not fresh-vs-cached bytes. Byte-stability across a
  // forced repack is proven in release-candidate.test.ts ("a fresh repack
  // yields byte-identical sha256") and phase-0-candidate.test.ts (D12).
  const candidate = packReleaseCandidate();
  const packs = packWorkspacePackages();
  expect(candidate.map((p) => p.sha256)).toEqual(packs.map((p) => p.sha256));
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
