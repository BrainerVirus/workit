// Ruling hook-reach-2026-11-13: in a checkout with no task store the launchers
// answer a plain write themselves, so their cheap test (hooks/write-reach.ts
// mayReach) must say yes to every write the registry guard denies. The oracle
// is the real gate (write-gate.ts shellGate) over a matrix of roots × writers
// × spellings × working dirs; a sample of its denies also goes through both
// real launcher entries.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { shellGate, writeGate } from "@/packages/workit-core/src/hooks/write-gate";
import { editReaches, mayReach, reachDirs } from "@/packages/workit-core/src/hooks/write-reach";

const ROOT = path.resolve(import.meta.dir, "../../..");
const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-reach-")));
const home = path.join(base, "home");
const config = path.join(home, ".config", "workit");
const state = path.join(home, ".local", "state", "workit");
const repo = path.join(home, "src", "proj", "repo");
const saved = { ...process.env };
const ENV = {
  HOME: home,
  WORKIT_CONFIG_DIR: config,
  WORKIT_STATE_DIR: state,
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  CODEX_HOME: path.join(home, ".codex"),
};

type Root = { name: string; parent: string; leaf: string; file: boolean };
const ROOTS: Root[] = [
  { name: "config dir", parent: path.dirname(config), leaf: "workit", file: false },
  { name: "workspaces.json", parent: config, leaf: "workspaces.json", file: true },
  { name: "issued", parent: path.join(state, "issued"), leaf: "x.json", file: true },
  { name: "approvals", parent: path.join(state, "approvals"), leaf: "y.json", file: true },
];

