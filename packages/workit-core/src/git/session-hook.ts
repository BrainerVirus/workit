// The prepare-commit-msg hook that gives a plain `git commit` the
// `Workit-Session:` trailer `workit git commit` adds (D18), for agents that
// cannot run `workit git` (a Claude Code worktree-isolated subagent).
// `workit doctor` reports it; `workit doctor --fix` installs it, in a Workit
// workspace only.
//
// - Slot: prepare-commit-msg, not commit-msg. Git runs it for -m/-F, amend,
//   merge and squash, even with --no-verify, and before commit-msg, so a
//   commitlint there sees the trailer. commit-msg stays the user's.
// - Where: `git rev-parse --git-path hooks`, so core.hooksPath is honoured.
//   Workit writes only an empty slot or its own script. Another tool's hook in
//   the slot (husky, lefthook, a hand-written one) is never renamed, wrapped or
//   edited: the state is `blocked` and `manual` names the line to add there.
//   A hooks directory outside the repository (a global core.hooksPath), or one
//   in the working tree that git does not ignore, is never written either.
// - The session comes from the same variables as host-session.ts: WORKIT_SESSION_ID
//   (unless WORKIT_HOST names another host than the shell's own), else
//   OPENCODE_SESSION_ID, PI_SESSION_ID or CODEX_THREAD_ID. No session, an unsafe
//   id, a comment-only message, a template message (`commit -t`, commit.template:
//   git aborts an unedited template, a trailer would defeat that), or a rebase
//   or cherry-pick replaying commits that keep their own trailers: unchanged.
// - `--if-exists addIfDifferent`: the same session's trailer is never repeated;
//   another session that amends adds its own, as `workit git commit --amend` does.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { GIT_TIMEOUTS } from "./rev";

export const SESSION_HOOK_NAME = "prepare-commit-msg";
export const SESSION_HOOK_MARKER = "# workit-session-trailer-hook";
/** Left by an unreleased build that chained commit-msg; reported, never used. */
const LEGACY_CHAINED = "commit-msg.workit-chained";

// LF only: Git for Windows runs hooks with its own sh, which reads LF scripts.
export const SESSION_HOOK_SCRIPT = `#!/bin/sh
${SESSION_HOOK_MARKER} v2
# Workit (https://github.com/BrainerVirus/workit) installed this hook with
# \`workit doctor --fix\`: it adds a Workit-Session trailer to commits made in an
# agent session. To remove it, delete this file.
case "\${2-}" in template) exit 0 ;; esac
gitdir=$(git rev-parse --git-dir) || exit 0
if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ] || [ -f "$gitdir/CHERRY_PICK_HEAD" ]; then
  exit 0
fi
trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }
inner=$(trim "\${OPENCODE_SESSION_ID-}"); inner_host=opencode
if [ -z "$inner" ]; then inner=$(trim "\${PI_SESSION_ID-}"); inner_host=pi; fi
if [ -z "$inner" ]; then inner=$(trim "\${CODEX_THREAD_ID-}"); inner_host=codex; fi
[ -n "$inner" ] || inner_host=
declared=$(trim "\${WORKIT_HOST-}")
family=$(printf '%s' "$declared" | sed 's/_cli$//;s/_desktop$//')
session=$inner
if [ "\${WORKIT_SESSION_ID+set}" = set ]; then
  if [ -z "$inner" ] || [ -z "$declared" ] || [ "$family" = "$inner_host" ]; then
    session=$(trim "$WORKIT_SESSION_ID")
  fi
fi
[ -n "$session" ] || exit 0
[ \${#session} -le 128 ] || exit 0
case "$session" in *[!A-Za-z0-9_.:@/+-]*) exit 0 ;; esac
body=$(sed '/^# -\\{24\\} >8 -\\{24\\}$/,$d' "$1" | git stripspace --strip-comments)
[ -n "$body" ] || exit 0
# A merge message has no final newline; interpret-trailers would glue the
# trailer to the subject line.
[ -z "$(tail -c 1 "$1")" ] || printf '\\n' >> "$1"
git -c trailer.separators=: -c trailer.where=end interpret-trailers --in-place \\
  --no-divider --if-exists addIfDifferent --trailer "Workit-Session: $session" "$1" || exit 0
exit 0
`;

