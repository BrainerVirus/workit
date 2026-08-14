import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractTarball,
  installPackedPackage,
  isolatedEnv,
  listTarball,
  npmRegistryReachable,
  packReleaseCandidate,
  packWorkspacePackages,
  readTarballFile,
  REPO_ROOT,
  runInIsolation,
} from "../shared/helpers/packages";

// Phase 0 corrective-candidate gate (RR-11, CA-30): pack every package WITHOUT
// publishing and verify the candidate installs and starts in isolation — packed
// metadata, entry files, dependency ranges, package-local Cursor MCP startup,
// preserved credentials, and installers that fail loudly on required failures.
// Pack-only: no publish, tag, or marketplace operation anywhere in this gate.

const CORE = "@brainervirus/workit-core";
const OPENCODE = "@brainervirus/workit-opencode";
const CURSOR = "@brainervirus/workit-cursor";
const CLI = "@brainervirus/workit-cli";

// The isolated npm-install gate fetches third-party runtime deps (ink/react/
// @inkjs/ui) from the public registry, so an offline/registry-outage CI run
// skips it cleanly instead of failing. Reachability is probed once; the online
// path keeps every assertion intact.
const npmRegistryOk = npmRegistryReachable();
if (!npmRegistryOk) {
  console.error("skipping npm-registry install gate: `npm ping` failed — registry unreachable");
}

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));

const hasEntry = (tarball: string, prefix: string) =>
  listTarball(tarball).some((entry) => entry === prefix || entry.startsWith(prefix));