beforeAll(() => {
  Object.assign(process.env, ENV);
  for (const dir of [config, path.join(state, "issued"), path.join(state, "approvals")])
    mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(config, "workspaces.json"), "{}\n");
  writeFileSync(path.join(state, "issued", "x.json"), "{}\n");
  writeFileSync(path.join(state, "approvals", "y.json"), "{}\n");
  mkdirSync(path.join(repo, "sub"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "feature/x", repo]);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  writeFileSync(path.join(repo, "a.ts"), "a\n");
  ROOTS.forEach((root, index) => {
    const target = path.join(root.parent, root.leaf);
    symlinkSync(root.parent, path.join(repo, `dir${index}`));
    symlinkSync(target, path.join(repo, `file${index}`));
    symlinkSync(root.parent, path.join(repo, "sub", `dir${index}`));
    if (root.file) linkSync(target, path.join(repo, `hard${index}`));
  });
});
afterAll(() => {
  for (const key of Object.keys(ENV)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(base, { recursive: true, force: true });
});

/** Each way of spelling `root`'s target: [label, setup prefix, the target word]. */
const spellings = (root: Root, index: number, cwd: string): [string, string, string][] => {
  const { parent, leaf } = root;
  const full = path.join(parent, leaf);
  const fromHome = path.relative(home, parent);
  const rel = path.relative(cwd, parent) || ".";
  const half = Math.floor(parent.length / 2);
  const out: [string, string, string][] = [
    ["literal", "", full],
    ["tilde", "", `~/${fromHome}/${leaf}`],
    ["$HOME", "", `$HOME/${fromHome}/${leaf}`],
    ["cd parent", `cd ${parent} && `, leaf],
    ["two cd steps", `cd ${path.dirname(rel)} && cd ${path.basename(parent)} && `, leaf],
    ["bare cd", "cd; ", `${fromHome}/${leaf}`],
    ["variable", `d=${parent}; `, `$d/${leaf}`],
    ["split variables", `a=${parent.slice(0, half)}; b=${parent.slice(half)}; `, `$a$b/${leaf}`],
    ["//", "", `${parent}//${leaf}`],
    ["/./", "", `${parent}/./${leaf}`],
    ["x/../", "", `${parent}/nope/../${leaf}`],
    ["glob last", "", `${parent}/${leaf.slice(0, 2)}*`],
    ["glob parent", "", `${path.dirname(parent)}/${path.basename(parent).slice(0, 2)}*/${leaf}`],
    ["brace", "", `${parent}/{${leaf},zz}`],
    ["quotes", "", `${parent}/"${leaf[0]}"\\${leaf.slice(1)}`],
    ["backslash-newline", "", `${parent}/${leaf.slice(0, 2)}\\\n${leaf.slice(2)}`],
    ["symlinked dir", "", path.join(repo, `dir${index}`, leaf)],
    ["symlinked file", "", path.join(repo, `file${index}`)],
    ["symlink, two missing levels", "", path.join(repo, `dir${index}`, leaf, "m1", "m2.json")],
    ["cd into a dir with a symlink", `cd ${path.join(repo, "sub")} && `, `dir${index}/${leaf}`],
  ];
  if (root.file) out.push(["hard link", "", path.join(repo, `hard${index}`)]);
  return out;
};

/** Each writer, as a command around the target `t`. */
const WRITERS: [string, (t: string) => string][] = [
  ["rm -rf", (t) => `rm -rf ${t}`],
  ["cp", (t) => `cp ${repo}/a.txt ${t}`],
  ["mv", (t) => `mv ${repo}/a.txt ${t}`],
  ["tee", (t) => `echo x | tee ${t}`],
  [">", (t) => `echo x > ${t}`],
  ["sed -i", (t) => `sed -i s/a/b/ ${t}`],
  ["rsync", (t) => `rsync -a ${repo}/src/ ${t}`],
  ["unlink", (t) => `unlink ${t}`],
  ["tar -x -C", (t) => `tar -xf ${repo}/e.tar -C ${t}`],
  ["curl -o", (t) => `curl -so ${t} http://127.0.0.1:9/x`],
  ["find -delete", (t) => `find ${t} -delete`],
  ["chmod", (t) => `chmod 600 ${t}`],
  ["vim -es", (t) => `vim -es -c w ${t}`],
  ["ln", (t) => `ln -sf ${repo}/a.txt ${t}`],
  ["-C<dir>", (t) => `tar -xf ${repo}/e.tar -C${t}`],
  ["--target-directory=", (t) => `cp ${repo}/a.txt --target-directory=${t}`],
  ["of=", (t) => `dd if=${repo}/a.txt of=${t}`],
];

// On Windows the launchers send every write (and every edit) to the runtime
// (ruling hook-reach-2026-11-13 item 4; ruling mweicn74), so mayReach's
// precision protects only POSIX: the differential tests run there, and the
// Windows rule has its own test below.
const ON_WINDOWS = process.platform === "win32";

const GUARD = /^workit (?:issued-registry|approvals|config|registry) guard/;
const denied: { cwd: string; command: string }[] = [];

test.skipIf(ON_WINDOWS)(
  "G every root × writer × spelling × working dir, W the registry guard denies one, T mayReach says yes; the guard denies at least the floor",
  () => {
    const cwds = [repo, home, path.dirname(config), config];
    const misses: string[] = [];
    let total = 0;
    for (const cwd of cwds)
      ROOTS.forEach((root, index) => {
        for (const [label, prefix, target] of spellings(root, index, cwd))
          for (const [writer, make] of WRITERS) {
            const command = prefix + make(target);
            total += 1;
            const oracle = shellGate(cwd, command, null);
            if (oracle.kind !== "deny" || !GUARD.test(oracle.reason)) continue;
            denied.push({ cwd, command });
            if (!mayReach(command, cwd))
              misses.push(`${root.name} / ${writer} / ${label} in ${cwd}: ${command}`);
          }
      });
    expect(misses).toEqual([]);
    // Not vacuous: most of the matrix is a write the guard denies, also from the
    // repo, where only the word test (not the working dir) can say yes.
    expect(total).toBeGreaterThan(5000);
    expect(denied.length).toBeGreaterThan(5000);
    expect(denied.filter((item) => item.cwd === repo).length).toBeGreaterThan(1200);
  },
  600_000,
);

test("G an edit whose file reaches a guarded path, W the gate denies it, T editReaches or mayReach says yes", () => {
  let count = 0;
  ROOTS.forEach((root, index) => {
    for (const file of [
      path.join(root.parent, root.leaf),
      path.join(repo, `dir${index}`, root.leaf),
      path.join(repo, `file${index}`),
      path.join(repo, `dir${index}`, root.leaf, "m1", "m2.json"),
      ...(root.file ? [path.join(repo, `hard${index}`)] : []),
    ]) {
      const oracle = writeGate(repo, [file], null);
      if (oracle.kind !== "deny" || !GUARD.test(oracle.reason)) continue;
      count += 1;
      expect(editReaches(file, repo) || mayReach(file, repo), file).toBe(true);
    }
  });
  expect(count).toBeGreaterThan(10);
});

test("G a dangling symlink in the repo to a guarded file not made yet, W a shell write or an edit names it, T the gate denies and mayReach and editReaches say yes (#837)", () => {
  const seal = path.join(config, "workspaces.json.seal");
  const grant = path.join(state, "approvals", "not-yet.json");
  for (const [name, target] of [
    ["dangling-seal", seal],
    ["dangling-grant", grant],
  ]) {
    rmSync(target, { force: true });
    symlinkSync(target, path.join(repo, name));
    expect(shellGate(repo, `echo x > ${name}`, null).kind, name).toBe("deny");
    expect(writeGate(repo, [path.join(repo, name)], null).kind, name).toBe("deny");
    expect(mayReach(`echo x > ${name}`, repo), name).toBe(true);
    expect(editReaches(name, repo), name).toBe(true);
    rmSync(path.join(repo, name));
  }
  // A relative dangling link inside a dir reached through a link at another depth (#855).
  const deep = path.join(base, "deep", "x", "y", "z");
  mkdirSync(deep, { recursive: true });
  symlinkSync(deep, path.join(repo, "ld"));
  symlinkSync(path.relative(deep, grant), path.join(deep, "rl"));
  expect(shellGate(repo, "echo x > ld/rl", null).kind).toBe("deny");
  expect(mayReach("echo x > ld/rl", repo)).toBe(true);
  expect(editReaches("ld/rl", repo)).toBe(true);
  rmSync(path.join(repo, "ld"));
  // A chain past 40 links: it may reach anything.
  let previous = path.join(base, "chain-end.txt");
  for (let index = 1; index <= 41; index++) {
    symlinkSync(previous, path.join(base, `c${index}`));
    previous = path.join(base, `c${index}`);
  }
  // Spelled relative with `/`: an absolute Windows temp path holds an 8.3 short name
  // (`RUNNER~1`) that mayReach reads as `~user` and answers yes for any file.
  const chained = (index: number) =>
    path.relative(repo, path.join(base, `c${index}`)).replaceAll("\\", "/");
  expect(mayReach(`echo x > ${chained(41)}`, repo)).toBe(true);
  expect(editReaches(chained(41), repo)).toBe(true);
  expect(mayReach(`echo x > ${chained(40)}`, repo)).toBe(false);
  symlinkSync(path.join(repo, "not-yet.txt"), path.join(repo, "dangling-plain"));
  expect(mayReach("echo x > dangling-plain", repo)).toBe(false);
  expect(editReaches("dangling-plain", repo)).toBe(false);
  rmSync(path.join(repo, "dangling-plain"));
});

test.skipIf(ON_WINDOWS)(
  "G plain writes and reads inside the repo, W mayReach reads them, T none reaches a guarded path",
  () => {
    for (const command of [
      "mkdir out",
      `mkdir -p ${repo}/out`,
      "rm -f a.txt",
      "cp a.txt b.txt",
      "echo x > a.txt",
      `echo x > ${path.join(base, "elsewhere.txt")}`,
      "sed -i s/a/b/ a.txt",
      "sed -n 1,5p a.ts",
      "find . -name '*.ts'",
      "awk '{print $1}' a.ts",
      "rg '=>' .",
      "ls 2>&1 | tail",
      "ls >/dev/null",
    ]) {
      expect(mayReach(command, repo), command).toBe(false);
      expect(shellGate(repo, command, null).kind, command).not.toBe("deny");
    }
    expect(editReaches(path.join(repo, "a.ts"), repo)).toBe(false);
  },
);

const launch = (entry: string[], payload: Record<string, unknown>) => {
  const child = spawnSync(entry[0] ?? "node", entry.slice(1), {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...saved, ...ENV, WORKIT_SESSION_ID: "" },
    timeout: 60_000,
  });
  expect(child.status, child.stderr).toBe(0);
  return (JSON.parse(child.stdout) as { hookSpecificOutput?: { permissionDecision?: string } })
    .hookSpecificOutput?.permissionDecision;
};

