import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { SUPPORT_MATRIX } from "../../packages/workit-core/src/core/support-matrix";

const node = "node";

test("stock Node runtime is the supported current line for Pi workers", () => {
  const result = spawnSync(node, ["--version"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("v" + SUPPORT_MATRIX.node.current);
});

test("stock Pi discovers the packed Workit extension and skills without explicit resource flags", async () => {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const stage = mkdtempSync(path.join(tmpdir(), "workit-pi-stock-"));
  const project = path.join(stage, "project");
  const agentDir = path.join(stage, "agent");
  mkdirSync(project);
  mkdirSync(agentDir);
  const piBin = path.join(
    repoRoot,
    "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  );
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const packed = spawnSync(
    "npm",
    [
      "pack",
      "--json",
      "--workspace",
      path.join(repoRoot, "packages/workit-pi"),
      "--pack-destination",
      stage,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
  const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0].filename;
  const extracted = path.join(stage, "extract");
  mkdirSync(extracted);
  const unpacked = spawnSync("tar", ["-xzf", path.join(stage, filename), "-C", extracted], {
    encoding: "utf8",
  });
  if (unpacked.status !== 0) throw new Error(unpacked.stderr || unpacked.stdout);
  const installed = spawnSync(
    node,
    [piBin, "install", path.join(extracted, "package"), "-l", "--approve"],
    { cwd: project, env, encoding: "utf8" },
  );
  if (installed.status !== 0) throw new Error(installed.stderr || installed.stdout);
  const child = spawn(
    node,
    [piBin, "--mode", "rpc", "--no-session", "--approve", "--offline", "--no-context-files"],
    { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "";
  let stderr = "";
  const messages: Array<Record<string, unknown>> = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    child.stdin.write('{"id":"commands","type":"get_commands"}\n');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi discovery timeout: ${stderr}`)), 10000);
      const poll = () => {
        if (
          messages.some(
            (message) => message.type === "response" && message.command === "get_commands",
          )
        ) {
          clearTimeout(timer);
          resolve();
        } else setTimeout(poll, 10);
      };
      poll();
    });
    const response = messages.find(
      (message) => message.type === "response" && message.command === "get_commands",
    ) as { data: { commands: Array<{ name: string; source: string }> } };
    const commands = response.data.commands;
    expect(commands.filter((command) => command.name.startsWith("skill:workit-"))).toHaveLength(7);
    expect(
      commands.some(
        (command) => command.name === "workit-worker" && command.source === "extension",
      ),
    ).toBe(true);
    expect(readFileSync(path.join(project, ".pi/settings.json"), "utf8")).toContain(
      "extract/package",
    );
    child.stdin.write(
      JSON.stringify({
        id: "reconcile",
        type: "prompt",
        message: '/workit-worker {"action":"reconcile","taskId":"missing","workerId":"missing"}',
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stderr).toBe("");
  } finally {
    child.kill();
    rmSync(stage, { recursive: true, force: true });
  }
});
