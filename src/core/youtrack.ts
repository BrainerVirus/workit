import fs from "node:fs";
import path from "node:path";
import { runScript, runScriptJson } from "./scripts";
import { PLUGIN_ROOT } from "./scripts";
import { resolveWorkspaceRoot } from "./scripts";

const ISSUE_RE = /^[A-Z]+-\d+$/;

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

export function verifyYouTrackToken(): Record<string, any> {
  return runScriptJson("youtrack/verify-token.sh", [], PLUGIN_ROOT);
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

export function context({ spec_path, plan_path, issue_id, issue_url, issue_ref, mode, workspace_root }: { spec_path?: string; plan_path?: string; issue_id?: string; issue_url?: string; issue_ref?: string; mode?: string; workspace_root: string }): Record<string, any> {
  const cfg = runScriptJson("youtrack/config.sh", ["load"], workspace_root);
  if (cfg.error) return { error: cfg.error };

  const greeting = runScript("youtrack/greeting.sh", [], workspace_root);
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

export function parseDuration(text: string, workspace_root: string): Record<string, any> {
  const out = runScriptJson("youtrack/parse-duration.sh", [text], workspace_root);
  if (out.error) return { error: out.error };
  return out.data;
}

export function logTime({ issueId, minutes, text, date, dateMs, workspace_root }: { issueId: string; minutes: number; text?: string; date?: string; dateMs?: number; workspace_root: string }): Record<string, any> {
  if (!issueId || !ISSUE_RE.test(issueId)) return { error: "invalid issueId" };
  if (!minutes || minutes <= 0) return { error: "minutes must be positive" };
  const workText = text ?? "workflow-toolkit";
  const dateArg =
    dateMs != null
      ? String(dateMs)
      : date && /^\d+$/.test(String(date))
        ? String(date)
        : "auto";
  const out = runScriptJson(
    "youtrack/api.sh",
    ["log-time", issueId, String(minutes), workText, dateArg],
    workspace_root,
  );
  if (out.error) return { error: out.error };
  return { issueId, minutes, text: workText, ...out.data, ok: true };
}

export function buildDraft({ issueId, projectName, userNotes, greeting, facts, includeProjectOpener, includeFacts }: { issueId: string; projectName?: string; userNotes?: string; greeting?: string; facts?: any; includeProjectOpener?: boolean; includeFacts?: boolean }): Record<string, any> {
  const header = "# Actualización\n\n";
  const open = greeting ? `${greeting}\n\n` : "";
  const project =
    includeProjectOpener && projectName ? `Hoy estuve full con ${projectName}.\n\n` : "";
  const narrative = (userNotes ?? "").trim();
  const factsBlock =
    includeFacts && facts?.progress_excerpt?.length
      ? "\n\n" + facts.progress_excerpt.map((l: string) => `- ${l}`).join("\n")
      : "";
  const commitsBlock =
    includeFacts && facts?.git_commits?.length
      ? "\n\n" + facts.git_commits.map((c: string) => `- ${c}`).join("\n")
      : "";
  return {
    issueId,
    markdown: header + open + project + narrative + factsBlock + commitsBlock,
  };
}

export function postUpdate({ confirmed, issueId, markdown, minutes, workspace_root }: { confirmed: boolean; issueId: string; markdown: string; minutes?: number; workspace_root?: string }, operations?: Record<string, any>): Record<string, any> {
  operations ??= {};
  if (!confirmed) return { error: "confirmed: true required" };
  if (!issueId || !ISSUE_RE.test(issueId)) return { error: "invalid issueId" };
  if (!markdown?.trim()) return { error: "markdown required" };

  const postComment = operations.postComment ?? ((id: string, text: string, root: string) =>
    runScriptJson("youtrack/api.sh", ["post-comment", id, text], root));
  const logTimeOperation = operations.logTime ?? logTime;
  const comment = postComment(issueId, markdown, workspace_root);
  if (comment.error) return { error: comment.error };

  if (minutes && minutes > 0) {
    const time = logTimeOperation({
      issueId,
      minutes,
      text: "workflow-toolkit update",
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
