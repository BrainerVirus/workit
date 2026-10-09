// The prepare-commit-msg hook that gives a plain `git commit` the
// `Workit-Session:` trailer `workit git commit` adds (D18), for agents that
// cannot run `workit git` (a Claude Code worktree-isolated subagent).
// `workit doctor` reports it; `workit doctor --fix` installs it, in a Workit
// workspace only.
//
// - One source of truth: the trailer logic is SESSION_TRAILER_SCRIPT, written
//   to `<git-common-dir>/workit/session-trailer.sh` (Workit-owned, never a hook
//   slot, never the working tree). The hook Workit installs, and every line a
//   user is told to add to a hook Workit does not own, is the same one-liner
//   that runs it with the hook's arguments.
// - Slot: prepare-commit-msg, not commit-msg. Git runs it for -m/-F, amend,
//   merge and squash, even with --no-verify, and before commit-msg, so a
//   commitlint there sees the trailer. commit-msg stays the user's.
// - Where: `git rev-parse --git-path hooks`, so core.hooksPath is honoured.
//   Workit writes only an empty slot or its own hook. Another tool's hook in
//   the slot (husky, lefthook, a hand-written one) is never renamed, wrapped or
//   edited: the state is `blocked` and `manual` names the line to add there;
//   once that hook (or husky script, or lefthook config) runs the helper, the
//   state is `manual`.
//   A hooks directory outside the repository (a global core.hooksPath), or one
//   in the working tree that git does not ignore, gets no hook either.
// - The session comes from the same variables as host-session.ts: WORKIT_SESSION_ID
//   (unless WORKIT_HOST names another host than the shell's own), else
//   OPENCODE_SESSION_ID, PI_SESSION_ID or CODEX_THREAD_ID. The message is left
//   unchanged with no session or an unsafe id; for a plain editor commit (no
//   message source: the trailer would sit in the buffer, and a user who empties
//   it would commit a trailer-only message instead of aborting); for a
//   template (git aborts an unedited one); for a comment-only message; and in a
//   rebase or cherry-pick replaying commits that keep their own trailers.
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
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { GIT_TIMEOUTS } from "./rev";

export const SESSION_HOOK_NAME = "prepare-commit-msg";
export const SESSION_HOOK_MARKER = "# workit-session-trailer-hook";
/** The helper under the git common dir that holds the trailer logic. */
const HELPER = ["workit", "session-trailer.sh"] as const;
/** Left by an unreleased build that chained commit-msg; reported, never used. */
const LEGACY_CHAINED = "commit-msg.workit-chained";