test("isolatedEnv strips script-specific path overrides that could re-point at the repo", () => {
  const home = tmp("wk-env-home-");
  const names = [
    "CONFIG_PATH",
    "PIN_PATH",
    "PKG_PATH",
    "CURSOR_MCP",
    "CURSOR_SETTINGS",
    "WORKFLOW_TOOLKIT_DEV",
    "XDG_CONFIG_HOME",
  ];
  const saved = new Map(names.map((n) => [n, process.env[n]]));
  for (const name of names) process.env[name] = `/repo/${name}`;
  try {
    const env = isolatedEnv(home, { BUN: "/usr/bin/bun" });
    for (const name of names) expect(env[name], name).toBeUndefined();
    expect(env.BUN).toBe("/usr/bin/bun");
    expect(env.HOME).toBe(home);
  } finally {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("packs all workspace packages into local tarballs without publishing", () => {
  const packs = packWorkspacePackages();
  expect(packs.map((p) => p.packageName)).toEqual([CORE, OPENCODE, CURSOR, CLI]);
  for (const pack of packs) {
    expect(existsSync(pack.tarball), pack.packageName).toBe(true);
    expect(pack.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(listTarball(pack.tarball).length, pack.packageName).toBeGreaterThan(0);
  }
});

test("the final release candidate is byte-stable with the phase-0 pack (CA-30)", () => {
  // Force a fresh pack against the earlier (cached) phase-0 pack: comparing two
  // calls that both hit the module cache would be comparing an array with
  // itself (D12). Order matters — packWorkspacePackages() must run first so the
  // force actually repacks.
  const packs = packWorkspacePackages();
  const candidate = packReleaseCandidate({ force: true });
  expect(candidate.map((p) => p.sha256)).toEqual(packs.map((p) => p.sha256));
});

test("packed adapter core dependency equals the packed core version (RR-01)", () => {
  const packs = packWorkspacePackages();
  const coreVersion = JSON.parse(
    readTarballFile(packs.find((p) => p.packageName === CORE)!.tarball, "package.json"),
  ).version;
  for (const name of [OPENCODE, CURSOR, CLI]) {
    const pack = packs.find((p) => p.packageName === name)!;
    const pkg = JSON.parse(readTarballFile(pack.tarball, "package.json"));
    expect(pkg.dependencies["@brainervirus/workit-core"], name).toBe(`^${coreVersion}`);
  }
});

test("packed tarballs carry no workspace: or local protocols, only valid ranges (CA-03)", () => {
  const packs = packWorkspacePackages();
  for (const pack of packs) {
    const raw = readTarballFile(pack.tarball, "package.json");
    expect(raw, pack.packageName).not.toContain("workspace:");
    expect(raw, pack.packageName).not.toContain("file:");
    expect(raw, pack.packageName).not.toContain("git:");
    const pkg = JSON.parse(raw);
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      expect(String(range), `${pack.packageName} → ${dep}`).toMatch(
        /^(?:[~^]?[0-9]+)(?:\.[0-9]+)+$/,
      );
    }
  }
});

test("expected entry files ship in each packed tarball", () => {
  const packs = packWorkspacePackages();
  const byName = (name: string) => packs.find((p) => p.packageName === name)!;

  const opencode = byName(OPENCODE).tarball;
  expect(hasEntry(opencode, "dist/plugin.js")).toBe(true);
  expect(hasEntry(opencode, "assets/commands/")).toBe(true);
  expect(hasEntry(opencode, "assets/skills/")).toBe(true);

  const cursor = byName(CURSOR).tarball;
  for (const f of [
    "dist/mcp-server.js",
    "dist/cursor-session-start.js",
    "mcp.json",
    "assets/logo.svg",
    ".cursor-plugin/plugin.json",
    "hooks/hooks-cursor.json",
  ]) {
    expect(hasEntry(cursor, f), f).toBe(true);
  }
  expect(hasEntry(cursor, "mcp/run-server.sh")).toBe(false);
  expect(hasEntry(cursor, "hooks/session-start")).toBe(false);
  const cursorPkg = JSON.parse(readTarballFile(cursor, "package.json"));
  expect(cursorPkg.bin["workit-cursor-mcp"]).toBe("./dist/mcp-server.js");
  expect(cursorPkg.bin["workit-cursor-session-start"]).toBe("./dist/cursor-session-start.js");

  const core = byName(CORE).tarball;
  for (const f of [
    "src/core.ts",
    "scripts/rewrite-workspace-deps.ts",
    "scripts/install-opencode-plugin.sh",
    "scripts/sync-runtime.sh",
    "templates/",
    "skills/",
    "vendor/superpowers/skills/",
  ]) {
    expect(hasEntry(core, f), f).toBe(true);
  }

  const cli = byName(CLI).tarball;
  expect(hasEntry(cli, "dist/index.js")).toBe(true);
  const cliPkg = JSON.parse(readTarballFile(cli, "package.json"));
  expect(cliPkg.bin.workit).toBe("./dist/index.js");
});

type McpClient = {
  child: ChildProcess;
  request: (method: string, params: unknown) => Promise<{ result?: unknown; error?: unknown }>;
};

function startMcpServer(
  cursorDir: string,
  env: Record<string, string>,
): McpClient & { workspace: string } {
  const workspace = tmp("wk-mcp-ws-");
  const child = spawn("node", ["dist/mcp-server.js", workspace], {
    cwd: cursorDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = new Map<number, (value: { result?: unknown; error?: unknown }) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
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
  return { child, request, workspace };
}

test("Cursor MCP launcher starts the server from the extracted package, repo-free (CA-05)", async () => {
  const packs = packWorkspacePackages();
  const cursor = packs.find((p) => p.packageName === CURSOR)!;
  const core = packs.find((p) => p.packageName === CORE)!;
  const install = tmp("wk-cursor-install-");
  const home = tmp("wk-cursor-home-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, core);
    const cursorDir = installPackedPackage(nm, cursor);
    // Static: the packed manifest launches the published package via npx
    // (CA-17), never a repo-relative dist/sh path.
    const mcpJson = JSON.parse(readFileSync(path.join(cursorDir, "mcp.json"), "utf8"));
    const server = mcpJson.mcpServers.workit;
    expect(server.command).toBe("npx");
    expect(server.args).toEqual([
      "-y",
      "--package=@brainervirus/workit-cursor@0.8.0",
      "workit-cursor-mcp",
      "${workspaceFolder}",
    ]);
    expect(server.args.join(" ")).not.toContain("$HOME");

    // Runtime: with a temp HOME and every WORKFLOW_* var stripped, the launcher
    // must resolve the installed core copy (not the repo) and serve MCP.
    const env = isolatedEnv(home, { BUN: process.execPath });
    const { child, request, workspace } = startMcpServer(cursorDir, env);
    try {
      const init = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "phase-0-test", version: "1.0" },
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
      rmSync(workspace, { recursive: true, force: true });
    }
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

const SCAFFOLD_RUNNER = `
import { readFileSync } from "node:fs";
import path from "node:path";
import { scaffoldYouTrack, scaffoldVcs } from "./logic.ts";
const cfg = path.join(process.env.HOME!, ".config", "workflow-toolkit");
const yt = scaffoldYouTrack(cfg, "https://example.youtrack.cloud", {
  locale: "en",
  timezone: "America/Santiago",
});
const vcs = scaffoldVcs(cfg, "gitlab");
console.log(
  JSON.stringify({
    ytStatus: yt.status,
    vcsStatus: vcs.status,
    ytToken: readFileSync(path.join(cfg, "youtrack.token"), "utf8"),
    glToken: readFileSync(path.join(cfg, "gitlab.token"), "utf8"),
  }),
);
`;

test("packed candidate preserves existing token bytes in a temp HOME (WZ-05)", () => {
  const packs = packWorkspacePackages();
  const core = packs.find((p) => p.packageName === CORE)!;
  const install = tmp("wk-cli-install-");
  const home = tmp("wk-cli-home-");
  try {
    const nm = path.join(install, "node_modules");
    mkdirSync(nm, { recursive: true });
    installPackedPackage(nm, core);
    // The packed CLI ships its bundled dist only; the wizard's scaffold logic is
    // its source of truth, so run it against the PACKED core from this isolated
    // install (the repository node_modules are not on the resolution path).
    cpSync(
      path.join(REPO_ROOT, "packages/workit-cli/src/logic.ts"),
      path.join(install, "logic.ts"),
    );
    writeFileSync(path.join(install, "runner.ts"), SCAFFOLD_RUNNER, "utf8");

    const cfg = path.join(home, ".config", "workflow-toolkit");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(path.join(cfg, "youtrack.token"), "perm_abcdef123456\n", { mode: 0o600 });
    writeFileSync(path.join(cfg, "gitlab.token"), "glpat-secret\n", { mode: 0o600 });

    const res = runInIsolation(install, "bun", ["runner.ts"], isolatedEnv(home));
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ytStatus).toBe("preserved");
    expect(out.vcsStatus).toBe("preserved");
    expect(out.ytToken).toBe("perm_abcdef123456\n");
    expect(out.glToken).toBe("glpat-secret\n");
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("packed installers fail loudly on a required failure in a temp HOME (RR-05)", () => {
  const packs = packWorkspacePackages();
  const core = packs.find((p) => p.packageName === CORE)!;
  const stub = tmp("wk-install-stub-");
  const home = tmp("wk-install-home-");
  const binDir = tmp("wk-install-bin-");
  try {
    // Stub monorepo whose scripts come from the PACKED core tarball.
    const { root, packageDir } = extractTarball(core.tarball);
    const scripts = path.join(stub, "packages", "workit-core", "scripts");
    try {
      cpSync(path.join(packageDir, "scripts"), scripts, { recursive: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    mkdirSync(path.join(stub, "packages", "workit-opencode", "src"), { recursive: true });
    writeFileSync(
      path.join(stub, "packages", "workit-opencode", "src", "plugin.ts"),
      "export default {};\n",
    );
    mkdirSync(path.join(stub, "packages", "workit-cursor", ".cursor-plugin"), { recursive: true });
    mkdirSync(path.join(stub, "packages", "workit-cursor", "mcp"), { recursive: true });
    mkdirSync(path.join(stub, "packages", "workit-cursor", "scripts"), { recursive: true });
    mkdirSync(path.join(stub, "packages", "workit-cursor", "dist"), { recursive: true });
    for (const dependency of ["@brainervirus/workit-core", "@modelcontextprotocol/sdk", "zod"]) {
      mkdirSync(path.join(stub, "node_modules", dependency), { recursive: true });
    }
    writeFileSync(
      path.join(stub, "packages", "workit-cursor", "scripts", "build.ts"),
      "// build\n",
    );
    for (const entry of ["mcp-server.js", "cursor-session-start.js"]) {
      writeFileSync(
        path.join(stub, "packages", "workit-cursor", "dist", entry),
        "#!/usr/bin/env node\n",
      );
    }
    spawnSync("git", ["init", "-q"], { cwd: stub, stdio: "ignore" });
    // A failed required copy must never look like a successful install.
    writeFileSync(
      path.join(binDir, "rsync"),
      "#!/usr/bin/env bash\necho 'FATAL: rsync unavailable' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    // macOS ships no flock (util-linux), so sync-runtime.sh FATALs on the lock
    // before ever reaching rsync; stub it so the rsync failure path is what
    // this fixture exercises.
    writeFileSync(path.join(binDir, "flock"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });
    const bun = path.join(binDir, "bun");
    writeFileSync(bun, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const env = isolatedEnv(home, {
      BUN: bun,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    const res = runInIsolation(
      stub,
      "bash",
      ["packages/workit-core/scripts/install-opencode-plugin.sh"],
      env,
    );
    expect(res.status, res.stdout + res.stderr).not.toBe(0);
    expect(res.stdout + res.stderr).toContain("FATAL");
    expect(res.stdout + res.stderr).toContain("rsync");
  } finally {
    rmSync(stub, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test.skipIf(!npmRegistryOk)(
  "isolated npm install of the packed CLI emits no EBADENGINE / ini@7 engine warning (CA-06)",
  () => {
    const packs = packWorkspacePackages();
    const install = tmp("wk-npm-cli-");
    const home = tmp("wk-npm-cli-home-");
    try {
      const byName = (name: string) => packs.find((p) => p.packageName === name)!;
      // npm resolves the @brainervirus/* workspace deps from the sibling tarballs
      // (file:), so no unpublished package has to exist on the registry. The
      // third-party runtime deps (ink/react/@inkjs/ui) resolve from the registry,
      // exactly as a real `npm install @brainervirus/workit-cli` would.
      writeFileSync(
        path.join(install, "package.json"),
        JSON.stringify(
          {
            name: "wk-cli-install-test",
            private: true,
            version: "1.0.0",
            dependencies: {
              "@brainervirus/workit-cli": pathToFileURL(byName(CLI).tarball).href,
            },
            overrides: {
              "@brainervirus/workit-core": pathToFileURL(byName(CORE).tarball).href,
              "@brainervirus/workit-cursor": pathToFileURL(byName(CURSOR).tarball).href,
              "@brainervirus/workit-opencode": pathToFileURL(byName(OPENCODE).tarball).href,
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      // Node 22.19 reports an `ini@7` EBADENGINE warning through the OpenCode ->
      // effect -> ini@7 path. The packed CLI must not pull that path, so a clean
      // install is warning-free regardless of Node version.
      const res = spawnSync(
        "npm",
        ["install", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts"],
        {
          cwd: install,
          env: isolatedEnv(home),
          encoding: "utf8",
          timeout: 120_000,
          shell: process.platform === "win32",
        },
      );
      expect(res.status, res.stdout + res.stderr).toBe(0);
      expect(res.stderr, res.stderr).not.toContain("EBADENGINE");
      expect(res.stderr, res.stderr).not.toContain("ini@7");
    } finally {
      rmSync(install, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
  180_000,
);
