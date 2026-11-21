// Redaction and bounding for text that comes back from a forge: CI logs,
// review comments, CLI stderr. All of it is untrusted data that an agent will
// read, so secrets are masked and the size is capped before it leaves core.

const R = "[REDACTED]";

// Token formats that are secrets wherever they appear.
const TOKEN_PATTERNS: readonly RegExp[] = [
  // GitHub tokens (classic, fine-grained, app, OAuth, refresh).
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu,
  // GitLab tokens, by every prefix GitLab documents
  // (https://docs.gitlab.com/security/tokens/#token-prefixes) and only those:
  // a bare `gl…-` also matches words such as `global-setup-teardown-hook`.
  /\b(?:glpat|gloas|gldt|glrtr|glrt|glcbt|glptt|glft|glimt|glagent|glwt|glsoat|glffct)-[A-Za-z0-9_-]{20,}/gu,
  // GitLab's session cookie.
  /\b_gitlab_session=[A-Za-z0-9%_-]{16,}/gu,
  /\bnpm_[A-Za-z0-9]{30,}/gu,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/gu,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/gu,
  /\bAIza[0-9A-Za-z_-]{35}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
];

// Slack/Discord webhooks: the path is the credential.
const WEBHOOK =
  /\b(https?:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)|discord(?:app)?\.com\/api\/webhooks))\/[^\s"'<>]+/giu;

// Userinfo in any URL (`https://user:pw@`, `postgres://a:b:c@`, `https://tok@`).
// The scheme starts where its run starts: `\b` started a scan at every word of
// a long `a-a-a-…` run, which was quadratic.
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu;

// `curl -u user:pass`, `--user user:pass`.
const CURL_USER = /(\s(?:-u|--user)(?:\s+|=))(["']?)[^\s"':]+:[^\s"']+\2/gu;

// Secret-ish keys in env dumps, YAML, JSON, headers and connection strings:
// DB_PASSWORD=…, "access_token": "…", X-Api-Key: …, PRIVATE-TOKEN: …,
// AccountKey=…; an optional auth scheme (Basic/Bearer) is kept.
// The key starts only where its name run starts, and the secret word is a
// lookahead bounded by that run: a scan from every inner `-` made a long
// `--a-a-a-…` run quadratic.
const NAME = "[A-Za-z0-9_.-]";
const KEY = String.raw`(?<!${NAME})(?=${NAME}*?(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|account[_-]?key|private[_-]?key|client[_-]?secret|credentials?|authorization|cookie|signature))${NAME}+`;
const ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9])(["']?${KEY}["']?\s*[:=]\s*["']?)((?:bearer|basic|token|digest)\s+)?([^\s"',;&]+)`,
  "giu",
);

const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/giu;

// A quoted value may contain spaces: password: "correct horse battery".
const QUOTED_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9])(["']?${KEY}["']?\s*[:=]\s*)(["'])([^"'\n]*[^\s"'][^"'\n]*)\2`,
  "giu",
);

// ~/.netrc: `machine h login u password p` (also split across lines).
const NETRC = /\b((?:machine|login)\s+\S+\s+(?:login\s+\S+\s+)?password\s+)\S+/giu;

// Secrets passed as CLI flags: sshpass -p X, mysql -pX / -p X.
const SSHPASS = /\b(sshpass\s+-p\s*)\S+/gu;
// mysql's `-pX` is masked after the line's first mysql. A lazy scan from every
// `mysql` to its `-p` was quadratic on a long line.
const MYSQL = /\bmysql(?:dump|admin|import|show)?\b/u;
const MYSQL_PASSWORD = /(\s-p)(?!\s|$)\S+/gu;
const maskMysql = (line: string): string => {
  const at = line.search(MYSQL);
  return at < 0 ? line : line.slice(0, at) + line.slice(at).replace(MYSQL_PASSWORD, `$1${R}`);
};

// The value after a long flag whose name carries a secret word, as a whole
// dash or underscore segment: `--password x`, `--client-secret=x`,
// `--API-KEY "a b"`. `--author` and `--tokens` are not secret names, and a
// following flag (`--token --json`) is not a value. A quote with no closing
// quote on its line masks the rest of the line. Over-masking a non-secret
// value (`--token-budget 5`, `--auth-method oauth`) is accepted as the safe
// default. An auth flag (`--authorization Bearer x`) keeps its scheme and
// masks the credential; any other flag masks the scheme word too. The name is
// one run checked by a lookahead, so a long `--a-a-…` stays linear.
const SECRET_FLAG = new RegExp(
  String.raw`(?<![\w-])(--(?=[\w-]*?(?<![a-z0-9])(?:password|passwd|pwd|secret|token|api[-_]?key|auth|authorization|credentials?|private[-_]?key|access[-_]?key)(?![a-z0-9]))[\w-]+(?:\s+|=))((?:bearer|basic|token|digest)\s+(?![\s-]))?(?:(["'])(?:[^\n]*?\3|[^\n]*)|(?!-)[^\s"']+)`,
  "giu",
);

// Signed-URL and query-string credentials (Azure SAS `sig=`, `token=`, …).
const QUERY_SECRET =
  /([?&;](?:sig|signature|token|access_token|api_key|apikey|key|password|secret|client_secret|X-Amz-Signature|X-Goog-Signature)=)[^&\s#"']+/giu;

// A key block from BEGIN to END, or to the end of the text when truncated.
const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu;

// Long base64 runs: redacted when they decode to a credential, or sit on a
// line that decodes base64 (`echo … | base64 -d`).
const BASE64 = /[A-Za-z0-9+/]{32,}={0,2}/gu;

// An OSC sequence ends at BEL and holds no ESC, so each scan stops at the
// next ESC (a scan to the end of the text from every `ESC ]` was quadratic).
const ANSI = new RegExp(
  String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*\u0007`,
  "gu",
);

export const stripAnsi = (value: string): string => value.replace(ANSI, "");

const decodesToSecret = (blob: string): boolean => {
  if (/^[0-9a-f]+$/iu.test(blob)) return false; // hex: commit/tree ids
  let decoded: string;
  try {
    decoded = Buffer.from(blob, "base64").toString("utf8");
  } catch {
    return false;
  }
  if (!/^[\x20-\x7e\s]+$/u.test(decoded)) return false;
  return (
    TOKEN_PATTERNS.some((pattern) => new RegExp(pattern.source, "u").test(decoded)) ||
    /^[^\s:]{1,64}:[^\s]{6,}$/u.test(decoded.trim())
  );
};

/** Mask secrets and strip terminal escapes. Works on whole (multi-line) text. */
export function redactText(value: string): string {
  let out = stripAnsi(value).replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]");
  out = out.replace(WEBHOOK, `$1/${R}`);
  out = out.replace(URL_USERINFO, `$1${R}@`);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, R);
  out = out.replace(CURL_USER, `$1$2${R}$2`);
  out = out.replace(BEARER, `$1${R}`);
  out = out.replace(QUOTED_ASSIGNMENT, (match, lead: string, quote: string, secret: string) =>
    secret.startsWith(R) ? match : `${lead}${quote}${R}${quote}`,
  );
  out = out.replace(NETRC, `$1${R}`);
  out = out.replace(SSHPASS, `$1${R}`);
  if (MYSQL.test(out)) out = out.split("\n").map(maskMysql).join("\n");
  out = out.replace(SECRET_FLAG, (match, flag: string, scheme?: string, quote?: string) => {
    const kept = scheme && /auth/iu.test(flag) ? scheme : "";
    const secret = match.slice(flag.length + kept.length);
    if (secret.startsWith(R)) return match;
    if (!quote) return `${flag}${kept}${R}`;
    const closed = secret.length > 1 && secret.endsWith(quote);
    return `${flag}${kept}${quote}${R}${closed ? quote : ""}`;
  });
  out = out.replace(QUERY_SECRET, `$1${R}`);
  out = out.replace(
    ASSIGNMENT,
    (match, lead: string, scheme: string | undefined, secret: string) =>
      secret.startsWith(R) ? match : `${lead}${scheme ?? ""}${R}`,
  );
  return out
    .split("\n")
    .map((line) =>
      line.replace(BASE64, (blob) =>
        /\bbase64\b/iu.test(line) || decodesToSecret(blob) ? R : blob,
      ),
    )
    .join("\n");
}

// GitHub Actions prefixes every log line with an ISO timestamp; GitLab traces
// carry section markers and a leading timestamp/stream tag in newer runners.
const LINE_NOISE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?)?(?:\d{2}[A-Z]\s)?/u;
const GITLAB_SECTION = /section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]]*\])?\r?/gu;

// Where the failure ends: everything after is runner cleanup.
const FAILURE_END = [/##\[error\]Process completed with exit code/u, /^ERROR: Job failed\b/u];

const MAX_LINE = 400;

// The first line that looks like the actual failure: a strong marker (a
// test-runner failure, an assertion, a thrown error) wins over a weak one
// (any "failed"/"ERROR" mention, which passing tests also print).
const STRONG_ERROR =
  /^\s*(?:\(fail\)|FAIL\b|✗|✕|×|error(?:\[[A-Z0-9]+\])?:|[A-Za-z]*Error\b:|AssertionError|Traceback|panic:|Exception\b)/u;
const WEAK_ERROR = /\berror\b[:[]|\bERROR\b|\bFAIL(?:ED)?\b|\bfailed\b|\bassert/u;
// Passing test lines and summaries mention failure words without failing.
const NOT_FIRST_ERROR =
  /^\s*(?:\(pass\)|\(skip\)|\(todo\)|✓|✔|ok\b|PASS\b)|^\s*\d+ fail\b|##\[error\]Process completed|^\s*0 (?:errors?|fail)/u;

/** Lines of context kept before the first error. */
const LEAD = 3;

/**
 * A bounded, redacted view of a CI log: at most `lines` lines. Runner
 * cleanup after the failure marker is dropped. When the first error sits
 * before the final window, the view is the region around that first error,
 * a `…` gap, then the end of the log (where the summary and exit code are).
 */
export function logTail(text: string, lines: number): string[] {
  if (lines <= 0) return [];
  const cleaned = text
    .replace(GITLAB_SECTION, "")
    .split(/\r?\n/u)
    // A bare \r rewrites the line in a terminal (progress bars): keep what
    // was finally shown.
    .map(
      (raw) =>
        stripAnsi(raw)
          .split("\r")
          .findLast((part) => part.trim()) ?? "",
    )
    .map((raw) => raw.replace(LINE_NOISE, ""));
  // Redact the whole text so a secret spanning lines (a private key) goes.
  const all = redactText(cleaned.join("\n")).split("\n");
  let end = all.length;
  for (let index = all.length - 1; index >= 0; index -= 1)
    if (FAILURE_END.some((pattern) => pattern.test(all[index]))) {
      end = index + 1;
      break;
    }
  const kept = all.slice(0, end);
  while (kept.length > 0 && !kept[kept.length - 1].trim()) kept.pop();
  const cap = (value: string) => (value.length > MAX_LINE ? `${value.slice(0, MAX_LINE)}…` : value);
  const tailStart = Math.max(0, kept.length - lines);
  const find = (pattern: RegExp) =>
    kept.findIndex((value) => pattern.test(value) && !NOT_FIRST_ERROR.test(value));
  const strong = find(STRONG_ERROR);
  const first = strong >= 0 ? strong : find(WEAK_ERROR);
  if (first < 0 || first >= tailStart || lines < 8) return kept.slice(tailStart).map(cap);
  const headCount = Math.ceil((lines - 1) * (2 / 3));
  const from = Math.max(0, first - LEAD);
  const head = kept.slice(from, from + headCount);
  const tailCount = lines - 1 - head.length;
  const tailFrom = Math.max(from + head.length, kept.length - tailCount);
  const tail = kept.slice(tailFrom);
  return [...head, ...(tailFrom > from + head.length ? ["…"] : []), ...tail].map(cap);
}

/** One-line, redacted, length-capped text (review comment bodies). */
export function shortBody(value: string, max = 300): string {
  const flat = redactText(value).replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
