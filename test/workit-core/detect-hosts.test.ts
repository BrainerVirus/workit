import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectHosts,
  emptyDetection,
  preselectedPlatforms,
} from "@/packages/workit-core/src/core/detect-hosts";

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));

function envWith(home: string, bins: string): NodeJS.ProcessEnv {
  return { HOME: home, PATH: bins };
}

test("empty home detects nothing and configures nothing", () => {
  const home = tmp("wf-detect-empty-");
  const bins = tmp("wf-detect-empty-bin-");
  try {
    const found = detectHosts({ home, env: envWith(home, bins) });
    for (const host of ["opencode", "cursor", "codex", "pi"] as const) {
      expect(found[host], host).toEqual({ detected: false, configured: false });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
  }
});

test("CLI on PATH detects the host without configuring it", () => {
  const home = tmp("wf-detect-bin-");
  const bins = tmp("wf-detect-bin-dir-");
  try {
    writeFileSync(path.join(bins, "opencode"), "#!/usr/bin/env bash\n", { mode: 0o755 });
    writeFileSync(path.join(bins, "pi"), "#!/usr/bin/env bash\n", { mode: 0o755 });
    const found = detectHosts({ home, env: envWith(home, bins) });
    expect(found.opencode).toEqual({ detected: true, configured: false });
    expect(found.pi).toEqual({ detected: true, configured: false });
    expect(found.cursor.detected).toBe(false);
    expect(found.codex.detected).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
  }
});

test("config markers detect the host; workit registrations mark configured", () => {
  const home = tmp("wf-detect-cfg-");
  const bins = tmp("wf-detect-cfg-bin-");
  try {
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      path.join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ plugin: ["workit"] }),
      "utf8",
    );
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { workit: { command: "x" } } }),
      "utf8",
    );
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    mkdirSync(path.join(home, ".pi"), { recursive: true });
    const found = detectHosts({ home, env: envWith(home, bins) });
    expect(found.opencode).toEqual({ detected: true, configured: true });
    expect(found.cursor).toEqual({ detected: true, configured: true });
    // Detect-all/mark-two: codex/pi surface presence but never configured.
    expect(found.codex).toEqual({ detected: true, configured: false });
    expect(found.pi).toEqual({ detected: true, configured: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
  }
});

test("cursor plugin dir alone marks cursor configured", () => {
  const home = tmp("wf-detect-plug-");
  const bins = tmp("wf-detect-plug-bin-");
  try {
    mkdirSync(path.join(home, ".cursor", "plugins", "local", "workit"), { recursive: true });
    const found = detectHosts({ home, env: envWith(home, bins) });
    expect(found.cursor).toEqual({ detected: true, configured: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
  }
});

test("preselectedPlatforms keeps detected wizard hosts only", () => {
  const found = {
    ...emptyDetection(),
    opencode: { detected: true, configured: false },
    pi: { detected: true, configured: false },
  };
  expect(preselectedPlatforms(found)).toEqual(["opencode"]);
  expect(preselectedPlatforms(emptyDetection())).toEqual([]);
});