// LF only: Git for Windows runs hooks with its own sh, which reads LF scripts.
export const SESSION_TRAILER_SCRIPT = `#!/bin/sh
# Workit (https://github.com/BrainerVirus/workit) wrote this file with
# \`workit doctor --fix\`. A prepare-commit-msg hook runs it with its own
# arguments to add a Workit-Session trailer to commits made in an agent session.
# Not a hook itself; delete it together with the line that runs it.
# lefthook passes a missing argument as its literal placeholder.
case "\${2-}" in "" | "{2}" | template) exit 0 ;; esac
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

/**
 * The line that runs the helper from a prepare-commit-msg hook. `args` are the
 * hook's own arguments (`"$@"` in a shell hook, `{1} {2} {3}` in lefthook).
 * Hooks run at the top of the work tree, where the relative common dir resolves.
 * A clone without the helper (a teammate who never ran `--fix`, while the
 * line sits in a committed husky hook) runs nothing and prints nothing.
 */
export const manualTrailerLine = (args = '"$@"'): string =>
  `h="$(git rev-parse --git-common-dir 2>/dev/null)/${HELPER.join("/")}"; [ ! -f "$h" ] || sh "$h" ${args} || true`;

/** What marks a hook or config that already runs the helper. */
const HELPER_REF = HELPER.join("/");

export const SESSION_HOOK_SCRIPT = `#!/bin/sh
${SESSION_HOOK_MARKER} v4
# Workit (https://github.com/BrainerVirus/workit) installed this hook with
# \`workit doctor --fix\`: it runs Workit's session-trailer helper, which adds a
# Workit-Session trailer to commits made in an agent session. To remove it,
# delete this file.
${manualTrailerLine()}
`;

export type SessionHookState =
  /** Not inside a git work tree, or git is unavailable. */
  | "not_git"
  /** The current Workit hook and helper are installed. */
  | "installed"
  /** An older Workit hook, or a missing or older helper; --fix rewrites them. */
  | "outdated"
  /** The slot is empty; --fix installs the hook. */
  | "missing"
  /** --fix will not write the hook; `reason` says why and `manual` what to do instead. */
  | "blocked"
  /** Another tool's hook or config already runs the helper (`via`, `manualTarget`). */
  | "manual";

/** Who owns the slot when it is blocked by another hook. */
export type HookOwner = "husky" | "lefthook" | "other";

export type SessionHookStatus = {
  state: SessionHookState;
  hooksDir: string | null;
  hookPath: string | null;
  /** The helper the hook and the manual line run. */
  helperPath: string | null;
  /** Whether the helper on disk is the current script. */
  helperCurrent: boolean;
  owner?: HookOwner;
  reason?: string;
  /** The manual fix when --fix cannot install the hook. */
  manual?: string;
  /** Where the manual line goes (or already is): a husky script, a lefthook config, a hook. */
  manualTarget?: string;
  /** For `manual`: who runs the helper. */
  via?: "husky" | "lefthook" | "existing hook";
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

// Whether a hook, script or config really runs the helper, not just mentions
// it. Shell text: a non-comment line invoking it, either directly
// (`sh …/workit/session-trailer.sh`) or as `sh "$h"` after an `h=` line
// naming it. Control flow (an `exit` before the line, an `if false`) is out
// of scope: this reads lines, it does not run them.
const isComment = (line: string) => /^\s*#/.test(line);
const DIRECT_CALL = new RegExp(
  String.raw`\bsh\s+(?:"[^"]*|\S*)${HELPER_REF.replaceAll(".", String.raw`\.`)}`,
);
const runsHelperText = (text: string): boolean => {
  const lines = text.split(/\r?\n/).filter((line) => !isComment(line));
  const assigned = lines.some((line) => /(?:^|[\s;])h=/.test(line) && line.includes(HELPER_REF));
  return lines.some((line) => DIRECT_CALL.test(line) || (assigned && /\bsh\s+"\$h"/.test(line)));
};

const LEFTHOOK_YAML = [
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
  "lefthook-local.yml",
  "lefthook-local.yaml",
  ".lefthook-local.yml",
  ".lefthook-local.yaml",
];
const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * A small indentation-aware read of a lefthook YAML config (no YAML library
 * in deps): a `run:` value under the top-level `prepare-commit-msg:` key, on
 * a non-comment line (or its `|`/`>` block), that runs the helper.
 * lefthook.json/.toml are not read, so they never count as manual.
 */
const lefthookRunsHelper = (text: string): boolean => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^prepare-commit-msg:\s*(?:#.*)?$/.test(line));
  if (start < 0) return false;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !isComment(line) && indentOf(line) === 0) break;
    block.push(line);
  }
  return block.some((line, i) => {
    if (isComment(line)) return false;
    const runKey = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!runKey) return false;
    let value = runKey[2] ?? "";
    if (/^[|>][-+]?\s*$/.test(value)) {
      const body: string[] = [];
      for (const next of block.slice(i + 1)) {
        if (next.trim() && indentOf(next) <= indentOf(line)) break;
        body.push(next);
      }
      value = body.join("\n");
    }
    return runsHelperText(value);
  });
};

const isExecutable = (file: string): boolean => {
  if (process.platform === "win32") return true;
  try {
    return (statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/** Whether the manual line is really in place for this owner. */
const manualInPlace = (input: ManualInput, target: string): boolean => {
  if (input.owner === "lefthook")
    return LEFTHOOK_YAML.some((name) => {
      const text = readText(path.join(input.top, name));
      return text !== null && lefthookRunsHelper(text);
    });
  const text = readText(target);
  if (text === null || !runsHelperText(text)) return false;
  // husky v9's `h` runs the user script with `sh -e`, so it needs no +x; any
  // other target is a hook git runs itself, which git skips unless executable.
  return (input.owner === "husky" && target !== input.hookPath) || isExecutable(target);
};

/** husky v9 stubs source `h` beside them; v4-v8 hooks source `_/husky.sh`. */
const isHuskyV9 = (text: string, hooksDir: string): boolean =>
  /\$\(dirname (?:-- )?"\$0"\)\/h"/.test(text) && existsSync(path.join(hooksDir, "h"));

const ownerOf = (text: string, hooksDir: string, top: string): HookOwner => {
  if (text.includes("husky.sh") || isHuskyV9(text, hooksDir)) return "husky";
  if (/lefthook/i.test(text) || lefthookConfig(top)) return "lefthook";
  return "other";
};

type ManualInput = {
  owner: HookOwner;
  text: string;
  hooksDir: string;
  hookPath: string;
  top: string;
  /** Workit's earlier hook, moved aside by lefthook. */
  displaced: string | null;
};

/** The file the manual line goes in for this owner. */
const manualTargetOf = ({ owner, text, hooksDir, hookPath, top }: ManualInput): string => {
  // husky v9 points core.hooksPath at `.husky/_` and runs `.husky/<hook>`
  // from the stub; husky v4-v8 hooks are the user's files themselves.
  if (owner === "husky" && isHuskyV9(text, hooksDir))
    return path.join(path.dirname(hooksDir), SESSION_HOOK_NAME);
  if (owner === "lefthook") return lefthookConfig(top) ?? path.join(top, "lefthook.yml");
  return hookPath;
};

const manualFor = (input: ManualInput): string => {
  const { owner, displaced } = input;
  const target = manualTargetOf(input);
  const stale = displaced ? `; delete the stale ${displaced} (nothing runs it)` : "";
  if (owner === "husky")
    return `add this line to ${target} (create it if missing; husky runs it)${stale}: ${manualTrailerLine()}`;
  if (owner === "lefthook")
    return [
      `merge this job into ${target} (add it to an existing \`${SESSION_HOOK_NAME}:\` \`jobs:\` list rather than a second \`${SESSION_HOOK_NAME}:\` key), then run \`lefthook install\`${stale}:`,
      `${SESSION_HOOK_NAME}:`,
      "  jobs:",
      "    - name: workit-session",
      `      run: ${manualTrailerLine("{1} {2} {3}")}`,
    ].join("\n");
  return `add this line to ${target} (a new file needs \`#!/bin/sh\` as its first line and \`chmod +x\`)${stale}: ${manualTrailerLine()}`;
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
  const none = { hooksDir: null, hookPath: null, helperPath: null, helperCurrent: false };
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
  const helperPath = path.join(commonDir, ...HELPER);
  const helperCurrent = readText(helperPath) === SESSION_TRAILER_SCRIPT;
  const leftover = leftoverOf(hooksDir);
  const base = { hooksDir, hookPath, helperPath, helperCurrent, ...(leftover ? { leftover } : {}) };
  const blocked = (reason: string, owner: HookOwner, text = ""): SessionHookStatus => {
    const old = `${hookPath}.old`;
    const displaced = readText(old)?.includes(SESSION_HOOK_MARKER) ? old : null;
    const input = { owner, text, hooksDir, hookPath, top: top.out, displaced };
    const manualTarget = manualTargetOf(input);
    const owned = text ? { owner } : {};
    // The user already added the line where it belongs.
    if (manualInPlace(input, manualTarget))
      return {
        state: "manual",
        ...base,
        ...owned,
        manualTarget,
        via: owner === "other" ? "existing hook" : owner,
      };
    return {
      state: "blocked",
      ...base,
      ...owned,
      reason: displaced ? `${reason} (Workit's earlier hook was moved to ${old})` : reason,
      manual: manualFor(input),
      manualTarget,
    };
  };
  if (!inside(hooksDir, commonDir) && !inside(hooksDir, top.out))
    return blocked(
      `core.hooksPath ${hooksDir} is outside the repository; a hook there runs in every repository that uses it`,
      "other",
    );
  const text = exists(hookPath) ? (readText(hookPath) ?? "") : null;
  if (text !== null) {
    if (text === SESSION_HOOK_SCRIPT)
      return { state: helperCurrent ? "installed" : "outdated", ...base };
    if (text.includes(SESSION_HOOK_MARKER)) return { state: "outdated", ...base };
    const owner = ownerOf(text, hooksDir, top.out);
    return blocked(
      `${hookPath} belongs to ${owner === "other" ? "another hook" : owner}; Workit never replaces it`,
      owner,
      text,
    );
  }
  if (!inside(hooksDir, commonDir)) {
    // A hooks directory in the working tree (a committed .githooks): a new
    // file there must be ignored, or it shows up in git status.
    const rel = path.relative(top.out, hookPath).split(path.sep).join("/");
    if (!run(top.out, ["check-ignore", "-q", "--", rel], env).ok)
      return blocked(
        `${hooksDir} is in the working tree and not ignored; the hook would show up as a new file`,
        "other",
      );
  }
  return { state: "missing", ...base };
}

