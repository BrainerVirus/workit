// `workit feedback "<title>" --body-file <f|->` (#777): drafts a report of
// Workit friction for the Workit tracker (the CLI package's bugs URL) from any
// workspace. The draft carries the Workit version, host, the failing verb and
// its exit text, and is redacted by default: remote URLs, absolute paths, the
// branch, ticket IDs and the workspace's org, repo and workspace names are
// replaced (--include-workspace keeps them; secrets are always masked). It
// searches the tracker's open issues for a duplicate and offers `--comment <n>`.
// Nothing is posted without --post, which the hosts ask the user about
// (host-permissions.ts), and --post takes the GitHub login from --account or
// `feedback.account` in workspaces.json, never the workspace's work account
// by default. A draft that is not posted is saved under `workit dir retros`.
// A workspace with `feedback: "off"` makes the verb refuse.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { systemRunner, type ForgeRunner } from "@workit-dev/core/src/forge/exec";
import type { ForgeResult } from "@workit-dev/core/src/forge/types";
import { githubIssues } from "@workit-dev/core/src/forge/issue-forge";
import { redactText } from "@workit-dev/core/src/forge/redact";
import { accountHome } from "@workit-dev/core/src/core/account-home";
import { repoDir } from "@workit-dev/core/src/core/repo-paths";
import { workspaceFeedback } from "@workit-dev/core/src/core/workspaces";
import pkg from "../../package.json" with { type: "json" };
import { emit, fail, ok, type Io } from "../output";
import { forgeDeps, parseFlags, usage } from "./forge-common";

const USAGE =
  'workit feedback "<title>" --body-file <f|-> [--verb "<workit …>"] [--exit-file <f|->] [--include-workspace] [--post [--account <login>] [--comment <n>]]';

/** The block the verb appends once; a saved draft passed back keeps it as is. */
const FACTS_MARK = "<!-- workit feedback -->";
const API_HOST = "github.com";

type ForgeCode = Extract<ForgeResult<unknown>, { ok: false }>["code"];
const TIMEOUT_MS = 20_000;

/** `owner/name` of the tracker named by the CLI package's bugs URL. */
export const trackerRepo = (bugs: string = pkg.bugs.url): string => {
  const match = /github\.com\/([^/\s]+\/[^/\s]+?)(?:\/issues)?\/?$/u.exec(bugs);
  if (!match) throw new Error(`the CLI package's bugs URL is not a GitHub repo: ${bugs}`);
  return match[1];
};

/** The agent host this shell runs under, from its environment markers. */
export const hostOf = (env: NodeJS.ProcessEnv): string => {
  const keys = Object.keys(env).filter((key) => env[key] !== undefined);
  const has = (test: (key: string) => boolean) => keys.some(test);
  if (has((key) => key === "CLAUDECODE" || key === "CLAUDE_CODE_ENTRYPOINT")) return "claude-code";
  if (has((key) => key.startsWith("CODEX_") && key !== "CODEX_HOME")) return "codex";
  if (has((key) => key.startsWith("OPENCODE"))) return "opencode";
  if (has((key) => key.startsWith("CURSOR_"))) return "cursor";
  if (has((key) => key.startsWith("PI_") && key !== "PI_CODING_AGENT_DIR")) return "pi";
  return "terminal";
};

/** What the workspace would leak into a draft: names, branch, remote URLs, its home. */
export type WorkspaceFacts = {
  names: string[];
  branch: string | null;
  home: string;
};

const gitLine = (cwd: string, args: string[]): string => {
  const done = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  return done.status === 0 ? (done.stdout ?? "") : "";
};

/** The org and repo names of every remote, the current branch and the workspace's name. */
export function workspaceFacts(
  cwd: string,
  workspace: string | null,
  tracker: string,
): WorkspaceFacts {
  const own = new Set(tracker.toLowerCase().split("/"));
  const names = new Set<string>();
  for (const line of gitLine(cwd, ["remote", "-v"]).split(/\r?\n/u)) {
    const url = line.split(/\s+/u)[1];
    const parts = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(url ?? "");
    for (const name of parts ? [parts[1], parts[2]] : [])
      if (name.length > 2 && !own.has(name.toLowerCase())) names.add(name);
  }
  if (workspace && workspace.length > 2) names.add(workspace);
  const branch = gitLine(cwd, ["branch", "--show-current"]).trim() || null;
  return {
    names: [...names],
    branch: branch && !/^(?:main|master|develop|trunk)$/u.test(branch) ? branch : null,
    home: accountHome() ?? "",
  };
}

