// The shared Node resolution behind the Claude Code, Codex and Cursor hook
// launchers and the Claude plugin's bin/workit shim: order, scan, record, the
// copies that must stay equal, and the old-Node safety of the launcher code.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  HOOK_NODE_FLOOR,
  floorMessage,
  floorOfRange,
  nodeRecord,
  resolveHookNode,
  scanInstalledNodes,
} from "@/packages/workit-core/src/core/node-resolve.mjs";
import { hookNodeReport, recordHookNode } from "@/packages/workit-cli/src/admin/hook-node";
import { bareNodeEnv, scratchDir } from "../shared/helpers/hook-node";
import { PLUGIN_DIR } from "../workit-claude-code/plugin-helpers";

const REPO = path.resolve(import.meta.dir, "../..");
const CANONICAL = path.join(REPO, "packages/workit-core/src/core/node-resolve.mjs");

const install = (file: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
  return file;
};

test("the launcher copies of node-resolve.mjs equal the core file, and the floor equals every engines.node", () => {
  const core = readFileSync(CANONICAL, "utf8");
  for (const copy of [
    "packages/workit-claude-code/bin/node-resolve.mjs",
    "packages/workit-cursor/hooks/node-resolve.mjs",
  ])
    expect(readFileSync(path.join(REPO, copy), "utf8"), copy).toBe(core);
  for (const pkg of ["workit-claude-code", "workit-codex", "workit-cursor", "workit-cli"]) {
    const range = JSON.parse(readFileSync(path.join(REPO, "packages", pkg, "package.json"), "utf8"))
      .engines?.node;
    expect(floorOfRange(range), pkg).toEqual(HOOK_NODE_FLOOR);
  }
  expect(readFileSync(path.join(PLUGIN_DIR, "bin/workit"), "utf8")).toContain(
    `node_floor=${HOOK_NODE_FLOOR[0]}`,
  );
});

test("Given $WORKIT_NODE, a recorded node and installs, When resolving, Then env wins, then the record, then the highest scanned >= 24", () => {
  const env = bareNodeEnv();
  const fnm = scratchDir("wk-fnm-");
  install(path.join(fnm, "node-versions", "v22.19.0", "installation", "bin", "node"));
  install(path.join(fnm, "node-versions", "v24.14.0", "installation", "bin", "node"));
  const best = install(path.join(fnm, "node-versions", "v25.9.0", "installation", "bin", "node"));
  const nvm = scratchDir("wk-nvm-");
  install(path.join(nvm, "versions", "node", "v24.20.0", "bin", "node"));
  const volta = scratchDir("wk-volta-");
  install(path.join(volta, "tools", "image", "node", "16.20.2", "bin", "node"));
  const scanEnv = { ...env, FNM_DIR: fnm, NVM_DIR: nvm, VOLTA_HOME: volta };

  expect(resolveHookNode({ env: scanEnv, floor: HOOK_NODE_FLOOR })).toEqual({
    path: best,
    version: "25.9.0",
    source: "scan",
  });
  expect(scanInstalledNodes(scanEnv).length).toBe(5);

  const recorded = install(path.join(scratchDir("wk-rec-"), "node"));
  mkdirSync(env.WORKFLOW_TOOLKIT_STATE, { recursive: true });
  writeFileSync(
    path.join(env.WORKFLOW_TOOLKIT_STATE, "node.json"),
    JSON.stringify({ path: recorded, version: "24.1.0" }),
  );
  expect(resolveHookNode({ env: scanEnv, floor: HOOK_NODE_FLOOR })?.source).toBe("recorded");
  // A record below the floor, or whose file is gone, is ignored.
  writeFileSync(
    path.join(env.WORKFLOW_TOOLKIT_STATE, "node.json"),
    JSON.stringify({ path: recorded, version: "22.1.0" }),
  );
  expect(resolveHookNode({ env: scanEnv, floor: HOOK_NODE_FLOOR })?.source).toBe("scan");

  const explicit = install(path.join(scratchDir("wk-env-"), "node"));
  expect(
    resolveHookNode({ env: { ...scanEnv, WORKIT_NODE: explicit }, floor: HOOK_NODE_FLOOR })?.path,
  ).toBe(explicit);
  expect(resolveHookNode({ env, floor: HOOK_NODE_FLOOR })).toBeNull();
});