/** The one line to add to a prepare-commit-msg hook Workit does not own (`$1`: message file). */
export const manualTrailerLine = (file = '"$1"'): string =>
  `s="\${WORKIT_SESSION_ID:-\${OPENCODE_SESSION_ID:-\${PI_SESSION_ID:-$CODEX_THREAD_ID}}}"; [ -z "$s" ] || git interpret-trailers --in-place --if-exists addIfDifferent --trailer "Workit-Session: $s" ${file} || true`;

export type SessionHookState =
  /** Not inside a git work tree, or git is unavailable. */
  | "not_git"
  /** This version of the Workit hook is installed. */
  | "installed"
  /** An older Workit hook is installed; --fix rewrites it. */
  | "outdated"
  /** The slot is empty; --fix installs the hook. */
  | "missing"
  /** --fix will not write; `reason` says why and `manual` what to do instead. */
  | "blocked";

/** Who owns the slot when it is blocked by another hook. */
export type HookOwner = "husky" | "lefthook" | "other";

export type SessionHookStatus = {
  state: SessionHookState;
  hooksDir: string | null;
  hookPath: string | null;
  owner?: HookOwner;
  reason?: string;
  /** The manual fix when --fix cannot install. */
  manual?: string;
  /** Files left by the unreleased commit-msg design, with how to recover. */
  leftover?: string;
};

const run = (cwd: string, args: string[], env: NodeJS.ProcessEnv) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUTS.local,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const exists = (file: string): boolean => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const LEFTHOOK_CONFIGS = [
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
  "lefthook.json",
  "lefthook.toml",
];

const lefthookConfig = (top: string): string | null =>
  LEFTHOOK_CONFIGS.map((name) => path.join(top, name)).find((file) => existsSync(file)) ?? null;

