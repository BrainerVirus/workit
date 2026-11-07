// `workit issue view|comment|close|create` (#439, retro W2.11): GitHub and
// GitLab issues through the workspace's verified account and the `pr` grant,
// each write recorded in the ledger (core forge/issue-ops.ts).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ISSUE_CLOSE_REASONS,
  type ForgeIssue,
  type IssueCloseReason,
} from "@workit-dev/core/src/forge/issue-forge";
import {
  closeIssue,
  commentOnIssue,
  createIssue,
  issueTarget,
  type CloseOutcome,
  type CommentOutcome,
  type CreateOutcome,
  type Recorded,
} from "@workit-dev/core/src/forge/issue-ops";
import { actorFromEnv } from "@workit-dev/core/src/ledger";
import { emit, ok, type Io } from "../output";
import { connect, forgeDeps, forgeFail, parseFlags, usage } from "./forge-common";

const VIEW_USAGE = "workit issue view <n> [--repo <owner/name>] [--json]";
const COMMENT_USAGE = "workit issue comment <n> --body-file <f|-> [--repo <owner/name>] [--json]";
const CLOSE_USAGE =
  "workit issue close <n> --reason completed|not-planned [--comment <text> | --comment-file <f|->] [--repo <owner/name>] [--json]";
const CREATE_USAGE =
  "workit issue create --title <t> --body-file <f|-> [--label <l>]… [--repo <owner/name>] [--json]";
const USAGE = [VIEW_USAGE, COMMENT_USAGE, CLOSE_USAGE, CREATE_USAGE].join("\n");

/** `--x-file <path>` (relative to the shell's directory, then --cwd) or `-` for stdin. */
function readTextFile(io: Io, flag: string, file: string): { text: string } | string {
  if (file === "-")
    try {
      return { text: forgeDeps.readStdin() };
    } catch {
      return `cannot read --${flag} - (stdin)`;
    }
  const shell = io.env.PWD;
  const dirs = path.isAbsolute(file)
    ? [""]
    : shell && path.isAbsolute(shell)
      ? [shell, io.cwd]
      : [io.cwd];
  const candidates = [...new Set(dirs.map((dir) => path.resolve(dir, file)))];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found)
    return `cannot read --${flag} ${file}: no such file at ${candidates.join(" or ")}; pass an absolute path, or --${flag} - with the text on stdin`;
  try {
    return { text: readFileSync(found, "utf8") };
  } catch {
    return `cannot read --${flag} ${found}`;
  }
}

/** The one positional issue number: `321` or `#321`. */
function issueNumber(positionals: readonly string[]): number | string {
  if (positionals.length !== 1)
    return positionals.length ? `one issue number, got ${positionals.join(" ")}` : "missing <n>";
  const match = /^#?([1-9]\d{0,8})$/u.exec(positionals[0]);
  return match ? Number(match[1]) : `<n> must be an issue number, not "${positionals[0]}"`;
}

const ledgerLine = (recorded: Recorded | null): string[] =>
  recorded && "error" in recorded ? [`ledger: not recorded (${recorded.error})`] : [];

function connectIssues(io: Io, repo: string | undefined) {
  const connected = connect(io);
  if (!connected.ok) return connected;
  return issueTarget(io.cwd, connected.data, { repo: repo ?? null });
}

async function view(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { repo: "value" });
  if (typeof flags === "string") return usage(io, flags, VIEW_USAGE);
  const number = issueNumber(flags.positionals);
  if (typeof number === "string") return usage(io, number, VIEW_USAGE);
  const api = connectIssues(io, flags.values.repo);
  if (!api.ok) return forgeFail(io, api);
  const issue = api.data.view(number);
  if (!issue.ok) return forgeFail(io, issue);
  return emit(io, ok(issue.data), (data: ForgeIssue) => [
    `#${data.number} ${data.state}${data.stateReason && data.state === "closed" ? ` (${data.stateReason})` : ""}: ${data.title}${data.url ? `  ${data.url}` : ""}`,
    ...(data.labels.length ? [`labels: ${data.labels.join(", ")}`] : []),
    ...(data.body ? ["", data.body.trimEnd()] : []),
  ]);
}

