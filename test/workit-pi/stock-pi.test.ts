import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SUPPORT_MATRIX } from "../../packages/workit-core/src/core/support-matrix";
import { parseWorkerResult } from "../../packages/workit-pi/src/worker";

test("stock Node runtime is the supported current line for Pi workers", () => {
  const result = spawnSync("node", ["--version"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("v" + SUPPORT_MATRIX.node.current);
});

test("a report does not stand in for a native process exit", () => {
  const report = parseWorkerResult([
    {
      type: "workit_worker_result",
      report: { outcome: "completed", summary: "ok", evidenceIds: [], findingIds: [] },
    },
  ]);
  expect(report.ok).toBe(true);
});

test("stock Pi can launch a reviewer fixture without a model or companion package", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-stock-"));
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir);
  const fixture = path.join(root, "fixture.mjs");
  writeFileSync(
    fixture,
    [
      "export default (pi) => {",
      "  pi.on('session_start', (_event, ctx) => {",
      "    process.stdout.write(JSON.stringify({type:'workit_worker_result', report:{outcome:'completed',summary:'fixture',evidenceIds:[],findingIds:[]}}) + '\\n');",
      "    setTimeout(() => ctx.shutdown(), 10);",
      "  });",
      "};",
    ].join("\n"),
  );
  const piBin = path.resolve(
    import.meta.dir,
    "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  );
  const child = spawn(
    "node",
    [
      piBin,
      "--mode",
      "rpc",
      "--no-session",
      "--approve",
      "--offline",
      "--no-context-files",
      "--extension",
      fixture,
    ],
    {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const status = await new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  expect(status, stderr + stdout).toBe(0);
  const lines = (stdout + "\n" + stderr).split(/\r?\n/).filter(Boolean);
  expect(parseWorkerResult(lines.map((line) => JSON.parse(line))).ok).toBe(true);
});