const escape = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** Spellings that look like ticket IDs but are not (UTF-8, SHA-256, ISO-8601, ES-2022). */
const NOT_TICKETS = /^(?:utf|sha|iso|rfc|http|https|tls|ssl|es|ecma|ipv|node|bun|win|x)-/iu;

/** Endings that make `name.ext` a file, not a host. */
const FILE_EXTENSIONS = new Set(
  "ts tsx mts cts js jsx mjs cjs json jsonc md mdx txt log lock yml yaml toml sh zsh bash ps1 py rb go rs java kt c h cpp css scss html xml svg png jpg gif env ini cfg conf d map snap test spec".split(
    " ",
  ),
);
/** Endings that make a one-dot `name.tld` a host. */
const HOST_TLDS = new Set(
  "com net org io dev app ai co cloud local internal corp lan intra home test example invalid int edu gov biz info me us uk de cl es fr eu ca au in jp cn br mx ar nl se ch it pl".split(
    " ",
  ),
);
/** Public hosts a Workit report may name. */
const PUBLIC_HOSTS = new Set(["github.com", "www.github.com"]);

/** A dotted name that is a host (not a file, a version or the public forge). */
const isHost = (name: string): boolean => {
  const labels = name.toLowerCase().split(".");
  const last = labels.at(-1) ?? "";
  if (PUBLIC_HOSTS.has(name.toLowerCase()) || FILE_EXTENSIONS.has(last) || /^\d+$/u.test(last))
    return false;
  return labels.length > 2 || HOST_TLDS.has(last);
};

/** IPv6 (bracketed or bare, with an optional port), never a clock time like 12:30:45. */
const isIpv6 = (value: string): boolean => {
  const bare = value.replace(/^\[|\](?::\d+)?$/gu, "");
  return bare.includes("::") || bare.split(":").length >= 5;
};

/** A relative path with directory segments: `./x`, `../x/y`, `a/b/c` or `dir/file.ext`. */
const isRelativePath = (value: string): boolean =>
  /^\.{1,2}\//u.test(value) ||
  value.split("/").length > 2 ||
  /\.[A-Za-z0-9]{1,6}$/u.test(value.split("/").at(-1) ?? "");

/**
 * Secrets are always masked. Unless `include`, so is everything that names
 * the workspace: URLs (the tracker's own stay), `user@host:path` remotes,
 * emails, host names other than github.com, IPv4 and IPv6 addresses,
 * absolute, home, UNC and relative paths (spaces included), ticket IDs, the
 * branch and the workspace's org, repo and workspace names. URLs go first,
 * before the secret masking, so a credential in a URL never splits it.
 */