async function comment(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, { "body-file": "value", repo: "value" });
  if (typeof flags === "string") return usage(io, flags, COMMENT_USAGE);
  const number = issueNumber(flags.positionals);
  if (typeof number === "string") return usage(io, number, COMMENT_USAGE);
  const file = flags.values["body-file"];
  if (file === undefined) return usage(io, "--body-file <f|-> is required", COMMENT_USAGE);
  const read = readTextFile(io, "body-file", file);
  if (typeof read === "string") return usage(io, read, COMMENT_USAGE);
  if (!read.text.trim()) return usage(io, "the comment body is empty", COMMENT_USAGE);
  const api = connectIssues(io, flags.values.repo);
  if (!api.ok) return forgeFail(io, api);
  const result = commentOnIssue(io.cwd, api.data, {
    number,
    body: read.text,
    actor: actorFromEnv(io.env),
  });
  if (!result.ok) return forgeFail(io, result);
  return emit(io, ok(result.data), (data: CommentOutcome) => [
    `commented on issue #${data.number}${data.url ? `  ${data.url}` : ""}`,
    ...ledgerLine(data.recorded),
  ]);
}

async function close(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    reason: "value",
    repo: "value",
    comment: "value",
    "comment-file": "value",
  });
  if (typeof flags === "string") return usage(io, flags, CLOSE_USAGE);
  const number = issueNumber(flags.positionals);
  if (typeof number === "string") return usage(io, number, CLOSE_USAGE);
  const reason = flags.values.reason as IssueCloseReason | undefined;
  if (!reason || !ISSUE_CLOSE_REASONS.includes(reason))
    return usage(
      io,
      `--reason is ${ISSUE_CLOSE_REASONS.join(" or ")}${reason ? ` (got ${reason})` : ""}`,
      CLOSE_USAGE,
    );
  if (flags.values.comment !== undefined && flags.values["comment-file"] !== undefined)
    return usage(io, "pass --comment or --comment-file, not both", CLOSE_USAGE);
  let text = flags.values.comment ?? null;
  if (flags.values["comment-file"] !== undefined) {
    const read = readTextFile(io, "comment-file", flags.values["comment-file"]);
    if (typeof read === "string") return usage(io, read, CLOSE_USAGE);
    text = read.text;
  }
  if (text !== null && !text.trim()) return usage(io, "the comment is empty", CLOSE_USAGE);
  const api = connectIssues(io, flags.values.repo);
  if (!api.ok) return forgeFail(io, api);
  const result = closeIssue(io.cwd, api.data, {
    number,
    reason,
    comment: text,
    actor: actorFromEnv(io.env),
  });
  if (!result.ok) return forgeFail(io, result);
  return emit(io, ok(result.data), (data: CloseOutcome) =>
    data.changed
      ? [
          `closed issue #${data.number} as ${data.reason}${data.url ? `  ${data.url}` : ""}`,
          ...(data.comment === "already_posted"
            ? [
                `comment: already posted by this session${data.commentUrl ? ` (${data.commentUrl})` : ""}; not posted again`,
              ]
            : data.commentUrl
              ? [`comment: ${data.commentUrl}`]
              : []),
          ...ledgerLine(data.recorded),
        ]
      : [`issue #${data.number} was already closed; nothing posted`],
  );
}

async function create(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    title: "value",
    "body-file": "value",
    label: "list",
    repo: "value",
  });
  if (typeof flags === "string") return usage(io, flags, CREATE_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, CREATE_USAGE);
  const title = flags.values.title?.trim();
  if (!title) return usage(io, "--title <t> is required", CREATE_USAGE);
  const file = flags.values["body-file"];
  if (file === undefined) return usage(io, "--body-file <f|-> is required", CREATE_USAGE);
  const read = readTextFile(io, "body-file", file);
  if (typeof read === "string") return usage(io, read, CREATE_USAGE);
  const api = connectIssues(io, flags.values.repo);
  if (!api.ok) return forgeFail(io, api);
  const result = createIssue(io.cwd, api.data, {
    title,
    body: read.text,
    labels: flags.lists.label ?? [],
    actor: actorFromEnv(io.env),
  });
  if (!result.ok) return forgeFail(io, result);
  return emit(io, ok(result.data), (data: CreateOutcome) => [
    `created issue #${data.number}${data.url ? `  ${data.url}` : ""}`,
    ...ledgerLine(data.recorded),
  ]);
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "view") return view(rest, io);
  if (sub === "comment") return comment(rest, io);
  if (sub === "close") return close(rest, io);
  if (sub === "create") return create(rest, io);
  return usage(
    io,
    sub && !sub.startsWith("-") ? `unknown issue subcommand "${sub}"` : "missing issue subcommand",
    USAGE,
  );
}
