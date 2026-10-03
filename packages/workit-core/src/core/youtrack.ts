import fs from "node:fs";
import path from "node:path";
import { readTemplate } from "./templates";
import { resolveWorkspaceRoot } from "./scripts";
import { configDir, isConfigObject, resolveConfigDir } from "./config";
import { resolveInside } from "../core";

const ISSUE_RE = /^[A-Z]+-\d+$/;
const TOKEN_PLACEHOLDER = "YOUR_TOKEN_HERE";

// Port of scripts/youtrack/config.sh chain: WORKFLOW_YOUTRACK_CONFIG ->
// configDir() (XDG_CONFIG_HOME / HOME .config + workit).
export const youTrackConfigPath = (): string =>
  process.env.WORKFLOW_YOUTRACK_CONFIG ?? path.join(configDir(), "youtrack.json");

/** Config path for read-only context.  Unlike youTrackConfigPath(), this never
 * calls configDir() and therefore cannot trigger legacy-config migration. */
export const youTrackReadOnlyConfigPath = (): string =>
  process.env.WORKFLOW_YOUTRACK_CONFIG ?? path.join(resolveConfigDir(), "youtrack.json");

const youTrackTokenModeOk = (p: string): boolean => {
  if (process.platform === "win32") return true;
  const mode = fs.statSync(p).mode & 0o777;
  return mode === 0o600;
};

// AR-07/CA-37: the shared shape rule applies here too — a parseable non-object
// youtrack.json (null, scalar, array) is malformed with the exact path, never
// missing/unconfigured, never silently defaulted.
function readYouTrackConfig(
  required: boolean,
): { config: Record<string, any>; path: string } | { error: string; path: string } {
  const cfgPath = youTrackConfigPath();
  if (!fs.existsSync(cfgPath)) {
    return required
      ? { error: "ERROR: missing youtrack.json", path: cfgPath }
      : { config: {}, path: cfgPath };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return { error: `${cfgPath} is not valid JSON`, path: cfgPath };
  }
  if (!isConfigObject(parsed)) {
    return { error: `${cfgPath} is not a JSON object`, path: cfgPath };
  }
  return { config: parsed as Record<string, any>, path: cfgPath };
}

const readYouTrackContextConfig = (): { data: Record<string, any> } | { error: string } => {
  const cfgPath = youTrackReadOnlyConfigPath();
  if (!fs.existsSync(cfgPath)) return { data: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return { error: "YouTrack configuration is unavailable" };
  }
  if (!isConfigObject(parsed)) return { error: "YouTrack configuration is unavailable" };
  return { data: readOnlyYouTrackConfig(parsed as Record<string, any>) };
};

// RL-01: typed load result — malformed carries {ok:false, error, configPath}
// mirroring vcsConfig, so risky consumers stop on the exact path.
export type YouTrackConfigResult =
  | { data: Record<string, any> }
  | { error: string }
  | { ok: false; error: string; configPath: string };

