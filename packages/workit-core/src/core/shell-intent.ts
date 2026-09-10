// Shared shell write-intent parser for the Cursor/Codex hooks (parity: one
// implementation, both adapters). Fail-closed where the shell cannot be
// attributed: redirects, quotes, chains, globs and unparseable shapes deny
// (invalid) instead of guessing. Operands are returned raw; each hook maps
// them through its own root containment.
export type ShellIntent = {
  /** The command can write (redirect or a write-shaped command). */
  intent: boolean;
  /** The shape cannot be attributed — deny without interpreting operands. */
  invalid: boolean;
  /** Raw operand candidates (flags excluded); empty unless intent. */
  values: string[];
};

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// First-token write commands (argv[0] basename, lowercase). Package-manager
// installs are included deliberately: install scripts execute arbitrary code,
// so `pip install <pkg>` must not sail through as a bare word — the package
// name becomes the scope value and ownership decides, exactly like any other
// operand.
const WRITE_COMMANDS = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "install",
  "tee",
  "ln",
  "unlink",
  "rmdir",
  "truncate",
  "dd",
  "apply",
]);

const GIT_WRITE_SUBCOMMANDS = new Set(["apply", "mv", "rm"]);

// Package-manager installs execute lifecycle scripts, so they write even
// though no argv token is a path: the package names become scope values.
const PACKAGE_MANAGERS = new Set(["npm", "pip", "pip3", "bun", "yarn", "pnpm"]);

const REDIRECT_RE = /(?:\d*>>?|&>)/;
const REDIRECT_TARGET_RE = /(?:\d*>>?|&>)\s*([^\s]+)/g;
// Characters that make token attribution fiction: quoting, expansion,
// globs, chains, pipes, subshells, newlines. A bare `&` is unparseable
// unless it is the `&>` redirect operator.
const UNPARSEABLE_RE = /['"`$*?()\\\n|;]/;
const unparseable = (command: string): boolean =>
  UNPARSEABLE_RE.test(command) || /&(?!>)/.test(command);

const basename = (token: string): string => {
  const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  return token.slice(slash + 1).toLowerCase();
};

export function shellWriteIntent(command: string): ShellIntent {
  const none = { intent: false, invalid: false, values: [] as string[] };
  if (!command.trim()) return none;
  const redirect = REDIRECT_RE.test(command);
  const tokens = command.trim().split(/\s+/);
  // Skip leading VAR= assignments (`FOO=1 rm x` still writes).
  let index = 0;
  while (index < tokens.length && ASSIGN_RE.test(tokens[index])) index += 1;
  const head = basename(tokens[index] ?? "");
  const rest = tokens.slice(index + 1);

  if (redirect || tokens.slice(index).some((token) => WRITE_COMMANDS.has(token))) {
    if (unparseable(command)) return { intent: true, invalid: true, values: [] };
    const values: string[] = [];
    if (redirect) {
      for (const match of command.matchAll(REDIRECT_TARGET_RE)) {
        const value = match[1];
        if (!value || value.startsWith("-") || value.startsWith("&"))
          return { intent: true, invalid: true, values: [] };
        values.push(value);
      }
    }
    // First verb token anywhere anchors the operand scan (mirrors the legacy
    // per-hook scanners so `2>err rm x` keeps both targets). Matching is
    // case-sensitive: `RM` never wrote anything through these hooks.
    const verbAt = tokens.findIndex((token, i) => i >= index && WRITE_COMMANDS.has(token));
    if (verbAt >= 0)
      values.push(...tokens.slice(verbAt + 1).filter((token) => !token.startsWith("-")));
    if (values.length === 0) return { intent: true, invalid: true, values: [] };
    return { intent: true, invalid: false, values };
  }
  if (head === "git" && GIT_WRITE_SUBCOMMANDS.has(basename(rest[0] ?? ""))) {
    if (unparseable(command)) return { intent: true, invalid: true, values: [] };
    const values = rest.slice(1).filter((token) => !token.startsWith("-"));
    if (values.length === 0) return { intent: true, invalid: true, values: [] };
    return { intent: true, invalid: false, values };
  }
  if (PACKAGE_MANAGERS.has(head) && basename(rest[0] ?? "") === "install") {
    if (unparseable(command)) return { intent: true, invalid: true, values: [] };
    const values = rest.slice(1).filter((token) => !token.startsWith("-"));
    if (values.length === 0) return { intent: true, invalid: true, values: [] };
    return { intent: true, invalid: false, values };
  }
  if (head === "sed" && rest.some((token) => /^-[a-zA-Z]*i/i.test(token))) {
    if (unparseable(command)) return { intent: true, invalid: true, values: [] };
    // Expression and file are indistinguishable lexically; include every
    // non-flag operand so the ownership check can only narrow, never widen.
    const values = rest.filter((token) => !token.startsWith("-"));
    if (values.length === 0) return { intent: true, invalid: true, values: [] };
    return { intent: true, invalid: false, values };
  }
  return none;
}
