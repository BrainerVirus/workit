import { afterAll, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fsMod from "node:fs";
import { applyUninstall, planUninstall } from "../../packages/workit-core/src/core/uninstall";

// Uninstall planning/apply tests run ONLY on temp fixture homes (D-07): every
// home/config path is injected, no default may resolve to the real HOME, and
// the fixture ~/.config/workit must stay byte-identical by construction
// (CA-11/CA-12/CA-14).

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-uninstall-"));
  const home = path.join(root, "home");
  const configDir = path.join(home, ".config", "workit");
  mkdirSync(path.join(configDir, "skills"), { recursive: true });
  const opencodeConfig = path.join(home, ".config", "opencode", "opencode.json");
  const cursorSettings = path.join(home, ".cursor", "settings.json");
  const cursorMcp = path.join(home, ".cursor", "mcp.json");
  const pluginDir = path.join(home, ".cursor", "plugins", "local", "workit");
  const paths = {
    home,
    configDir,
    opencodeConfig,
    cursorSettings,
    cursorMcp,
    cursorPluginDir: pluginDir,
  };
  const writeJson = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  };
  return {
    root,
    ...paths,
    writeJson,
    seedInstalled: () => {
      writeJson(opencodeConfig, {
        plugin: ["file:///dev/workit/packages/workit-opencode/src/plugin.ts", "@other/pkg"],
        model: "keep-me",
      });
      writeJson(cursorSettings, {
        enabled_plugins: { workit: true, other: true },
        plugin_dirs: ["/unrelated/dir", pluginDir],
        theme: "dark",
      });
      writeJson(cursorMcp, {
        mcpServers: { workit: { command: "npx" }, otherServer: { command: "node" } },
      });
      mkdirSync(path.join(pluginDir, "rules"), { recursive: true });
      writeFileSync(path.join(pluginDir, "rules", "x.mdc"), "rule");
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const fixtures: ReturnType<typeof fixture>[] = [];
afterAll(() => {
  for (const f of fixtures) f.cleanup();
});
const tracked = () => {
  const f = fixture();
  fixtures.push(f);
  return f;
};

test("plan reports both hosts installed with exact action paths", () => {
  const f = tracked();
  f.seedInstalled();
  const plan = planUninstall(f);
  expect(plan.hosts.map((h) => h.host)).toEqual(["opencode", "cursor"]);
  const oc = plan.hosts.find((h) => h.host === "opencode")!;
  expect(oc.installed).toBe(true);
  expect(oc.actions).toEqual([
    { kind: "edit-json-remove", path: f.opencodeConfig, detail: expect.any(String) },
  ]);
  const cur = plan.hosts.find((h) => h.host === "cursor")!;
  expect(cur.installed).toBe(true);
  expect(cur.actions).toEqual(
    expect.arrayContaining([
      { kind: "edit-json-remove", path: f.cursorSettings, detail: expect.any(String) },
      { kind: "edit-json-remove", path: f.cursorMcp, detail: expect.any(String) },
      { kind: "remove-dir", path: f.cursorPluginDir, detail: expect.any(String) },
    ]),
  );
  expect(cur.actions).toHaveLength(3);
});

test("apply removes only workit entries; foreign bytes preserved elsewhere", () => {
  const f = tracked();
  f.seedInstalled();
  const result = applyUninstall(planUninstall(f), f);
  expect(result.ok).toBe(true);
  const statuses = result.entries.map((e) => e.status);
  expect(statuses.every((s) => s === "removed")).toBe(true);

  const oc = JSON.parse(readFileSync(f.opencodeConfig, "utf8"));
  expect(oc.plugin).toEqual(["@other/pkg"]);
  expect(oc.model).toBe("keep-me");
  // Byte-level: rewritten files end with exactly one trailing newline.
  expect(readFileSync(f.opencodeConfig, "utf8")).toMatch(/\}\n$/);

  const settings = JSON.parse(readFileSync(f.cursorSettings, "utf8"));
  expect(settings.enabled_plugins).toEqual({ other: true });
  expect(settings.plugin_dirs).toEqual(["/unrelated/dir"]);
  expect(settings.theme).toBe("dark");

  const mcp = JSON.parse(readFileSync(f.cursorMcp, "utf8"));
  expect(mcp.mcpServers).toEqual({ otherServer: { command: "node" } });

  expect(existsSync(f.cursorPluginDir)).toBe(false);
});

test("~/.config/workit stays byte-identical through plan and apply", () => {
  const f = tracked();
  f.seedInstalled();
  writeFileSync(path.join(f.configDir, "config.json"), '{"locale":"es-CL"}');
  writeFileSync(path.join(f.configDir, "youtrack.token"), "secret-bytes");
  writeFileSync(path.join(f.configDir, "skills", "wk-init.md"), "# skill");
  const snapshot = ["config.json", "youtrack.token", "skills/wk-init.md"].map((rel) =>
    readFileSync(path.join(f.configDir, rel)),
  );
  planUninstall(f);
  applyUninstall(planUninstall(f), f);
  const after = ["config.json", "youtrack.token", "skills/wk-init.md"].map((rel) =>
    readFileSync(path.join(f.configDir, rel)),
  );
  expect(after).toEqual(snapshot);
  // By construction the config dir is never an action target.
  const allActions = planUninstall(f).hosts.flatMap((h) => h.actions.map((a) => a.path));
  expect(allActions.some((p) => p.startsWith(f.configDir))).toBe(false);
});

test("malformed host JSON fails that action untouched while others proceed", () => {
  const f = tracked();
  f.seedInstalled();
  const broken = "{not json";
  writeFileSync(f.cursorSettings, broken);
  const result = applyUninstall(planUninstall(f), f);
  const settingsEntry = result.entries.find((e) => e.path === f.cursorSettings)!;
  expect(settingsEntry.status).toBe("failed");
  expect(readFileSync(f.cursorSettings, "utf8")).toBe(broken);
  expect(existsSync(f.cursorPluginDir)).toBe(false);
  expect(result.entries.find((e) => e.path === f.cursorMcp)!.status).toBe("removed");
});

// An existing-but-unreadable file (EACCES) must not be conflated with a missing
// one: plan still marks the host installed and apply fails that action with
// bytes untouched (mirrors setup.ts readExisting disambiguation).
test("existing-but-unreadable settings.json plans installed and applies failed untouched", () => {
  if (process.platform === "win32") return; // chmod is not advisory on win32
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses permissions
  const f = tracked();
  f.seedInstalled();
  const before = readFileSync(f.cursorSettings);
  chmodSync(f.cursorSettings, 0o000);
  try {
    const plan = planUninstall(f);
    const cur = plan.hosts.find((h) => h.host === "cursor")!;
    expect(cur.installed).toBe(true);
    expect(
      cur.actions.some((a) => a.kind === "edit-json-remove" && a.path === f.cursorSettings),
    ).toBe(true);
    const result = applyUninstall(plan, f);
    expect(result.ok).toBe(false);
    expect(result.entries.find((e) => e.path === f.cursorSettings)!.status).toBe("failed");
    // Sibling actions proceed.
    expect(result.entries.find((e) => e.path === f.cursorMcp)!.status).toBe("removed");
    expect(existsSync(f.cursorPluginDir)).toBe(false);
  } finally {
    chmodSync(f.cursorSettings, 0o644);
  }
  expect(readFileSync(f.cursorSettings)).toEqual(before);
});

test("existing-but-unreadable mcp.json plans installed and applies failed untouched", () => {
  if (process.platform === "win32") return; // chmod is not advisory on win32
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses permissions
  const f = tracked();
  f.seedInstalled();
  const before = readFileSync(f.cursorMcp);
  chmodSync(f.cursorMcp, 0o000);
  try {
    const plan = planUninstall(f);
    const cur = plan.hosts.find((h) => h.host === "cursor")!;
    expect(cur.installed).toBe(true);
    expect(cur.actions.some((a) => a.kind === "edit-json-remove" && a.path === f.cursorMcp)).toBe(
      true,
    );
    const result = applyUninstall(plan, f);
    expect(result.ok).toBe(false);
    expect(result.entries.find((e) => e.path === f.cursorMcp)!.status).toBe("failed");
  } finally {
    chmodSync(f.cursorMcp, 0o644);
  }
  expect(readFileSync(f.cursorMcp)).toEqual(before);
});

test("double-apply is idempotent and post-apply plan reports nothing installed", () => {
  const f = tracked();
  f.seedInstalled();
  applyUninstall(planUninstall(f), f);
  const second = applyUninstall(planUninstall(f), f);
  expect(second.ok).toBe(true);
  expect(second.entries.every((e) => e.status === "skipped")).toBe(true);
  const afterPlan = planUninstall(f);
  expect(afterPlan.hosts.every((h) => !h.installed && h.actions.length === 0)).toBe(true);
});

test("only-if-changed: clean host files are never rewritten", () => {
  const f = tracked();
  f.writeJson(f.opencodeConfig, { plugin: ["@other/pkg"] });
  const before = readFileSync(f.opencodeConfig, "utf8");
  const result = applyUninstall(planUninstall(f), f);
  expect(result.entries.filter((e) => e.path === f.opencodeConfig)).toHaveLength(0);
  expect(readFileSync(f.opencodeConfig, "utf8")).toBe(before);
});

test("remove-dir refuses any path other than the canonical plugins/local/workit", () => {
  const f = tracked();
  const evil = path.join(f.home, ".cursor", "plugins", "local", "..", "local", "evil");
  mkdirSync(path.join(f.home, ".cursor", "plugins", "local", "evil"), { recursive: true });
  const plan = {
    hosts: [
      {
        host: "cursor" as const,
        installed: true,
        actions: [{ kind: "remove-dir" as const, path: evil, detail: "forged" }],
      },
    ],
  };
  const result = applyUninstall(plan, f);
  expect(result.entries[0].status).toBe("failed");
  expect(existsSync(path.join(f.home, ".cursor", "plugins", "local", "evil"))).toBe(true);
});

test("forged edit-json-remove outside recognized targets fails closed", () => {
  const f = tracked();
  const evil = path.join(f.home, "evil.json");
  const plan = {
    hosts: [
      {
        host: "cursor" as const,
        installed: true,
        actions: [{ kind: "edit-json-remove" as const, path: evil, detail: "forged" }],
      },
    ],
  };
  const result = applyUninstall(plan, f);
  expect(result.entries[0].status).toBe("failed");
  expect(existsSync(evil)).toBe(false);
});

test("HOME fallback chain matches setup.ts: explicit home > env.HOME > homedir (no process.env tier)", () => {
  // With an empty injected env and no explicit home, resolution must land on
  // os.homedir() (spied to a hermetic fixture) — never on an ambient
  // process.env.HOME tier.
  const spiedHome = mkdtempSync(path.join(os.tmpdir(), "wk-uninstall-homespy-"));
  mkdirSync(path.join(spiedHome, ".config", "opencode"), { recursive: true });
  writeFileSync(
    path.join(spiedHome, ".config", "opencode", "opencode.json"),
    JSON.stringify({ plugin: ["@brainervirus/workit-opencode"] }, null, 2) + "\n",
    "utf8",
  );
  const spy = spyOn(os, "homedir").mockReturnValue(spiedHome);
  const prevHome = process.env.HOME;
  process.env.HOME = "/hostile/injected-home";
  try {
    const plan = planUninstall({ env: {} });
    const oc = plan.hosts.find((h) => h.host === "opencode")!;
    expect(oc.actions.map((a) => a.path)).toEqual([
      path.join(spiedHome, ".config", "opencode", "opencode.json"),
    ]);
    const cur = plan.hosts.find((h) => h.host === "cursor")!;
    expect(cur.actions.some((a) => a.path.startsWith("/hostile"))).toBe(false);
  } finally {
    spy.mockRestore();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(spiedHome, { recursive: true, force: true });
  }
  // Explicit home still wins over env.HOME (fixture sanity).
  const f = tracked();
  f.seedInstalled();
  const explicit = planUninstall({ env: { HOME: "/env-home" }, home: f.home });
  expect(explicit.hosts[0].actions[0]?.path).toBe(
    path.join(f.home, ".config", "opencode", "opencode.json"),
  );
});

test("byte-compare read failure fails that action; siblings proceed (vanish-between-reads race)", () => {
  const f = tracked();
  f.seedInstalled();
  const plan = planUninstall(f);
  // Deterministic TOCTOU: the byte-compare re-read of settings.json (the second
  // read of that path inside apply) throws as if the file vanished after
  // parse — the guard must fail THIS action only, never abort the rest.
  let settingsReads = 0;
  const realReadFileSync = readFileSync;
  const spy = spyOn(fsMod, "readFileSync").mockImplementation(((p: unknown, opts: unknown) => {
    if (String(p) === f.cursorSettings && (settingsReads += 1) >= 2) {
      throw new Error("simulated vanish between reads");
    }
    return realReadFileSync(p as string, opts as undefined);
  }) as typeof readFileSync);
  try {
    const result = applyUninstall(plan, f);
    const settingsEntry = result.entries.find((e) => e.path === f.cursorSettings)!;
    expect(settingsEntry.status).toBe("failed");
    expect(settingsEntry.detail).toContain("read failed");
    expect(result.ok).toBe(false);
    // Sibling actions still completed.
    expect(result.entries.find((e) => e.path === f.cursorMcp)!.status).toBe("removed");
    expect(existsSync(f.cursorPluginDir)).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

test("rm allow-list survives an ancestor-symlinked HOME (realpath belt does not over-block)", () => {
  if (process.platform === "win32") return;
  const f = tracked();
  f.seedInstalled();
  // The whole fixture home is reached through a symlink alias — exactly what
  // realpath equality sees on BOTH sides, so the belt must stay open here.
  const alias = path.join(path.dirname(f.home), `${path.basename(f.home)}-alias`);
  symlinkSync(f.home, alias, "dir");
  try {
    const aliased: Parameters<typeof planUninstall>[0] = {
      ...f,
      home: alias,
      cursorPluginDir: path.join(alias, ".cursor", "plugins", "local", "workit"),
    };
    const plan = planUninstall(aliased);
    const result = applyUninstall(plan, aliased);
    expect(result.ok, JSON.stringify(result.entries)).toBe(true);
    const dirEntry = result.entries.find((e) => e.path === aliased.cursorPluginDir)!;
    expect(dirEntry.status).toBe("removed");
    expect(existsSync(f.cursorPluginDir)).toBe(false);
  } finally {
    rmSync(alias, { force: true });
  }
});

test("a plugin dir swapped to an off-site symlink removes only the link, never the target", () => {
  if (process.platform === "win32") return;
  const f = tracked();
  f.seedInstalled();
  // TOCTOU-style swap: after planning, workit/ becomes a symlink to a decoy.
  rmSync(f.cursorPluginDir, { recursive: true, force: true });
  const decoy = path.join(f.root, "decoy");
  mkdirSync(decoy, { recursive: true });
  writeFileSync(path.join(decoy, "precious"), "keep", "utf8");
  symlinkSync(decoy, f.cursorPluginDir, "dir");
  const result = applyUninstall(planUninstall(f), f);
  expect(result.entries.find((e) => e.path === f.cursorPluginDir)!.status).toBe("removed");
  expect(existsSync(path.join(decoy, "precious"))).toBe(true); // decoy untouched
  expect(existsSync(f.cursorPluginDir)).toBe(false); // the link itself is gone
});

test("plan-vs-applied parity: every planned action yields exactly one entry", () => {
  const f = tracked();
  f.seedInstalled();
  const plan = planUninstall(f);
  const result = applyUninstall(plan, f);
  expect(result.entries.map((e) => e.path)).toEqual(
    plan.hosts.flatMap((h) => h.actions.map((a) => a.path)),
  );
  expect(result.entries.map((e) => e.host)).toEqual(
    plan.hosts.flatMap((h) => h.actions.map(() => h.host)),
  );
});
