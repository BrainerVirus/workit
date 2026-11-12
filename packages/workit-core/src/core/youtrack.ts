import fs from "node:fs";
import path from "node:path";
import { readTemplate } from "./templates";
import { resolveWorkspaceRoot } from "./scripts";
import { configDir, isConfigObject, resolveConfigDir } from "./config";
import { resolveInside } from "../core";
import {
  YTRACK_EXIT,
  YTRACK_MISSING,
  ytrackDetail,
  ytrackRunner,
  type YtrackRun,
} from "./youtrack-ytrack";

const ISSUE_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

// Port of scripts/youtrack/config.sh chain: WORKIT_YOUTRACK_CONFIG ->
// configDir() (XDG_CONFIG_HOME / HOME .config + workit).
export const youTrackConfigPath = (): string =>
  process.env.WORKIT_YOUTRACK_CONFIG ?? path.join(configDir(), "youtrack.json");

/** Config path for read-only context: the resolved config dir, no side effects. */
export const youTrackReadOnlyConfigPath = (): string =>
  process.env.WORKIT_YOUTRACK_CONFIG ?? path.join(resolveConfigDir(), "youtrack.json");

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

export type WorkTimezone = {
  timezone: string;
  source: "youtrack.json" | "process";
};

/** The timezone that decides a work item's calendar day: an explicit
 * youtrack.json `timezone` wins, otherwise the process timezone (TZ). */
export const effectiveWorkTimezone = (
  cfg: Record<string, any> | null | undefined,
): WorkTimezone => {
  const configured = cfg?.timezone;
  return typeof configured === "string" && configured.trim()
    ? { timezone: configured.trim(), source: "youtrack.json" }
    : { timezone: processTimezone(), source: "process" };
};

/** Neutral default work-item text for meeting time; youtrack.json can set a
 * global `meetingWorkItemText` or a per-meeting `workItemText`. */
export const DEFAULT_MEETING_WORK_ITEM_TEXT = "Meetings";

export const meetingWorkItemText = (
  cfg: Record<string, any> | null | undefined,
  item?: Record<string, any> | null,
): string => {
  if (typeof item?.workItemText === "string" && item.workItemText) return item.workItemText;
  if (typeof cfg?.meetingWorkItemText === "string" && cfg.meetingWorkItemText)
    return cfg.meetingWorkItemText;
  return DEFAULT_MEETING_WORK_ITEM_TEXT;
};

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
export function youTrackWorkDateMs(dateRaw: string):
  | {
      data: {
        dateMs: number;
        timezone: string;
        timezoneSource: WorkTimezone["source"];
        localDate: string;
      };
    }
  | { error: string } {
  const cfgPath = youTrackConfigPath();
  let effective = effectiveWorkTimezone(null);
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
    effective = effectiveWorkTimezone(parsed as Record<string, any>);
  }
  const tz = effective.timezone;
  const meta = { timezone: tz, timezoneSource: effective.source };
  const raw = dateRaw || "auto";
  try {
    if (raw === "auto") {
      const { y, m, d } = tzParts(new Date(), tz);
      const dateMs = utcMidnight(Number(y), Number(m), Number(d));
      if (dateMs === null) return { error: "could not resolve date" };
      return { data: { dateMs, ...meta, localDate: `${y}-${m}-${d}` } };
    }
    if (/^\d+$/.test(raw)) {
      // An explicit epoch is already a work-item date (UTC midnight of the
      // day); its label is that UTC calendar day so it round-trips exactly.
      const dt = new Date(Number(raw));
      if (Number.isNaN(dt.getTime())) return { error: `invalid date: ${raw}` };
      return { data: { dateMs: Number(raw), ...meta, localDate: dt.toISOString().slice(0, 10) } };
    }
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    const dateMs = match ? utcMidnight(Number(match[1]), Number(match[2]), Number(match[3])) : null;
    if (!match || dateMs === null) return { error: `invalid date: ${raw} (expected YYYY-MM-DD)` };
    const localDate = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    return { data: { dateMs, ...meta, localDate } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "could not resolve date" };
  }
}

/** The timezone that decides a work item's day (youtrack.json `timezone`, else TZ), read-only. */
export const youTrackWorkTimezone = (): string => {
  const read = readYouTrackContextConfig();
  return effectiveWorkTimezone("error" in read ? null : read.data).timezone;
};

/** youtrack.json's baseUrl without trailing slashes, read-only; null when unset. */
export const youTrackBaseUrl = (): string | null => {
  const read = readYouTrackContextConfig();
  if ("error" in read) return null;
  const base = typeof read.data.baseUrl === "string" ? read.data.baseUrl.replace(/\/+$/, "") : "";
  return base || null;
};

