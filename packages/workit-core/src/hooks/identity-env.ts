// A shell command that changes the variables Workit reads its acting identity
// from (#883). On Claude Code and Codex the host sets them (SessionStart's
// WORKIT_HOST and WORKIT_SESSION_ID, the agent stamp's WORKIT_AGENT_ID): an
// agent that sets, unsets or empties one (`NAME=…`, `env -u NAME`, `env -i`,
// `export`, `unset`, `declare -x`, PowerShell `$env:NAME`) could make the CLI
// read another actor, or no host at all, and take a forged agent id. Words,
// not text, so a `grep WORKIT_HOST` or a quoted mention passes.
import { shellScript } from "./delivery-verbs";
import { segmentsOf, type ShellDialect } from "./shell-words";

const NAMES = "WORKIT_(?:AGENT_ID|HOST|SESSION_ID|SESSION_TOKEN)";
const IDENTITY = new RegExp(`^${NAMES}$`, "u");
const POWERSHELL = new RegExp(
  `\\$env:${NAMES}\\b|env:[\\\\/]?${NAMES}\\b|EnvironmentVariable\\(\\s*['"]${NAMES}\\b`,
  "iu",
);
/** Builtins that export, unset or declare the names after them. */
const DECLARES = new Set(["export", "unset", "declare", "typeset", "local", "readonly"]);
const base = (word: string | undefined): string => word?.split(/[\\/]/u).at(-1) ?? "";
const named = (word: string | undefined): boolean => IDENTITY.test(word?.split("=")[0] ?? "");

/** What `env`'s arguments from `at` change: a cleared environment or an identity name. */
const envChange = (words: readonly string[], at: number): string | null => {
  for (let index = at; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-u" || word === "--unset") {
      if (named(words[index + 1])) return words[index + 1];
      index += 1;
    } else if (/^(?:-u|--unset=)./u.test(word)) {
      if (named(word.replace(/^(?:-u|--unset=)/u, ""))) return word;
    } else if (word === "-" || word === "--ignore-environment" || /^-[a-z]*i/u.test(word))
      return "env -i";
    else if (word.includes("=") && !word.startsWith("-")) {
      if (named(word)) return word.split("=")[0];
    } else if (!word.startsWith("-")) return null;
  }
  return null;
};

/** The identity variable `command` changes (or `env -i`), or null. */
export const identityEnvChange = (
  command: string,
  dialect: ShellDialect = "posix",
  depth = 0,
  runsWorkit = command.includes("workit"),
): string | null => {
  if (!/WORKIT_|\benv\b/u.test(command)) return null;
  if (dialect === "powershell") return POWERSHELL.exec(command)?.[0] ?? null;
  let segments;
  try {
    segments = segmentsOf(command, dialect);
  } catch {
    return null;
  }
  for (const { words } of segments) {
    let at = 0;
    while (/^[A-Za-z_]\w*=/u.test(words[at] ?? "")) {
      if (named(words[at])) return words[at].split("=")[0];
      at += 1;
    }
    if (["builtin", "command"].includes(words[at] ?? "")) at += 1;
    if (DECLARES.has(words[at] ?? "")) {
      const hit = words.slice(at + 1).find(named);
      if (hit) return hit.split("=")[0];
    }
    for (let index = at; index < words.length; index += 1)
      if (base(words[index]) === "env") {
        const hit = envChange(words, index + 1);
        // A cleared environment matters only to a workit call it runs (`env -i ls` reads).
        if (hit && (hit !== "env -i" || runsWorkit)) return hit;
      }
    const script = depth < 4 ? shellScript(words) : null;
    const nested = script ? identityEnvChange(script, dialect, depth + 1, runsWorkit) : null;
    if (nested) return nested;
  }
  return null;
};

export const identityEnvDeny = (change: string): string =>
  `workit identity: this command changes ${change}. The host sets WORKIT_HOST, WORKIT_SESSION_ID and WORKIT_AGENT_ID, and Workit acts as who they name; run it without changing them (a verifier or reviewer passes the --session and --token its start text names).`;