test("Given Windows layouts, When scanning, Then node.exe under fnm, nvm-windows and volta is found", () => {
  const appdata = scratchDir("wk-appdata-");
  const exe = install(
    path.join(appdata, "fnm", "node-versions", "v24.5.0", "installation", "node.exe"),
  );
  const nvmHome = scratchDir("wk-nvmhome-");
  install(path.join(nvmHome, "v24.2.0", "node.exe"));
  const found = scanInstalledNodes(
    { ...bareNodeEnv(), APPDATA: appdata, NVM_HOME: nvmHome },
    "win32",
  );
  expect(found.map((entry) => entry.path)).toContain(exe);
  expect(found.length).toBe(2);
});

test("Given setup runs on a Node >= 24, When it records, Then node.json holds its path; a bun or old Node records nothing", () => {
  const env = bareNodeEnv();
  const file = recordHookNode(env, { execPath: "/opt/node-24/bin/node", version: "24.22.1" });
  expect(file).toBe(path.join(env.WORKFLOW_TOOLKIT_STATE, "node.json"));
  expect(JSON.parse(readFileSync(file as string, "utf8"))).toMatchObject({
    path: "/opt/node-24/bin/node",
    version: "24.22.1",
  });
  expect(recordHookNode(bareNodeEnv(), { execPath: "/usr/bin/bun", version: "24.3.0" })).toBeNull();
  expect(
    recordHookNode(bareNodeEnv(), { execPath: "/usr/bin/node", version: "22.1.0" }),
  ).toBeNull();
  expect(
    nodeRecord({ env, execPath: "/x/node", version: "22.0.0", floor: HOOK_NODE_FLOOR }),
  ).toBeNull();
});

test("Given the PATH node, a record and no install, When doctor's report is built, Then it names which node the hooks run on", () => {
  const env = bareNodeEnv();
  expect(hookNodeReport(env, "v24.14.0")).toMatchObject({ pathOk: true, resolved: null });
  expect(hookNodeReport(env, "v22.19.0")).toMatchObject({ pathOk: false, resolved: null });
  expect(hookNodeReport(env, null)).toMatchObject({ pathOk: false, resolved: null });
  const node = install(path.join(scratchDir("wk-rec-"), "node"));
  recordHookNode(env, { execPath: node, version: "24.14.0" });
  expect(hookNodeReport(env, "v22.19.0").resolved).toMatchObject({
    path: node,
    source: "recorded",
  });
});

test("floorMessage reports only a version below the floor", () => {
  expect(floorMessage("20.1.0", [24, 0, 0], ">=24")).toBe("needs Node >=24, found 20.1.0");
  expect(floorMessage("24.0.0", [24, 0, 0], ">=24")).toBeNull();
  expect(floorMessage("garbage", [24, 0, 0], ">=24")).toBeNull();
  expect(floorMessage("20.1.0", null, "")).toBeNull();
});

