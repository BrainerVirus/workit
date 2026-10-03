// Redaction and bounding for text that comes back from a forge: CI logs,
// review comments, CLI stderr. All of it is untrusted data that an agent will
// read, so secrets are masked and the size is capped before it leaves core.

const SECRET_PATTERNS: readonly RegExp[] = [
  // Credentials embedded in URLs (https://user:token@host).
  /(?<=[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+(?=@)/giu,
  // GitHub tokens (classic, fine-grained, app, OAuth, refresh).
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
  // GitLab tokens (personal, project/group, trigger, runner, deploy, feed…).
  /\bgl(?:pat|ptt|rt|dt|ft|oas|cbt|imt|agent|soat|ffct)-[A-Za-z0-9_-]{16,}\b/gu,
  // npm, Slack, AWS access key ids, OpenAI/Anthropic-style keys.
  /\bnpm_[A-Za-z0-9]{30,}\b/gu,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/gu,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
];

// `Authorization: Bearer x`, `token=x`, `password: x` (an explicit `:`/`=`
// separator, so prose such as "token validation failed" survives).
const ASSIGNMENT =
  /\b(authorization|token|access[_-]?token|api[_-]?key|secret|password|passwd)(\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?["']?([^\s"',;]{6,})/giu;

const BEARER = /\bbearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu;

const PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu;

const ANSI = new RegExp(String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007`, "gu");

/** Mask secrets and strip terminal escapes. */
export function redactText(value: string): string {
  let out = value.replace(ANSI, "").replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  out = out.replace(BEARER, "Bearer [REDACTED]");
  return out.replace(ASSIGNMENT, (match, key: string, sep: string, secret: string) =>
    secret === "[REDACTED]" ? match : `${key}${sep}[REDACTED]`,
  );
}

// GitHub Actions prefixes every log line with an ISO timestamp; GitLab traces
// carry section markers and a leading timestamp/stream tag in newer runners.
const LINE_NOISE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?)?(?:\d{2}[A-Z]\s)?/u;
const GITLAB_SECTION = /section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]]*\])?\r?/gu;

// Where the failure ends: everything after is runner cleanup.
const FAILURE_END = [/##\[error\]Process completed with exit code/u, /^ERROR: Job failed\b/u];

const MAX_LINE = 400;

/**
 * The last `lines` meaningful lines of a CI log, redacted. Runner cleanup
 * after the failure marker is dropped, so the tail shows the failure itself.
 */
export function logTail(text: string, lines: number): string[] {
  if (lines <= 0) return [];
  const all = text
    .replace(GITLAB_SECTION, "")
    .split(/\r?\n/u)
    .map((raw) => raw.replace(ANSI, "").replace(LINE_NOISE, "").replace(/\r/gu, ""));
  let end = all.length;
  for (let index = all.length - 1; index >= 0; index -= 1)
    if (FAILURE_END.some((pattern) => pattern.test(all[index]))) {
      end = index + 1;
      break;
    }
  const kept = all.slice(0, end);
  while (kept.length > 0 && !kept[kept.length - 1].trim()) kept.pop();
  return kept
    .slice(-lines)
    .map((value) => redactText(value))
    .map((value) => (value.length > MAX_LINE ? `${value.slice(0, MAX_LINE)}…` : value));
}

/** One-line, redacted, length-capped text (review comment bodies). */
export function shortBody(value: string, max = 300): string {
  const flat = redactText(value).replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
