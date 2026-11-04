// Every Workit location comes from core/workit-paths.mjs (docs/agents/file-locations.md).
// This fails when non-test code under packages/ reaches for the raw ingredients
// of one (homedir(), an XDG_* variable, APPDATA, LOCALAPPDATA, Library/Application
// Support or a literal ~/.local/{state,share}/workit) outside the resolver, its
// byte-equal copies and the shell functions it exports. Each other use is
// allowlisted below with the reason it is not a Workit location; an entry that no
// longer matches anything fails too, so the list cannot rot.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CONFIG_DIR_SH,
  DATA_DIR_SH,
  STATE_DIR_SH,
} from "@/packages/workit-core/src/core/workit-paths.mjs";

const REPO = path.resolve(import.meta.dir, "../..");

const INGREDIENT =
  /\bhomedir\(\)|\bXDG_[A-Z]+_(?:HOME|DIR)\b|\b(?:LOCAL)?APPDATA\b|Application Support|\.local[/\\](?:state|share)[/\\]workit|\.cache[/\\]workit\b|"\.local",\s*"(?:state|share)",\s*"workit"/;

const NODE_RESOLVE_COPIES = [
  "packages/workit-core/src/core/node-resolve.mjs",
  "packages/workit-claude-code/bin/node-resolve.mjs",
  "packages/workit-codex/bin/node-resolve.mjs",
  "packages/workit-cursor/hooks/node-resolve.mjs",
];

type Allow = { file: string | string[]; match: string; why: string };

const NODE_SCAN =
  "Node version-manager discovery (fnm, nvm, volta, mise, asdf), not a Workit location";
const HOST_HOME =
  "the home that host config files (~/.claude, ~/.codex, ~/.cursor, ~/.pi) hang off";
const SANDBOX = "a throwaway sandbox env handed to a child probe";

const ALLOW: Allow[] = [
  ...["os.homedir()", "APPDATA", "XDG_DATA_HOME", "Application Support"].map((match) => ({
    file: NODE_RESOLVE_COPIES,
    match,
    why: NODE_SCAN,
  })),
  {
    file: "packages/workit-claude-code/bin/workit",
    match: "Application Support/fnm",
    why: NODE_SCAN,
  },
  { file: "packages/workit-cli/src/install/launcher.ts", match: "/fnm", why: NODE_SCAN },
  ...[
    "packages/workit-cli/src/admin/detect-hosts.ts",
    "packages/workit-cli/src/admin/doctor.ts",
    "packages/workit-cli/src/admin/host-install.ts",
    "packages/workit-cli/src/admin/host-permissions.ts",
    "packages/workit-cli/src/admin/setup.ts",
    "packages/workit-cli/src/admin/uninstall.ts",
    "packages/workit-cli/src/upgrade/shared.ts",
  ].map((file) => ({ file, match: "HOME ?? os.homedir()", why: HOST_HOME })),
  {
    file: "packages/workit-cli/src/admin/doctor.ts",
    match: '"opencode"',
    why: "OpenCode's config",
  },
  { file: "packages/workit-cli/src/admin/doctor.ts", match: ".bun/bin/bun", why: "the bun binary" },
  { file: "packages/workit-cli/src/admin/doctor.ts", match: "path.join(scratch", why: SANDBOX },
  { file: "packages/workit-cli/src/upgrade/probes.ts", match: "path.join(scratch", why: SANDBOX },
  {
    file: "packages/workit-cli/src/admin/host-install.ts",
    match: '"opencode"',
    why: "OpenCode's package cache",
  },
  {
    file: "packages/workit-cli/src/admin/host-install.ts",
    match: "env.LOCALAPPDATA ?? pathApi",
    why: "host app install dirs on Windows",
  },
  {
    file: "packages/workit-cli/src/admin/host-install.ts",
    match: "env.XDG_CONFIG_HOME = context.env",
    why: "the child env a host CLI runs with (OpenCode reads its own config there)",
  },
  {
    file: "packages/workit-cli/src/upgrade/shared.ts",
    match: '"XDG_',
    why: "the variables an explicit home clears from the child env",
  },
  {
    file: "packages/workit-cli/src/upgrade/shared.ts",
    match: "XDG_CONFIG_HOME",
    why: "OpenCode's config and the host child env; Workit's own config comes from configDir",
  },
  {
    file: [
      "packages/workit-cli/src/verbs/models.ts",
      "packages/workit-core/src/hooks/model-limit.ts",
    ],
    match: 'os.homedir(), ".claude"',
    why: "Claude Code's config dir",
  },
  {
    file: "packages/workit-codex/scripts/agents.ts",
    match: 'os.homedir(), ".codex"',
    why: "Codex's home",
  },
  {
    file: [
      "packages/workit-core/scripts/install-codex-plugin.sh",
      "packages/workit-core/scripts/install-cursor-plugin.sh",
      "packages/workit-core/scripts/install-opencode-plugin.sh",
      "packages/workit-core/scripts/install-pi-package.sh",
    ],
    match: 'SHARE="${HOME}/.local/share/workit"',
    why: "dev share-clone installers; install-cursor-plugin.sh also runs piped without lib/ (follow-up: source lib/config-dir.sh)",
  },
  {
    file: "packages/workit-core/scripts/sync-runtime.sh",
    match: "XDG_RUNTIME_DIR",
    why: "the dev sync script's flock file (follow-up: a runtime dir in lib/config-dir.sh)",
  },
  {
    file: ["packages/workit-core/src/autonomy.ts", "packages/workit-core/src/core/remotes.ts"],
    match: "return os.homedir();",
    why: "the account home fallback (grants D15, ssh_config); the grants dir itself comes from configDir",
  },
  {
    file: "packages/workit-core/src/autonomy.ts",
    match: "WORKIT_CONFIG_DIR or XDG_CONFIG_HOME",
    why: "a message naming the overrides",
  },
  {
    file: "packages/workit-core/src/core/cleanup.ts",
    match: "XDG_CACHE_HOME",
    why: "managed worktrees in ~/.cache/workit-wt, beside the cache dir; moving them is part 2 of W2.25",
  },
  {
    file: "packages/workit-core/src/core/cli-locate.ts",
    match: "XDG_BIN_HOME",
    why: "the user's bin dir on PATH, where the workit link goes",
  },
  {
    file: "packages/workit-core/src/core/heavy-rules.ts",
    match: "os.homedir()",
    why: "host settings files",
  },
  {
    file: "packages/workit-core/src/core/heavy-rules.ts",
    match: "Application Support/ClaudeCode",
    why: "Claude Code's managed settings",
  },
  {
    file: "packages/workit-core/src/core/heavy-rules.ts",
    match: "XDG_CONFIG_HOME",
    why: "OpenCode's config",
  },
  {
    file: "packages/workit-core/src/core/heavy-scope.ts",
    match: "XDG_RUNTIME_DIR",
    why: "the systemd user manager's runtime dir",
  },
  {
    file: "packages/workit-core/src/core/logger.ts",
    match: "escapeRegExp(os.homedir())",
    why: "redacting the home from log lines",
  },
  {
    file: "packages/workit-core/src/forge/resolve.ts",
    match: "env.XDG_CONFIG_HOME",
    why: "gh and glab config identity in a cache key",
  },
  { file: "packages/workit-core/src/git/rev.ts", match: "os.homedir()", why: "~/.ssh/config" },
  {
    file: [
      "packages/workit-core/src/hooks/raw-git.ts",
      "packages/workit-core/src/hooks/write-gate.ts",
    ],
    match: "os.homedir()",
    why: "`~` and bare `cd` in a shell command",
  },
];

