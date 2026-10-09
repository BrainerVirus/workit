// workit doctor host checks on scratch homes: Codex plugin hook trust and
// agents (codex-cli 0.160.1), and the Pi extension (pi-coding-agent 0.85.1).
import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDoctor, type DoctorCheck } from "@/packages/workit-cli/src/admin/doctor";
import { installCodexAgents } from "@/packages/workit-codex/scripts/agents";
import cliPkg from "@/packages/workit-cli/package.json" with { type: "json" };

const repo = path.resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(path.join(tmpdir(), "workit-doctor-hosts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emptyBin = path.join(scratch, "empty-bin");
mkdirSync(emptyBin, { recursive: true });

let n = 0;
const freshHome = () => {
  const home = path.join(scratch, `home-${++n}`);
  const cwd = path.join(scratch, `work-${n}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
};

const doctor = (home: string, cwd: string, env: Record<string, string> = {}) =>
  runDoctor({
    host: "cli",
    cliVersion: cliPkg.version,
    home,
    cwd,
    configDir: path.join(home, "config"),
    stateDir: path.join(home, "state"),
    dev: path.join(home, "no-dev"),
    env: { HOME: home, PATH: emptyBin, ...env },
  });
const check = (report: ReturnType<typeof runDoctor>, id: string): DoctorCheck =>
  report.checks.find((c) => c.id === id)!;

// --- Codex -------------------------------------------------------------------

// The workit hooks.json as installed, and the `currentHash` codex-cli 0.160.1
// reported for each of its hooks through `codex app-server` `hooks/list`.
const COMMAND = "node ${PLUGIN_ROOT}/dist/workit-hook.js";
const handler = [{ type: "command", command: COMMAND }];
const HOOKS = {
  hooks: {
    SessionStart: [{ matcher: "*", hooks: handler }],
    UserPromptSubmit: [{ hooks: handler }],
    PreToolUse: [{ matcher: "*", hooks: handler }],
    PostToolUse: [{ matcher: "Bash", hooks: handler }],
    SubagentStart: [{ matcher: "*", hooks: handler }],
    SubagentStop: [{ matcher: "*", hooks: handler }],
  },
};
const OBSERVED: Record<string, string> = {
  session_start: "sha256:6b29fdf64f68f1e0f6bb5c36f896d141191dfd86494df8f216c87556a9591360",
  user_prompt_submit: "sha256:d2307c6ab710f78745ffa1326cbe816451beac4b102a92d036adf690b32ffb27",
  pre_tool_use: "sha256:a03d3e0d3018093a73a18448969499eef65c168088ee1ee2f659b1eca1c8627b",
  post_tool_use: "sha256:b65ae0aede5a6e65af171bb9a2ade2c3e7649a2955f985edc4865a391c821a21",
  subagent_start: "sha256:fb4814e43323c0773920d0a75e3405e3a63ae146608b93fa61730750a8a9a823",
  subagent_stop: "sha256:3b74408935c63cfd71b489615a4fd371890019bd4577755cd666e4f9f10480d5",
};
const ID = "workit@workflow-toolkit";
const key = (event: string) => `${ID}:hooks/hooks.json:${event}:0:0`;

const codexInstall = (
  opts: { agents?: boolean; trust?: Record<string, string>; disabled?: string[] } = {},
) => {
  const { home, cwd } = freshHome();
  const codexHome = path.join(home, ".codex");
  const root = path.join(codexHome, "plugins", "cache", "workflow-toolkit", "workit", "8.5.2");
  mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(root, "hooks"), { recursive: true });
  writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), '{"name":"workit"}');
  writeFileSync(path.join(root, "package.json"), '{"version":"8.5.2"}');
  writeFileSync(path.join(root, "hooks", "hooks.json"), JSON.stringify(HOOKS));
  if (opts.agents !== false)
    cpSync(path.join(repo, "packages/workit-codex/agents"), path.join(root, "agents"), {
      recursive: true,
    });
  const state = Object.entries(opts.trust ?? {}).map(
    ([event, hash]) => `\n[hooks.state."${key(event)}"]\ntrusted_hash = "${hash}"\n`,
  );
  for (const event of opts.disabled ?? [])
    state.push(`\n[hooks.state."${key(event)}"]\nenabled = false\n`);
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `model = "gpt-5"\n\n[plugins."${ID}"]\nenabled = true\n${state.join("")}`,
  );
  return { home, cwd, codexHome, root };
};

test("Given no Workit Codex plugin, When doctor runs, Then the Codex checks pass as skipped", () => {
  const { home, cwd } = freshHome();
  const report = doctor(home, cwd);
  expect(check(report, "codex_hooks")).toMatchObject({ status: "pass" });
  expect(check(report, "codex_agents")).toMatchObject({ status: "pass" });
  expect(check(report, "codex_hooks").detail).toContain("skipping");
});

// Trust goes through Codex's own review: the fix never offers config lines to
// paste (a second [hooks.state."…"] table is a duplicate key that breaks config.toml).
const expectReviewFix = (fix: string | undefined) => {
  expect(fix).toContain("run `/hooks`");
  expect(fix).toContain('"Trust all and continue"');
  expect(fix).not.toContain("trusted_hash");
  expect(fix).not.toContain("hooks.state");
  expect(fix).not.toContain("sha256:");
  expect(fix).not.toContain("config.toml");
};

test("Given the Codex plugin hooks untrusted, When doctor runs, Then it names them and points to Codex's /hooks review", () => {
  const { home, cwd } = codexInstall();
  const hooks = check(doctor(home, cwd), "codex_hooks");
  expect(hooks.status).toBe("warn");
  expect(hooks.detail).toContain(
    "6 of 6 hooks untrusted (session_start, user_prompt_submit, pre_tool_use, post_tool_use, subagent_start, subagent_stop)",
  );
  expectReviewFix(hooks.fix);
});

test("Given every Codex plugin hook trusted with Codex's own hash, When doctor runs, Then it passes", () => {
  const { home, cwd } = codexInstall({ trust: OBSERVED });
  const hooks = check(doctor(home, cwd), "codex_hooks");
  expect(hooks.status, hooks.detail).toBe("pass");
  expect(hooks.detail).toContain("6 Workit Codex plugin hooks trusted");
});

test("Given a hook trusted under an older definition or disabled, When doctor runs, Then it warns and names it", () => {
  const changed = codexInstall({
    trust: { ...OBSERVED, pre_tool_use: `sha256:${"0".repeat(64)}` },
  });
  const modified = check(doctor(changed.home, changed.cwd), "codex_hooks");
  expect(modified.status).toBe("warn");
  expect(modified.detail).toContain("1 of 6 hooks changed since trusted (pre_tool_use)");
  expectReviewFix(modified.fix);
  const { session_start: _, ...rest } = OBSERVED;
  const off = codexInstall({ trust: rest, disabled: ["session_start"] });
  const disabled = check(doctor(off.home, off.cwd), "codex_hooks");
  expect(disabled.status).toBe("warn");
  expect(disabled.detail).toContain("hooks disabled (session_start)");
  expect(disabled.fix).toContain("enable and trust");
  expectReviewFix(disabled.fix);
});

test("Given the plugin's agents not yet in the Codex home, When doctor runs, Then it warns with the install command; installed copies pass", () => {
  const { home, cwd, codexHome, root } = codexInstall({ trust: OBSERVED });
  const missing = check(doctor(home, cwd), "codex_agents");
  expect(missing.status).toBe("warn");
  expect(missing.detail).toContain(path.join(codexHome, "agents", "workit-verifier.toml"));
  expect(missing.fix).toBe(
    `node ${JSON.stringify(path.join(root, "dist", "launch-mcp.js"))} --install-agents, then start a new Codex session`,
  );
  // What the MCP launcher writes (version-stamped markers) is what the doctor expects.
  installCodexAgents(root, codexHome);
  const ok = check(doctor(home, cwd), "codex_agents");
  expect(ok.status, ok.detail).toBe("pass");
  expect(ok.detail).toContain("workit-implementer, workit-reviewer, workit-verifier");
  // A copy a newer plugin version wrote is fine; an unversioned old copy is outdated.
  const verifier = path.join(codexHome, "agents", "workit-verifier.toml");
  const stamped = readFileSync(verifier, "utf8");
  writeFileSync(verifier, stamped.replace("Workit 8.5.2 ", "Workit 99.0.0 "));
  expect(check(doctor(home, cwd), "codex_agents").status).toBe("pass");
  writeFileSync(verifier, stamped.replace("Workit 8.5.2 ", "Workit "));
  const outdated = check(doctor(home, cwd), "codex_agents");
  expect(outdated.detail).toContain(`${verifier} outdated`);
  rmSync(verifier);
  symlinkSync(path.join(home, "elsewhere.toml"), verifier);
  const linked = check(doctor(home, cwd), "codex_agents");
  expect(linked.status).toBe("warn");
  expect(linked.detail).toContain(`${verifier} is a symlink`);
  rmSync(verifier);
  installCodexAgents(root, codexHome);
  writeFileSync(
    path.join(codexHome, "agents", "workit-reviewer.toml"),
    'name = "workit-reviewer"\n',
  );
  const shadowed = check(doctor(home, cwd), "codex_agents");
  expect(shadowed.status).toBe("warn");
  expect(shadowed.detail).toContain("is a user agent that shadows");
  expect(shadowed.fix).toContain("rename or remove");
});

test("Given a Codex plugin that predates bundled agents, When doctor runs, Then it warns to reinstall the plugin", () => {
  const { home, cwd } = codexInstall({ agents: false, trust: OBSERVED });
  const agents = check(doctor(home, cwd), "codex_agents");
  expect(agents.status).toBe("warn");
  expect(agents.fix).toBe(`codex plugin remove ${ID} && codex plugin add ${ID}`);
});

// --- Pi ----------------------------------------------------------------------

const PI = "@brainervirus/workit-pi";
const piHome = (
  opts: { entry?: unknown; version?: string; dist?: boolean; project?: boolean } = {},
) => {
  const { home, cwd } = freshHome();
  const agentDir = path.join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsDir = opts.project ? path.join(cwd, ".pi") : agentDir;
  mkdirSync(settingsDir, { recursive: true });
  if (opts.entry !== undefined)
    writeFileSync(
      path.join(settingsDir, "settings.json"),
      JSON.stringify({ packages: [opts.entry] }),
    );
  const root = path.join(settingsDir, "npm", "node_modules", "@brainervirus", "workit-pi");
  if (opts.version) {
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: PI, version: opts.version, pi: { extensions: ["./dist/workit.js"] } }),
    );
    if (opts.dist !== false)
      writeFileSync(path.join(root, "dist", "workit.js"), "export default () => {};\n");
  }
  return { home, cwd, root };
};
const older = (v: string) => {
  const [major, minor] = v.split(".").map(Number);
  return minor > 0 ? `${major}.${minor - 1}.0` : `${major - 1}.0.0`;
};

test("Given no Pi on the machine, When doctor runs, Then the Pi check passes as skipped", () => {
  const { home, cwd } = freshHome();
  expect(check(doctor(home, cwd), "pi_extension")).toMatchObject({
    status: "pass",
    detail: "Pi not installed — skipping",
  });
});

test("Given Pi without the Workit package, When doctor runs, Then it warns missing with pi install", () => {
  const { home, cwd } = piHome();
  const pi = check(doctor(home, cwd), "pi_extension");
  expect(pi.status).toBe("warn");
  expect(pi.detail).toContain("missing");
  expect(pi.fix).toBe(`pi install npm:${PI}`);
  const listed = piHome({ entry: `npm:${PI}` });
  const notInstalled = check(doctor(listed.home, listed.cwd), "pi_extension");
  expect(notInstalled.detail).toContain("listed but not installed");
  expect(notInstalled.fix).toBe(`pi install npm:${PI}`);
});

test("Given the Workit Pi package at the workit version, When doctor runs, Then it passes", () => {
  const { home, cwd } = piHome({ entry: `npm:${PI}`, version: cliPkg.version });
  const pi = check(doctor(home, cwd), "pi_extension");
  expect(pi.status, pi.detail).toBe("pass");
  expect(pi.detail).toContain(`loads dist/workit.js`);
  const project = piHome({ entry: `npm:${PI}`, version: cliPkg.version, project: true });
  expect(check(doctor(project.home, project.cwd), "pi_extension").detail).toContain("(project,");
});

test("Given a Workit Pi package older than workit, When doctor runs, Then it warns stale with the update command unless nothing newer is published", () => {
  const old = older(cliPkg.version);
  const floating = piHome({ entry: `npm:${PI}`, version: old });
  const registry = { WORKIT_DOCTOR_STALE_REGISTRY_VERSION: cliPkg.version };
  const stale = check(doctor(floating.home, floating.cwd, registry), "pi_extension");
  expect(stale.status).toBe("warn");
  expect(stale.detail).toContain(`${PI} ${old}`);
  expect(stale.detail).toContain(`older than workit ${cliPkg.version}`);
  expect(stale.fix).toBe(`pi update npm:${PI}`);
  const pinned = piHome({ entry: `npm:${PI}@${old}`, version: old });
  expect(check(doctor(pinned.home, pinned.cwd, registry), "pi_extension").fix).toBe(
    `pi install npm:${PI}@${cliPkg.version}`,
  );
  const newest = check(
    doctor(floating.home, floating.cwd, { WORKIT_DOCTOR_STALE_REGISTRY_VERSION: old }),
    "pi_extension",
  );
  expect(newest.status, newest.detail).toBe("pass");
});

test("Given an older Workit Pi package and an unreachable registry, When doctor runs, Then it passes and says the registry was unreachable", () => {
  const old = older(cliPkg.version);
  const { home, cwd } = piHome({ entry: `npm:${PI}`, version: old });
  const pi = check(
    doctor(home, cwd, { WORKIT_DOCTOR_STALE_REGISTRY_CMD: "/nonexistent/npm" }),
    "pi_extension",
  );
  expect(pi.status, pi.detail).toBe("pass");
  expect(pi.detail).toContain("registry unreachable");
  expect(pi.detail).not.toContain("stale");
  expect(pi.fix).toBeUndefined();
});

test("Given the Workit Pi extension filtered out or not built, When doctor runs, Then it warns not loading with the fix", () => {
  for (const extensions of [[], ["!dist/*"], ["-dist/workit.js"], ["other.js"]]) {
    const { home, cwd } = piHome({
      entry: { source: `npm:${PI}`, extensions },
      version: cliPkg.version,
    });
    const pi = check(doctor(home, cwd), "pi_extension");
    expect(pi.status, JSON.stringify(extensions)).toBe("warn");
    expect(pi.detail).toContain("not loading");
    expect(pi.fix).toContain('remove the "extensions" filter');
  }
  for (const extensions of [["dist/workit.js"], ["*.js"], ["!other.js"]]) {
    const { home, cwd } = piHome({
      entry: { source: `npm:${PI}`, extensions },
      version: cliPkg.version,
    });
    expect(check(doctor(home, cwd), "pi_extension").status, JSON.stringify(extensions)).toBe(
      "pass",
    );
  }
  const unbuilt = piHome({ entry: `npm:${PI}`, version: cliPkg.version, dist: false });
  const pi = check(doctor(unbuilt.home, unbuilt.cwd), "pi_extension");
  expect(pi.detail).toContain("not loading");
  expect(pi.fix).toBe(`pi remove npm:${PI} && pi install npm:${PI}`);
});

test("Given a local-path Pi install of the checkout, When doctor runs, Then it is identified by package name", () => {
  const { home, cwd } = freshHome();
  const agentDir = path.join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const checkout = path.join(home, "checkout", "workit-pi");
  mkdirSync(path.join(checkout, "dist"), { recursive: true });
  writeFileSync(
    path.join(checkout, "package.json"),
    JSON.stringify({ name: PI, version: cliPkg.version, pi: { extensions: ["./dist/workit.js"] } }),
  );
  writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["../../checkout/workit-pi"] }),
  );
  const unbuilt = check(doctor(home, cwd), "pi_extension");
  expect(unbuilt.status).toBe("warn");
  expect(unbuilt.fix).toBe(`cd ${JSON.stringify(checkout)} && bun run build`);
  writeFileSync(path.join(checkout, "dist", "workit.js"), "export default () => {};\n");
  expect(check(doctor(home, cwd), "pi_extension").status).toBe("pass");
  // A checkout older than workit has no registry evidence of staleness: it passes.
  const old = older(cliPkg.version);
  writeFileSync(
    path.join(checkout, "package.json"),
    JSON.stringify({ name: PI, version: old, pi: { extensions: ["./dist/workit.js"] } }),
  );
  const behind = check(doctor(home, cwd), "pi_extension");
  expect(behind.status, behind.detail).toBe("pass");
  expect(behind.detail).toContain("not compared with the registry");
});
