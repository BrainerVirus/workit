import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readTemplate } from "./templates";
import { resolveWorkspaceRoot } from "./scripts";

const ISSUE_RE = /^[A-Z]+-\d+$/;
const TOKEN_PLACEHOLDER = "YOUR_TOKEN_HERE";

// Port of scripts/youtrack/config.sh chain: WORKFLOW_YOUTRACK_CONFIG ->
// XDG_CONFIG_HOME / HOME .config + workflow-toolkit/youtrack.json.
export const youTrackConfigPath = (): string =>
  process.env.WORKFLOW_YOUTRACK_CONFIG ??
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "workflow-toolkit", "youtrack.json");

const youTrackTokenModeOk = (p: string): boolean => {
  if (process.platform === "win32") return true;
  const mode = fs.statSync(p).mode & 0o777;
  return mode === 0o600;
};

function readYouTrackConfig(required: boolean): { config: Record<string, any>; path: string } | { error: string } {
  const cfgPath = youTrackConfigPath();
  if (!fs.existsSync(cfgPath)) {
    return required ? { error: "ERROR: missing youtrack.json" } : { config: {}, path: cfgPath };
  }
  try {
    const config = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, any>;
    return { config, path: cfgPath };
  } catch {
    return { error: "invalid youtrack.json" };
  }
}

/** Load + redact youtrack.json; validates the token file like youtrack/config.sh load. */
export function youTrackConfigLoad(): { data: Record<string, any> } | { error: string } {
  const loaded = readYouTrackConfig(true);
  if ("error" in loaded) return loaded;
  const cfgPath = loaded.path;
  const tokenFile = String(loaded.config.tokenFile ?? "");
  const tokenPath = tokenFile
    ? (path.isAbsolute(tokenFile) ? path.resolve(tokenFile) : path.resolve(process.cwd(), tokenFile))
    : "";
  if (!tokenPath || !fs.existsSync(tokenPath)) {
    return { error: "missing youtrack.token" };
  }
  if (!youTrackTokenModeOk(tokenPath)) {
    return { error: "youtrack.token mode must be 0600" };
  }
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token || token === TOKEN_PLACEHOLDER || token.startsWith(TOKEN_PLACEHOLDER)) {
    return { error: "token file still placeholder — edit locally, then /wk-status" };
  }
  const redacted: Record<string, any> = { ...loaded.config };
  delete redacted.tokenFile;
  redacted.tokenPresent = true;
  redacted.configPath = path.resolve(cfgPath);
  redacted.tokenPath = path.resolve(tokenPath);
  return { data: redacted };
}

function tzParts(date: Date, tz: string): { y: string; m: string; d: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { y: map.year, m: map.month, d: map.day, hour: map.hour, minute: map.minute };
}

/** Port of scripts/youtrack/greeting.sh. */
export function youTrackGreeting(configOverride?: string): { stdout: string; exitCode: number; stderr: string } {
  const cfgPath = configOverride ?? youTrackConfigPath();
  try {
    const config = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, any>;
    const tz = String(config.timezone ?? "America/Santiago");
    const now = new Date();
    const { y, m, d, hour, minute } = tzParts(now, tz);
    const cutoff = String(config.greetingCutoff ?? "12:00").split(":");
    const cutoffHour = Number(cutoff[0]);
    const cutoffMinute = Number(cutoff[1] ?? 0);
    const greetings = (config.greetings ?? {}) as Record<string, string>;
    const isMorning = Number(hour) < cutoffHour || (Number(hour) === cutoffHour && Number(minute) < cutoffMinute);
    const greeting = isMorning
      ? greetings.morning ?? "buenos días"
      : greetings.afternoon ?? "buenas tardes";
    const mention = String(config.defaultMention ?? "Alejandra.Flores");
    void y; void m; void d;
    return { stdout: `@${mention} Hola, ${greeting}.\n`, exitCode: 0, stderr: "" };
  } catch (err) {
    return { stdout: "", exitCode: 1, stderr: err instanceof Error ? err.message : "greeting failed" };
  }
}

/** Port of scripts/youtrack/parse-duration.sh. */
export function youTrackParseDuration(text: string): { data: { minutes: number; text: string } } | { error: string } {
  const lower = String(text).toLowerCase().trim();
  let total = 0;
  for (const match of lower.matchAll(/(\d+)\s*h/g)) total += Number(match[1]) * 60;
  for (const match of lower.matchAll(/(\d+)\s*m/g)) total += Number(match[1]);
  if (total === 0 && /^\d+$/.test(lower)) total = Number(lower);
  if (total <= 0) return { error: "could not parse duration" };
  return { data: { minutes: total, text: String(text).trim() } };
}

