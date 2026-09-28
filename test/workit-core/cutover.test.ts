import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  applyCutover,
  applyRollback,
  classifyHostGeneration,
  countLegacyFlowRecords,
  detectCursorLatest,
  detectSourceLinkedOpenCode,
  digestFile,
  legacyFlowRecordDigests,
  previewCutover,
  previewRollback,
  readGenerationState,
  resumeCutover,
} from "@/packages/workit-core/src/core/cutover";
import { installV1Skills, removeLegacySkills } from "@/test/shared/helpers/cutover-fixture";
import { applyFxCutover, approve, makeFx, resolvePathsForTest } from "./cutover-test-helpers";

test("rollback refuses to overwrite a subsequent user edit", () => {
  const fx = makeFx();
  try {
    const cutover = applyFxCutover(fx);
    writeFileSync(fx.cursorMcp, readFileSync(fx.cursorMcp, "utf8") + "\n");
    expect(applyRollback(cutover.backupId, resolvePathsForTest(fx))).toMatchObject({
      ok: false,
      code: "revision_conflict",
    });
  } finally {
    fx.cleanup();
  }
});

test("all 31 legacy workflow records stay byte-stable through cutover", () => {
  const fx = makeFx();
  try {
    const before = legacyFlowRecordDigests(fx.workspace);
    expect(before.length).toBe(31);
    applyFxCutover(fx);
    expect(legacyFlowRecordDigests(fx.workspace)).toEqual(before);
    expect(countLegacyFlowRecords(fx.workspace)).toBe(31);
  } finally {
    fx.cleanup();
  }
});

test("v1 task data and repository work are preserved on rollback conflict", () => {
  const fx = makeFx();
  try {
    const taskFile = path.join(fx.workspace, ".workit", "tasks", "task-1.json");
    const taskBefore = readFileSync(taskFile, "utf8");
    const cutover = applyFxCutover(fx);
    writeFileSync(fx.cursorSettings, '{"edited":true}\n');
    expect(applyRollback(cutover.backupId, resolvePathsForTest(fx)).ok).toBe(false);
    expect(readFileSync(taskFile, "utf8")).toBe(taskBefore);
  } finally {
    fx.cleanup();
  }
});

test("new v1 task may reference old docs without importing authority", () => {
  const fx = makeFx();
  try {
    const task = JSON.parse(
      readFileSync(path.join(fx.workspace, ".workit", "tasks", "task-1.json"), "utf8"),
    );
    expect(task.title).toContain("docs/legacy-flow-0/spec.md");
    const flow = JSON.parse(
      readFileSync(path.join(fx.workspace, "docs/legacy-flow-0/sdd/flow.json"), "utf8"),
    );
    expect(flow.execution.status).not.toBe(task.execution?.status);
  } finally {
    fx.cleanup();
  }
});

