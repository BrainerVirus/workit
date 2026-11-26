// #880 for Windows shells: under strict confinement a PowerShell statement (a
// `pwsh -c` script or the PowerShell tool) or a `cmd /c` statement passes only
// when its command is a known read; any other is a writer in its run dir.
// These tests only dispatch the hook: no command below is run.
import "@/test/shared/state-isolation";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { shellMutationTargets } from "@/packages/workit-core/src/hooks/write-gate";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
let root: string;
let lead: string;
let wt: string;
const stateBefore = process.env.WORKIT_STATE_DIR;

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

beforeAll(async () => {
  configHome = useConfigHome("wk-confine-windows-config-");
  root = mkdtempSync(path.join(os.tmpdir(), "wk-confine-windows-"));
  process.env.WORKIT_STATE_DIR = path.join(root, "state");
  lead = path.join(root, "app");
  mkdirSync(lead, { recursive: true });
  git(lead, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", path.join(root, "no-hooks")],
  ])
    git(lead, "config", key, value);
  writeFileSync(path.join(lead, "package.json"), '{ "name": "app", "version": "1.0.0" }\n');
  git(lead, "add", "-A");
  git(lead, "commit", "-qm", "chore: base");
  const plan = path.join(root, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      name: "wave",
      trunk: "main",
      slices: [
        {
          id: "a",
          branch: "feature/a",
          tier: "standard",
          reason: "parallel",
          scope: ["a.ts"],
          goal: "ship a",
          acceptance: ["Given the app, When a runs, Then it works"],
          verify: ["workit check test"],
          forbidden: ["no edits outside SCOPE"],
        },
      ],
    }),
  );
  const cli = async (argv: string[]) => {
    let stdout = "";
    const code = await main(argv, {
      cwd: lead,
      env: { ...process.env, WORKIT_SESSION_ID: "lead-windows" },
      stdout: (text) => void (stdout += text),
      stderr: () => undefined,
    });
    if (code !== 0) throw new Error(`workit ${argv.join(" ")}: ${stdout}`);
    return JSON.parse(stdout).data;
  };
  await cli(["fanout", "plan", plan, "--json"]);
  wt = (await cli(["fanout", "worktree", "create", "a", "--json"])).path;
});

afterAll(() => {
  if (stateBefore === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = stateBefore;
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});

type Specific = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};

