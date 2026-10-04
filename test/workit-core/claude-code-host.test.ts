// S14 host wiring for Claude Code: wizard detection, the native install plan
// (git-hosted marketplace → npm package), setup apply verification, and the
// doctor's stale/skew check over Claude's plugin registry.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectHosts, preselectedPlatforms } from "@/packages/workit-core/src/core/detect-hosts";
import { runDoctor } from "@/packages/workit-core/src/core/doctor";
import {
  claudeWorkitInstalls,
  isClaudeWorkitInstalled,
  planHostInstall,
  runHostInstall,
} from "@/packages/workit-core/src/core/host-install";
import { applySetupPreview, buildSetupPreview } from "@/packages/workit-core/src/core/setup";
import {
  applyUninstall,
  planUninstall,
  type UninstallAction,
} from "@/packages/workit-core/src/core/uninstall";

const temp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const executable = (file: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/usr/bin/env node\n", { mode: 0o755 });
};
const REPO = path.resolve(import.meta.dir, "../..");
const CORE_VERSION = JSON.parse(
  readFileSync(path.join(REPO, "packages/workit-core/package.json"), "utf8"),
).version as string;

/** Record a Claude Code plugin install the way `claude plugin install` does (2.1.288). */
const recordInstall = (
  configDir: string,
  options: {
    id?: string;
    version?: string;
    name?: string;
    repository?: string;
    scope?: "user" | "project" | "local";
    projectPath?: string;
  } = {},
) => {
  const id = options.id ?? "workit@workit";
  const version = options.version ?? "2.1.5";
  const installPath = path.join(
    configDir,
    "plugins",
    "cache",
    ...id.split("@").toReversed(),
    version,
  );
  mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(installPath, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: options.name ?? "workit",
      version,
      repository: options.repository ?? "https://github.com/BrainerVirus/workit",
    }),
  );
  writeFileSync(
    path.join(configDir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        [id]: [
          {
            scope: options.scope ?? "user",
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
            installPath,
            version,
          },
        ],
      },
    }),
  );
  return installPath;
};

