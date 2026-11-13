// Write-gate gaps (#843, #837): `>& file` and `>&file` write the file; a
// symlink to a guarded file that does not exist yet (a dangling link) is
// written through; `sponge` writes its operand; an inline interpreter fed on
// stdin (`python3 - "$F" <<EOF`) runs the heredoc, not "$F"; and a write
// target an interpreter builds from a guarded dir is reported as unresolved,
// not as the dir itself. Every host's entry agrees.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grantsHome } from "@/packages/workit-core/src/autonomy";
import { configDir } from "@/packages/workit-core/src/core/workit-paths.mjs";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { codexAdapter } from "@/packages/workit-core/src/hooks/hosts/codex";
import { cursorAdapter } from "@/packages/workit-core/src/hooks/hosts/cursor";
import { shellGate, shellWrites, writeGate } from "@/packages/workit-core/src/hooks/write-gate";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { fixture } from "./hook-fixtures";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-guard-gaps-")));
const home = path.join(base, "home");
const state = path.join(base, "state");
const root = path.join(base, "repo");
const KEYS = [
  "HOME",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "WORKIT_CONFIG",
  "WORKIT_CONFIG_DIR",
  "WORKIT_STATE_DIR",
];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const savedResolve = grantsHome.resolve;
beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.WORKIT_STATE_DIR = state;
  grantsHome.resolve = () => path.join(base, "account");
});
afterEach(() => {
  grantsHome.resolve = savedResolve;
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A path as a POSIX shell on Windows (Git Bash) is given it: forward slashes. */
const sh = (file: string) => file.replaceAll("\\", "/");
const CONFIG = configDir({ HOME: home });
const ACCOUNT = configDir({ HOME: path.join(base, "account") });

/** Each guarded file: the config files (this env's and the account's) and a registry file. */
const GUARDED: Array<{ name: string; file: string }> = [
  { name: "config", file: path.join(CONFIG, "workspaces.json") },
  { name: "seal", file: path.join(CONFIG, "workspaces.json.seal") },
  { name: "account config", file: path.join(ACCOUNT, "workspaces.json") },
  { name: "issued", file: path.join(state, "issued", "s1.json") },
  { name: "approvals", file: path.join(state, "approvals", "grants", "a.json") },
];
for (const { file } of GUARDED) mkdirSync(path.dirname(file), { recursive: true });
mkdirSync(root, { recursive: true });

type Verdict = { deny: boolean; reason: string };
const claudeOut = (toolName: string, toolInput: Record<string, unknown>): Verdict => {
  const out = (
    dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "pre-tool-use-write", root, {
        tool_name: toolName,
        tool_input: toolInput,
      }),
    ).json as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
  return {
    deny: out?.permissionDecision === "deny",
    reason: out?.permissionDecisionReason ?? "",
  };
};
const codexOut = (name: string, toolInput: Record<string, unknown>): Verdict => {
  const out = (
    dispatchHook(codexAdapter, fixture("codex", name, root, { tool_input: toolInput })).json as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
  return {
    deny: out?.permissionDecision === "deny",
    reason: out?.permissionDecisionReason ?? "",
  };
};
const cursorOut = (name: string, overrides: Record<string, unknown>): Verdict => {
  const out = dispatchHook(cursorAdapter, fixture("cursor", name, root, overrides)).json as {
    permission?: string;
    agent_message?: string;
  };
  return { deny: out.permission === "deny", reason: out.agent_message ?? "" };
};
const openCodeOut = (action: string, resource: string): Verdict => {
  const event = {
    action,
    resources: [resource],
    effect: "allow",
    message: undefined as string | undefined,
  };
  evaluateShellPermission(root, event);
  return { deny: event.effect === "deny", reason: event.message ?? "" };
};
const piOut = (toolName: string, input: Record<string, unknown>): Verdict => {
  const ctx = { cwd: root, isProjectTrusted: () => true } as never;
  const out = enforceToolPolicy({ toolName, input } as never, ctx) as
    | { block?: boolean; reason?: string }
    | undefined;
  return { deny: Boolean(out?.block), reason: out?.reason ?? "" };
};

/** Each host's entry for a shell command. */
const SHELLS: Record<string, (command: string) => Verdict> = {
  "Claude Code": (command) => claudeOut("Bash", { command }),
  Codex: (command) => codexOut("pre-tool-use-bash", { command }),
  Cursor: (command) => cursorOut("before-shell-execution", { command }),
  OpenCode: (command) => openCodeOut("shell", command),
  Pi: (command) => piOut("bash", { command }),
};
/** Each host's entry for a file edit. */
const EDITS: Record<string, (file: string) => Verdict> = {
  "Claude Code Edit": (file) => claudeOut("Edit", { file_path: file }),
  "Claude Code Write": (file) => claudeOut("Write", { file_path: file, content: "{}" }),
  "Codex apply_patch": (file) =>
    codexOut("pre-tool-use-apply-patch", {
      command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-{}\n+{"x":1}\n*** End Patch\n`,
    }),
  "Cursor Write": (file) => cursorOut("pre-tool-use", { tool_input: { file_path: file } }),
  "OpenCode edit": (file) => openCodeOut("edit", file),
  "Pi write": (file) => piOut("write", { path: file }),
};

const everyShell = (command: string, deny: boolean) => {
  for (const [host, run] of Object.entries(SHELLS))
    expect(run(command).deny, `${host}: ${command}`).toBe(deny);
};

test("G a guarded file, W a shell writes it with `>& file` or `>&file`, T every host denies; `2>&1`, `>&2` and `>&-` stay allowed", () => {
  for (const { name, file } of GUARDED) {
    writeFileSync(file, "{}");
    for (const command of [
      `echo x >& ${sh(file)}`,
      `echo x >&${sh(file)}`,
      `echo x 1>& ${sh(file)}`,
      `echo x >&2x; echo y >& ${sh(file)}`,
    ])
      everyShell(command, true);
    expect(shellGate(root, `echo x >& ${sh(file)}`, null).kind, name).toBe("deny");
  }
  for (const command of [
    "echo x 2>&1",
    "echo x >&2",
    "echo x >&-",
    "echo x 1>&2 2>&-",
    "exec 3>&1 4>&3-",
  ])
    everyShell(command, false);
});

test("G `>& word`, W the gate reads the command, T a word that is not an fd number or `-` is a written file", () => {
  expect(shellWrites("echo x >& out.txt")).toEqual({ writes: true, targets: ["out.txt"] });
  expect(shellWrites("echo x >&out.txt")).toEqual({ writes: true, targets: ["out.txt"] });
  expect(shellWrites("echo x >&2x")).toEqual({ writes: true, targets: ["2x"] });
  for (const command of ["echo x >&2", "echo x 2>&1", "echo x >&-", "echo x >& 2", "exec 4>&3-"])
    expect(shellWrites(command).writes, command).toBe(false);
});

test("G a guarded file, W `cmd | sponge <file>` writes it, T every host denies; sponge elsewhere is a plain write", () => {
  for (const { file } of GUARDED) {
    writeFileSync(file, "{}");
    for (const command of [`echo x | sponge ${sh(file)}`, `jq . x.json | sponge -a ${sh(file)}`])
      everyShell(command, true);
  }
  expect(shellWrites("jq . a.json | sponge a.json")).toEqual({
    writes: true,
    targets: ["a.json"],
  });
  everyShell("jq . a.json | sponge a.json", false);
});

test("G a symlink in the repo to a guarded file, live or not yet made, W a shell write, sponge, Edit or Write targets the link, T every host denies", () => {
  const links = path.join(root, "links");
  mkdirSync(links, { recursive: true });
  for (const [index, { name, file }] of GUARDED.entries()) {
    const link = path.join(links, `l${index}`);
    symlinkSync(file, link);
    for (const exists of [false, true]) {
      rmSync(file, { force: true });
      if (exists) writeFileSync(file, "{}");
      const label = `${name} (${exists ? "live" : "dangling"})`;
      for (const command of [`echo x > links/l${index}`, `echo x | sponge links/l${index}`])
        for (const [host, run] of Object.entries(SHELLS))
          expect(run(command).deny, `${label} ${host}: ${command}`).toBe(true);
      for (const [host, run] of Object.entries(EDITS))
        expect(run(link).deny, `${label} ${host}`).toBe(true);
      expect(writeGate(root, [link]).kind, label).toBe("deny");
    }
  }
  // A dangling link that points elsewhere, and one chained through another link.
  symlinkSync(path.join(root, "not-yet.json"), path.join(links, "elsewhere"));
  everyShell("echo x > links/elsewhere", false);
  expect(writeGate(root, [path.join(links, "elsewhere")]).kind).toBe("none");
  symlinkSync(path.join(links, "l0"), path.join(links, "chain"));
  rmSync(GUARDED[0].file, { force: true });
  everyShell("echo x > links/chain", true);
  expect(writeGate(root, [path.join(links, "chain")]).kind).toBe("deny");
  // A dangling relative link into the config dir, and a dangling link to the dir's parent.
  symlinkSync(
    path.relative(links, path.join(CONFIG, "workspaces.json.seal")),
    path.join(links, "rel"),
  );
  rmSync(GUARDED[1].file, { force: true });
  everyShell("echo x > links/rel", true);
  rmSync(links, { recursive: true, force: true });
});

test("G an inline interpreter fed its script on stdin with `-`, W a shell-variable argument names a file, T the heredoc is judged as the script, never the argument (#837)", () => {
  const config = sh(path.join(CONFIG, "workspaces.json"));
  const data = path.join(base, "data.txt");
  // Data that reads like a guarded write: it is an argument, not the script.
  writeFileSync(data, `open('${config}','w').write('{}')\n`);
  writeFileSync(path.join(base, "plain.txt"), "notes\n");
  const relative = `open('.git/workit/plans/probe.json','w').write('{}')`;
  for (const [runner, flag] of [
    ["python3", "-"],
    ["node", "-"],
    ["bash", "-s"],
    ["sh", "-s"],
  ]) {
    const body = runner === "node" ? "require('fs').writeFileSync('out.json','{}')" : relative;
    const script = runner.endsWith("sh") ? "echo '{}' > out.json" : body;
    everyShell(`F=${sh(data)}; ${runner} ${flag} "$F" <<'EOF2'\n${script}\nEOF2`, false);
    const evil =
      runner === "node"
        ? `require('fs').writeFileSync('${config}','{}')`
        : runner.endsWith("sh")
          ? `echo '{}' > ${config}`
          : `open('${config}','w').write('{}')`;
    everyShell(
      `F=${sh(path.join(base, "plain.txt"))}; ${runner} ${flag} "$F" <<'EOF2'\n${evil}\nEOF2`,
      true,
    );
  }
  // The issue's repro, as written.
  everyShell(
    `F=/tmp/some/file.txt; python3 - "$F" <<'EOF2'\nimport sys\nt=open(sys.argv[1]).read()\n${relative}\nEOF2`,
    false,
  );
});

test("G interpreter code that builds a write target from a guarded dir and a value Workit cannot resolve, W it runs, T denied saying the target is unresolved, never naming the dir", () => {
  const fromHome = sh(path.relative(home, CONFIG)).split("/");
  const joined = fromHome.map((part) => `'${part}'`).join(", ");
  const roots = [
    { dir: sh(CONFIG), label: "config guard" },
    { dir: sh(path.join(state, "approvals")), label: "approvals guard" },
    { dir: sh(path.join(state, "issued")), label: "issued-registry guard" },
  ];
  const commands = (dir: string) => [
    `python3 - "$F" <<'EOF'\nimport os, sys\np = os.path.join('${dir}', sys.argv[1])\nopen(p, 'w').write('{}')\nEOF`,
    `python3 -c "import os, sys; open(os.path.join('${dir}', sys.argv[1]), 'w')" "$F"`,
    `node -e "require('fs').writeFileSync(require('path').join('${dir}', process.argv[1]), '{}')" x`,
  ];
  for (const { dir, label } of roots)
    for (const command of commands(dir))
      for (const [host, run] of Object.entries(SHELLS)) {
        const out = run(command);
        expect(out.deny, `${host}: ${command}`).toBe(true);
        expect(out.reason, `${host}: ${command}`).toContain(`workit ${label}: `);
        expect(out.reason, `${host}: ${command}`).toContain("could not resolve");
        expect(out.reason, `${host}: ${command}`).not.toContain(dir);
        expect(out.reason, `${host}: ${command}`).not.toContain(path.normalize(dir));
      }
  const fromHomeScript = `python3 - <<'EOF'\nimport os, sys\np = os.path.join(os.path.expanduser('~'), ${joined}, sys.argv[1])\nopen(p, 'w').write('{}')\nEOF`;
  const out = SHELLS["Claude Code"](fromHomeScript);
  expect(out.deny).toBe(true);
  expect(out.reason).toContain("could not resolve");
  expect(out.reason).not.toContain(CONFIG);
  // Code that takes the dir itself still names it.
  const taken = shellGate(root, `python3 -c "import shutil; shutil.rmtree('${sh(CONFIG)}')"`, null);
  expect(taken.kind === "deny" ? taken.reason : "").toContain(CONFIG);
});

test("G a dir link in the repo to a dir at another depth, holding a relative dangling link to a guarded file, W a write, sponge, tee or edit names it through the dir link, T every host denies (#855)", () => {
  // repo/ld -> <base>/deep/x/y/z; z/rl -> ../../../../state/approvals/grants/new.json: the
  // relative target climbs from z's real path, not from repo/ld.
  const deep = path.join(base, "deep", "x", "y", "z");
  mkdirSync(deep, { recursive: true });
  const ld = path.join(root, "ld");
  symlinkSync(deep, ld, "junction");
  for (const [index, { name, file }] of GUARDED.entries()) {
    rmSync(file, { force: true });
    symlinkSync(path.relative(deep, file), path.join(deep, `rl${index}`));
    const link = `ld/rl${index}`;
    for (const command of [
      `echo x > ${link}`,
      `echo x >& ${link}`,
      `echo x | sponge ${link}`,
      `echo x | tee ${link}`,
    ])
      for (const [host, run] of Object.entries(SHELLS))
        expect(run(command).deny, `${name} ${host}: ${command}`).toBe(true);
    for (const [host, run] of Object.entries(EDITS))
      expect(run(path.join(root, link)).deny, `${name} ${host}`).toBe(true);
  }
  // The same depth trick to a plain file stays allowed.
  symlinkSync(path.relative(deep, path.join(base, "plain-new.txt")), path.join(deep, "plain"));
  everyShell("echo x > ld/plain", false);
  rmSync(ld);
  rmSync(path.join(base, "deep"), { recursive: true, force: true });
});

test("G a chain of more than 40 symlinks, W a write or an edit names its head, T every host denies it as a link Workit could not resolve; a chain of 40 is followed", () => {
  const chain = path.join(root, "chain");
  mkdirSync(chain, { recursive: true });
  let previous = path.join(base, "chain-end.txt");
  for (let index = 1; index <= 41; index++) {
    symlinkSync(previous, path.join(chain, `c${index}`));
    previous = path.join(chain, `c${index}`);
  }
  for (const [host, run] of Object.entries(SHELLS)) {
    const out = run("echo x > chain/c41");
    expect(out.deny, host).toBe(true);
    expect(out.reason, host).toContain("could not resolve");
  }
  for (const [host, run] of Object.entries(EDITS))
    expect(run(path.join(chain, "c41")).deny, host).toBe(true);
  // 40 links to a plain file: followed to the end, allowed.
  everyShell("echo x > chain/c40", false);
  rmSync(chain, { recursive: true, force: true });
});