// The launcher code must parse and run on Node 16 (a repo pinned there is the
// reason it exists). Syntax-level guard first (always on), then a real run
// under the oldest Node >= 16 on this machine when one exists.
const LAUNCHER_FILES = [
  "packages/workit-core/src/core/node-resolve.mjs",
  "packages/workit-claude-code/bin/workit-hook.mjs",
  "packages/workit-cursor/hooks/launch.mjs",
];
const NEWER_THAN_NODE_16 =
  /\?\?=|\|\|=|&&=|structuredClone|import\.meta\.dirname|import\.meta\.filename|Object\.groupBy|\.toSorted\(|\.findLast\(|\bstatic\s*\{|\bwith\s*\{\s*type/;

test("the launcher files use no syntax or API newer than Node 16 (syntax-level guard)", () => {
  for (const file of LAUNCHER_FILES) {
    const body = readFileSync(path.join(REPO, file), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(NEWER_THAN_NODE_16.exec(body)?.[0], file).toBeUndefined();
    expect(/^import .* from "(?!node:|\.\/)/m.test(body), `${file} imports a non-builtin`).toBe(
      false,
    );
  }
});

const oldestNode = (): string | null => {
  const home = process.env.HOME ?? "";
  const roots = [
    path.join(process.env.FNM_DIR ?? path.join(home, ".local/share/fnm"), "node-versions"),
    path.join(process.env.NVM_DIR ?? path.join(home, ".nvm"), "versions/node"),
  ];
  let best: { major: number; file: string } | null = null;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const major = Number(/^v(\d+)\./.exec(name)?.[1]);
      const file = [
        path.join(root, name, "installation/bin/node"),
        path.join(root, name, "bin/node"),
      ].find((candidate) => existsSync(candidate));
      if (major >= 16 && major < 24 && file && (!best || major < best.major))
        best = { major, file };
    }
  }
  return best?.file ?? null;
};

test("Given the oldest Node >= 16 on this machine, When it runs the Claude launcher, Then it parses and re-runs on a resolved Node (skipped without an old Node)", () => {
  const old = oldestNode();
  if (!old) {
    console.warn("no Node 16-23 installed here: syntax-level guard only");
    return;
  }
  const fake = install(path.join(scratchDir("wk-fake-"), "node"));
  writeFileSync(fake, '#!/bin/sh\necho "RAN $*"\ncat\nexit 4\n');
  const child = spawnSync(old, [path.join(PLUGIN_DIR, "bin/workit-hook.mjs")], {
    input: '{"hook_event_name":"PreToolUse"}',
    encoding: "utf8",
    env: bareNodeEnv({ WORKIT_NODE: fake }),
  });
  expect(child.stderr).toBe("");
  expect(child.status).toBe(4);
  expect(child.stdout).toContain("RAN ");
  expect(child.stdout).toContain("PreToolUse");
});

test("Given the Claude plugin shim on a PATH node below 24, When it runs, Then it resolves $WORKIT_NODE, the record, then the highest install", () => {
  const shim = path.join(PLUGIN_DIR, "bin/workit");
  const root = scratchDir("wk-shim-");
  const bin = path.join(root, "bin");
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "dist", "workit.js"), "");
  // An installed-layout plugin (no monorepo sibling) whose PATH node says v20.
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "workit"), readFileSync(shim));
  chmodSync(path.join(bin, "workit"), 0o755);
  const old = install(path.join(root, "oldbin", "node"));
  writeFileSync(old, '#!/bin/sh\n[ "$1" = "-v" ] && echo v20.1.0\n');
  const reportNode = (version: string) =>
    '#!/bin/sh\n[ "$1" = "-v" ] && { echo v' +
    version +
    '; exit 0; }\necho "SHIM-RAN-ON ' +
    version +
    ' $*"\n';
  const env = bareNodeEnv({
    PATH: `${path.dirname(old)}:/usr/bin:/bin`,
    WORKIT_CLAUDE_RUNTIME: "dist",
  });
  const fnm = scratchDir("wk-fnm-");
  for (const version of ["22.19.0", "24.14.0", "24.22.1"]) {
    const file = path.join(fnm, "node-versions", `v${version}`, "installation/bin/node");
    install(file);
    writeFileSync(file, reportNode(version));
  }
  const run = (extra: Record<string, string> = {}) =>
    spawnSync("sh", [path.join(bin, "workit"), "arg1"], {
      encoding: "utf8",
      env: { ...env, FNM_DIR: fnm, ...extra },
    });
  expect(run().stdout).toContain("SHIM-RAN-ON 24.22.1");
  const explicit = install(path.join(scratchDir("wk-explicit-"), "node"));
  writeFileSync(explicit, reportNode("30.0.0"));
  expect(run({ WORKIT_NODE: explicit }).stdout).toContain("SHIM-RAN-ON 30.0.0");
  const recorded = install(path.join(scratchDir("wk-recorded-"), "node"));
  writeFileSync(recorded, reportNode("26.0.0"));
  mkdirSync(env.WORKFLOW_TOOLKIT_STATE, { recursive: true });
  writeFileSync(
    path.join(env.WORKFLOW_TOOLKIT_STATE, "node.json"),
    JSON.stringify({ path: recorded, version: "26.0.0" }),
  );
  expect(run().stdout).toContain("SHIM-RAN-ON 26.0.0");
});