test.skipIf(ON_WINDOWS)(
  "G a sample of the guard's denies, W each goes through Claude Code's and Codex's real launcher, T both deny",
  () => {
    expect(denied.length).toBeGreaterThan(5000);
    const fromRepo = denied.filter((item) => item.cwd === repo);
    const step = Math.max(1, Math.floor(fromRepo.length / 32));
    const sample = fromRepo.filter((_, index) => index % step === 0).slice(0, 32);
    expect(sample.length).toBeGreaterThanOrEqual(30);
    for (const { cwd, command } of sample) {
      const claude = launch(
        ["node", path.join(ROOT, "packages/workit-claude-code/bin/workit-hook.mjs")],
        {
          hook_event_name: "PreToolUse",
          session_id: "11111111-2222-3333-4444-555555555555",
          transcript_path: "/tmp/x.jsonl",
          cwd,
          permission_mode: "default",
          tool_name: "Bash",
          tool_input: { command, description: "d" },
          tool_use_id: "toolu_reach",
        },
      );
      expect(claude, `claude: ${command}`).toBe("deny");
      const codex = launch(
        [process.execPath, path.join(ROOT, "packages/workit-codex/hooks/launcher.ts")],
        {
          session_id: "session-1",
          cwd,
          model: "gpt-5",
          permission_mode: "default",
          transcript_path: null,
          hook_event_name: "PreToolUse",
          turn_id: "turn-1",
          tool_use_id: "tool-1",
          tool_name: "bash",
          tool_input: { command },
        },
      );
      expect(codex, `codex: ${command}`).toBe("deny");
    }
  },
  600_000,
);