/** husky v9 stubs source `h` beside them; v4-v8 hooks source `_/husky.sh`. */
const isHusky = (text: string, hooksDir: string): boolean =>
  text.includes("husky.sh") ||
  (/\$\(dirname (?:-- )?"\$0"\)\/h"/.test(text) && existsSync(path.join(hooksDir, "h")));

const ownerOf = (text: string, hooksDir: string, top: string): HookOwner => {
  if (isHusky(text, hooksDir)) return "husky";
  if (/lefthook/i.test(text) || lefthookConfig(top)) return "lefthook";
  return "other";
};

const manualFor = (owner: HookOwner, hooksDir: string, top: string, hookPath: string): string => {
  if (owner === "husky") {
    // husky v9 runs <hooksPath>/../<hook>; its core.hooksPath is `.husky/_`.
    const script = path.join(path.dirname(hooksDir), SESSION_HOOK_NAME);
    return `add this line to ${script} (husky runs it): ${manualTrailerLine()}`;
  }
  if (owner === "lefthook") {
    const config = lefthookConfig(top) ?? path.join(top, "lefthook.yml");
    return [
      `add this job to ${config}, then run \`lefthook install\`:`,
      `${SESSION_HOOK_NAME}:`,
      "  jobs:",
      "    - name: workit-session",
      "      run: |",
      `        ${manualTrailerLine("{1}")}`,
    ].join("\n");
  }
  return `add this line to ${hookPath}: ${manualTrailerLine()}`;
};

const leftoverOf = (hooksDir: string): string | undefined => {
  const chained = path.join(hooksDir, LEGACY_CHAINED);
  const commitMsg = path.join(hooksDir, "commit-msg");
  const oldOurs = readText(commitMsg)?.includes(SESSION_HOOK_MARKER) ?? false;
  if (exists(chained))
    return oldOurs
      ? `${chained} was left by an earlier Workit build: move it back to ${commitMsg} (replacing Workit's old hook there)`
      : `${chained} was left by an earlier Workit build and nothing runs it: if it is your original commit-msg hook, move it back to ${commitMsg}; otherwise delete it`;
  if (oldOurs)
    return `${commitMsg} is a hook from an earlier Workit build; delete it (the trailer now comes from ${SESSION_HOOK_NAME})`;
  return undefined;
};

/** Where the prepare-commit-msg hook of the repository at `cwd` lives, and what it is. */
export function inspectSessionHook(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionHookStatus {
  const none = { hooksDir: null, hookPath: null };
  if (!existsSync(cwd)) return { state: "not_git", ...none };
  const top = run(cwd, ["rev-parse", "--show-toplevel"], env);
  if (!top.ok || !top.out) return { state: "not_git", ...none };
  const paths = run(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-path", "hooks"],
    env,
  );
  const [commonDir, hooksDir] = paths.out.split(/\r?\n/);
  if (!paths.ok || !commonDir || !hooksDir) return { state: "not_git", ...none };
  const hookPath = path.join(hooksDir, SESSION_HOOK_NAME);
  const leftover = leftoverOf(hooksDir);
  const base = { hooksDir, hookPath, ...(leftover ? { leftover } : {}) };
  const generic = manualFor("other", hooksDir, top.out, hookPath);
  if (!inside(hooksDir, commonDir) && !inside(hooksDir, top.out))
    return {
      state: "blocked",
      ...base,
      reason: `core.hooksPath ${hooksDir} is outside the repository; a hook there runs in every repository that uses it`,
      manual: generic,
    };
  const text = exists(hookPath) ? (readText(hookPath) ?? "") : null;
  if (text !== null) {
    if (text === SESSION_HOOK_SCRIPT) return { state: "installed", ...base };
    if (text.includes(SESSION_HOOK_MARKER)) return { state: "outdated", ...base };
    const owner = ownerOf(text, hooksDir, top.out);
    const displaced =
      exists(`${hookPath}.old`) && readText(`${hookPath}.old`)?.includes(SESSION_HOOK_MARKER);
    return {
      state: "blocked",
      ...base,
      owner,
      reason: `${hookPath} belongs to ${owner === "other" ? "another hook" : owner}${displaced ? ` (Workit's hook was moved to ${hookPath}.old)` : ""}; Workit never replaces it`,
      manual: manualFor(owner, hooksDir, top.out, hookPath),
    };
  }
  if (!inside(hooksDir, commonDir)) {
    // A hooks directory in the working tree (a committed .githooks): a new
    // file there must be ignored, or it shows up in git status.
    const rel = path.relative(top.out, hookPath).split(path.sep).join("/");
    if (!run(top.out, ["check-ignore", "-q", "--", rel], env).ok)
      return {
        state: "blocked",
        ...base,
        reason: `${hooksDir} is in the working tree and not ignored; the hook would show up as a new file`,
        manual: generic,
      };
  }
  return { state: "missing", ...base };
}

export type SessionHookInstall = {
  /** What --fix did: wrote the hook, rewrote an older one, or nothing. */
  action: "installed" | "updated" | "unchanged" | "skipped";
  status: SessionHookStatus;
  detail: string;
};

/**
 * Install (or refresh) the hook for the repository at `cwd`. The caller decides
 * that `cwd` is a Workit workspace; this writes only an empty slot or Workit's
 * own script.
 */
export function installSessionHook(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionHookInstall {
  const status = inspectSessionHook(cwd, env);
  if (status.state === "installed")
    return { action: "unchanged", status, detail: `hook already at ${status.hookPath}` };
  if (status.state !== "missing" && status.state !== "outdated")
    return {
      action: "skipped",
      status,
      detail: status.reason ?? "not inside a git work tree",
    };
  const hookPath = status.hookPath!;
  // Written beside the slot, then renamed into it; a failed write leaves no
  // stray file and the slot as it was.
  const staged = `${hookPath}.workit-new`;
  mkdirSync(status.hooksDir!, { recursive: true });
  try {
    writeFileSync(staged, SESSION_HOOK_SCRIPT, { mode: 0o755 });
    chmodSync(staged, 0o755);
    renameSync(staged, hookPath);
  } finally {
    rmSync(staged, { force: true });
  }
  const verb = status.state === "missing" ? "installed" : "updated";
  return {
    action: verb,
    status: inspectSessionHook(cwd, env),
    detail: `${verb} the Workit ${SESSION_HOOK_NAME} hook at ${hookPath}`,
  };
}
