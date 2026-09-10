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

// Bare write verbs matched anywhere in the argv stream (case-sensitive).
// `install` covers every package manager uniformly — npm, pip, cargo, go,
// dotnet, gem, composer and future ones all spell it the same way, so no
// per-manager list can go stale: the package names become scope values and
// ownership decides, exactly like any other operand.
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

// Destructive git subcommands. `checkout` is deliberately absent: branch
// switches rewrite the tree but are routine agent workflow, and paths vs
// branches are indistinguishable lexically — flagging it would deny everyday
// `git checkout main`. `clean`/`restore` have no such routine use.
const GIT_WRITE_SUBCOMMANDS = new Set(["apply", "mv", "rm", "clean", "restore"]);

// Managers whose write verb is not `install` (those are covered generically
// above). Deliberately small: `git add`/`checkout` stay out because staging
// and branch switches are routine agent workflow, not smuggled writes.
const ADD_STYLE_MANAGERS: Record<string, string[]> = {
  dotnet: ["add"],
  composer: ["require"],
  poetry: ["add"],
  cargo: ["add"],
  go: ["get"],
  npm: ["ci", "update"],
  yarn: ["upgrade"],
  pnpm: ["upgrade"],
  bun: ["update"],
};

// Dry-run probes never write, even for destructive subcommands.
const DRY_RUN_RE = /^(?:-n|--dry-run)$/;

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
    if (rest.some((token) => DRY_RUN_RE.test(token))) return none;
    if (unparseable(command)) return { intent: true, invalid: true, values: [] };
    const values = rest.slice(1).filter((token) => !token.startsWith("-"));
    if (values.length === 0) return { intent: true, invalid: true, values: [] };
    return { intent: true, invalid: false, values };
  }
  const addVerbs = ADD_STYLE_MANAGERS[head];
  if (addVerbs !== undefined && addVerbs.includes(basename(rest[0] ?? ""))) {
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