/** Parse bare id (NSR-40) or YouTrack URL into issue id. */
export function parseIssueRef(
  input: unknown,
): { issueId: string; source: string } | { error: string } {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return { error: "empty issue reference" };

  if (ISSUE_RE.test(trimmed)) {
    return { issueId: trimmed, source: "id" };
  }

  const fromPath = trimmed.match(/\/(?:issue|issues)\/([A-Z][A-Z0-9_]*-\d+)/i);
  if (fromPath && ISSUE_RE.test(fromPath[1])) {
    return { issueId: fromPath[1], source: "url" };
  }

  const anywhere = trimmed.match(/([A-Z][A-Z0-9_]*-\d+)/);
  if (anywhere && ISSUE_RE.test(anywhere[1])) {
    return { issueId: anywhere[1], source: "url" };
  }

  return { error: `could not parse issue id from: ${trimmed}` };
}

export type YouTrackScripts = {
  config(): Record<string, any>;
  parseDuration(text: string): Record<string, any>;
};

const defaultScripts: YouTrackScripts = {
  config: readYouTrackContextConfig,
  parseDuration: (text) => youTrackParseDuration(text),
};

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
      workItemText: meetingWorkItemText(cfg, item),
      url: item.url ?? (base && item.issue ? `${base}/issue/${item.issue}` : null),
    }));
  }
  const issue = cfg.meetingIssue;
  return [
    {
      key: "general",
      issue,
      label: "General meetings",
      workItemText: meetingWorkItemText(cfg),
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
  for (const key of ["timezone", "meetingIssue", "meetingWorkItemText"])
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
  scripts: YouTrackScripts = defaultScripts,
): Record<string, any> {
  const cfg = scripts.config();
  if (cfg.error) return { error: cfg.error };

  const safeConfig = readOnlyYouTrackConfig(cfg.data);
  const meetingOptions = meetingOptionsFromConfig(safeConfig);

  if (mode === "meetings" && !issue_id && !issue_url && !issue_ref) {
    return {
      config: safeConfig,
      workTimezone: effectiveWorkTimezone(safeConfig),
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
    workTimezone: effectiveWorkTimezone(safeConfig),
    issueId: issue,
    issueUrl,
    mode: mode ?? (selectedMeeting ? "meetings" : "task"),
    meetingOptions,
    workItemText: selectedMeeting?.workItemText ?? null,
  };
}

/** Fetch a YouTrack issue body for context.read (titles alone mislead), through
 * ytrack. A missing ytrack or login degrades (offline keeps the link shape); a
 * failed read fails closed so sessions never mistake titles for bodies. */
export const fetchYouTrackIssueBody = async (
  issue: string,
  ytrack: YtrackRun = ytrackRunner(process.env, youTrackBaseUrl()),
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
  const viaYtrack = ytrack([
    "issue",
    "view",
    issue,
    "--json",
    "idReadable,summary,description,state",
  ]);
  if (viaYtrack.missing) return { error: YTRACK_MISSING, kind: "creds" };
  if (viaYtrack.status !== YTRACK_EXIT.ok)
    return {
      error: `ytrack issue view failed (exit ${viaYtrack.status ?? "signal"}): ${ytrackDetail(viaYtrack)}`,
      kind: viaYtrack.status === YTRACK_EXIT.auth ? "creds" : "request",
    };
  try {
    const parsed = JSON.parse(viaYtrack.stdout) as Record<string, unknown>;
    return {
      data: {
        idReadable: String(parsed.idReadable ?? issue),
        summary: String(parsed.summary ?? ""),
        description: typeof parsed.description === "string" ? parsed.description : null,
        state: typeof parsed.state === "string" && parsed.state ? parsed.state : null,
      },
    };
  } catch {
    return { error: "ytrack printed invalid JSON", kind: "request" };
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

export function buildDraft({
  issueId,
  projectName,
  userNotes,
  facts,
  includeProjectOpener,
  includeFacts,
}: {
  issueId: string;
  projectName?: string;
  userNotes?: string;
  facts?: any;
  includeProjectOpener?: boolean;
  includeFacts?: boolean;
}): Record<string, any> {
  // The wording lives in the editable issue-update template (config
  // templates/issue-update.md overrides the bundled neutral one). Placeholders
  // this build does not fill (e.g. a legacy {{greetingSection}}) render empty.
  const tpl = readTemplate("issue-update").content;
  const para = (value: string): string => (value ? `\n\n${value}` : "");
  const sections: Record<string, string> = {
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
  filled = filled.replace(/\{\{[A-Za-z0-9_]+\}\}/g, "");
  const collapsed = filled.replace(/\n{3,}/g, "\n\n").trimEnd();
  // Bare draft keeps the header's trailing blank line (matches legacy output);
  // drafts with sections end right after the last one.
  const markdown = Object.values(sections).some(Boolean) ? collapsed : `${collapsed}\n\n`;
  return { issueId, markdown };
}