test("the wizard detects `claude` on PATH and a recorded Workit plugin install", () => {
  const home = temp("workit-claude-detect-");
  const bin = temp("workit-claude-detect-bin-");
  try {
    let found = detectHosts({ home, env: { HOME: home, PATH: bin } });
    expect(found["claude-code"]).toEqual({ detected: false, configured: false });
    // A config directory alone is not an installation.
    mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
    expect(detectHosts({ home, env: { HOME: home, PATH: bin } })["claude-code"].detected).toBe(
      false,
    );
    executable(path.join(bin, "claude"));
    found = detectHosts({ home, env: { HOME: home, PATH: bin } });
    expect(found["claude-code"]).toEqual({ detected: true, configured: false });
    expect(preselectedPlatforms(found)).toContain("claude-code");
    recordInstall(path.join(home, ".claude"));
    expect(detectHosts({ home, env: { HOME: home, PATH: bin } })["claude-code"]).toEqual({
      detected: true,
      configured: true,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("only a canonical Workit manifest counts as installed, from any marketplace or CLAUDE_CONFIG_DIR", () => {
  const home = temp("workit-claude-installs-");
  try {
    const config = path.join(home, "custom-claude");
    const env = { HOME: home, CLAUDE_CONFIG_DIR: config };
    recordInstall(config, { name: "workit", repository: "https://github.com/someone/else" });
    expect(isClaudeWorkitInstalled(home, env)).toBe(false);
    recordInstall(config, { id: "workit@my-fork", version: "9.9.9" });
    expect(claudeWorkitInstalls(home, env)).toEqual([
      expect.objectContaining({ id: "workit@my-fork", version: "9.9.9" }),
    ]);
    // The default config dir is not consulted when CLAUDE_CONFIG_DIR is set.
    expect(isClaudeWorkitInstalled(home, { HOME: home })).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude Code setup registers the git-hosted marketplace once, then installs workit@workit", () => {
  const home = temp("workit-claude-plan-");
  const bin = temp("workit-claude-plan-bin-");
  try {
    executable(path.join(bin, "node"));
    executable(path.join(bin, "claude"));
    const env = { HOME: home, PATH: bin };
    const commands = planHostInstall("claude-code", { home, cwd: home, env });
    expect(commands.slice(1).map((command) => command.args)).toEqual([
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "add", "BrainerVirus/workit"],
      ["plugin", "install", "workit@workit", "--scope", "user"],
    ]);
    const ran: string[] = [];
    const listing = JSON.stringify([{ name: "workit", source: "github" }], null, 2);
    const result = runHostInstall(commands, (command) => {
      ran.push(command.purpose);
      return {
        exitCode: 0,
        stdout: command.args.includes("list") ? listing : "",
        stderr: "",
      };
    });
    expect(result.ok).toBe(true);
    // Already-registered marketplace: the add is skipped, the install still runs.
    expect(ran).toEqual([
      "Check the Node.js 24+ package runtime requirement",
      "Check whether the Workit Claude Code marketplace is already registered",
      "Install the Workit Claude Code plugin",
    ]);
    expect(
      planHostInstall("claude-code", { home, cwd: home, env, mode: "upgrade" })
        .slice(1)
        .map((command) => command.args),
    ).toEqual([
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "update", "workit"],
      ["plugin", "update", "workit@workit"],
    ]);
    // An existing install is never re-installed by setup.
    recordInstall(path.join(home, ".claude"));
    expect(planHostInstall("claude-code", { home, cwd: home, env })).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("setup apply reports Claude Code installed only when the plugin registry shows Workit", () => {
  const home = temp("workit-claude-setup-");
  const bin = temp("workit-claude-setup-bin-");
  const configDir = temp("workit-claude-setup-config-");
  try {
    executable(path.join(bin, "node"));
    executable(path.join(bin, "claude"));
    const env = { HOME: home, PATH: bin, WORKFLOW_TOOLKIT_CONFIG_DIR: configDir };
    const options = { home, cwd: home, env, dir: configDir, configDir };
    const preview = buildSetupPreview(
      {
        platforms: ["claude-code"],
        locale: "en",
        branchPreset: "github-flow",
        branchAllowed: "",
        branchProtected: "",
        baseUrl: "",
        vcsProvider: "skip",
        workspaces: [],
        applyProject: false,
      },
      options,
    );
    const host = preview.mutations.find((mutation) => mutation.type === "install-host");
    expect(host?.path).toBe(path.join(home, ".claude", "plugins", "installed_plugins.json"));
    const applied = applySetupPreview(preview, {
      ...options,
      runHostCommand: (command) => {
        if (command.args.includes("install")) recordInstall(path.join(home, ".claude"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const claude = applied.entries.filter((entry) => entry.platform === "claude-code");
    expect(claude.map((entry) => entry.status)).not.toContain("Failed");
    expect(claude.some((entry) => entry.detail?.includes("plugin install workit@workit"))).toBe(
      true,
    );
    // A host command that "succeeds" without registering Workit is a failure.
    rmSync(path.join(home, ".claude"), { recursive: true, force: true });
    const unverified = applySetupPreview(preview, {
      ...options,
      runHostCommand: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(
      unverified.entries.some(
        (entry) => entry.platform === "claude-code" && entry.status === "Failed",
      ),
    ).toBe(true);
  } finally {
    for (const dir of [home, bin, configDir]) rmSync(dir, { recursive: true, force: true });
  }
});

// Each call runs the whole doctor (runtime, identity and lock probes too),
// which takes seconds on a CI runner.
test("doctor warns only when a newer Claude Code plugin version is published with the native update command", () => {
  const home = temp("workit-claude-doctor-");
  try {
    const check = (env: NodeJS.ProcessEnv) =>
      runDoctor({ home, env: { HOME: home, ...env } }).checks.find(
        (entry) => entry.id === "claude_plugin",
      )!;
    expect(check({}).status).toBe("pass");
    recordInstall(path.join(home, ".claude"), { version: CORE_VERSION });
    const current = check({ WORKIT_DOCTOR_STALE_REGISTRY_VERSION: CORE_VERSION });
    expect(current.status).toBe("pass");
    recordInstall(path.join(home, ".claude"), { version: "0.0.1" });
    const stale = check({ WORKIT_DOCTOR_STALE_REGISTRY_VERSION: CORE_VERSION });
    expect(stale.status).toBe("warn");
    expect(stale.detail).toContain(
      `stale_install: workit@workit 0.0.1 is behind published ${CORE_VERSION}`,
    );
    // An older plugin with nothing newer published (or an unreachable registry)
    // is not a finding, whatever this CLI's version.
    expect(check({ WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "0.0.1" }).status).toBe("pass");
    expect(stale.fix).toBe(
      "claude plugin marketplace update workit && claude plugin update workit@workit",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test("uninstall previews a native `claude plugin uninstall` per Workit install and runs only that argv", () => {
  const home = temp("workit-claude-uninstall-");
  try {
    const env = { HOME: home };
    expect(planUninstall({ home, env }).hosts.find((h) => h.host === "claude-code")).toEqual({
      host: "claude-code",
      installed: false,
      actions: [],
    });
    recordInstall(path.join(home, ".claude"), { id: "workit@workit" });
    const plan = planUninstall({ home, env });
    const claude = plan.hosts.find((h) => h.host === "claude-code")!;
    expect(claude.installed).toBe(true);
    expect(claude.actions).toEqual([
      expect.objectContaining({
        kind: "host-command",
        command: "claude",
        args: ["plugin", "uninstall", "workit@workit", "--scope", "user"],
        cwd: null,
        detail: "claude plugin uninstall workit@workit --scope user",
      }),
    ]);
    const ran: string[][] = [];
    const reviewed = { hosts: [claude] };
    const result = applyUninstall(reviewed, {
      home,
      env,
      runHostCommand: (step) => {
        ran.push(step.args);
        rmSync(path.join(home, ".claude", "plugins", "installed_plugins.json"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(ran).toEqual([["plugin", "uninstall", "workit@workit", "--scope", "user"]]);
    expect(result.entries).toEqual([
      expect.objectContaining({ host: "claude-code", status: "removed" }),
    ]);
    // Already gone: skipped without running anything.
    expect(
      applyUninstall(reviewed, {
        home,
        env,
        runHostCommand: () => {
          throw new Error("must not run");
        },
      }).entries[0].status,
    ).toBe("skipped");
    // A tampered plan never runs an arbitrary command.
    recordInstall(path.join(home, ".claude"));
    const tampered = {
      hosts: [
        {
          ...claude,
          actions: [{ ...claude.actions[0], args: ["plugin", "uninstall", "other@x", "--prune"] }],
        },
      ],
    } as typeof reviewed;
    const refused = applyUninstall(tampered, {
      home,
      env,
      runHostCommand: () => {
        throw new Error("must not run");
      },
    });
    expect(refused.ok).toBe(false);
    expect(refused.entries[0].detail).toContain("refusing unreviewed host command");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("project and local installs count only inside their project, and uninstall from it with --scope", () => {
  const home = temp("workit-claude-scope-");
  try {
    const project = path.join(home, "repo");
    const other = path.join(home, "elsewhere");
    mkdirSync(path.join(project, "src"), { recursive: true });
    mkdirSync(other, { recursive: true });
    const env = { HOME: home };
    recordInstall(path.join(home, ".claude"), { scope: "project", projectPath: project });
    // Outside the project (and with no project at all) nothing applies.
    expect(isClaudeWorkitInstalled(home, env, other)).toBe(false);
    expect(isClaudeWorkitInstalled(home, env, null)).toBe(false);
    expect(claudeWorkitInstalls(home, env, path.join(project, "src"))).toEqual([
      expect.objectContaining({ scope: "project", projectPath: project }),
    ]);
    // Setup installs user scope, so a project-only install does not satisfy it.
    expect(planUninstall({ home, env, cwd: other }).hosts.at(-1)?.actions).toEqual([]);
    const plan = planUninstall({ home, env, cwd: project });
    const claude = plan.hosts.find((h) => h.host === "claude-code")!;
    expect(claude.actions).toEqual([
      expect.objectContaining({
        args: ["plugin", "uninstall", "workit@workit", "--scope", "project"],
        cwd: project,
      }),
    ]);
    const steps: Array<{ args: string[]; cwd?: string }> = [];
    const applied = applyUninstall(
      { hosts: [claude] },
      {
        home,
        env,
        runHostCommand: (step) => {
          steps.push({ args: step.args, cwd: step.cwd });
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(applied.ok).toBe(true);
    expect(steps).toEqual([
      { args: ["plugin", "uninstall", "workit@workit", "--scope", "project"], cwd: project },
    ]);
    const reviewedAction = claude.actions[0] as Extract<UninstallAction, { kind: "host-command" }>;
    // A project-scope action without its project, or a user-scope one with a
    // cwd, is not the reviewed shape.
    for (const action of [
      { ...reviewedAction, cwd: null },
      { ...reviewedAction, args: ["plugin", "uninstall", "workit@workit", "--scope", "user"] },
      {
        ...claude.actions[0],
        args: ["plugin", "uninstall", "workit@workit", "--scope", "managed"],
      },
    ]) {
      const refused = applyUninstall(
        { hosts: [{ ...claude, actions: [action] }] },
        {
          home,
          env,
          runHostCommand: () => ({ exitCode: 0, stdout: "", stderr: "" }),
        },
      );
      expect(refused.entries[0].status, JSON.stringify(action.args)).toBe("failed");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