const SCANNED = /\.(?:ts|tsx|mjs|cjs|js|sh)$/;
const isTest = (file: string) => /(?:^|\/)(?:test|tests|__tests__)\/|\.test\.[a-z]+$/.test(file);

const scannedFiles = (): string[] => {
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "packages"],
    { cwd: REPO, encoding: "utf8" },
  ).stdout;
  return [...new Set(listed.split("\n").filter(Boolean))].filter(
    (file) =>
      !/\/(?:node_modules|dist)\//.test(file) &&
      !isTest(file) &&
      path.basename(file) !== "workit-paths.mjs" &&
      (SCANNED.test(file) || /\/bin\/[^/.]+$/.test(file)),
  );
};

/** The file's text with the resolver's shell functions blanked (same line count). */
const withoutResolverShell = (text: string) =>
  [STATE_DIR_SH, CONFIG_DIR_SH, DATA_DIR_SH].reduce(
    (body, fn) => body.split(fn).join(fn.replace(/[^\n]/g, "")),
    text,
  );

const COMMENT = /^\s*(?:\/\/|\/\*|\*|#)/;

test("no code under packages/ builds a Workit location outside core/workit-paths.mjs", () => {
  const used = new Set<Allow>();
  const offenders: string[] = [];
  for (const file of scannedFiles()) {
    let text: string;
    try {
      text = readFileSync(path.join(REPO, file), "utf8");
    } catch {
      continue;
    }
    withoutResolverShell(text)
      .split("\n")
      .forEach((line, index) => {
        if (COMMENT.test(line) || !INGREDIENT.test(line)) return;
        const allowed = ALLOW.find(
          (entry) => [entry.file].flat().includes(file) && line.includes(entry.match),
        );
        if (allowed) used.add(allowed);
        else offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
  }
  expect(
    offenders,
    "build these from core/workit-paths.mjs, or allowlist them with a reason",
  ).toEqual([]);
  const stale = ALLOW.filter((entry) => !used.has(entry)).map((entry) => entry.match);
  expect(stale, "allowlist entries that no longer match any line").toEqual([]);
});

test("the lint catches a Workit path built from homedir() or an XDG variable", () => {
  for (const line of [
    'const dir = path.join(os.homedir(), ".config", "workit");',
    'const dir = path.join(env.XDG_STATE_HOME, "workit");',
    'const dir = path.join(env.LOCALAPPDATA, "workit");',
    'const dir = path.join(home, "Library", "Application Support", "workit");',
    'state="$HOME/.local/state/workit"',
  ])
    expect(INGREDIENT.test(line), line).toBe(true);
  expect(INGREDIENT.test("const dir = stateDir(env);")).toBe(false);
});
