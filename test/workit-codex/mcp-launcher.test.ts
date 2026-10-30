// The Codex MCP entry (.mcp.json) starts bin/launch-mcp.mjs with the PATH node.
// Below the engines floor it re-runs dist/launch-mcp.js on a resolved Node with
// stdio untouched; with none it writes one stderr line and exits non-zero.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bareNodeEnv, fakeNode, scratchDir } from "../shared/helpers/hook-node";

const PKG = path.resolve(import.meta.dir, "../../packages/workit-codex");

const plugin = () => {
  const root = scratchDir("wk-codex-mcp-");
  mkdirSync(path.join(root, "bin"));
  for (const file of ["launch-mcp.mjs", "node-resolve.mjs"])
    copyFileSync(path.join(PKG, "bin", file), path.join(root, "bin", file));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ engines: { node: ">=24" } }));
  return root;
};
const run = (root: string, env: Record<string, string>) =>
  spawnSync("node", [path.join(root, "bin", "launch-mcp.mjs")], {
    input: '{"jsonrpc":"2.0"}',
    encoding: "utf8",
    env: bareNodeEnv(env),
  });

test("the codex MCP launcher copy of node-resolve.mjs equals core's", () => {
  expect(readFileSync(path.join(PKG, "bin/node-resolve.mjs"), "utf8")).toBe(
    readFileSync(path.join(PKG, "../workit-core/src/core/node-resolve.mjs"), "utf8"),
  );
});

test("Given Node 20 on PATH and a Node 24 resolved, When Codex starts the MCP server, Then it re-runs dist/launch-mcp.js there with stdio passed through", () => {
  const root = plugin();
  const child = run(root, { WORKIT_HOOK_NODE_VERSION: "20.1.0", WORKIT_NODE: fakeNode() });
  expect(child.status).toBe(3);
  expect(child.stdout).toBe(`ARGV ${path.join(root, "dist", "launch-mcp.js")}\n{"jsonrpc":"2.0"}`);
});

test("Given Node 20 and no Node 24, When the MCP server starts, Then one stderr line, nothing on stdout, non-zero exit", () => {
  const child = run(plugin(), { WORKIT_HOOK_NODE_VERSION: "20.1.0" });
  expect(child.status).not.toBe(0);
  expect(child.stdout).toBe("");
  expect(child.stderr.trim().split("\n")).toHaveLength(1);
  expect(child.stderr).toContain("needs Node >=24, found 20.1.0");
});

test("Given a current Node, When the launcher runs, Then it imports dist/launch-mcp.js", () => {
  const root = plugin();
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist", "launch-mcp.js"), 'console.log("MCP-LOADED");\n');
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module", engines: { node: ">=24" } }),
  );
  expect(run(root, {}).stdout).toContain("MCP-LOADED");
});