/** A Claude Code PreToolUse call of the shell `tool` from a subagent of `type` in `cwd`. */
const shell = (tool: string, command: string, type: string, id: string, cwd = lead) => {
  const payload = fixture("claude-code", "pre-tool-use-write", cwd, {
    tool_name: tool,
    // Windows paths go with forward slashes; a backslash case runs only on POSIX.
    tool_input: { command: process.platform === "win32" ? command.replaceAll("\\", "/") : command },
  });
  payload.agent_id = id;
  payload.agent_type = type;
  return (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput;
};
type Run = (command: string) => Specific["hookSpecificOutput"];
const verifier: Run = (command) => shell("Bash", command, "workit:verifier", "ver-win");
const implementer: Run = (command) => shell("Bash", command, "workit:implementer", "impl-win", wt);
/** The PowerShell tool, run in the lead's checkout. */
const pwshVerifier: Run = (command) =>
  shell("PowerShell", command, "workit:verifier", "ver-win-ps");
const pwshImplementer: Run = (command) =>
  shell("PowerShell", command, "workit:implementer", "impl-win-ps");

const VERIFIER = "workit scratch confinement: verifier ver-win";
const IMPLEMENTER = "workit worktree confinement: implementer impl-win";

const allowed = (run: Run, commands: string[]) => {
  for (const command of commands) expect(run(command)?.permissionDecision, command).toBeUndefined();
};
const denied = (run: Run, commands: string[], reason: string) => {
  for (const command of commands) {
    const out = run(command);
    expect(out?.permissionDecision, command).toBe("deny");
    expect(out?.permissionDecisionReason, command).toContain(reason);
  }
};
/** Denied for a judge in the lead's checkout and for an implementer that `cd`s there. */
const deniedInLead = (commands: string[]) => {
  denied(verifier, commands, VERIFIER);
  denied(
    implementer,
    commands.map((command) => `cd ${lead} && ${command}`),
    IMPLEMENTER,
  );
};

const allowedInLead = (commands: string[]) => {
  allowed(verifier, commands);
  allowed(
    implementer,
    commands.map((command) => `cd ${lead} && ${command}`),
  );
};

test("Given a pwsh -c script whose command writes or runs code, When a judge or an implementer runs it in the lead's checkout, Then it is denied; in the implementer's worktree it runs", () => {
  const writers = [
    "pwsh -c 'sc f a'",
    "pwsh -c 'ri package.json'",
    "pwsh -c 'Rename-Item package.json b.json'",
    "pwsh -c 'rni package.json b.json'",
    "pwsh -c 'Clear-Content package.json'",
    "pwsh -c 'ac package.json x'",
    "pwsh -c 'Set-ItemProperty package.json -Name IsReadOnly -Value 1'",
    "pwsh -c 'Expand-Archive a.zip'",
    "pwsh -c 'Compress-Archive src a.zip'",
    "pwsh -c 'Get-ChildItem | Export-Csv a.csv'",
    "pwsh -c 'Get-ChildItem | Tee-Object a.txt'",
    "pwsh -c 'Get-ChildItem | Out-File a.txt'",
    "pwsh -c 'md d'",
    `pwsh -c "[IO.File]::WriteAllText('a', 'b')"`,
    `pwsh -c "[IO.File]::Delete('package.json')"`,
    `pwsh -c "[System.IO.Directory]::CreateDirectory('d')"`,
    // Scripts and script blocks run from inside the script.
    "pwsh -c '& ./x.ps1'",
    "pwsh -c '. ./x.ps1'",
    "pwsh -c './x.ps1'",
    "pwsh -c 'Start-Process x'",
    "pwsh -c 'start x'",
    "pwsh -c 'saps x'",
    "pwsh -c 'Invoke-Item x'",
    "pwsh -c 'ii x'",
    "pwsh -c 'Invoke-Command -ScriptBlock { Get-ChildItem }'",
    "pwsh -c '$s = { Get-ChildItem }; & $s'",
    "pwsh -c '$s = { Get-ChildItem }; $s.Invoke()'",
    // A method, a member set or a member called by name on a file.
    "pwsh -c '(Get-Item package.json).Delete()'",
    "pwsh -c 'Get-ChildItem | % Delete'",
    "pwsh -c 'Get-ChildItem | ForEach-Object -MemberName MoveTo -ArgumentList x'",
    "pwsh -c '$f = Get-Item package.json; $f.IsReadOnly = $true'",
    `pwsh -c '$function:f = "Remove-Item src"; f'`,
    `pwsh -c 'Write-Output "$(Remove-Item src)"'`,
    "pwsh -c 'Get-ChildItem > out.txt'",
    `pwsh -c 'Get-ChildItem | % ("De" + "lete")'`,
    `pwsh -c "(Get-ChildItem).ForEach('Delete')"`,
    // An en dash reads as `-`; a script the shell expands first is not the text Workit reads.
    "pwsh -c 'Remove\u2013Item src'",
    `pwsh -c "$SCRIPT"`,
    // Windows PowerShell runs its positional words as a command.
    "powershell Remove-Item src",
    // A script on stdin, an encoded command or a command glued to its parameter.
    "echo 'Remove-Item src' | pwsh",
    "echo 'Remove-Item src' | pwsh -c -",
    "echo 'Remove-Item src' | pwsh -s",
    "pwsh -EncodedCommand:ZQBjAGgAbwA=",
    "pwsh -enc:ZQBjAGgAbwA=",
    "pwsh -EncodedCommand=ZQBjAGgAbwA=",
    "pwsh -Command:Get-ChildItem",
  ];
  deniedInLead(writers);
  allowed(implementer, writers);
});

test("Given a cmd /c script with a builtin or program outside the read-only set, When a judge or an implementer runs it in the lead's checkout, Then it is denied; in the implementer's worktree it runs", () => {
  const writers = [
    "cmd /c copy package.json b.json",
    "cmd /c move package.json b.json",
    "cmd /c ren package.json b.json",
    "cmd /c md d",
    "cmd /c rd /s /q src",
    "cmd /c xcopy src d /e",
    "cmd /c robocopy src d",
    "cmd /c attrib +r package.json",
    "cmd /c call x.bat",
    "cmd /c x.bat",
    `cmd /c "dir & del package.json"`,
    "cmd /c set X=1",
    `cmd /c "if exist a del a"`,
    "cmd /c git status",
    "echo del package.json | cmd",
  ];
  deniedInLead(writers);
  allowed(implementer, writers);
});

test("Given xargs or find -exec whose command stdin or {} names, When a judge or an implementer runs it in the lead's checkout, Then it is denied", () => {
  deniedInLead([
    "echo touch | xargs -J % % f",
    "echo f | xargs -J % touch %",
    "echo touch | find . -exec {} f \\;",
    "echo touch f | xargs -L1 env",
    "echo touch f | xargs nice",
  ]);
});

test("Given the PowerShell tool, When a judge or an implementer in the lead's checkout runs a statement that writes, Then it is denied; a read-only statement runs", () => {
  const writers = [
    "Remove-Item package.json",
    "sc a b",
    "& ./x.ps1",
    "[IO.File]::Delete('package.json')",
    "copy package.json b.json",
    "Get-ChildItem | Export-Csv a.csv",
    "Get-ChildItem > out.txt",
    "Get-ChildItem; Remove-Item package.json",
    "cmd /c del package.json",
  ];
  denied(pwshVerifier, writers, "workit scratch confinement: verifier ver-win-ps");
  denied(pwshImplementer, writers, "workit worktree confinement: implementer impl-win-ps");
  const reads = [
    "Get-ChildItem",
    "gci src | Select-Object Name",
    "Get-Content package.json -Raw | ConvertFrom-Json",
    "git status",
    "cd src; ls",
    "pwsh -c Get-ChildItem",
    "cmd /c dir",
  ];
  allowed(pwshVerifier, reads);
  allowed(pwshImplementer, reads);
});

// #956/#961/#964's read-only Windows forms, and other everyday reads, keep running.
test("Given a pwsh or cmd script that only reads, When a judge or an implementer runs it in the lead's checkout, Then the hook allows it", () => {
  const reads = [
    "pwsh -c Get-ChildItem",
    "pwsh -NoProfile -Command Get-ChildItem src",
    "powershell Get-ChildItem",
    "cmd /c dir",
    `cmd /c "echo %PATH%"`,
    "xargs cat",
    "ls | xargs -I{} cat {}",
    "echo a | xargs",
    "find . -name x -exec cat {} \\;",
    "pwsh -c 'Get-Content package.json | ConvertFrom-Json | Select-Object -ExpandProperty name'",
    "pwsh -c 'gci -Recurse -Filter *.ts | Where-Object { $_.Length -gt 0 } | Sort-Object Length | Select-Object -First 5 | Format-Table Name, Length'",
    "pwsh -c 'Test-Path package.json; Resolve-Path .; pwd'",
    "pwsh -c 'gci | % { $_.Name.ToUpper() }'",
    "pwsh -c 'gci | % Name'",
    "pwsh -c '$x = Get-Content package.json -Raw; $x.Length'",
    `pwsh -c 'Write-Output "files: $((gci).Count)"'`,
    "pwsh -c 'gci | measure | Out-String'",
    "pwsh -c 'cd src; ls; echo done'",
    "pwsh -c 'gci 2>$null'",
    "pwsh -c 'git status && git log -1'",
    "pwsh -NoProfile -c 'if (Test-Path package.json) { Get-Content package.json } else { Write-Host none }'",
    "pwsh -c 'foreach ($f in gci) { $f.FullName }'",
    `cmd /c "dir /s /b & type package.json"`,
    `cmd /c "where git"`,
    `cmd /c "findstr name package.json"`,
    "cmd /c ver",
    "cmd /c set",
    `cmd /c "type package.json | more"`,
    `cmd /c "dir 2>nul"`,
    `cmd /c "@echo off & echo hi"`,
  ];
  allowed(verifier, reads);
  allowed(
    implementer,
    reads.map((command) => `cd ${lead} && ${command}`),
  );
});

/** Whether `targets` hold a writer Workit cannot see into, run in `dir`. */
const writerIn = (dir: string, targets: string[]): boolean =>
  targets.some(
    (target) => path.dirname(target) === dir && path.basename(target).startsWith(".workit-runs-"),
  );

// A property of the allowlist, not of a list of names: any noun after a writer verb counts.
test("Given any cmdlet whose verb is outside the read-only verbs, When it runs in a pwsh -c script or the PowerShell tool, Then it is a writer in its run dir; a read verb is not", () => {
  const verbs = [
    "Set",
    "New",
    "Remove",
    "Add",
    "Clear",
    "Copy",
    "Move",
    "Rename",
    "Export",
    "Start",
    "Invoke",
    "Stop",
    "Import",
    "Install",
    "Update",
    "Expand",
    "Compress",
    "Enable",
    "Disable",
    "Register",
    "Save",
    "Send",
    "Restore",
    "Reset",
    "Mount",
    "Unblock",
    "Protect",
    "Edit",
  ];
  const nouns = ["Item", "Content", "ItemProperty", "Acl", "Csv", "Module", "Zyxwv"];
  for (const verb of verbs)
    for (const noun of nouns)
      for (const name of [`${verb}-${noun}`, `${verb}-${noun}`.toLowerCase()]) {
        const script = shellMutationTargets(lead, `pwsh -c "${name} x"`, "posix", true);
        expect(writerIn(lead, script), name).toBe(true);
        const tool = shellMutationTargets(lead, `Get-Date; ${name} x`, "powershell", true);
        expect(writerIn(lead, tool), name).toBe(true);
      }
  for (const name of ["Out-File", "Out-Printer", "Tee-Object", "Write-Zyxwv"]) {
    const targets = shellMutationTargets(lead, `gci | ${name} x`, "powershell", true);
    expect(writerIn(lead, targets), name).toBe(true);
  }
  const reads = ["Get", "Select", "Where", "Measure", "Sort", "Format", "ConvertFrom", "ConvertTo"];
  for (const verb of reads)
    for (const noun of nouns)
      expect(
        shellMutationTargets(lead, `pwsh -c "${verb}-${noun} x"`, "posix", true),
        `${verb}-${noun}`,
      ).toEqual([]);
});

// Verification mwx7wdfd, item 1: a static member reached through a variable or `$_` is still a static call.
test("Given a static member on a type held in a variable or $_, When a judge or an implementer runs it in the lead's checkout, Then it is denied", () => {
  deniedInLead([
    `pwsh -c '$t = [IO.File]; $t::Delete("package.json")'`,
    `pwsh -c '$t = [type]"System.IO.File"; $t::Delete("package.json")'`,
    `pwsh -c '[IO.File] | % { $_::Delete("package.json") }'`,
  ]);
  denied(pwshVerifier, ["$t = [IO.File]; $t::Delete('package.json')"], "verifier ver-win-ps");
});

// Item 2: parameters before `-Command` match as PowerShell matches them, with their values.
test("Given pwsh or powershell parameters before -Command, When one takes a value, is unknown, or loads code, Then the script after it is judged or the command counts as a writer", () => {
  // Abbreviations PowerShell matches: the value is skipped and the script is read.
  deniedInLead([
    "pwsh -ep Bypass -c 'ri package.json'",
    "pwsh -exe Bypass -c 'ri package.json'",
    "pwsh -exec Bypass -c 'ri package.json'",
    "powershell -Version 2 -c 'ri package.json'",
    "pwsh -of Text -c 'ri package.json'",
    "pwsh -ou Text -c 'ri package.json'",
    "pwsh -wo src -c 'ri package.json'",
    "pwsh -wor src -c 'ri package.json'",
    "pwsh -wi Hidden -c 'ri package.json'",
    "pwsh -cu p -c 'ri package.json'",
  ]);
  // Unknown or ambiguous, or loading code: a writer even when the script reads.
  deniedInLead([
    "pwsh -epo x -c Get-ChildItem",
    "pwsh -in Text -c Get-ChildItem",
    "pwsh -v -c Get-ChildItem",
    "pwsh -ver x -c Get-ChildItem",
    "pwsh -Config x -c Get-ChildItem",
    "pwsh -ConfigurationName x -c Get-ChildItem",
    "pwsh -SettingsFile x -c Get-ChildItem",
    "powershell -PSConsoleFile x -c Get-ChildItem",
    "pwsh -Login -c Get-ChildItem",
  ]);
  allowedInLead([
    "pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -c Get-ChildItem",
    "pwsh -nop -noni -nol -c Get-ChildItem",
    "pwsh -ep Bypass -wd src -of Text -c Get-ChildItem",
    "pwsh -Version",
  ]);
});

// Item 3: an environment that changes what a later program runs or loads.
test("Given a PowerShell $env: or a Bash assignment of a name that changes what a program runs, When a judge or an implementer runs a program after it in the lead's checkout, Then it is denied", () => {
  const pwsh = [
    `pwsh -c '$env:GIT_PAGER = "sh"; git log'`,
    `pwsh -c '$env:Path += ";C:/x"; git status'`,
    `pwsh -c '$env:NODE_OPTIONS = "-r ./x.js"; node -v'`,
  ];
  deniedInLead(pwsh);
  denied(pwshImplementer, [`$env:EDITOR = "x"; git commit`], "implementer impl-win-ps");
  // A judge's Bash refuses these names already; an implementer's confinement now counts them.
  denied(
    implementer,
    [
      "PAGER=sh git log",
      "GIT_SSH_COMMAND=x git fetch",
      "export EDITOR=x; git status",
      "env PATH=/x git status",
      "BASH_ENV=x bash -c true",
    ].map((command) => `cd ${lead} && ${command}`),
    IMPLEMENTER,
  );
  allowedInLead([`pwsh -c '$env:FOO = 1; git status'`]);
  allowed(implementer, [
    `cd ${lead} && FOO=1 git status`,
    `cd ${lead} && GIT_PAGER=cat git log`,
    `cd ${lead} && GIT_OPTIONAL_LOCKS=0 git status`,
  ]);
});

// #967 residuals: more names that load code, for Bash and PowerShell alike; npm's in any case.
test("Given a Bash or PowerShell assignment of an askpass, a cargo, JVM, .NET, Bun, npm or search-path name, When a judge or an implementer runs a program after it in the lead's checkout, Then it is denied; the exempt values run", () => {
  const names = [
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "CARGO_BUILD_RUSTC_WRAPPER",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "DOTNET_STARTUP_HOOKS",
    "COMPLUS_X",
    "CORECLR_PROFILER_PATH",
    "BUN_OPTIONS",
    "NODE_PATH",
    "npm_config_script_shell",
    "NPM_CONFIG_SCRIPT_SHELL",
    "Npm_Config_Node_Options",
    "PROMPT_COMMAND",
    "PATHEXT",
    "PSModulePath",
  ];
  deniedInLead(names.map((name) => `pwsh -c '$env:${name} = "x"; git status'`));
  denied(
    implementer,
    names.flatMap((name) => [
      `cd ${lead} && ${name}=x git status`,
      `cd ${lead} && export ${name}=x; ls`,
      `cd ${lead} && env ${name}=x ls`,
    ]),
    IMPLEMENTER,
  );
  denied(
    verifier,
    names.map((name) => `${name}=x git status`),
    VERIFIER,
  );
  // Case matters to a POSIX shell for every name but npm's.
  allowed(implementer, [
    `cd ${lead} && ssh_askpass=x git status`,
    `cd ${lead} && GIT_PAGER=cat PAGER=cat GIT_OPTIONAL_LOCKS=0 git log`,
  ]);
});

// #967 residuals: `pwsh -wd X` moves to X before the script runs; a pipe name and -Interactive are benign.
test("Given pwsh -WorkingDirectory before -c, When the script writes a relative path, Then the path is read in that directory", () => {
  // From the implementer's worktree, -wd moves the script's writes into the lead's checkout.
  denied(
    implementer,
    [
      `pwsh -wd ${lead} -c 'ri package.json'`,
      `pwsh -WorkingDirectory ${lead} -c 'ri package.json'`,
      `pwsh -WorkingDirectory:${lead} -c 'ri package.json'`,
      `pwsh -NoProfile -wd ${lead} -CommandWithArgs 'ri package.json'`,
    ],
    IMPLEMENTER,
  );
  // From the lead's checkout, -wd moves them into the worktree.
  allowed(implementer, [
    `cd ${lead} && pwsh -wd ${wt} -c 'ri package.json'`,
    `cd ${lead} && pwsh -WorkingDirectory ${wt} -c 'sc f a'`,
  ]);
  // A -wd after -c is part of the script, not a directory.
  denied(implementer, [`cd ${lead} && pwsh -c 'ri package.json' -wd ${wt}`], IMPLEMENTER);
  deniedInLead([
    "pwsh -CustomPipeName p -c 'ri package.json'",
    "pwsh -Interactive -c 'ri package.json'",
    "pwsh -i -c 'ri package.json'",
  ]);
  allowedInLead([
    "pwsh -CustomPipeName p -c Get-ChildItem",
    "pwsh -Interactive -c Get-ChildItem",
    "pwsh -i -NoProfile -c Get-ChildItem",
  ]);
});

// #967 residuals: a judge's read behind a non-loader assignment or `env` runs.
test("Given a judge, When an env or prefix assignment of a non-loader name or an exempt value comes before a read, Then it runs; a loader name is still denied", () => {
  allowed(verifier, [
    "env GIT_PAGER=cat git log",
    "A=b git status",
    "env A=b git status",
    "A=b ls",
    "env A=b ls",
  ]);
  denied(verifier, ["env GIT_PAGER=sh git log", "env NODE_PATH=x git status"], VERIFIER);
});

// Item 4: a command word spelled with a cmd variable may be any program.
test("Given a command word that is a cmd variable, When a judge or an implementer runs it in the lead's checkout, Then it is denied", () => {
  deniedInLead([
    "%COMSPEC% /c del package.json",
    `cmd /c "%COMSPEC% /c del package.json"`,
    `cmd /c ""%COMSPEC%" /c del package.json"`,
    "cmd /v:on /c !X! /c del package.json",
    `pwsh -c '%COMSPEC% /c del package.json'`,
  ]);
});