test("G the Claude Code launcher, W its source is read, T it holds write-reach.ts's region equal after type erasure", () => {
  const region = (file: string) => {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    const begin = text.indexOf("// write-reach:begin");
    const end = text.indexOf("// write-reach:end");
    expect(begin, file).toBeGreaterThan(0);
    expect(end, file).toBeGreaterThan(begin);
    return text.slice(begin, end);
  };
  const erase = (code: string, loader: "ts" | "js") =>
    new Bun.Transpiler({ loader, deadCodeElimination: false }).transformSync(
      `${code}\nexport { hasTaskStore, fileReaches, mayReachWith, guardedDirs };`,
    );
  expect(erase(region("packages/workit-claude-code/bin/workit-hook.mjs"), "js")).toBe(
    erase(region("packages/workit-core/src/hooks/write-reach.ts"), "ts"),
  );
});

test("G the guarded dirs, W the launcher and core build them for one fixture env, T both feed the shared region the same workit-paths builders", () => {
  // The launcher's workit-paths.mjs is core's, byte for byte.
  expect(
    readFileSync(path.join(ROOT, "packages/workit-claude-code/bin/workit-paths.mjs"), "utf8"),
  ).toBe(readFileSync(path.join(ROOT, "packages/workit-core/src/core/workit-paths.mjs"), "utf8"));
  const flat = (file: string) => readFileSync(path.join(ROOT, file), "utf8").replace(/\s+/g, " ");
  expect(flat("packages/workit-claude-code/bin/workit-hook.mjs")).toContain(
    "guardedDirs(process.env, { configDir: workitConfigDir, stateDir: workitStateDir, userHome })",
  );
  expect(flat("packages/workit-claude-code/bin/workit-hook.mjs")).toMatch(
    /configDir as workitConfigDir, migrateLegacyDirs, stateDir as workitStateDir, userHome, \} from "\.\/workit-paths\.mjs"/,
  );
  expect(flat("packages/workit-core/src/hooks/write-reach.ts")).toContain(
    "guardedDirs(env, { configDir, stateDir, userHome })",
  );
  const env = {
    HOME: path.join(base, "fixture-home"),
    WORKIT_STATE_DIR: path.join(base, "fixture-state"),
    WORKIT_CONFIG_DIR: path.join(base, "fixture-config"),
  };
  const dirs = reachDirs(env);
  expect(dirs.state).toBe(env.WORKIT_STATE_DIR);
  expect(dirs.configs[0]).toBe(env.WORKIT_CONFIG_DIR);
  expect(dirs.home).toBe(env.HOME);
});

