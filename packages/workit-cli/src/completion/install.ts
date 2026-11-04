// Install the completion script for the user's shell where that shell loads it
// per user, as `workit setup` and `workit upgrade` do: zsh in <XDG data
// home>/zsh/site-functions/_workit, bash in <XDG data
// home>/bash-completion/completions/workit, fish in <XDG config
// home>/fish/completions/workit.fish. PowerShell gets the profile
// line only. No rc file is ever edited: when zsh's fpath lacks the directory,
// the lines to add are printed. Only a file carrying COMPLETION_MARKER is
// overwritten or removed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { workitDir } from "@brainervirus/workit-core/src/core/workit-paths.mjs";
import { COMPLETION_MARKER, completionScript, type Shell } from "./scripts";

type Env = NodeJS.ProcessEnv;

/**
 * The per-user XDG base for `kind` (the parent of Workit's own dir there),
 * from the one resolver: Workit's own overrides are not the shell's.
 */
const xdgBase = (kind: "data" | "config", env: Env, platform: NodeJS.Platform): string =>
  path.dirname(
    workitDir(kind, { ...env, WORKIT_CONFIG: undefined, WORKIT_CONFIG_DIR: undefined }, platform),
  );

/** Where `shell` loads a per-user completion file from; null for PowerShell (a profile line). */
export function completionFile(
  shell: Shell,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (shell === "zsh")
    return path.join(xdgBase("data", env, platform), "zsh", "site-functions", "_workit");
  if (shell === "bash")
    return path.join(xdgBase("data", env, platform), "bash-completion", "completions", "workit");
  if (shell === "fish")
    return path.join(xdgBase("config", env, platform), "fish", "completions", "workit.fish");
  return null;
}

/** The user's shell: $SHELL's name, PowerShell on Windows, else null. */
function userShell(env: Env, platform: NodeJS.Platform = process.platform): Shell | null {
  const name = path.basename(env.SHELL ?? "").replace(/\.exe$/u, "");
  if (name === "zsh" || name === "bash" || name === "fish") return name;
  if (platform === "win32" || name === "pwsh" || name === "powershell") return "powershell";
  return null;
}

/** The directories zsh searches for functions (`$fpath` of a non-interactive zsh); null when zsh cannot run. */
function zshFpath(env: Env): string[] | null {
  const run = spawnSync("zsh", ["-c", "print -rl -- $fpath"], {
    env,
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
  });
  return run.status === 0 ? run.stdout.split("\n").filter(Boolean) : null;
}

const POWERSHELL_PROFILE_LINE = "workit completion powershell | Out-String | Invoke-Expression";

export type CompletionInstall = {
  shell: Shell | null;
  file: string | null;
  status: "written" | "current" | "skipped" | "failed";
  /** Lines for the user: what to add where, or why nothing was written. */
  notes: string[];
};

const owned = (file: string): boolean => {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n", 3)
      .some((line) => line.startsWith(COMPLETION_MARKER));
  } catch {
    return false;
  }
};

/** Write the completion script for the user's shell (or `shell`); none known, nothing. Never edits an rc file. */
export function installCompletion(options: {
  env: Env;
  version: string;
  platform?: NodeJS.Platform;
  shell?: Shell | null;
  fpath?: (env: Env) => string[] | null;
}): CompletionInstall {
  const platform = options.platform ?? process.platform;
  const shell = options.shell === undefined ? userShell(options.env, platform) : options.shell;
  if (!shell)
    return {
      shell,
      file: null,
      status: "skipped",
      notes: [],
    };
  const file = completionFile(shell, options.env, platform);
  if (!file)
    return {
      shell,
      file,
      status: "skipped",
      notes: [`add to your PowerShell profile ($PROFILE): ${POWERSHELL_PROFILE_LINE}`],
    };
  const script = completionScript(shell, options.version);
  const exists = fs.existsSync(file);
  if (exists && !owned(file))
    return {
      shell,
      file,
      status: "skipped",
      notes: [`${file} was not written by Workit; left as is`],
    };
  let status: CompletionInstall["status"] = "current";
  if (!exists || fs.readFileSync(file, "utf8") !== script) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, script);
      status = "written";
    } catch (error) {
      return {
        shell,
        file,
        status: "failed",
        notes: [`could not write ${file}: ${(error as Error).message}`],
      };
    }
  }
  return { shell, file, status, notes: shellNotes(shell, file, options) };
}

function shellNotes(
  shell: Shell,
  file: string,
  options: { env: Env; fpath?: (env: Env) => string[] | null },
): string[] {
  const dir = path.dirname(file);
  if (shell === "bash")
    return [
      `bash-completion loads it in new bash sessions; without bash-completion add to ~/.bashrc: source "${file}"`,
    ];
  if (shell === "fish") return ["fish loads it in new fish sessions"];
  const fpath = (options.fpath ?? zshFpath)(options.env);
  if (fpath?.includes(dir)) return ["that directory is on zsh's $fpath: new zsh sessions load it"];
  return [
    "zsh's $fpath lacks that directory; add these lines to ~/.zshrc (before any other compinit), then open a new shell:",
    `  fpath=("${dir}" $fpath)`,
    "  autoload -Uz compinit && compinit",
  ];
}

/** Remove the completion files Workit wrote (each shell's); a foreign file stays. */
export function removeCompletions(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const removed: string[] = [];
  for (const shell of ["zsh", "bash", "fish"] as const) {
    const file = completionFile(shell, env, platform);
    if (!file || !owned(file)) continue;
    try {
      fs.rmSync(file);
      removed.push(file);
    } catch {
      // left for the next run; doctor-free: a stale script only completes old verbs
    }
  }
  return removed;
}

const VERB: Record<CompletionInstall["status"], string> = {
  written: "written to",
  current: "up to date in",
  failed: "not written to",
  skipped: "not written to",
};

/** The human lines for an install: where it went, then the notes. */
export const completionLines = (
  result: CompletionInstall,
  paint: (text: string) => string,
): string[] => [
  ...(result.shell && result.file && result.status !== "skipped"
    ? [`${result.shell} completion ${VERB[result.status]} ${paint(result.file)}`]
    : []),
  ...result.notes,
];
