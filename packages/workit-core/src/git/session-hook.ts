// The commit-msg hook that gives a plain `git commit` the `Workit-Session:`
// trailer `workit git commit` adds (D18), for agents that cannot run
// `workit git` (a Claude Code worktree-isolated subagent). `workit doctor`
// reports it; `workit doctor --fix` installs it in a Workit workspace only.
//
// - Where: `git rev-parse --git-path hooks`, so core.hooksPath is honoured.
//   A hooks directory outside the repository (a global hooks path) is never
//   written: that would add trailers in every repository.
// - An existing commit-msg hook (lefthook, husky, a hand-written one) is never
//   overwritten: it moves to `commit-msg.workit-chained` and runs first, and its
//   exit status decides the commit. A tracked hook, or one in the working tree
//   that git does not ignore, is left alone (moving it would dirty the tree).
// - The session comes from the same variables as host-session.ts: WORKIT_SESSION_ID
//   (unless WORKIT_HOST names another host than the shell's own), else
//   OPENCODE_SESSION_ID, PI_SESSION_ID or CODEX_THREAD_ID. No session, an unsafe
//   id, or an empty message: the message is left as it is.
// - `--if-exists addIfDifferent`: the same session's trailer is never repeated
//   (amend, `workit git commit`, which already adds it); another session that
//   amends adds its own, as `workit git commit --amend` does.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { GIT_TIMEOUTS } from "./rev";

export const SESSION_HOOK_MARKER = "# workit-session-trailer-hook";
export const CHAINED_HOOK_NAME = "commit-msg.workit-chained";

// LF only: Git for Windows runs hooks with its own sh, which reads LF scripts.
export const SESSION_HOOK_SCRIPT = `#!/bin/sh
${SESSION_HOOK_MARKER} v1
# Installed by \`workit doctor --fix\`: adds a Workit-Session trailer to commits
# made in an agent session. Uninstall: delete this file and, if present, rename
# ${CHAINED_HOOK_NAME} back to commit-msg.
chained="$(dirname "$0")/${CHAINED_HOOK_NAME}"
if [ -f "$chained" ] && [ -x "$chained" ]; then
  "$chained" "$@" || exit $?
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

export type SessionHookState =
  /** Not inside a git work tree, or git is unavailable. */
  | "not_git"
  /** This version of the Workit hook is installed. */
  | "installed"
  /** An older Workit hook is installed; --fix rewrites it. */
  | "outdated"
  /** No commit-msg hook. */
  | "missing"
  /** Another commit-msg hook; --fix chains it. */
  | "foreign"
  /** --fix cannot install safely; `reason` says why. */
  | "blocked";

export type SessionHookStatus = {
  state: SessionHookState;
  hooksDir: string | null;
  hookPath: string | null;
  /** The chained original hook, when one is present. */
  chained: string | null;
  reason?: string;
};

const run = (cwd: string, args: string[]) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUTS.local,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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

/** Where the commit-msg hook of the repository at `cwd` lives, and what it is. */
export function inspectSessionHook(cwd: string): SessionHookStatus {
  const none = { hooksDir: null, hookPath: null, chained: null };
  if (!existsSync(cwd)) return { state: "not_git", ...none };
  const top = run(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.out) return { state: "not_git", ...none };
  const paths = run(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--git-path",
    "hooks",
  ]);
  const [commonDir, hooksDir] = paths.out.split(/\r?\n/);
  if (!paths.ok || !commonDir || !hooksDir) return { state: "not_git", ...none };
  const hookPath = path.join(hooksDir, "commit-msg");
  const chainedPath = path.join(hooksDir, CHAINED_HOOK_NAME);
  const chained = exists(chainedPath) ? chainedPath : null;
  const base = { hooksDir, hookPath, chained };
  if (!inside(hooksDir, commonDir) && !inside(hooksDir, top.out))
    return {
      state: "blocked",
      ...base,
      reason: `core.hooksPath ${hooksDir} is outside the repository; a hook there runs in every repository that uses it`,
    };
  if (!inside(hooksDir, commonDir)) {
    // A hooks directory in the working tree (husky, a committed .githooks):
    // Workit's files must neither replace a tracked hook nor show up as new files.
    const rel = path.relative(top.out, hookPath).split(path.sep).join("/");
    if (run(top.out, ["ls-files", "--error-unmatch", "--", rel]).ok)
      return {
        state: "blocked",
        ...base,
        reason: `${hookPath} is tracked by git; moving it would change the repository`,
      };
    if (!run(top.out, ["check-ignore", "-q", "--", rel]).ok)
      return {
        state: "blocked",
        ...base,
        reason: `${hooksDir} is in the working tree and not ignored; the hook would show up as a new file`,
      };
  }
  if (!exists(hookPath)) return { state: "missing", ...base };
  const text = readText(hookPath);
  if (text === SESSION_HOOK_SCRIPT) return { state: "installed", ...base };
  if (text?.includes(SESSION_HOOK_MARKER)) return { state: "outdated", ...base };
  if (chained)
    return {
      state: "blocked",
      ...base,
      reason: `${hookPath} is not Workit's and ${chained} already exists; neither is overwritten`,
    };
  return { state: "foreign", ...base };
}

export type SessionHookInstall = {
  /** What --fix did: wrote the hook, rewrote an older one, chained another, or nothing. */
  action: "installed" | "updated" | "chained" | "unchanged" | "skipped";
  status: SessionHookStatus;
  detail: string;
};

/**
 * Install (or refresh) the hook for the repository at `cwd`. The caller decides
 * that `cwd` is a Workit workspace; this never overwrites a hook that is not
 * Workit's.
 */
export function installSessionHook(cwd: string): SessionHookInstall {
  const status = inspectSessionHook(cwd);
  const write = (file: string) => {
    writeFileSync(file, SESSION_HOOK_SCRIPT, { mode: 0o755 });
    chmodSync(file, 0o755);
  };
  switch (status.state) {
    case "installed":
      return {
        action: "unchanged",
        status,
        detail: `commit-msg hook already at ${status.hookPath}`,
      };
    case "not_git":
    case "blocked":
      return {
        action: "skipped",
        status,
        detail: status.reason ?? "not inside a git work tree",
      };
    case "outdated":
      write(status.hookPath!);
      return {
        action: "updated",
        status: inspectSessionHook(cwd),
        detail: `rewrote the Workit commit-msg hook at ${status.hookPath}`,
      };
    case "missing":
      mkdirSync(status.hooksDir!, { recursive: true });
      write(status.hookPath!);
      return {
        action: "installed",
        status: inspectSessionHook(cwd),
        detail: `installed the Workit commit-msg hook at ${status.hookPath}`,
      };
    case "foreign": {
      // Written beside it first: a failed write leaves the original in place.
      const chained = path.join(status.hooksDir!, CHAINED_HOOK_NAME);
      const staged = `${status.hookPath!}.workit-new`;
      write(staged);
      renameSync(status.hookPath!, chained);
      renameSync(staged, status.hookPath!);
      return {
        action: "chained",
        status: inspectSessionHook(cwd),
        detail: `moved the existing commit-msg hook to ${chained} (it runs first) and installed the Workit hook at ${status.hookPath}`,
      };
    }
  }
}