test("detects current source-linked OpenCode registration", () => {
  const fx = makeFx();
  try {
    expect(detectSourceLinkedOpenCode(fx.opencodeConfig)).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("detects Cursor @latest canonical registration", () => {
  const fx = makeFx();
  try {
    expect(detectCursorLatest(fx.cursorMcp)).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("refuses mixed host components during preview", () => {
  const fx = makeFx();
  try {
    installV1Skills(fx.pluginDir);
    expect(
      classifyHostGeneration("cursor", {
        home: fx.home,
        configDir: fx.configDir,
        stateDir: fx.stateDir,
        dev: fx.dev,
        workspace: fx.workspace,
        opencodeConfig: fx.opencodeConfig,
        cursorSettings: fx.cursorSettings,
        cursorMcp: fx.cursorMcp,
        cursorPluginDir: fx.pluginDir,
        piConfig: path.join(fx.home, ".pi", "config.json"),
        piSettings: path.join(fx.home, ".pi", "agent", "settings.json"),
        sessions: [],
      }),
    ).toBe("mixed");
    expect(previewCutover(resolvePathsForTest(fx)).blocked.some((b) => b.includes("mixed"))).toBe(
      true,
    );
  } finally {
    fx.cleanup();
  }
});

test("active or unknown old sessions block activation", () => {
  const fx = makeFx();
  try {
    expect(
      previewCutover({
        ...resolvePathsForTest(fx),
        sessions: [{ host: "opencode", handle: "ses_live", state: "active" }],
      }).blocked.some((b) => b.includes("active")),
    ).toBe(true);
    expect(
      previewCutover({
        ...resolvePathsForTest(fx),
        sessions: [{ host: "cursor", handle: "ses_x", state: "unknown" }],
      }).blocked.some((b) => b.includes("unknown")),
    ).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("apply backs up managed digests and reports activation receipt", () => {
  const fx = makeFx();
  try {
    removeLegacySkills(fx.pluginDir);
    installV1Skills(fx.pluginDir);
    const receipt = applyCutover(
      previewCutover(resolvePathsForTest(fx)),
      approve(["opencode", "cursor", "codex", "pi"]),
      resolvePathsForTest(fx),
    );
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.data.backupId).toBeTruthy();
    expect(receipt.data.managedFiles.length).toBeGreaterThan(0);
    expect(receipt.data.partial).toBe(false);
    expect(
      previewRollback(receipt.data.backupId, resolvePathsForTest(fx)).restorable.length,
    ).toBeGreaterThan(0);
  } finally {
    fx.cleanup();
  }
});

test("rollback restores managed integration files without removing v1 task state", () => {
  const fx = makeFx();
  try {
    removeLegacySkills(fx.pluginDir);
    installV1Skills(fx.pluginDir);
    const beforeMcp = readFileSync(fx.cursorMcp, "utf8");
    const applied = applyCutover(
      previewCutover(resolvePathsForTest(fx)),
      approve(["cursor"]),
      resolvePathsForTest(fx),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(readFileSync(fx.cursorMcp, "utf8")).not.toBe(beforeMcp);
    expect(applyRollback(applied.data.backupId, resolvePathsForTest(fx)).ok).toBe(true);
    expect(readFileSync(fx.cursorMcp, "utf8")).toBe(beforeMcp);
    expect(applyRollback(applied.data.backupId, resolvePathsForTest(fx)).ok).toBe(true);
    expect(existsSync(path.join(fx.workspace, ".workit", "tasks", "task-1.json"))).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("rollback removes generated integrations and rejects a damaged backup", () => {
  const fx = makeFx();
  try {
    const applied = applyFxCutover(fx);
    const backupRoot = path.join(fx.stateDir, "cutover", "backups", applied.backupId);
    const originalPaths = new Set(
      JSON.parse(readFileSync(path.join(backupRoot, "manifest.json"), "utf8")).files.map(
        (entry: { path: string }) => entry.path,
      ),
    );
    const generatedFile = applied.managedFiles.find(
      (entry) => !originalPaths.has(entry.path) && entry.path.endsWith("cutover-choices.json"),
    );
    expect(generatedFile).toBeDefined();
    if (!generatedFile) return;
    expect(existsSync(generatedFile.path)).toBe(true);
    expect(previewRollback(applied.backupId, resolvePathsForTest(fx)).issues).toEqual([]);
    expect(applyRollback(applied.backupId, resolvePathsForTest(fx)).ok).toBe(true);
    expect(existsSync(generatedFile.path)).toBe(false);
    expect(applyRollback(applied.backupId, resolvePathsForTest(fx)).ok).toBe(true);

    const storageDir = path.join(backupRoot, "files");
    writeFileSync(path.join(storageDir, readdirSync(storageDir)[0]!), "damaged\n");
    const preview = previewRollback(applied.backupId, resolvePathsForTest(fx));
    expect(preview.issues.length).toBeGreaterThan(0);
    expect(applyRollback(applied.backupId, resolvePathsForTest(fx))).toMatchObject({
      ok: false,
      code: "recovery_required",
    });
    expect(existsSync(generatedFile.path)).toBe(false);
  } finally {
    fx.cleanup();
  }
});

test("cutover refreshes an exact generated skill and reports its ownership evidence", () => {
  const fx = makeFx();
  try {
    removeLegacySkills(fx.pluginDir);
    installV1Skills(fx.pluginDir);
    const relative = "skills/workit-behavioral-tdd/SKILL.md";
    const installed = path.join(fx.pluginDir, relative);
    const legacy = readFileSync("test/fixtures/legacy-workit-behavioral-tdd.fixture", "utf8");
    writeFileSync(installed, legacy);

    const ruleRelative = "rules/workit-contract.mdc";
    const installedRule = path.join(fx.pluginDir, ruleRelative);
    mkdirSync(path.dirname(installedRule), { recursive: true });
    writeFileSync(installedRule, readFileSync("test/fixtures/legacy-workit-contract.mdc"));

    const source = path.resolve("packages/workit-cursor", relative);
    const fixtureSource = path.join(fx.dev, "packages/workit-cursor", relative);
    mkdirSync(path.dirname(fixtureSource), { recursive: true });
    writeFileSync(fixtureSource, readFileSync(source));
    const ruleSource = path.resolve("packages/workit-cursor", ruleRelative);
    const fixtureRuleSource = path.join(fx.dev, "packages/workit-cursor", ruleRelative);
    mkdirSync(path.dirname(fixtureRuleSource), { recursive: true });
    writeFileSync(fixtureRuleSource, readFileSync(ruleSource));

    const paths = resolvePathsForTest(fx);
    const plan = previewCutover(paths, ["cursor"]);
    expect(plan.inventory.entries.find((entry) => entry.path === installed)).toMatchObject({
      disposition: "convert",
      ownershipEvidence: expect.stringContaining("SHA-256 matches generated Cursor asset"),
    });
    expect(plan.inventory.entries.find((entry) => entry.path === installedRule)).toMatchObject({
      disposition: "convert",
      ownershipEvidence: expect.stringContaining("SHA-256 matches generated Cursor asset"),
    });

    const applied = applyCutover(plan, approve(["cursor"]), paths);
    expect(applied.ok).toBe(true);
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(source, "utf8"));
    expect(readFileSync(installedRule, "utf8")).toBe(readFileSync(ruleSource, "utf8"));
    if (applied.ok)
      expect(applied.data.notes).toContain(
        `cursor: refreshed verified generated asset ${relative}`,
      );
  } finally {
    fx.cleanup();
  }
});

test("cursor replacement preserves edited skills and unrelated vendor content", () => {
  const fx = makeFx();
  try {
    removeLegacySkills(fx.pluginDir);
    installV1Skills(fx.pluginDir);
    const editedSkill = path.join(fx.pluginDir, "skills", "workit-plan", "SKILL.md");
    writeFileSync(editedSkill, "# user edit\n");
    const vendor = path.join(fx.pluginDir, "vendor", "local-note.txt");
    mkdirSync(path.dirname(vendor), { recursive: true });
    writeFileSync(vendor, "keep this\n");
    const plan = previewCutover(resolvePathsForTest(fx), ["cursor"]);
    expect(plan.inventory.entries.find((entry) => entry.path === editedSkill)).toMatchObject({
      disposition: "unknown",
      ownershipEvidence: null,
    });
    const applied = applyCutover(plan, approve(["cursor"]), resolvePathsForTest(fx));
    expect(applied.ok).toBe(true);
    expect(readFileSync(editedSkill, "utf8")).toBe("# user edit\n");
    expect(readFileSync(vendor, "utf8")).toBe("keep this\n");
    expect(existsSync(path.join(fx.pluginDir, "skills", "workit-plan"))).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("records resolutions and writes converted config during apply", () => {
  const fx = makeFx();
  try {
    removeLegacySkills(fx.pluginDir);
    installV1Skills(fx.pluginDir);
    const result = applyCutover(
      previewCutover(resolvePathsForTest(fx)),
      approve(["cursor"]),
      resolvePathsForTest(fx),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = JSON.parse(readFileSync(path.join(fx.configDir, "config.json"), "utf8"));
    expect(config.workflowMode).toBeUndefined();
    expect(
      JSON.parse(readFileSync(path.join(fx.configDir, "cutover-choices.json"), "utf8")).resolutions,
    ).toMatchObject({
      legacyWorkflowMode: "fresh-v1-task",
    });
  } finally {
    fx.cleanup();
  }
});

test("partial activation when a host apply fails", () => {
  const fx = makeFx();
  try {
    removeLegacySkills(fx.pluginDir);
    installV1Skills(fx.pluginDir);
    const paths = { ...resolvePathsForTest(fx), dev: null };
    const result = applyCutover(
      previewCutover(paths, ["cursor", "pi"]),
      approve(["cursor", "pi"]),
      paths,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.partial).toBe(true);
    expect(result.data.generation).toBe("legacy");
    expect(readGenerationState(fx.configDir).target).toBe("legacy");
    expect(result.data.hosts).toEqual(["cursor"]);

    const resumed = resumeCutover(result.data.backupId, resolvePathsForTest(fx));
    expect(resumed).toMatchObject({
      ok: true,
      data: { partial: false, generation: "v1", hosts: ["cursor", "pi"] },
    });
    expect(readGenerationState(fx.configDir).target).toBe("v1");
    expect(resumeCutover(result.data.backupId, resolvePathsForTest(fx))).toMatchObject({
      ok: true,
      data: { backupId: result.data.backupId, partial: false },
    });
  } finally {
    fx.cleanup();
  }
});

test("interrupted cutover resumes from its last completed host step", () => {
  const fx = makeFx();
  const codexSource = path.join(fx.dev, "packages/workit-codex/.codex-plugin");
  try {
    rmSync(codexSource, { recursive: true, force: true });
    const paths = resolvePathsForTest(fx);
    const first = applyCutover(
      previewCutover(paths, ["opencode", "codex"]),
      approve(["opencode", "codex"]),
      paths,
    );
    expect(first).toMatchObject({ ok: false, code: "requirements_unsatisfied" });
    if (first.ok) return;
    const backupId = first.details?.path;
    expect(typeof backupId).toBe("string");
    if (typeof backupId !== "string") return;

    mkdirSync(codexSource, { recursive: true });
    writeFileSync(path.join(codexSource, "plugin.json"), "{}\n");
    const resumed = resumeCutover(backupId, paths);

    expect(resumed).toMatchObject({
      ok: true,
      data: { partial: false, generation: "v1", hosts: ["opencode", "codex"] },
    });
    expect(JSON.parse(readFileSync(fx.opencodeConfig, "utf8")).plugin).toContain(
      `file://${fx.dev}/packages/workit-opencode/dist/plugin.js`,
    );
    expect(existsSync(path.join(fx.home, ".codex/plugins/workit/.codex-plugin/plugin.json"))).toBe(
      true,
    );
  } finally {
    fx.cleanup();
  }
});

test("previewCutover is read-only", () => {
  const fx = makeFx();
  try {
    const before = digestFile(fx.cursorMcp);
    previewCutover(resolvePathsForTest(fx));
    expect(digestFile(fx.cursorMcp)).toBe(before);
  } finally {
    fx.cleanup();
  }
});

test("preview inventories state and history by bytes without exposing file contents", () => {
  const fx = makeFx();
  try {
    const plan = previewCutover(resolvePathsForTest(fx), ["opencode"]);
    const taskFile = path.join(fx.workspace, ".workit", "tasks", "task-1.json");
    const task = plan.inventory.entries.find((entry) => entry.path === taskFile);
    const tokenFile = path.join(fx.configDir, "youtrack.token");
    const token = plan.inventory.entries.find((entry) => entry.path === tokenFile);
    const config = plan.inventory.entries.find(
      (entry) => entry.path === path.join(fx.configDir, "config.json"),
    );
    const histories = plan.inventory.entries.filter(
      (entry) => entry.category === "project-history" && entry.path.endsWith("/flow.json"),
    );

    expect(plan.inventory.complete).toBe(true);
    expect(task).toMatchObject({
      category: "project-state",
      disposition: "preserve",
      kind: "file",
    });
    expect(token).toMatchObject({
      category: "configuration",
      disposition: "preserve",
      kind: "file",
    });
    expect(config).toMatchObject({
      category: "configuration",
      disposition: "convert",
      kind: "file",
    });
    expect(histories).toHaveLength(31);
    expect(plan.inventory.bytes).toBeGreaterThan(0);
    expect(plan.inventory.files).toBeGreaterThan(histories.length);
    expect(JSON.stringify(plan.inventory)).not.toContain("secret-value");
  } finally {
    fx.cleanup();
  }
});

test("preview blocks symlink traversal and apply leaves the outside target untouched", () => {
  if (process.platform === "win32") return;
  const fx = makeFx();
  try {
    const outside = path.join(fx.root, "outside.json");
    const link = path.join(fx.pluginDir, "outside.json");
    writeFileSync(outside, "private outside bytes\n");
    symlinkSync(outside, link);
    const paths = resolvePathsForTest(fx);
    const beforeSettings = readFileSync(fx.cursorSettings, "utf8");
    const plan = previewCutover(paths, ["cursor"]);

    expect(plan.inventory.complete).toBe(false);
    expect(plan.blocked.join("\n")).toContain("symlink not followed during inventory");
    expect(plan.inventory.entries.find((entry) => entry.path === link)?.kind).toBe("symlink");
    expect(plan.inventory.entries.some((entry) => entry.path === outside)).toBe(false);
    expect(applyCutover(plan, approve(["cursor"]), paths).ok).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("private outside bytes\n");
    expect(readFileSync(fx.cursorSettings, "utf8")).toBe(beforeSettings);
    expect(existsSync(path.join(fx.stateDir, "cutover", "backups"))).toBe(false);
  } finally {
    fx.cleanup();
  }
});

test("Pi cutover adds Workit paths without replacing unrelated package, extension, or skill entries", () => {
  const fx = makeFx();
  try {
    const piConfig = path.join(fx.home, ".pi", "config.json");
    const piSettings = path.join(fx.home, ".pi", "agent", "settings.json");
    mkdirSync(path.dirname(piConfig), { recursive: true });
    mkdirSync(path.dirname(piSettings), { recursive: true });
    writeFileSync(
      piConfig,
      JSON.stringify({
        theme: "dark",
        extensions: ["/user/extension.js"],
        skills: ["/user/skills"],
      }),
    );
    writeFileSync(piSettings, JSON.stringify({ packages: ["/user/pi-package"], telemetry: false }));
    const paths = { ...resolvePathsForTest(fx), piConfig, piSettings };
    const result = applyCutover(previewCutover(paths, ["pi"]), approve(["pi"]), paths);
    expect(result.ok).toBe(true);
    const config = JSON.parse(readFileSync(piConfig, "utf8"));
    const settings = JSON.parse(readFileSync(piSettings, "utf8"));
    expect(config).toMatchObject({
      theme: "dark",
      extensions: ["/user/extension.js", path.join(fx.dev, "packages/workit-pi/dist/workit.js")],
      skills: ["/user/skills", path.join(fx.dev, "packages/workit-pi/skills")],
    });
    expect(settings).toMatchObject({
      telemetry: false,
      packages: ["/user/pi-package", path.join(fx.dev, "packages/workit-pi")],
    });
  } finally {
    fx.cleanup();
  }
});
