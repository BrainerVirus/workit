// #891 review: the set-verdict store (<state>/verdicts/) and every repository
// ledger (<git common dir>/workit/ledger/) are written only by the workit CLI.
// An agent's Edit/Write or shell write to either is denied.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import {
  inRepoLedger,
  shellGate,
  unquotedWindowsRegistry,
  windowsSlashed,
} from "@/packages/workit-core/src/hooks/write-gate";
import { editReaches, mayReach } from "@/packages/workit-core/src/hooks/write-reach";
import { useConfigHome, type ConfigHome } from "@/test/shared/grant-home";
import { fixture, tempRoot } from "./hook-fixtures";

const base = mkdtempSync(path.join(tmpdir(), "workit-verdict-guard-"));
const state = path.join(base, "state");
const root = tempRoot("workit-verdict-guard-root-");
const ledger = path.join(root, ".git", "workit", "ledger");
// A bare repository's (or a `--separate-git-dir`'s) common dir: HEAD and objects, no `.git` name.
const bare = path.join(base, "app.git");
const bareLedger = path.join(bare, "workit", "ledger");
const saved = process.env.WORKIT_STATE_DIR;
let home: ConfigHome;
beforeAll(() => {
  process.env.WORKIT_STATE_DIR = state;
  home = useConfigHome("workit-verdict-guard-home-");
  mkdirSync(path.join(state, "verdicts", "sets"), { recursive: true });
  mkdirSync(ledger, { recursive: true });
  mkdirSync(path.join(state, "folders", "app-1a2b", "ledger"), { recursive: true });
  mkdirSync(path.join(state, "issued"), { recursive: true });
  mkdirSync(path.join(state, "approvals"), { recursive: true });
  mkdirSync(path.join(bare, "objects"), { recursive: true });
  writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(bareLedger, { recursive: true });
  // A `workit/ledger` dir in a plain folder is no repository ledger.
  mkdirSync(path.join(base, "notes", "workit", "ledger"), { recursive: true });
});
afterAll(() => {
  home.restore();
  if (saved === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = saved;
  rmSync(base, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const claude = (toolName: string, toolInput: Record<string, unknown>) =>
  (
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

const TARGETS = [
  path.join(state, "folders", "app-1a2b", "ledger", "ledger.jsonl"),
  path.join(state, "verdicts", "sets", "ledger.jsonl"),
  path.join(state, "verdicts", "0123abcd", "ledger.jsonl"),
  path.join(ledger, "ledger.jsonl"),
  path.join(bareLedger, "ledger.jsonl"),
];

test("G the verdict store and a repository ledger, W Claude Code Edit/Write targets them, T denied by the ledger guard", () => {
  for (const file of TARGETS)
    for (const tool of ["Edit", "Write", "MultiEdit"]) {
      const out = claude(tool, { file_path: file });
      expect([file, tool, out?.permissionDecision]).toEqual([file, tool, "deny"]);
      expect(out?.permissionDecisionReason).toContain("ledger guard");
    }
  expect(claude("Write", { file_path: path.join(state, "logs", "x.log") })).toBeUndefined();
});

test("G shell writes into the verdict store or a ledger, W Claude Code runs them, T denied; reads pass", () => {
  for (const file of TARGETS)
    for (const command of [
      `echo '{"type":"verdict.set"}' >> ${file}`,
      `printf x | tee -a ${file}`,
      `cp /tmp/x ${file}`,
      `sed -i s/a/b/ ${file}`,
      `rm -rf ${path.dirname(file)}`,
    ])
      expect(claude("Bash", { command })?.permissionDecision, command).toBe("deny");
  expect(claude("Bash", { command: `cat ${TARGETS[0]}` })).toBeUndefined();
  expect(claude("Bash", { command: `wc -l ${TARGETS[2]}` })).toBeUndefined();
});

test("G Windows paths with unquoted backslashes into the verdict store or a ledger, W written, T denied; read, T allowed", () => {
  const prior = process.env.WORKIT_STATE_DIR;
  process.env.WORKIT_STATE_DIR = "C:\\st";
  try {
    const cases: Array<[string, string | null]> = [
      ["echo x >> C:\\st\\verdicts\\sets\\ledger.jsonl", "ledger"],
      ["cp x.jsonl C:\\st\\folders\\app-1a2b\\ledger\\ledger.jsonl", "ledger"],
      ["echo x >> C:\\repo\\.git\\workit\\ledger\\ledger.jsonl", "ledger"],
      ["type C:\\st\\verdicts\\sets\\ledger.jsonl > copy.txt", null],
      ["echo x > C:\\st\\folders\\app-1a2b\\tasks\\note.txt", null],
    ];
    for (const [command, want] of cases)
      expect(unquotedWindowsRegistry(command, "win32"), command).toBe(want as never);
  } finally {
    process.env.WORKIT_STATE_DIR = prior;
  }
});

test("G a ledger under a git common dir not named .git (bare, --separate-git-dir), W written, T denied; a workit/ledger dir with no git dir above it passes", () => {
  const file = path.join(bareLedger, "ledger.jsonl");
  expect(claude("Write", { file_path: file })?.permissionDecision).toBe("deny");
  expect(claude("Bash", { command: `echo x >> ${file}` })?.permissionDecision).toBe("deny");
  expect(mayReach(`echo x >> ${file}`, root)).toBe(true);
  expect(editReaches(file, root)).toBe(true);
  const plain = path.join(base, "notes", "workit", "ledger", "n.txt");
  expect(claude("Write", { file_path: plain })).toBeUndefined();
  expect(claude("Bash", { command: `echo x >> ${plain}` })).toBeUndefined();
  expect(editReaches(plain, root)).toBe(false);
  // Every workit/ledger in the path counts, not only the last.
  expect(inRepoLedger(path.join(bareLedger, "workit", "ledger", "x"))).toBe(true);
  expect(inRepoLedger(path.join(base, "notes", "workit", "ledger", "x"))).toBe(false);
});

test("G a link or mount into a guarded registry, or of a dir holding one, then a write through it in the same command, W run, T denied before the link exists", () => {
  // Each registry with a file in it (the config dir guards only workspaces.json and its seal).
  const registries: Array<[string, string]> = [
    [path.join(state, "issued"), "s.json"],
    [path.join(state, "approvals"), "a.json"],
    [path.join(state, "verdicts"), "ledger.jsonl"],
    [path.join(state, "folders", "app-1a2b", "ledger"), "ledger.jsonl"],
    [home.configDir, "workspaces.json"],
    [ledger, "ledger.jsonl"],
    [bareLedger, "ledger.jsonl"],
  ];
  const links = (source: string, name: string) => [
    `ln -s ${source} l && echo x >> l/${name}`,
    `ln ${source}/${name} l && echo x >> l`,
    `ln -sf ${source} l; echo x >> l/${name}`,
    `ln -sT ${source} l && echo x >> l/${name}`,
    `ln --symbolic ${source} l && echo x >> l/${name}`,
    `/bin/ln -s -- ${source} l && echo x >> l/${name}`,
    `cp -s ${source}/${name} l && echo x >> l`,
    `cp -l ${source}/${name} l && echo x >> l`,
    `cp --link ${source}/${name} l && echo x >> l`,
    `cp -rs ${source} l && echo x >> l/${name}`,
    `cp --symbolic-link ${source}/${name} l && echo x >> l`,
    `sudo mount --bind ${source} m && echo x >> m/${name}`,
    `bindfs ${source} m && echo x >> m/${name}`,
    `install -l s ${source}/${name} l && echo x >> l`,
    `install -lh ${source}/${name} l && echo x >> l`,
    `rsync -a --link-dest=${source} /tmp/empty/ d/ && echo x >> d/${name}`,
    `rsync -a --link-dest ${source} /tmp/empty/ d/`,
    `mklink /D l ${source} && echo x >> l/${name}`,
    `mklink l ${source}/${name}`,
    `cmd /c mklink /J l ${source}`,
    `cmd.exe /c "mklink /H l ${source}/${name}"`,
    // A compound cmd string: every `&&`, `&`, `||` or `|` segment is judged.
    `cmd /c "cd x && mklink /J l ${source}"`,
    `cmd.exe /c "echo a & mklink /D l ${source}"`,
    `cmd /c "dir || mklink /H l ${source}/${name}"`,
    `cmd /C "echo a | mklink /J l ${source}"`,
    // PowerShell's `;`-separated statements, run from a POSIX shell.
    `powershell -Command "cd x; New-Item -ItemType SymbolicLink -Path l -Target ${source}"`,
    `pwsh -c "Get-Date; ni l -ItemType Junction -Value ${source}"`,
    // xargs or parallel fed a guarded path on stdin (here-string or heredoc).
    `xargs -I{} ln -s {} l <<< ${source}`,
    `xargs ln -s -t d <<< ${source}`,
    `xargs -I {} cp -l {}/${name} l <<EOF\n${source}\nEOF`,
    `xargs -I{} mklink /J l {} <<< ${source}`,
    `xargs -I{} rsync -a --link-dest={} /tmp/empty/ d/ <<< ${source}`,
    `xargs -I{} install -l s {}/${name} l <<< ${source}`,
    `parallel ln -s {} l ::: ${source}`,
  ];
  for (const [source, name] of registries)
    for (const command of links(source, name)) {
      const out = claude("Bash", { command });
      expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
      expect(out?.permissionDecisionReason, command).toContain("links or mounts");
      expect(mayReach(command, root), command).toBe(true);
    }
  // A dir that holds a registry or a ledger: the state dir, the config dir's
  // parent, a git dir, the repository it is in, a ledger's workit dir.
  for (const source of [
    state,
    path.join(state, "folders"),
    path.join(state, "folders", "app-1a2b"),
    path.dirname(home.configDir),
    path.join(root, ".git"),
    root,
    bare,
    path.dirname(bareLedger),
  ]) {
    const command = `ln -s ${source} up && echo x >> up/x`;
    const out = claude("Bash", { command });
    expect([command, out?.permissionDecision]).toEqual([command, "deny"]);
    expect(out?.permissionDecisionReason).toContain("links or mounts");
  }
  // PowerShell's New-Item (or `ni`) makes a symbolic link, junction or hard link.
  for (const [source, name] of registries)
    for (const command of [
      `New-Item -ItemType SymbolicLink -Path l -Target ${source}`,
      `ni l -ItemType Junction -Value ${source}`,
      `New-Item -ItemType:HardLink -Path l -Target:${source}/${name}`,
      `cmd /c "cd x && mklink /J l ${source}"`,
      `Get-Date; pwsh -Command "cd x; ni l -ItemType Junction -Value ${source}"`,
    ]) {
      const out = shellGate(root, command, null, "powershell");
      expect([command, out.kind]).toEqual([command, "deny"]);
      expect(mayReach(command, root), command).toBe(true);
    }
  // A relative --link-dest is read from the destination.
  const fromDest = path.relative(path.join(root, "d"), path.join(state, "verdicts"));
  expect(
    claude("Bash", { command: `rsync -a --link-dest=${fromDest} /tmp/empty/ d/` })
      ?.permissionDecision,
  ).toBe("deny");
  // A relative symbolic source resolves from the link's dir.
  const relative = path.relative(path.join(root, "sub"), path.join(state, "verdicts"));
  expect(
    claude("Bash", { command: `mkdir -p sub && ln -s ${relative} sub/v && echo x >> sub/v/x` })
      ?.permissionDecision,
  ).toBe("deny");
  // Links that reach nothing guarded, and a plain copy out of a registry, pass.
  for (const command of [
    `ln -s ../node_modules nm && ls nm`,
    `ln -sf ${path.join(base, "notes")} n && echo x >> n/x`,
    `cp -s ${path.join(base, "notes", "a")} b`,
    `cp ${path.join(state, "verdicts", "sets", "ledger.jsonl")} copy.jsonl`,
    `rsync -a --link-dest=../prev ${path.join(base, "notes")}/ d/`,
    `install -m 644 ${path.join(base, "notes", "a")} b`,
    `mklink /D n ${path.join(base, "notes")}`,
    `cmd /c "cd x && mklink /J n ${path.join(base, "notes")}"`,
    `pwsh -c "Get-Date; ni n -ItemType Junction -Value ${path.join(base, "notes")}"`,
    `xargs -I{} ln -s {} n <<< ${path.join(base, "notes")}`,
  ])
    expect(claude("Bash", { command }), command).toBeUndefined();
  expect(shellGate(root, "New-Item -ItemType Directory -Path x", null, "powershell").kind).not.toBe(
    "deny",
  );
});

test("G an unquoted Windows path in a command, W slashed for the POSIX analysis, T each word with a backslash reads with slashes; elsewhere, untouched", () => {
  expect(windowsSlashed("ln -s C:\\st\\issued l && echo x >> l/s.json", "win32")).toBe(
    "ln -s C:/st/issued l && echo x >> l/s.json",
  );
  expect(windowsSlashed("ln -s /st/issued l", "win32")).toBeNull();
  expect(windowsSlashed("ln -s C:\\st\\issued l", "linux")).toBeNull();
});