test("G any text or file, Windows-shaped included, W mayReach and editReaches read it on this platform, T each answers a boolean and never throws", () => {
  const short = path.join(base, "RUNNER~1", "AppData", "Local", "Temp");
  for (const text of [
    "ls",
    "mkdir out",
    `mkdir -p ${repo}/out`,
    `mkdir -p ${short}\\wk\\repo/out`,
    "echo x > C:\\Users\\RUNNER~1\\AppData\\Roaming\\workit\\workspaces.json",
    "Set-Content -Path $env:APPDATA\\workit\\x -Value 1",
    "cd /d C:\\x && del y",
    "rm -rf ~/x/*",
    "",
  ]) {
    expect(typeof mayReach(text, repo), text).toBe("boolean");
    expect(typeof mayReach(text, short), text).toBe("boolean");
    expect(typeof editReaches(text || "a.ts", repo), text).toBe("boolean");
  }
});

/** Did a launcher answer on its own, without the runtime? */
const answeredAlone = {
  claude: (payload: Record<string, unknown>) => {
    const child = spawnSync(
      "node",
      [path.join(ROOT, "packages/workit-claude-code/bin/workit-hook.mjs")],
      {
        input: JSON.stringify(payload),
        encoding: "utf8",
        // A runtime that cannot start says so on stderr; the fast path never starts it.
        env: {
          ...saved,
          ...ENV,
          WORKIT_SESSION_ID: "",
          WORKIT_CLAUDE_RUNTIME: "source",
          WORKIT_BUN: path.join(base, "no-bun"),
        },
        timeout: 60_000,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    return !child.stderr.includes("hook unavailable");
  },
  codex: (entry: string, payload: Record<string, unknown>) => {
    const child = spawnSync("node", [entry], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...saved, ...ENV, WORKIT_SESSION_ID: "" },
      timeout: 60_000,
    });
    return (
      child.status === 0 &&
      child.stdout.trim() === '{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}'
    );
  },
};

test.if(ON_WINDOWS)(
  "G Windows and a repo with no task store, W an agent writes from the shell or edits, T both launchers' real entries send every write and edit to the runtime",
  () => {
    // The Codex entry as built, its runtime and failure chunks removed: only the quiet path answers.
    const out = path.join(base, "codex-build");
    const built = spawnSync(
      process.execPath,
      [path.join(ROOT, "packages/workit-codex/scripts/build.ts"), out],
      { encoding: "utf8", timeout: 300_000 },
    );
    expect(built.status, built.stderr).toBe(0);
    const dist = path.join(out, "dist");
    for (const file of readdirSync(dist))
      if (
        file !== "workit-hook.js" &&
        /runCodexHook|answerRuntimeFailure/.test(readFileSync(path.join(dist, file), "utf8"))
      )
        rmSync(path.join(dist, file));
    const codex = path.join(dist, "workit-hook.js");
    const pre = (tool_name: string, tool_input: Record<string, unknown>) => ({
      hook_event_name: "PreToolUse",
      session_id: "11111111-2222-3333-4444-555555555555",
      transcript_path: "x.jsonl",
      cwd: repo,
      permission_mode: "default",
      tool_name,
      tool_input,
      tool_use_id: "toolu_win",
    });
    for (const command of [
      "mkdir out",
      "rm -f a.txt",
      "cp a.txt b.txt",
      "echo x | tee a.txt",
      "echo x > a.txt",
      "sed -i s/a/b/ a.txt",
    ]) {
      expect(answeredAlone.claude(pre("Bash", { command })), `claude: ${command}`).toBe(false);
      expect(answeredAlone.claude(pre("PowerShell", { command })), `pwsh: ${command}`).toBe(false);
      expect(answeredAlone.codex(codex, pre("bash", { command })), `codex: ${command}`).toBe(false);
    }
    const file = path.join(repo, "a.ts");
    for (const [tool, input] of [
      ["Edit", { file_path: file, old_string: "a", new_string: "b" }],
      ["Write", { file_path: file, content: "x" }],
      ["MultiEdit", { file_path: file, edits: [] }],
      ["NotebookEdit", { notebook_path: path.join(repo, "a.ipynb"), new_source: "x" }],
    ] as const)
      expect(answeredAlone.claude(pre(tool, input)), tool).toBe(false);
    expect(answeredAlone.codex(codex, pre("apply_patch", { command: "*** Begin Patch" }))).toBe(
      false,
    );
    // A read stays with the launcher, so the probe can tell the two apart.
    expect(answeredAlone.claude(pre("Read", { file_path: file }))).toBe(true);
  },
  600_000,
);