/** Load + redact youtrack.json; validates the token file like youtrack/config.sh load. */
export function youTrackConfigLoad(): YouTrackConfigResult {
  const loaded = readYouTrackConfig(true);
  if ("error" in loaded) {
    // RL-01: malformed (parse failure or non-object) fails closed with the exact
    // path, mirroring vcsConfig's {ok:false,error,configPath} shape.
    return { ok: false, error: loaded.error, configPath: loaded.path };
  }
  const cfgPath = loaded.path;
  const tokenFile = String(loaded.config.tokenFile ?? "");
  const tokenPath = tokenFile
    ? path.isAbsolute(tokenFile)
      ? path.resolve(tokenFile)
      : path.resolve(process.cwd(), tokenFile)
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

function tzParts(date: Date, tz: string): { y: string; m: string; d: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { y: map.year, m: map.month, d: map.day };
}

// The process timezone (honours TZ). Used when youtrack.json has no explicit
// `timezone` override; there is no hard-coded default zone.
const processTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// A YouTrack work-item date is the calendar day at UTC midnight. Computing it
// with Date.UTC keeps it independent of the process timezone (Date.parse of a
// local "T00:00:00" shifted it a day back east of UTC).
const utcMidnight = (y: number, m: number, d: number): number | null => {
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d
    ? ms
    : null;
};

/** Port of scripts/youtrack/parse-duration.sh. */
export function youTrackParseDuration(
  text: string,
): { data: { minutes: number; text: string } } | { error: string } {
  const lower = String(text).toLowerCase().trim();
  let total = 0;
  for (const match of lower.matchAll(/(\d+)\s*h/g)) total += Number(match[1]) * 60;
  for (const match of lower.matchAll(/(\d+)\s*m/g)) total += Number(match[1]);
  if (total === 0 && /^\d+$/.test(lower)) total = Number(lower);
  if (total <= 0) return { error: "could not parse duration" };
  return { data: { minutes: total, text: String(text).trim() } };
}

/** Port of scripts/youtrack/work-date-ms.sh — resolve work-item date as epoch ms.
 * The calendar day comes from youtrack.json `timezone` when set (optional
 * override), otherwise from the process timezone. */
export function youTrackWorkDateMs(
  dateRaw: string,
): { data: { dateMs: number; timezone: string; localDate: string } } | { error: string } {
  const cfgPath = youTrackConfigPath();
  let tz = processTimezone();
  // Missing file is a legitimate unconfigured state (reader: "missing" keeps
  // defaults); a parseable non-object is malformed and must propagate the
  // exact-path error instead of silently defaulting the timezone.
  if (fs.existsSync(cfgPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch {
      return { error: `${cfgPath} is not valid JSON` };
    }
    if (!isConfigObject(parsed)) {
      return { error: `${cfgPath} is not a JSON object` };
    }
    const configured = (parsed as Record<string, any>).timezone;
    if (typeof configured === "string" && configured.trim()) tz = configured.trim();
  }
  const raw = dateRaw || "auto";
  try {
    if (raw === "auto") {
      const { y, m, d } = tzParts(new Date(), tz);
      const dateMs = utcMidnight(Number(y), Number(m), Number(d));
      if (dateMs === null) return { error: "could not resolve date" };
      return { data: { dateMs, timezone: tz, localDate: `${y}-${m}-${d}` } };
    }
    if (/^\d+$/.test(raw)) {
      const dt = new Date(Number(raw));
      const { y, m, d } = tzParts(dt, tz);
      return { data: { dateMs: Number(raw), timezone: tz, localDate: `${y}-${m}-${d}` } };
    }
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    const dateMs = match ? utcMidnight(Number(match[1]), Number(match[2]), Number(match[3])) : null;
    if (!match || dateMs === null) return { error: `invalid date: ${raw} (expected YYYY-MM-DD)` };
    const localDate = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    return { data: { dateMs, timezone: tz, localDate } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "could not resolve date" };
  }
}

export const youTrackToken = (): { token: string; base: string } | { error: string } => {
  const loaded = readYouTrackConfig(true);
  if ("error" in loaded) return loaded;
  const tokenFile = String(loaded.config.tokenFile ?? "");
  const tokenPath = tokenFile
    ? path.isAbsolute(tokenFile)
      ? path.resolve(tokenFile)
      : path.resolve(process.cwd(), tokenFile)
    : "";
  if (!tokenPath || !fs.existsSync(tokenPath)) return { error: "missing youtrack.token" };
  if (!youTrackTokenModeOk(tokenPath)) return { error: "youtrack.token mode must be 0600" };
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token) return { error: "empty token file" };
  if (token === TOKEN_PLACEHOLDER || token.startsWith(TOKEN_PLACEHOLDER)) {
    return {
      error:
        "token file still has placeholder YOUR_TOKEN_HERE — edit the file locally, then run /wk-status",
    };
  }
  const base = String(loaded.config.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return { error: "baseUrl missing in config" };
  return { token, base };
};

// fetch replaces the previous curl -fsS request helper: check res.ok,
// surface HTTP errors without a token-bearing body, parse JSON on success.
export async function youTrackRequest(
  url: string,
  init: { method: string; token: string; body?: unknown },
): Promise<{ status: number; stdout: string; stderr: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${init.token}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  try {
    const res = await fetch(url, { method: init.method, headers, body });
    const text = await res.text();
    if (!res.ok) {
      return { status: res.status, stdout: "", stderr: text.slice(0, 200) };
    }
    return { status: 0, stdout: text, stderr: "" };
  } catch (err) {
    return { status: 1, stdout: "", stderr: err instanceof Error ? err.message : "network error" };
  }
}

/** Port of scripts/youtrack/api.sh — log-time / post-comment with the WORKFLOW_YT_WRITE guard. */
export async function youTrackApi(
  args: string[],
  writeFlag = process.env.WORKFLOW_YT_WRITE ?? "",
): Promise<{ data: Record<string, any> } | { error: string }> {
  const cmd = args[0];
  if (cmd === "log-time" || cmd === "post-comment") {
    if (writeFlag !== "1") {
      return {
        error:
          "YouTrack write operations require WORKFLOW_YT_WRITE=1 (refusing to mutate production)",
      };
    }
  }
  const creds = youTrackToken();
  if ("error" in creds) return creds;
  const { token, base } = creds;

  if (cmd === "log-time") {
    const [issue, minutesRaw, text, dateArg] = args.slice(1);
    const minutes = Number(minutesRaw);
    const dateMs = youTrackWorkDateMs(dateArg ?? "auto");
    if ("error" in dateMs) return dateMs;
    const out = await youTrackRequest(
      `${base}/api/issues/${issue}/timeTracking/workItems?fields=id,idReadable`,
      {
        method: "POST",
        token,
        body: { duration: { minutes }, text, date: dateMs.data.dateMs },
      },
    );
    if (out.status !== 0) return { error: "YouTrack HTTP request failed" };
    try {
      const created = JSON.parse(out.stdout) as Record<string, any>;
      return {
        data: {
          ok: true,
          issueId: issue,
          workItemId: created.id,
          dateMs: dateMs.data.dateMs,
          minutes,
        },
      };
    } catch {
      return { error: "invalid JSON from YouTrack API" };
    }
  }
  if (cmd === "post-comment") {
    const [issue, text] = args.slice(1);
    const out = await youTrackRequest(`${base}/api/issues/${issue}/comments`, {
      method: "POST",
      token,
      body: { text },
    });
    if (out.status !== 0) return { error: "YouTrack HTTP request failed" };
    return { data: { ok: true, issueId: issue } };
  }
  return { error: "unknown subcommand" };
}

/** Port of scripts/youtrack/verify-token.sh — read-only GET /api/users/me. */
export async function youTrackVerifyToken(): Promise<
  { data: Record<string, any> } | { error: string; http_status?: number; path?: string }
> {
  const cfgPath = youTrackConfigPath();
  if (!fs.existsSync(cfgPath)) return { error: "missing youtrack.json" };
  const creds = youTrackToken();
  if ("error" in creds) return { error: creds.error };
  const { token, base } = creds;

  const me = await youTrackRequest(`${base}/api/users/me?fields=id,login,name,email`, {
    method: "GET",
    token,
  });
  if (me.status !== 0) {
    const err =
      me.status === 401 || me.status === 403
        ? "authentication failed (401/403)"
        : `HTTP error: ${me.stderr.slice(0, 200)}`;
    return { error: err, http_status: me.status };
  }
  let user: Record<string, any>;
  try {
    user = JSON.parse(me.stdout) as Record<string, any>;
  } catch {
    return { error: "invalid JSON from YouTrack /api/users/me" };
  }
  const result: Record<string, any> = {
    ok: true,
    method: "GET /api/users/me",
    baseUrl: base,
    login: user.login,
    name: user.name,
    email: user.email,
    id: user.id,
  };
  const meeting = readYouTrackConfig(false);
  const meetingIssue = "config" in meeting ? meeting.config.meetingIssue : undefined;
  if (meetingIssue) {
    const issue = await youTrackRequest(
      `${base}/api/issues/${meetingIssue}?fields=id,idReadable,summary`,
      { method: "GET", token },
    );
    if (issue.status === 0) {
      try {
        const parsed = JSON.parse(issue.stdout) as Record<string, any>;
        result.meetingIssue = meetingIssue;
        result.meetingIssueReadable = true;
        result.meetingIssueSummary = parsed.summary;
      } catch {
        /* unreadable */
      }
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
  if ("error" in loaded) {
    return { data: { error: loaded.error } };
  }
  const config = loaded.config;
  const defaults = (config.tokenDefaults ?? {}) as Record<string, any>;
  const name = String(defaults.name ?? tokenName);
  const desc = String(
    defaults.description ?? "OpenCode workit — /wk-issue-update and /wk-meetings",
  );
  const scopes = Array.isArray(defaults.scopes) ? defaults.scopes : ["YouTrack"];
  const base = String(config.baseUrl ?? "https://enghouseamg.youtrack.cloud").replace(/\/+$/, "");
  const tokenFile = String(
    config.tokenFile ?? path.join(path.dirname(loaded.path), "youtrack.token"),
  );
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
export function parseIssueRef(
  input: unknown,
): { issueId: string; source: string } | { error: string } {
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
  parseDuration(text: string): Record<string, any>;
  api(args: string[]): Record<string, any> | Promise<Record<string, any>>;
};

const defaultScripts: YouTrackScripts = {
  config: () => youTrackConfigLoad(),
  parseDuration: (text) => youTrackParseDuration(text),
  api: (args) => youTrackApi(args, process.env.WORKFLOW_YT_WRITE ?? ""),
};

const contextScripts: YouTrackScripts = {
  config: readYouTrackContextConfig,
  parseDuration: (text) => youTrackParseDuration(text),
  api: () => ({ error: "YouTrack context is read-only" }),
};

export function verifyYouTrackToken(
  scripts: YouTrackScripts = defaultScripts,
): Record<string, any> {
  return scripts.config();
}

function resolveYouTrackFromPaths(
  spec_path: string | undefined,
  plan_path: string | undefined,
  workspace_root: string,
): string | null {
  const root = resolveWorkspaceRoot(workspace_root);
  for (const rel of [spec_path, plan_path].filter(Boolean) as string[]) {
    let full: string;
    try {
      full = resolveInside(root, rel);
    } catch {
      continue;
    }
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

const readOnlyYouTrackConfig = (cfg: Record<string, any>): Record<string, any> => {
  const publicUrl = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    try {
      const url = new URL(value);
      if (url.username || url.password)
        return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
      return value;
    } catch {
      return undefined;
    }
  };
  const safe: Record<string, any> = {};
  const baseUrl = publicUrl(cfg.baseUrl);
  if (baseUrl) safe.baseUrl = baseUrl;
  for (const key of ["timezone", "meetingIssue"])
    if (typeof cfg[key] === "string") safe[key] = cfg[key];
  if (
    cfg.meetingIssues &&
    typeof cfg.meetingIssues === "object" &&
    !Array.isArray(cfg.meetingIssues)
  ) {
    safe.meetingIssues = Object.fromEntries(
      Object.entries(cfg.meetingIssues).flatMap(([key, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const item = value as Record<string, any>;
        const safeItem: Record<string, string> = {};
        for (const field of ["issue", "label", "workItemText"])
          if (typeof item[field] === "string") safeItem[field] = item[field];
        const url = publicUrl(item.url);
        if (url) safeItem.url = url;
        return [[key, safeItem]] as const;
      }),
    );
  }
  return safe;
};

export function context(
  {
    spec_path,
    plan_path,
    issue_id,
    issue_url,
    issue_ref,
    mode,
    workspace_root,
  }: {
    spec_path?: string;
    plan_path?: string;
    issue_id?: string;
    issue_url?: string;
    issue_ref?: string;
    mode?: string;
    workspace_root: string;
  },
  scripts: YouTrackScripts = contextScripts,
): Record<string, any> {
  const cfg = scripts.config();
  if (cfg.error) return { error: cfg.error };

  const safeConfig = readOnlyYouTrackConfig(cfg.data);
  const meetingOptions = meetingOptionsFromConfig(safeConfig);

  if (mode === "meetings" && !issue_id && !issue_url && !issue_ref) {
    return {
      config: safeConfig,
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
  if (!issue && mode === "meetings") issue = meetingOptions[0]?.issue ?? safeConfig.meetingIssue;
  if (!issue) issue = resolveYouTrackFromPaths(spec_path, plan_path, workspace_root) ?? undefined;
  if (!issue || !ISSUE_RE.test(issue)) {
    return {
      error:
        "invalid or missing issue id — pass issue_url, issue_id, or spec/plan with **YouTrack:**",
      requiresIssueInput: true,
    };
  }

  const base = (safeConfig.baseUrl || "").replace(/\/$/, "");
  const issueUrl = base ? `${base}/issue/${issue}` : null;

  const selectedMeeting = meetingOptions.find((m) => m.issue === issue);

  return {
    config: safeConfig,
    issueId: issue,
    issueUrl,
    mode: mode ?? (selectedMeeting ? "meetings" : "task"),
    meetingOptions,
    workItemText: selectedMeeting?.workItemText ?? null,
  };
}

/** Fetch a YouTrack issue body for context.read (titles alone mislead).
 * Creds failure degrades (offline keeps the link shape); request failure
 * with creds fails closed so sessions never mistake titles for bodies. */
export const fetchYouTrackIssueBody = async (
  issue: string,
  creds: () => { token: string; base: string } | { error: string } = youTrackToken,
  request: typeof youTrackRequest = youTrackRequest,
): Promise<
  | {
      data: {
        idReadable: string;
        summary: string;
        description: string | null;
        state: string | null;
      };
    }
  | { error: string; kind: "creds" | "request" }
> => {
  const credentials = creds();
  if ("error" in credentials) return { error: credentials.error, kind: "creds" };
  const { token, base } = credentials;
  const out = await request(
    `${base}/api/issues/${encodeURIComponent(issue)}?fields=idReadable,summary,description,customFields(name,value(name))`,
    { method: "GET", token },
  );
  if (out.status !== 0)
    return { error: out.stderr || "YouTrack issue fetch failed", kind: "request" };
  try {
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    const customFields = Array.isArray(parsed.customFields) ? parsed.customFields : [];
    const stateField = customFields.find(
      (field): field is { name: unknown; value: unknown } =>
        typeof field === "object" &&
        field !== null &&
        (field as { name: unknown }).name === "State",
    );
    const stateValue = stateField?.value;
    const stateName =
      typeof stateValue === "object" && stateValue !== null
        ? (stateValue as { name?: unknown }).name
        : undefined;
    return {
      data: {
        idReadable: String(parsed.idReadable ?? issue),
        summary: String(parsed.summary ?? ""),
        description: typeof parsed.description === "string" ? parsed.description : null,
        state:
          typeof stateValue === "string"
            ? stateValue
            : typeof stateName === "string" && stateName
              ? stateName
              : null,
      },
    };
  } catch {
    return { error: "invalid JSON from YouTrack API", kind: "request" };
  }
};

export function parseDuration(
  text: string,
  _workspace_root: string,
  scripts: YouTrackScripts = defaultScripts,
): Record<string, any> {
  const out = scripts.parseDuration(text);
  if (out.error) return { error: out.error };
  return out.data;
}

export async function logTime(
  {
    issueId,
    minutes,
    text,
    date,
    dateMs,
    workspace_root: _workspace_root,
  }: {
    issueId: string;
    minutes: number;
    text?: string;
    date?: string;
    dateMs?: number;
    workspace_root: string;
  },
  scripts: YouTrackScripts = defaultScripts,
): Promise<Record<string, any>> {
  if (!issueId || !ISSUE_RE.test(issueId)) return { error: "invalid issueId" };
  if (!minutes || minutes <= 0) return { error: "minutes must be positive" };
  const workText = text ?? "workit";
  const dateArg =
    dateMs != null ? String(dateMs) : date && /^\d+$/.test(String(date)) ? String(date) : "auto";
  const out = await scripts.api(["log-time", issueId, String(minutes), workText, dateArg]);
  if (out.error) return { error: out.error };
  return { issueId, minutes, text: workText, ...out.data, ok: true };
}

export function buildDraft({
  issueId,
  projectName,
  userNotes,
  greeting,
  facts,
  includeProjectOpener,
  includeFacts,
}: {
  issueId: string;
  projectName?: string;
  userNotes?: string;
  greeting?: string;
  facts?: any;
  includeProjectOpener?: boolean;
  includeFacts?: boolean;
}): Record<string, any> {
  // The wording lives in the editable issue-update template (config
  // templates/issue-update.md overrides the bundled neutral one). `greeting`
  // is an optional caller-supplied opening line; there is no built-in text.
  const tpl = readTemplate("issue-update").content;
  const para = (value: string): string => (value ? `\n\n${value}` : "");
  const sections: Record<string, string> = {
    "{{greetingSection}}": (greeting ?? "").trim(),
    "{{projectSection}}": includeProjectOpener && projectName ? `Project: ${projectName}` : "",
    "{{userNotesSection}}": (userNotes ?? "").trim(),
    "{{progressSection}}":
      includeFacts && facts?.progress_excerpt?.length
        ? facts.progress_excerpt.map((l: string) => `- ${l}`).join("\n")
        : "",
    "{{gitCommitsSection}}":
      includeFacts && facts?.git_commits?.length
        ? facts.git_commits.map((c: string) => `- ${c}`).join("\n")
        : "",
  };
  let filled = tpl;
  for (const [placeholder, value] of Object.entries(sections))
    filled = filled.replaceAll(placeholder, para(value));
  const collapsed = filled.replace(/\n{3,}/g, "\n\n").trimEnd();
  // Bare draft keeps the header's trailing blank line (matches legacy output);
  // drafts with sections end right after the last one.
  const markdown = Object.values(sections).some(Boolean) ? collapsed : `${collapsed}\n\n`;
  return { issueId, markdown };
}

export async function postUpdate(
  {
    confirmed,
    issueId,
    markdown,
    minutes,
    workspace_root,
  }: {
    confirmed: boolean;
    issueId: string;
    markdown: string;
    minutes?: number;
    workspace_root?: string;
  },
  operations?: Record<string, any>,
): Promise<Record<string, any>> {
  operations ??= {};
  if (!confirmed) return { error: "confirmed: true required" };
  if (!issueId || !ISSUE_RE.test(issueId)) return { error: "invalid issueId" };
  if (!markdown?.trim()) return { error: "markdown required" };

  const postComment =
    operations.postComment ??
    ((id: string, text: string, _root: string) =>
      youTrackApi(["post-comment", id, text], process.env.WORKFLOW_YT_WRITE ?? ""));
  const logTimeOperation = operations.logTime ?? logTime;
  const comment = await postComment(issueId, markdown, workspace_root);
  if (comment.error) return { error: comment.error };

  if (minutes && minutes > 0) {
    const time = await logTimeOperation({
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
        retry: "youtrack.time",
      };
    }
    return { ok: true, issueId, postedComment: true, loggedMinutes: minutes };
  }

  return { ok: true, issueId, postedComment: true };
}