/**
 * Write `content` through a staged file renamed into place. The finally only
 * matters when the write or chmod throws after the staged file exists; a
 * rename failure cannot be provoked through inspect (an unreadable or
 * directory slot is reported blocked first), so that path is not tested.
 */
const writeExecutable = (file: string, content: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const staged = `${file}.workit-new`;
  try {
    writeFileSync(staged, content, { mode: 0o755 });
    chmodSync(staged, 0o755);
    renameSync(staged, file);
  } finally {
    rmSync(staged, { force: true });
  }
};

export type SessionHookInstall = {
  /** What --fix did to the hook slot: wrote the hook, rewrote an older one, or nothing. */
  action: "installed" | "updated" | "unchanged" | "skipped";
  /** Whether the helper was (re)written. */
  helperWritten: boolean;
  status: SessionHookStatus;
  detail: string;
};

/**
 * Install (or refresh) the helper and the hook for the repository at `cwd`.
 * The caller decides that `cwd` is a Workit workspace. The helper is written
 * even when the slot is blocked, so the manual line works; the slot is written
 * only when empty or holding Workit's own hook.
 */
export function installSessionHook(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionHookInstall {
  const status = inspectSessionHook(cwd, env);
  if (status.state === "not_git")
    return {
      action: "skipped",
      helperWritten: false,
      status,
      detail: "not inside a git work tree",
    };
  const helperWritten = !status.helperCurrent;
  if (helperWritten) writeExecutable(status.helperPath!, SESSION_TRAILER_SCRIPT);
  const helper = helperWritten ? `; wrote ${status.helperPath}` : "";
  if (status.state === "installed")
    return {
      action: "unchanged",
      helperWritten,
      status,
      detail: `hook already at ${status.hookPath}`,
    };
  if (status.state === "manual")
    return {
      action: "unchanged",
      helperWritten,
      status: inspectSessionHook(cwd, env),
      detail: `${status.manualTarget} already runs the helper (via ${status.via})${helper}`,
    };
  if (status.state === "blocked")
    return {
      action: "skipped",
      helperWritten,
      status: inspectSessionHook(cwd, env),
      detail: `${status.reason}${helper}`,
    };
  const fresh = status.state === "missing";
  const slotCurrent = readText(status.hookPath!) === SESSION_HOOK_SCRIPT;
  if (!slotCurrent) writeExecutable(status.hookPath!, SESSION_HOOK_SCRIPT);
  const verb = fresh ? "installed" : "updated";
  return {
    action: verb,
    helperWritten,
    status: inspectSessionHook(cwd, env),
    detail: `${verb} the Workit ${SESSION_HOOK_NAME} hook at ${status.hookPath}${helper}`,
  };
}