export function redactDraft(
  text: string,
  facts: WorkspaceFacts,
  tracker: string,
  include = false,
): string {
  if (include) return redactText(text);
  const kept: string[] = [];
  const hold = (value: string): string => {
    kept.push(value);
    return `${kept.length - 1}`;
  };
  const isTracker = new RegExp(
    String.raw`^(?:https?://)?(?:www\.)?github\.com/${escape(tracker)}(?=$|[/#?])`,
    "iu",
  );
  /** A URL without the sentence punctuation that follows it. */
  const url = (match: string): string => {
    const value = match.replace(/[.,;:!?)\]]+$/u, "");
    const rest = match.slice(value.length);
    return (isTracker.test(value) ? hold(value) : "<url>") + rest;
  };
  let out = text;
  if (facts.branch) out = out.replaceAll(facts.branch, "<branch>");
  out = out
    .replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/giu, url)
    .replaceAll(/\b(?:www\.)?github\.com\/[\w.-]+(?:\/[^\s<>"'`]*)?/giu, url)
    .replaceAll(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*:[\w./~-]*/gu, "<url>");
  out = redactText(out)
    .replaceAll(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gu, "<email>")
    // Quoted paths keep their spaces: the whole quoted text goes.
    .replaceAll(/(["'`])((?:[A-Za-z]:)?[\\/~.][^"'`\n]*[\\/][^"'`\n]*)\1/gu, "$1<path>$1")
    .replaceAll(/\\\\[^\s\\"'`]+\\[^\s"'`]*/gu, "<path>")
    .replaceAll(/\b[A-Za-z]:\\(?:[^\s\\"'`]+(?: [^\s\\"'`]+)*\\)*[^\s\\"'`]*/gu, "<path>");
  if (facts.home.length > 1) out = out.replaceAll(facts.home, "~");
  const segment = String.raw`[\w.@+-]+(?: [\w.@+-]+)*`;
  out = out
    .replaceAll(
      new RegExp(String.raw`(?<![\w.~<>-])~?\/(?:${segment}\/)+[\w.@+-]*`, "gu"),
      "<path>",
    )
    .replaceAll(/(?<![\w/])~\/[\w.@+/-]*/gu, "<path>")
    .replaceAll(/(?<![\w.~<>/-])(?:\.{1,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]+/gu, (value) =>
      isRelativePath(value) ? "<path>" : value,
    )
    .replaceAll(
      /(?<![\w:])\[?(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\]?(?::\d+)?(?![\w:])/giu,
      (value) => (isIpv6(value) && /[0-9a-f]/iu.test(value) ? "<host>" : value),
    )
    .replaceAll(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/gu, "<host>")
    .replaceAll(/\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+(?::\d+)?\b/giu, (value) =>
      isHost(value.replace(/:\d+$/u, "")) ? "<host>" : value,
    )
    .replaceAll(/\b[A-Za-z][A-Za-z0-9]{1,9}-\d+\b/gu, (id) =>
      NOT_TICKETS.test(id) ? id : "<ticket>",
    );
  for (const name of facts.names.toSorted((a, b) => b.length - a.length))
    out = out.replaceAll(new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, "giu"), "<name>");
  return out.replaceAll(/(\d+)/gu, (_, index: string) => kept[Number(index)]);
}

export type DraftInput = {
  title: string;
  body: string;
  verb: string | null;
  exitText: string | null;
  host: string;
  include: boolean;
};

/** The issue body: the agent's text, then the facts block (version, host, verb, exit text) once. */
export function draftBody(input: DraftInput): string {
  const body = input.body.trimEnd();
  if (body.includes(FACTS_MARK)) return `${body}\n`;
  const fence = "```";
  return [
    body,
    "",
    FACTS_MARK,
    `- Workit: ${pkg.version}`,
    `- Host: ${input.host}`,
    `- Platform: ${process.platform}`,
    ...(input.verb ? [`- Verb: \`${input.verb.replaceAll("`", "'")}\``] : []),
    `- Workspace details: ${input.include ? "included at the user's request" : "redacted"}`,
    ...(input.exitText?.trim()
      ? [
          "",
          "Exit text:",
          "",
          `${fence}text`,
          input.exitText.trimEnd().replaceAll(fence, "'''"),
          fence,
        ]
      : []),
    "",
  ].join("\n");
}

/** `--x-file <path>` (relative to the shell's directory, then --cwd) or `-` for stdin. */
function readText(
  io: Io,
  flag: string,
  file: string,
): { text: string; path: string | null } | string {
  if (file === "-")
    try {
      return { text: forgeDeps.readStdin(), path: null };
    } catch {
      return `cannot read --${flag} - (stdin)`;
    }
  const shell = io.env.PWD;
  const dirs = path.isAbsolute(file)
    ? [""]
    : shell && path.isAbsolute(shell)
      ? [shell, io.cwd]
      : [io.cwd];
  const found = [...new Set(dirs.map((dir) => path.resolve(dir, file)))].find((candidate) =>
    existsSync(candidate),
  );
  if (!found) return `cannot read --${flag} ${file}: no such file; pass an absolute path or -`;
  try {
    return { text: readFileSync(found, "utf8"), path: found };
  } catch {
    return `cannot read --${flag} ${found}`;
  }
}

export type Duplicate = { number: number; title: string; url: string | null };

const STOP_WORDS = new Set(
  "the a an and or of to in on for with when without from is are be not no it its by as at this that workit".split(
    " ",
  ),
);

/** Up to three open tracker issues whose text matches the title's words (read-only search API). */
function searchDuplicates(
  runner: ForgeRunner,
  tracker: string,
  title: string,
): { found: Duplicate[] } | { error: string } {
  const words = title
    .toLowerCase()
    .replaceAll(/<[a-z]+>/gu, " ")
    .split(/[^a-z0-9-]+/u)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .slice(0, 6);
  if (!words.length) return { found: [] };
  const query = `repo:${tracker} is:issue is:open ${words.join(" ")}`;
  const done = runner(
    "gh",
    ["api", "-X", "GET", "search/issues", "-f", `q=${query}`, "-f", "per_page=3"],
    { timeoutMs: TIMEOUT_MS },
  );
  if (done.missing) return { error: "gh is not installed" };
  if (done.status !== 0)
    return { error: redactText(done.stderr.trim().split("\n")[0] || "the search failed") };
  try {
    const items = (JSON.parse(done.stdout) as { items?: unknown }).items;
    return {
      found: (Array.isArray(items) ? items : []).flatMap((item: Record<string, unknown>) =>
        typeof item?.number === "number" && !item.pull_request
          ? [
              {
                number: item.number,
                title: typeof item.title === "string" ? item.title : "",
                url: typeof item.html_url === "string" ? item.html_url : null,
              },
            ]
          : [],
      ),
    };
  } catch {
    return { error: "the search returned invalid JSON" };
  }
}

const quote = (value: string): string => `"${value.replaceAll(/["\\$`]/gu, (c) => `\\${c}`)}"`;

const slug = (title: string): string =>
  title
    .toLowerCase()
    .replaceAll(/<[a-z]+>/gu, "")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 48) || "feedback";

/** Save the draft under `workit dir retros`: its path, or why it could not be saved. */
function saveDraft(io: Io, title: string, body: string): { path: string } | { error: string } {
  const dir = repoDir("retros", io.cwd);
  if (dir instanceof Error) return { error: dir.message };
  const stamp = new Date(forgeDeps.now()).toISOString().replaceAll(/[-:]/gu, "").slice(0, 15);
  const file = path.join(dir, `feedback-${stamp}-${slug(title)}.md`);
  try {
    writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
    return { path: file };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** A runner that carries `token` on every call; the token never reaches argv or output. */
const withToken =
  (base: ForgeRunner, token: string): ForgeRunner =>
  (bin, args, options) =>
    base(bin, args, { ...options, token });

/** Variables that would make `gh auth token` print themselves instead of the named login's token. */
const TOKEN_VARIABLES = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

/** `env` without the token variables (gh prefers them over `--user`). */
export const withoutTokenEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !TOKEN_VARIABLES.has(key)));

/** The login's gh token on github.com (`gh auth token --user`), never printed. */
function accountToken(runner: ForgeRunner, account: string): { token: string } | { error: string } {
  const done = runner("gh", ["auth", "token", "--hostname", API_HOST, "--user", account], {
    timeoutMs: TIMEOUT_MS,
  });
  if (done.missing) return { error: "gh is not installed" };
  const token = done.status === 0 ? done.stdout.trim() : "";
  return token ? { token } : { error: `gh has no ${account} login on ${API_HOST}` };
}

type Draft = {
  repo: string;
  title: string;
  body: string;
  duplicates: Duplicate[];
  duplicateSearch: string | null;
  saved: string | null;
  saveError?: string;
  posted: { kind: "issue" | "comment"; number: number; url: string | null } | null;
};

const human = (data: Draft): string[] => [
  `Draft for ${data.repo}: ${data.title}`,
  "",
  ...data.body.trimEnd().split("\n"),
  "",
  ...(data.duplicateSearch ? [`duplicate search: ${data.duplicateSearch}`] : []),
  ...data.duplicates.map(
    (issue) =>
      `possible duplicate: #${issue.number} ${issue.title}${issue.url ? `  ${issue.url}` : ""} (comment instead: --comment ${issue.number})`,
  ),
  ...(data.posted
    ? [
        `posted ${data.posted.kind === "issue" ? "issue" : "a comment on"} #${data.posted.number}${data.posted.url ? `  ${data.posted.url}` : ""}`,
      ]
    : [
        "nothing posted",
        ...(data.saveError ? [`draft not saved: ${data.saveError}`] : []),
        ...(data.saved
          ? [
              `draft saved: ${data.saved}`,
              `after the user says yes: workit feedback ${quote(data.title)} --body-file ${quote(data.saved)} --post --account <login>${data.duplicates[0] ? ` [--comment ${data.duplicates[0].number}]` : ""}`,
            ]
          : []),
      ]),
];

export async function run(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    "body-file": "value",
    verb: "value",
    "exit-file": "value",
    "include-workspace": "boolean",
    post: "boolean",
    account: "value",
    comment: "value",
  });
  if (typeof flags === "string") return usage(io, flags, USAGE);
  if (flags.positionals.length !== 1)
    return usage(
      io,
      flags.positionals.length ? "quote the title as one argument" : 'missing "<title>"',
      USAGE,
    );
  const settings = workspaceFeedback(io.cwd);
  if (settings.off)
    return emit(
      io,
      fail(
        "blocked",
        `workit feedback is off for workspace ${settings.workspace ?? "?"} (feedback: "off" in workspaces.json)`,
        { unblock: "report the friction to the user in your reply instead" },
      ),
    );
  const bodyFile = flags.values["body-file"];
  if (bodyFile === undefined) return usage(io, "--body-file <f|-> is required", USAGE);
  const exitFile = flags.values["exit-file"];
  if (bodyFile === "-" && exitFile === "-")
    return usage(io, "only one of --body-file and --exit-file can read stdin", USAGE);
  const comment = flags.values.comment;
  if (comment !== undefined && !/^#?[1-9]\d{0,8}$/u.test(comment))
    return usage(io, "--comment takes an issue number", USAGE);
  const account = flags.values.account;
  if (account !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(account))
    return usage(io, "--account takes a GitHub login", USAGE);
  if (!flags.booleans.has("post") && (comment !== undefined || account !== undefined))
    return usage(io, "--comment and --account are used with --post", USAGE);
  const body = readText(io, "body-file", bodyFile);
  if (typeof body === "string") return usage(io, body, USAGE);
  if (!body.text.trim()) return usage(io, "the body is empty: describe a synthetic repro", USAGE);
  const exit = exitFile === undefined ? null : readText(io, "exit-file", exitFile);
  if (typeof exit === "string") return usage(io, exit, USAGE);

  const repo = trackerRepo();
  const include = flags.booleans.has("include-workspace");
  const facts = workspaceFacts(io.cwd, settings.workspace, repo);
  const redact = (text: string) => redactDraft(text, facts, repo, include);
  const title = redact(flags.positionals[0].trim()).replaceAll(/\s+/gu, " ").slice(0, 200);
  if (!title) return usage(io, 'missing "<title>"', USAGE);
  const text = redact(
    draftBody({
      title,
      body: body.text,
      verb: flags.values.verb ?? null,
      exitText: exit?.text ?? null,
      host: hostOf(io.env),
      include,
    }),
  );

  const base = forgeDeps.runner ?? systemRunner("github", API_HOST, io.env);
  const login = account ?? settings.account;
  // The lookup runs without GH_TOKEN and kin: gh would print those, not the login's token.
  const lookup = forgeDeps.runner ?? systemRunner("github", API_HOST, withoutTokenEnv(io.env));
  const token = flags.booleans.has("post") && login ? accountToken(lookup, login) : null;
  const runner = token && "token" in token ? withToken(base, token.token) : base;
  const search = searchDuplicates(runner, repo, title);
  const draft: Draft = {
    repo,
    title,
    body: text,
    duplicates: "found" in search ? search.found : [],
    duplicateSearch: "error" in search ? `unavailable (${search.error})` : null,
    saved: null,
    posted: null,
  };
  /** The draft as saved under `workit dir retros` (a saved draft passed back is not saved twice). */
  const keep = (): Draft => {
    if (body.path && body.text.includes(FACTS_MARK)) return { ...draft, saved: body.path };
    const saved = saveDraft(io, title, text);
    return "path" in saved ? { ...draft, saved: saved.path } : { ...draft, saveError: saved.error };
  };

  if (!flags.booleans.has("post")) return emit(io, ok(keep()), human);

  const refuse = (
    code: "invalid_input" | "blocked" | ForgeCode,
    error: string,
    before = "",
  ): number => {
    const kept = keep();
    const file = kept.saved ? quote(kept.saved) : "<f>";
    const retry = `workit feedback ${quote(title)} --body-file ${file} --post --account ${login ?? "<login>"}${comment ? ` --comment ${comment.replace("#", "")}` : ""}`;
    return emit(io, fail(code, error, { data: kept, unblock: `${before}Retry as: ${retry}` }));
  };
  if (!login)
    return refuse(
      "invalid_input",
      "--post needs the GitHub login to post with: pass --account <login> or set feedback.account in workspaces.json; the workspace's own account is never used by default",
    );
  if (token && "error" in token)
    return refuse("blocked", token.error, `gh auth login --hostname ${API_HOST} as ${login}. `);
  const issues = githubIssues({ apiHost: API_HOST, repo, runner });
  const target = comment ? Number(comment.replace("#", "")) : null;
  const posted =
    target === null
      ? issues.create({ title, body: text, labels: [] })
      : issues.comment(target, `**${title}**\n\n${text}`);
  if (!posted.ok) return refuse(posted.code, posted.error);
  const number = target ?? (posted.data as { number: number }).number;
  return emit(
    io,
    ok({
      ...draft,
      posted: { kind: target === null ? "issue" : "comment", number, url: posted.data.url },
    } satisfies Draft),
    human,
  );
}