/** Port of scripts/youtrack/work-date-ms.sh — resolve work-item date as epoch ms. */
export function youTrackWorkDateMs(dateRaw: string): { data: { dateMs: number; timezone: string; localDate: string } } | { error: string } {
  const cfgPath = youTrackConfigPath();
  let tz = "America/Santiago";
  try {
    const config = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, any>;
    tz = String(config.timezone ?? "America/Santiago");
  } catch { /* defaults */ }
  const raw = dateRaw || "auto";
  try {
    if (raw === "auto" || !raw) {
      const now = new Date();
      const { y, m, d } = tzParts(now, tz);
      const dateMs = Math.floor(Date.parse(`${y}-${m}-${d}T00:00:00`) / 86400000) * 86400000;
      return { data: { dateMs, timezone: tz, localDate: `${y}-${m}-${d}` } };
    }
    if (/^\d+$/.test(raw)) {
      const dt = new Date(Number(raw));
      const { y, m, d } = tzParts(dt, tz);
      return { data: { dateMs: Number(raw), timezone: tz, localDate: `${y}-${m}-${d}` } };
    }
    const [y, m, d] = raw.split("-").map(Number);
    const dateMs = Math.floor(Date.parse(`${y}-${m}-${d}T00:00:00`) / 86400000) * 86400000;
    return { data: { dateMs, timezone: tz, localDate: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "could not resolve date" };
  }
}

const youTrackToken = (): { token: string; base: string } | { error: string } => {
  const loaded = readYouTrackConfig(true);
  if ("error" in loaded) return loaded;
  const tokenFile = String(loaded.config.tokenFile ?? "");
  const tokenPath = tokenFile
    ? (path.isAbsolute(tokenFile) ? path.resolve(tokenFile) : path.resolve(process.cwd(), tokenFile))
    : "";
  if (!tokenPath || !fs.existsSync(tokenPath)) return { error: "missing youtrack.token" };
  if (!youTrackTokenModeOk(tokenPath)) return { error: "youtrack.token mode must be 0600" };
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token) return { error: "empty token file" };
  if (token === TOKEN_PLACEHOLDER || token.startsWith(TOKEN_PLACEHOLDER)) {
    return { error: "token file still has placeholder YOUR_TOKEN_HERE — edit the file locally, then run /wk-status" };
  }
  const base = String(loaded.config.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return { error: "baseUrl missing in config" };
  return { token, base };
};

function youTrackCurl(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("curl", ["-fsS", ...args], { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Port of scripts/youtrack/api.sh — log-time / post-comment with the WORKFLOW_YT_WRITE guard. */
export function youTrackApi(args: string[], writeFlag = process.env.WORKFLOW_YT_WRITE ?? ""): { data: Record<string, any> } | { error: string } {
  const cmd = args[0];
  if (cmd === "log-time" || cmd === "post-comment") {
    if (writeFlag !== "1") {
      return { error: "YouTrack write operations require WORKFLOW_YT_WRITE=1 (refusing to mutate production)" };
    }
  }
  const creds = youTrackToken();
  if ("error" in creds) return creds;
  const { token, base } = creds;
  const auth = ["-H", `Authorization: Bearer ${token}`, "-H", "Accept: application/json"];

  if (cmd === "log-time") {
    const [issue, minutesRaw, text, dateArg] = args.slice(1);
    const minutes = Number(minutesRaw);
    const dateMs = youTrackWorkDateMs(dateArg ?? "auto");
    if ("error" in dateMs) return dateMs;
    const body = JSON.stringify({ duration: { minutes }, text, date: dateMs.data.dateMs });
    const out = youTrackCurl([
      ...auth, "-H", "Content-Type: application/json", "-d", body,
      `${base}/api/issues/${issue}/timeTracking/workItems?fields=id,idReadable`,
    ]);
    if (out.status !== 0) return { error: "YouTrack HTTP request failed" };
    try {
      const created = JSON.parse(out.stdout) as Record<string, any>;
      return { data: { ok: true, issueId: issue, workItemId: created.id, dateMs: dateMs.data.dateMs, minutes } };
    } catch {
      return { error: "invalid JSON from YouTrack API" };
    }
  }
  if (cmd === "post-comment") {
    const [issue, text] = args.slice(1);
    const body = JSON.stringify({ text });
    const out = youTrackCurl([
      ...auth, "-H", "Content-Type: application/json", "-d", body,
      `${base}/api/issues/${issue}/comments`,
    ]);
    if (out.status !== 0) return { error: "YouTrack HTTP request failed" };
    return { data: { ok: true, issueId: issue } };
  }
  return { error: "unknown subcommand" };
}

/** Port of scripts/youtrack/verify-token.sh — read-only GET /api/users/me. */
export function youTrackVerifyToken(): { data: Record<string, any> } | { error: string; http_status?: number; path?: string } {
  const cfgPath = youTrackConfigPath();
  if (!fs.existsSync(cfgPath)) return { error: "missing youtrack.json" };
  const creds = youTrackToken();
  if ("error" in creds) return { error: creds.error };
  const { token, base } = creds;

  const me = youTrackCurl(["-H", `Authorization: Bearer ${token}`, "-H", "Accept: application/json",
    `${base}/api/users/me?fields=id,login,name,email`]);
  if (me.status !== 0) {
    const body = me.stderr.trim() || me.stdout.trim();
    const err = me.status === 22 ? "authentication failed (401/403)" : `HTTP error: ${body.slice(0, 200)}`;
    return { error: err, http_status: me.status };
  }
  let user: Record<string, any>;
  try {
    user = JSON.parse(me.stdout) as Record<string, any>;
  } catch {
    return { error: "invalid JSON from YouTrack /api/users/me" };
  }
  const result: Record<string, any> = {
    ok: true, method: "GET /api/users/me", baseUrl: base,
    login: user.login, name: user.name, email: user.email, id: user.id,
  };
  const meeting = readYouTrackConfig(false);
  const meetingIssue = "config" in meeting ? meeting.config.meetingIssue : undefined;
  if (meetingIssue) {
    const issue = youTrackCurl(["-H", `Authorization: Bearer ${token}`, "-H", "Accept: application/json",
      `${base}/api/issues/${meetingIssue}?fields=id,idReadable,summary`]);
    if (issue.status === 0) {
      try {
        const parsed = JSON.parse(issue.stdout) as Record<string, any>;
        result.meetingIssue = meetingIssue;
        result.meetingIssueReadable = true;
        result.meetingIssueSummary = parsed.summary;
      } catch { /* unreadable */ }
    } else {
      result.meetingIssue = meetingIssue;
      result.meetingIssueReadable = false;
      result.warning = `token valid but cannot read issue ${meetingIssue}`;
    }
  }
  return { data: result };
}

/** Port of scripts/youtrack/token-create-url.sh — deep link to Account Security. */
export function youTrackTokenCreateUrl(): { data: Record<string, any> } {
  const tokenName = process.env.WORKFLOW_YT_TOKEN_NAME ?? "workit";
  const loaded = readYouTrackConfig(false);
  const config = loaded && "config" in loaded ? loaded.config : {};
  const cfgPath = loaded && "config" in loaded ? loaded.path : youTrackConfigPath();
  const defaults = (config.tokenDefaults ?? {}) as Record<string, any>;
  const name = String(defaults.name ?? tokenName);
  const desc = String(defaults.description ?? "OpenCode workit — /wk-issue-update and /wk-meetings");
  const scopes = Array.isArray(defaults.scopes) ? defaults.scopes : ["YouTrack"];
  const base = String(config.baseUrl ?? "https://enghouseamg.youtrack.cloud").replace(/\/+$/, "");
  const tokenFile = String(config.tokenFile ?? path.join(path.dirname(cfgPath), "youtrack.token"));
  const tab = String(defaults.profileTab ?? "account-security");
  const createUrl = `${base}/users/me?${new URLSearchParams({ tab })}`;
  const docsUrl = "https://www.jetbrains.com/help/youtrack/cloud/manage-permanent-token.html";
  return {
    data: {
      tokenName: name,
      tokenDescription: desc,
      scopes,
      tokenFile: path.resolve(tokenFile),
      createUrl,
      docsUrl,
      prefillSupported: false,
      steps: [
        "Profile → Account Security → **New token** (or open createUrl)",
        `Name: **${name}**`,
        `Scope: **${scopes.join(", ")}** only — remove other services`,
        "**Create token** → copy immediately (shown once)",
        "Paste into token file → save → `/wk-status`",
      ],
    },
  };
}

/** Parse bare id (NSR-40) or YouTrack URL into issue id. */
export function parseIssueRef(input: unknown): { issueId: string; source: string } | { error: string } {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return { error: "empty issue reference" };

  if (ISSUE_RE.test(trimmed)) {
    return { issueId: trimmed, source: "id" };
  }

  const fromPath = trimmed.match(/\/(?:issue|issues)\/([A-Z]+-\d+)/i);
  if (fromPath && ISSUE_RE.test(fromPath[1])) {
    return { issueId: fromPath[1], source: "url" };
  }

  const anywhere = trimmed.match(/([A-Z]+-\d+)/);
  if (anywhere && ISSUE_RE.test(anywhere[1])) {
    return { issueId: anywhere[1], source: "url" };
  }

  return { error: `could not parse issue id from: ${trimmed}` };
}

export type YouTrackScripts = {
  config(): Record<string, any>;
  greeting(): { stdout: string; exitCode: number; stderr: string };
  parseDuration(text: string): Record<string, any>;
  api(args: string[]): Record<string, any>;
};

const defaultScripts: YouTrackScripts = {
  config: () => youTrackConfigLoad(),
  greeting: () => youTrackGreeting(),
  parseDuration: (text) => youTrackParseDuration(text),
  api: (args) => youTrackApi(args, process.env.WORKFLOW_YT_WRITE ?? ""),
};

export function verifyYouTrackToken(scripts: YouTrackScripts = defaultScripts): Record<string, any> {
  return scripts.config();
}

function resolveYouTrackFromPaths(spec_path: string | undefined, plan_path: string | undefined, workspace_root: string): string | null {
  const root = resolveWorkspaceRoot(workspace_root);
  for (const rel of [spec_path, plan_path].filter(Boolean) as string[]) {
    const full = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, "utf8");
    const m = text.match(/^\*\*YouTrack:\*\*\s*`?([A-Z]+-\d+)`?/m);
    if (m) return m[1];
  }
  return null;
}

function meetingOptionsFromConfig(cfg: any): Record<string, any>[] {
  const base = (cfg.baseUrl || "").replace(/\/$/, "");
  if (cfg.meetingIssues && typeof cfg.meetingIssues === "object") {
    return Object.entries(cfg.meetingIssues).map(([key, item]: [string, any]) => ({
      key,
      issue: item.issue,
      label: item.label ?? item.issue,
      workItemText: item.workItemText ?? "Reuniones",
      url: item.url ?? (base && item.issue ? `${base}/issue/${item.issue}` : null),
    }));
  }
  const issue = cfg.meetingIssue;
  return [
    {
      key: "general",
      issue,
      label: "General meetings",
      workItemText: "Reuniones",
      url: base && issue ? `${base}/issue/${issue}` : null,
    },
  ];
}

export function context({ spec_path, plan_path, issue_id, issue_url, issue_ref, mode, workspace_root }: { spec_path?: string; plan_path?: string; issue_id?: string; issue_url?: string; issue_ref?: string; mode?: string; workspace_root: string }, scripts: YouTrackScripts = defaultScripts): Record<string, any> {
  const cfg = scripts.config();
  if (cfg.error) return { error: cfg.error };

  const greeting = scripts.greeting();
  if (greeting.exitCode !== 0) {
    return { error: (greeting.stderr || greeting.stdout || "greeting failed").trim() };
  }

  const meetingOptions = meetingOptionsFromConfig(cfg.data);

  if (mode === "meetings" && !issue_id && !issue_url && !issue_ref) {
    return {
      config: cfg.data,
      greeting: greeting.stdout.trim(),
      mode: "meetings",
      requiresMeetingChoice: true,
      meetingOptions,
      issueId: null,
    };
  }

  let issue = issue_id;
  if (!issue && (issue_url || issue_ref)) {
    const parsed = parseIssueRef(issue_url ?? issue_ref);
    if ("error" in parsed) return { error: parsed.error };
    issue = parsed.issueId;
  }
  if (!issue && mode === "meetings") issue = meetingOptions[0]?.issue ?? cfg.data.meetingIssue;
  if (!issue) issue = resolveYouTrackFromPaths(spec_path, plan_path, workspace_root) ?? undefined;
  if (!issue || !ISSUE_RE.test(issue)) {
    return {
      error: "invalid or missing issue id — pass issue_url, issue_id, or spec/plan with **YouTrack:**",
      requiresIssueInput: true,
    };
  }

  const base = (cfg.data.baseUrl || "").replace(/\/$/, "");
  const issueUrl = base ? `${base}/issue/${issue}` : null;

  const selectedMeeting = meetingOptions.find((m) => m.issue === issue);

  return {
    config: cfg.data,
    greeting: greeting.stdout.trim(),
    issueId: issue,
    issueUrl,
    mode: mode ?? (selectedMeeting ? "meetings" : "task"),
    meetingOptions,
    workItemText: selectedMeeting?.workItemText ?? null,
  };
}

export function parseDuration(text: string, _workspace_root: string, scripts: YouTrackScripts = defaultScripts): Record<string, any> {
  const out = scripts.parseDuration(text);
  if (out.error) return { error: out.error };
  return out.data;
}

export function logTime({ issueId, minutes, text, date, dateMs, workspace_root }: { issueId: string; minutes: number; text?: string; date?: string; dateMs?: number; workspace_root: string }, scripts: YouTrackScripts = defaultScripts): Record<string, any> {
  if (!issueId || !ISSUE_RE.test(issueId)) return { error: "invalid issueId" };
  if (!minutes || minutes <= 0) return { error: "minutes must be positive" };
  const workText = text ?? "workit";
  const dateArg =
    dateMs != null
      ? String(dateMs)
      : date && /^\d+$/.test(String(date))
        ? String(date)
        : "auto";
  const out = scripts.api(["log-time", issueId, String(minutes), workText, dateArg]);
  if (out.error) return { error: out.error };
  return { issueId, minutes, text: workText, ...out.data, ok: true };
}


export function buildDraft({ issueId, projectName, userNotes, greeting, facts, includeProjectOpener, includeFacts }: { issueId: string; projectName?: string; userNotes?: string; greeting?: string; facts?: any; includeProjectOpener?: boolean; includeFacts?: boolean }): Record<string, any> {
  const tpl = readTemplate("issue-update").content;
  const para = (value: string): string => (value ? `\n\n${value}` : "");
  const filled = tpl
    .replaceAll("{{greetingSection}}", para(greeting ? `${greeting}` : ""))
    .replaceAll("{{projectSection}}", para(includeProjectOpener && projectName ? `Hoy estuve full con ${projectName}.` : ""))
    .replaceAll("{{userNotesSection}}", para((userNotes ?? "").trim()))
    .replaceAll("{{progressSection}}", para(includeFacts && facts?.progress_excerpt?.length
      ? facts.progress_excerpt.map((l: string) => `- ${l}`).join("\n") : ""))
    .replaceAll("{{gitCommitsSection}}", para(includeFacts && facts?.git_commits?.length
      ? facts.git_commits.map((c: string) => `- ${c}`).join("\n") : ""));
  const collapsed = filled.replace(/\n{3,}/g, "\n\n").trimEnd();
  // Bare draft keeps the header's trailing blank line (matches legacy output);
  // drafts with sections end right after the last one.
  const markdown = collapsed === "# Actualización" ? `${collapsed}\n\n` : collapsed;
  return { issueId, markdown };
}

export function postUpdate({ confirmed, issueId, markdown, minutes, workspace_root }: { confirmed: boolean; issueId: string; markdown: string; minutes?: number; workspace_root?: string }, operations?: Record<string, any>): Record<string, any> {
  operations ??= {};
  if (!confirmed) return { error: "confirmed: true required" };
  if (!issueId || !ISSUE_RE.test(issueId)) return { error: "invalid issueId" };
  if (!markdown?.trim()) return { error: "markdown required" };

  const postComment = operations.postComment ?? ((id: string, text: string, root: string) =>
    youTrackApi(["post-comment", id, text], process.env.WORKFLOW_YT_WRITE ?? ""));
  const logTimeOperation = operations.logTime ?? logTime;
  const comment = postComment(issueId, markdown, workspace_root);
  if (comment.error) return { error: comment.error };

  if (minutes && minutes > 0) {
    const time = logTimeOperation({
      issueId,
      minutes,
      text: "workit update",
      workspace_root,
    });
    if (time.error) {
      return {
        ok: false,
        partial: true,
        issueId,
        postedComment: true,
        loggedMinutes: 0,
        error: time.error,
        retry: "workflow_youtrack_log_time",
      };
    }
    return { ok: true, issueId, postedComment: true, loggedMinutes: minutes };
  }

  return { ok: true, issueId, postedComment: true };
}
